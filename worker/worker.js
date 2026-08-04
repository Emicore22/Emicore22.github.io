// Kontraframe worker — the only server-side piece of the platform.
// Lets anonymous reviewers (holding a share token) stream videos and post
// comments against the owner's Dropbox, without ever exposing Dropbox
// credentials to the browser.
//
// Secrets (set via `wrangler secret put`):
//   DROPBOX_APP_KEY, DROPBOX_APP_SECRET, DROPBOX_REFRESH_TOKEN, ADMIN_KEY
// Vars (wrangler.toml): ALLOWED_ORIGIN

// Must match STATUSES in js/versions.js.
const STATUSES = ["in_review", "needs_changes", "approved"];

const LIMITS = {
  BODY_BYTES: 64 * 1024,
  TEXT_CHARS: 2000,
  AUTHOR_CHARS: 60,
  SHAPES: 40,
  PEN_POINTS: 2000,
  WRITES_PER_MIN: 20,
};

// Per-isolate caches (best-effort; fine at this scale).
let dbxToken = { value: null, expiresAt: 0 };
let sharesCache = { data: null, fetchedAt: 0 };
const writeLog = new Map(); // token → [timestamps]

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    try {
      const res = await route(request, env);
      for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      return res;
    } catch (err) {
      const res = json({ error: err.expose ? err.message : "Internal error" }, err.status || 500);
      for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      return res;
    }
  },
};

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
  // Only a configured origin gets CORS approval; everyone else's browser
  // blocks the response. (Also allow no-Origin requests, e.g. curl, which
  // CORS doesn't protect against anyway — the share token is the real gate.)
  // Comma-separated so the app can live on more than one host — during a move,
  // or to keep older share links working.
  const allowed = String(env.ALLOWED_ORIGIN || "").split(",").map((o) => o.trim()).filter(Boolean);
  if (allowed.includes(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function fail(status, message, code) {
  const err = new Error(message);
  err.status = status;
  err.expose = true;
  err.code = code;
  return err;
}

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  // ── reviewer endpoints (share-token auth) ──
  //
  // A share names either one video or a whole folder. A folder token has no
  // fixed video — /api/session with no ?video= returns the folder's grid
  // instead of a player, and every other endpoint needs ?video=/{video} to
  // say which one. resolveShareVideo is the one place that turns "this
  // token plus whatever video the caller named" into a video that is
  // actually allowed: a video-scoped share always resolves to its own
  // video regardless of what's asked for, and a folder-scoped share must
  // load the project to confirm the requested video genuinely belongs to
  // that folder — otherwise this would be the one place a folder link
  // could be walked into the rest of the account.
  if (path === "/api/session" && request.method === "GET") {
    const share = await requireShare(env, url.searchParams.get("token"));
    const requestedVideo = url.searchParams.get("video");
    if (share.groupId && !requestedVideo) {
      return json(await buildFolderSession(env, share));
    }
    const videoId = await resolveShareVideo(env, share, requestedVideo);
    return json(await buildSession(env, share.projectId, videoId));
  }
  if (path === "/api/media" && request.method === "GET") {
    const share = await requireShare(env, url.searchParams.get("token"));
    const videoId = await resolveShareVideo(env, share, url.searchParams.get("video"));
    const version = Number(url.searchParams.get("version"));
    const project = await readProject(env, share.projectId);
    const video = project.videos.find((v) => v.id === videoId);
    if (!video) throw fail(404, "Video not found");
    return json(await mediaLinkForVideo(env, video, version));
  }
  if (path === "/api/comments" && request.method === "GET") {
    const share = await requireShare(env, url.searchParams.get("token"));
    const videoId = await resolveShareVideo(env, share, url.searchParams.get("video"));
    const doc = await readComments(env, share.projectId, videoId);
    return json({ comments: doc.comments });
  }
  if (path === "/api/comments" && request.method === "POST") {
    const body = await readBody(request);
    const share = await requireShare(env, body.token);
    rateLimit(share.token);
    const videoId = await resolveShareVideo(env, share, body.video);
    const comment = validateComment(body, { isOwner: false });
    await appendComment(env, share.projectId, videoId, comment);
    return json({ comment });
  }
  // Reviewers set the approval status — the whole point of sending them a
  // link. Scoped to whichever video their token (plus, for a folder share,
  // their ?video=) covers, and shares the comment rate limit so a token
  // can't hammer Dropbox.
  if (path === "/api/status" && request.method === "POST") {
    const body = await readBody(request);
    const share = await requireShare(env, body.token);
    rateLimit(share.token);
    const videoId = await resolveShareVideo(env, share, body.video);
    if (!STATUSES.includes(body.status)) throw fail(400, "Unknown status");
    await setVideoStatus(env, share.projectId, videoId, body.status);
    return json({ status: body.status });
  }

  // ── owner endpoints (ADMIN_KEY auth) ──
  if (path.startsWith("/admin/")) {
    requireAdmin(request, env);

    if (path === "/admin/comments" && request.method === "POST") {
      const body = await readBody(request);
      const { action, projectId, videoId } = body;
      if (!projectId || !videoId) throw fail(400, "projectId and videoId required");
      if (action === "add") {
        const comment = validateComment(body.comment || {}, { isOwner: true });
        await appendComment(env, projectId, videoId, comment);
        return json({ comment });
      }
      if (action === "resolve") {
        await mutateComments(env, projectId, videoId, (doc) => {
          const c = doc.comments.find((c) => c.id === body.commentId);
          if (c) c.resolved = !!body.resolved;
          return doc;
        });
        return json({ ok: true });
      }
      if (action === "delete") {
        await mutateComments(env, projectId, videoId, (doc) => {
          // Take the thread with the comment; replies left behind would be
          // invisible but still counted.
          doc.comments = doc.comments.filter(
            (c) => c.id !== body.commentId && c.parentId !== body.commentId
          );
          return doc;
        });
        return json({ ok: true });
      }
      throw fail(400, "Unknown action");
    }

    if (path === "/admin/shares" && request.method === "GET") {
      const doc = await readShares(env, true);
      return json({ shares: doc.shares });
    }
    if (path === "/admin/shares" && request.method === "POST") {
      const body = await readBody(request);
      if (!body.projectId) throw fail(400, "projectId required");
      if (!body.videoId && !body.groupId) throw fail(400, "videoId or groupId required");
      if (body.videoId && body.groupId) throw fail(400, "Provide videoId or groupId, not both");
      // 8 random bytes (64 bits) is already far past what a network-facing
      // bearer token needs against brute force — the win from spending more
      // of them on hex digits (4 bits each) instead of base62 (~5.95 bits
      // each) is a token nobody wants to paste into a Slack message.
      const token = "s-" + base62(crypto.getRandomValues(new Uint8Array(8)), 11);
      const share = {
        token,
        projectId: String(body.projectId),
        // Exactly one of these is set — that's what makes a share
        // video-scoped or folder-scoped everywhere else in this file.
        videoId: body.videoId ? String(body.videoId) : null,
        groupId: body.groupId ? String(body.groupId) : null,
        label: String(body.label || "").slice(0, 120),
        createdAt: new Date().toISOString(),
        expiresAt: body.expiresAt || new Date(Date.now() + 30 * 86400 * 1000).toISOString(),
        revoked: false,
      };
      await mutateJson(env, "/shares.json", (doc) => {
        doc.shares.push(share);
        return doc;
      }, () => ({ schema: 1, shares: [] }));
      sharesCache = { data: null, fetchedAt: 0 };
      return json({ token, share });
    }
    if (path === "/admin/shares/revoke" && request.method === "POST") {
      const body = await readBody(request);
      await mutateJson(env, "/shares.json", (doc) => {
        const s = doc.shares.find((s) => s.token === body.token);
        if (s) s.revoked = true;
        return doc;
      }, () => ({ schema: 1, shares: [] }));
      sharesCache = { data: null, fetchedAt: 0 };
      return json({ ok: true });
    }
  }

  throw fail(404, "Not found");
}

// ── auth helpers ────────────────────────────────────────────────────────────

function requireAdmin(request, env) {
  const header = request.headers.get("Authorization") || "";
  const key = header.replace(/^Bearer\s+/i, "");
  if (!env.ADMIN_KEY || !timingSafeEqual(key, env.ADMIN_KEY)) throw fail(401, "Invalid admin key");
}

function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

// Accepts both: the original 32-hex-char token (already-issued links keep
// working) and the shorter base62 one new links use.
const SHARE_TOKEN = /^s-([0-9a-f]{32}|[0-9A-Za-z]{11})$/;

async function requireShare(env, token) {
  if (!token || !SHARE_TOKEN.test(token)) throw fail(403, "Invalid link", "expired");
  const doc = await readShares(env);
  const share = doc.shares.find((s) => s.token === token);
  if (!share || share.revoked) throw fail(403, "This link is no longer active", "expired");
  if (share.expiresAt && Date.parse(share.expiresAt) < Date.now()) {
    throw fail(403, "This link has expired", "expired");
  }
  return share;
}

function rateLimit(token) {
  const now = Date.now();
  const log = (writeLog.get(token) || []).filter((t) => now - t < 60000);
  if (log.length >= LIMITS.WRITES_PER_MIN) throw fail(429, "Too many comments — slow down a little");
  log.push(now);
  writeLog.set(token, log);
}

async function readBody(request) {
  const text = await request.text();
  if (text.length > LIMITS.BODY_BYTES) throw fail(413, "Request too large");
  try {
    return JSON.parse(text);
  } catch {
    throw fail(400, "Invalid JSON");
  }
}

// ── comment validation ──────────────────────────────────────────────────────

const COMMENT_ID = /^c-[0-9a-f]{6,32}$/;

function validateComment(input, { isOwner }) {
  const text = String(input.text || "").slice(0, LIMITS.TEXT_CHARS).trim();
  // Replies are plain text hanging off a comment; drawings stay on the
  // top-level note they annotate.
  const parentId = input.parentId ? String(input.parentId) : null;
  if (parentId && !COMMENT_ID.test(parentId)) throw fail(400, "Invalid parent comment");
  const annotation = parentId ? null : validateAnnotation(input.annotation);
  if (!text && !annotation) throw fail(400, "Comment is empty");
  const timeSec = Number(input.timeSec);
  if (!Number.isFinite(timeSec) || timeSec < 0) throw fail(400, "Invalid timestamp");
  return {
    id: input.id && COMMENT_ID.test(input.id) ? input.id : "c-" + hex(crypto.getRandomValues(new Uint8Array(8))),
    version: Math.max(1, Math.floor(Number(input.version) || 1)),
    author: String(input.author || (isOwner ? "Owner" : "Reviewer")).slice(0, LIMITS.AUTHOR_CHARS),
    isOwner,
    timeSec,
    text,
    resolved: false,
    createdAt: new Date().toISOString(),
    annotation,
    parentId,
  };
}

function validateAnnotation(a) {
  if (!a || !Array.isArray(a.shapes) || !a.shapes.length) return null;
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const pair = (p) => [num(p?.[0]), num(p?.[1])];
  const color = (c) => (/^#[0-9a-fA-F]{3,8}$/.test(String(c)) ? String(c) : "#ff4757");
  const shapes = a.shapes.slice(0, LIMITS.SHAPES).map((s) => {
    const base = { color: color(s.color), width: Math.min(0.05, Math.abs(num(s.width)) || 0.004) };
    if (s.type === "pen" && Array.isArray(s.points)) {
      return { type: "pen", points: s.points.slice(0, LIMITS.PEN_POINTS).map(pair), ...base };
    }
    if (s.type === "arrow") return { type: "arrow", from: pair(s.from), to: pair(s.to), ...base };
    if (s.type === "rect") return { type: "rect", x: num(s.x), y: num(s.y), w: num(s.w), h: num(s.h), ...base };
    return null;
  }).filter(Boolean);
  return shapes.length ? { shapes } : null;
}

// ── Dropbox plumbing ────────────────────────────────────────────────────────

async function dropboxToken(env) {
  if (dbxToken.value && Date.now() < dbxToken.expiresAt) return dbxToken.value;
  const res = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: env.DROPBOX_REFRESH_TOKEN,
      client_id: env.DROPBOX_APP_KEY,
      client_secret: env.DROPBOX_APP_SECRET,
    }),
  });
  if (!res.ok) throw new Error(`Dropbox token refresh failed (${res.status})`);
  const data = await res.json();
  dbxToken = { value: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
  return dbxToken.value;
}

