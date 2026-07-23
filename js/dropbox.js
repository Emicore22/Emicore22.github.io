// Thin Dropbox API v2 client (owner mode — direct from the browser).
// Paths are relative to the app folder root ("" = root, "/foo/bar.json").

import { dbxFetch } from "./auth.js";

const API = "https://api.dropboxapi.com/2";
const CONTENT = "https://content.dropboxapi.com/2";

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

// Single-call upload (Dropbox caps this at 150 MB). XHR for upload progress.
export function uploadFile(path, file, { onProgress, accessToken } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${CONTENT}/files/upload`);
    xhr.setRequestHeader("Authorization", `Bearer ${accessToken}`);
    xhr.setRequestHeader(
      "Dropbox-API-Arg",
      JSON.stringify({ path, mode: "add", autorename: true, mute: true })
    );
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(JSON.parse(xhr.responseText));
      else reject(new Error(`Upload failed (${xhr.status}): ${xhr.responseText}`));
    };
    xhr.onerror = () => reject(new Error("Upload failed: network error"));
    xhr.send(file);
  });
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
