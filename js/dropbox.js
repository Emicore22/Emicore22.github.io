// Thin Dropbox API v2 client (owner mode — direct from the browser).
// Paths are relative to the app folder root ("" = root, "/foo/bar.json").

import { dbxFetch, getAccessToken } from "./auth.js";

const API = "https://api.dropboxapi.com/2";
const CONTENT = "https://content.dropboxapi.com/2";

// Dropbox's single-call upload endpoint stops at 150 MB; bigger files go up
// through an upload session, in chunks of a multiple of 4 MB as Dropbox asks.
const SINGLE_SHOT_MAX = 150 * 1024 * 1024;
const CHUNK_SIZE = 8 * 1024 * 1024;
const CHUNK_ATTEMPTS = 3;

async function rpc(endpoint, body) {
  const res = await dbxFetch(`${API}/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? null),
  });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Dropbox ${endpoint} failed (${res.status}): ${text}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  return res.json();
}

function isNotFound(err) {
  return err.status === 409 && /not_found/.test(err.body || "");
}

// Returns {data, rev} or null when the file doesn't exist yet.
export async function downloadJson(path) {
  const res = await dbxFetch(`${CONTENT}/files/download`, {
    method: "POST",
    headers: { "Dropbox-API-Arg": JSON.stringify({ path }) },
  });
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 409 && /not_found/.test(text)) return null;
    throw new Error(`Dropbox download ${path} failed (${res.status}): ${text}`);
  }
  const meta = JSON.parse(res.headers.get("Dropbox-API-Result") || "{}");
  return { data: await res.json(), rev: meta.rev };
}

// Writes JSON. Pass `rev` for compare-and-swap (mode: update); omit to overwrite.
// Throws err.conflict = true when the rev no longer matches.
export async function uploadJson(path, data, rev = null) {
  const mode = rev ? { ".tag": "update", update: rev } : "overwrite";
  const res = await dbxFetch(`${CONTENT}/files/upload`, {
    method: "POST",
    headers: {
      "Dropbox-API-Arg": JSON.stringify({ path, mode, autorename: false, mute: true }),
      "Content-Type": "application/octet-stream",
    },
    body: JSON.stringify(data, null, 2),
  });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Dropbox upload ${path} failed (${res.status}): ${text}`);
    err.conflict = res.status === 409 && /conflict/.test(text);
    throw err;
  }
  return res.json();
}

// Read-modify-write with CAS retry. `mutate(data)` returns the new data
// (or null to abort). `initial()` provides the document when it doesn't exist.
export async function updateJson(path, mutate, initial) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const existing = await downloadJson(path);
    const data = existing ? existing.data : initial();
    const next = mutate(structuredClone(data));
    if (next == null) return data;
    try {
      await uploadJson(path, next, existing?.rev ?? null);
      return next;
    } catch (err) {
      if (!err.conflict || attempt === 3) throw err;
    }
  }
}

// One authenticated upload POST, reporting bytes sent so far.
// XHR rather than fetch() because only XHR exposes upload progress.
function postContent({ endpoint, accessToken, apiArg, body, onBytes }) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${CONTENT}/${endpoint}`);
    xhr.setRequestHeader("Authorization", `Bearer ${accessToken}`);
    xhr.setRequestHeader("Dropbox-API-Arg", JSON.stringify(apiArg));
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onBytes) onBytes(e.loaded);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        // append_v2 answers 200 with an empty body.
        resolve(xhr.responseText ? JSON.parse(xhr.responseText) : {});
      } else {
        const err = new Error(`Upload failed (${xhr.status}): ${xhr.responseText}`);
        err.status = xhr.status;
        err.body = xhr.responseText;
        reject(err);
      }
    };
    xhr.onerror = () => reject(new Error("Upload failed: network error"));
    xhr.send(body);
  });
}

// Retries dropped connections, 5xx and 429; gives up immediately on the
// 4xx answers that mean the request itself was wrong.
async function withRetry(send) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await send();
    } catch (err) {
      const fatal = err.status >= 400 && err.status < 500 && err.status !== 429;
      if (fatal || attempt >= CHUNK_ATTEMPTS) throw err;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

export function uploadFile(path, file, { onProgress, accessToken } = {}) {
  const commit = { path, mode: "add", autorename: true, mute: true };
  if (file.size > SINGLE_SHOT_MAX) return uploadSession(file, commit, onProgress);
  return withRetry(async () =>
    postContent({
      endpoint: "files/upload",
      accessToken: accessToken || (await getAccessToken()),
      apiArg: commit,
      body: file,
      onBytes: (n) => onProgress?.(Math.min(1, n / file.size)),
    })
  );
}

// Chunked upload for files past the single-call ceiling. The access token is
// re-read per chunk so an upload longer than the token's life still finishes.
async function uploadSession(file, commit, onProgress) {
  const total = file.size;
  const report = (sent) => onProgress?.(Math.min(1, sent / total));
  const chunkAt = (offset) => file.slice(offset, Math.min(offset + CHUNK_SIZE, total));

  const first = chunkAt(0);
  const { session_id } = await withRetry(async () =>
    postContent({
      endpoint: "files/upload_session/start",
      accessToken: await getAccessToken(),
      apiArg: { close: false },
      body: first,
      onBytes: report,
    })
  );

  let offset = first.size;
  report(offset);

  while (offset < total) {
    const at = offset;
    const chunk = chunkAt(at);
    try {
      await withRetry(async () =>
        postContent({
          endpoint: "files/upload_session/append_v2",
          accessToken: await getAccessToken(),
          apiArg: { cursor: { session_id, offset: at }, close: false },
          body: chunk,
          onBytes: (n) => report(at + n),
        })
      );
      offset = at + chunk.size;
    } catch (err) {
      // Dropbox rejects an out-of-step chunk with the offset it actually
      // wants — resync there rather than failing the whole upload.
      const wanted = /"correct_offset":\s*(\d+)/.exec(err.body || "");
      if (!wanted) throw err;
      offset = Number(wanted[1]);
    }
    report(offset);
  }

  return withRetry(async () =>
    postContent({
      endpoint: "files/upload_session/finish",
      accessToken: await getAccessToken(),
      apiArg: { cursor: { session_id, offset: total }, commit },
      body: new Blob(),
    })
  );
}

export async function listFolder(path) {
  let entries = [];
  try {
    let res = await rpc("files/list_folder", { path, recursive: false });
    entries = res.entries;
    while (res.has_more) {
      res = await rpc("files/list_folder/continue", { cursor: res.cursor });
      entries = entries.concat(res.entries);
    }
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
  return entries;
}

export async function deleteFile(path) {
  try {
    await rpc("files/delete_v2", { path });
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
}

// Direct, range-request-capable URL, valid ~4 hours.
export async function getTemporaryLink(path) {
  const res = await rpc("files/get_temporary_link", { path });
  return { url: res.link, expiresAt: Date.now() + 3.5 * 3600 * 1000 };
}

// Server-side copy — Dropbox moves the bytes on its own end, so an already-
// uploaded video attaching itself as another video's new version never
// passes back through the browser the way a fresh upload would.
// autorename guards the unlikely case of a genuine path collision, the same
// way every upload in this app already does.
export async function copyFile(fromPath, toPath) {
  const res = await rpc("files/copy_v2", { from_path: fromPath, to_path: toPath, autorename: true });
  return res.metadata;
}