async function dbx(env, url, options, retried = false) {
  const token = await dropboxToken(env);
  const res = await fetch(url, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` },
  });
  if (res.status === 401 && !retried) {
    dbxToken = { value: null, expiresAt: 0 };
    return dbx(env, url, options, true);
  }
  return res;
}

// Returns {data, rev} or null.
async function downloadJson(env, path) {
  const res = await dbx(env, "https://content.dropboxapi.com/2/files/download", {
    method: "POST",
    headers: { "Dropbox-API-Arg": JSON.stringify({ path }) },
  });
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 409 && text.includes("not_found")) return null;
    throw new Error(`Dropbox download ${path} failed (${res.status})`);
  }
  const meta = JSON.parse(res.headers.get("Dropbox-API-Result") || "{}");
  return { data: await res.json(), rev: meta.rev };
}

async function uploadJson(env, path, data, rev) {
  const mode = rev ? { ".tag": "update", update: rev } : "overwrite";
  const res = await dbx(env, "https://content.dropboxapi.com/2/files/upload", {
    method: "POST",
    headers: {
      "Dropbox-API-Arg": JSON.stringify({ path, mode, autorename: false, mute: true }),
      "Content-Type": "application/octet-stream",
    },
    body: JSON.stringify(data, null, 2),
  });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Dropbox upload ${path} failed (${res.status})`);
    err.conflict = res.status === 409 && text.includes("conflict");
    throw err;
  }
}

// CAS read-modify-write with retry — the concurrency primitive for all
// shared JSON files.
async function mutateJson(env, path, mutate, initial) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const existing = await downloadJson(env, path);
    const doc = mutate(existing ? existing.data : initial());
    try {
      await uploadJson(env, path, doc, existing?.rev);
      return doc;
    } catch (err) {
      if (!err.conflict || attempt === 3) throw err;
    }
  }
}

// ── domain reads/writes ─────────────────────────────────────────────────────

async function readShares(env, fresh = false) {
  if (!fresh && sharesCache.data && Date.now() - sharesCache.fetchedAt < 60000) return sharesCache.data;
  const res = await downloadJson(env, "/shares.json");
  const doc = res?.data || { schema: 1, shares: [] };
  sharesCache = { data: doc, fetchedAt: Date.now() };
  return doc;
}

const commentsPath = (pid, vid) => `/projects/${pid}/comments/${vid}.json`;

async function readComments(env, pid, vid) {
  const res = await downloadJson(env, commentsPath(pid, vid));
  return res?.data || { schema: 1, videoId: vid, comments: [] };
}

function mutateComments(env, pid, vid, mutate) {
  return mutateJson(env, commentsPath(pid, vid), mutate, () => ({ schema: 1, videoId: vid, comments: [] }));
}

function appendComment(env, pid, vid, comment) {
  return mutateComments(env, pid, vid, (doc) => {
    if (comment.parentId) {
      const parent = doc.comments.find((c) => c.id === comment.parentId);
      if (!parent) throw fail(404, "The comment being replied to no longer exists");
      // Threads stay one level deep: a reply to a reply joins the same thread.
      if (parent.parentId) comment.parentId = parent.parentId;
      // Keep the reply pinned where the thread is, so version filters and
      // timeline ordering treat it as part of that note.
      comment.timeSec = parent.timeSec;
      comment.version = parent.version;
    }
    doc.comments.push(comment);
    return doc;
  });
}

// Compare-and-swap against project.json so a reviewer's status change can't
// clobber a concurrent edit by the owner.
async function setVideoStatus(env, pid, vid, status) {
  let found = false;
  await mutateJson(env, `/projects/${pid}/project.json`, (project) => {
    const video = project.videos.find((v) => v.id === vid);
    if (video) {
      video.status = status;
      found = true;
    }
    return project;
  }, () => {
    throw fail(404, "Project not found");
  });
  if (!found) throw fail(404, "Video not found");
}

async function readProject(env, pid) {
  const res = await downloadJson(env, `/projects/${pid}/project.json`);
  if (!res) throw fail(404, "Project not found");
  return res.data;
}

// Given a video already resolved (and, for a folder share, already checked
// against the token's group), gets a link for one of its versions.
async function mediaLinkForVideo(env, video, versionN) {
  const version = video.versions.find((v) => v.n === versionN) || video.versions.at(-1);
  if (!version) throw fail(404, "No media uploaded yet");
  const res = await dbx(env, "https://api.dropboxapi.com/2/files/get_temporary_link", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: version.path }),
  });
  if (!res.ok) throw new Error(`get_temporary_link failed (${res.status})`);
  const data = await res.json();
  return { mediaUrl: data.link, mediaExpiresAt: Date.now() + 3.5 * 3600 * 1000, version: version.n };
}

// The one gate a folder share's ?video= param passes through. A video-scoped
// share ignores whatever was asked for and always resolves to its own video —
// there is nothing else it could mean. A folder-scoped share has no fixed
// video, so the caller must name one, and it has to actually carry that
// share's groupId in the real project data: without this check a folder
// link's token would work as a skeleton key for every video anywhere in the
// account, not just the ones the folder it named actually contains.
async function resolveShareVideo(env, share, requestedVideoId) {
  if (share.videoId) return share.videoId;
  if (!requestedVideoId) throw fail(400, "video required");
  const project = await readProject(env, share.projectId);
  const video = project.videos.find((v) => v.id === requestedVideoId);
  if (!video || video.groupId !== share.groupId) throw fail(403, "That video isn't part of this share");
  return requestedVideoId;
}

async function buildSession(env, projectId, videoId) {
  const project = await readProject(env, projectId);
  const video = project.videos.find((v) => v.id === videoId);
  if (!video) throw fail(404, "Video not found");
  const media = await mediaLinkForVideo(env, video, video.currentVersion);
  const commentsDoc = await readComments(env, projectId, videoId);
  return {
    project: { id: project.id, name: project.name },
    video: {
      id: video.id,
      name: video.name,
      fps: video.fps,
      status: video.status,
      currentVersion: video.currentVersion,
      // Media paths are intentionally stripped — reviewers never see them.
      versions: video.versions.map((v) => ({ n: v.n, label: v.label || "" })),
    },
    comments: commentsDoc.comments,
    mediaUrl: media.mediaUrl,
    mediaExpiresAt: media.mediaExpiresAt,
  };
}

// The grid a folder link opens to: every video in the folder, none of the
// per-video detail (comments, a media link) that only the video the reviewer
// actually picks needs to pay for.
async function buildFolderSession(env, share) {
  const project = await readProject(env, share.projectId);
  const group = (project.groups || []).find((g) => g.id === share.groupId);
  if (!group) throw fail(404, "Folder not found");
  const videos = project.videos.filter((v) => v.groupId === share.groupId);
  return {
    project: { id: project.id, name: project.name },
    group: { id: group.id, name: group.name },
    videos: videos.map((v) => ({
      id: v.id,
      name: v.name,
      fps: v.fps,
      status: v.status,
      currentVersion: v.currentVersion,
      versions: v.versions.map((ver) => ({ n: ver.n, label: ver.label || "" })),
    })),
  };
}

function hex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Random bytes as fixed-length base62 — denser than hex (~5.95 bits/char vs
// 4), so a token needs noticeably fewer characters for the same entropy.
// Treats the whole byte string as one big integer and repeatedly divides it
// down rather than mapping each byte to a digit on its own, which would bias
// some digits over others (256 isn't a multiple of 62). Left-padded with the
// alphabet's own "0" so every token this produces is exactly `length` long —
// otherwise a value with leading zero bits would come out shorter, and a
// short token isn't the same string as its zero-padded self.
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
function base62(bytes, length) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = BASE62[Number(n % 62n)] + out;
    n /= 62n;
  }
  return out.padStart(length, "0");
}
