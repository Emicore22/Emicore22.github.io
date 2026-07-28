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
  async fetch(request, env, ctx) {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    try {
      const res = await route(request, env, ctx);
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
  // Only the configured origin gets CORS approval; everyone else's browser
  // blocks the response. (Also allow no-Origin requests, e.g. curl, which
  // CORS doesn't protect against anyway — the share token is the real gate.)
  if (origin === env.ALLOWED_ORIGIN) headers["Access-Control-Allow-Origin"] = origin;
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

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;

  // ── reviewer endpoints (share-token auth) ──
  if (path === "/api/session" && request.method === "GET") {
    const share = await requireShare(env, url.searchParams.get("token"));
    return json(await buildSession(env, share));
  }
  if (path === "/api/media" && request.method === "GET") {
    const share = await requireShare(env, url.searchParams.get("token"));
    const version = Number(url.searchParams.get("version"));
    return json(await mediaLink(env, share, version));
  }
  if (path === "/api/comments" && request.method === "GET") {
    const share = await requireShare(env, url.searchParams.get("token"));
    const doc = await readComments(env, share.projectId, share.videoId);
    return json({ comments: stripEmails(doc.comments) });
  }
  if (path === "/api/comments" && request.method === "POST") {
    const body = await readBody(request);
    const share = await requireShare(env, body.token);
    rateLimit(share.token);
    const comment = validateComment(body, { isOwner: false });
    await appendComment(env, share.projectId, share.videoId, comment);
    queueNotification(ctx, env, { projectId: share.projectId, videoId: share.videoId, comment });
    return json({ comment: stripEmails([comment])[0] });
  }
  // Reviewers set the approval status — the whole point of sending them a
  // link. Scoped to the one video their token covers, and shares the comment
  // rate limit so a token can't hammer Dropbox.
  if (path === "/api/status" && request.method === "POST") {
    const body = await readBody(request);
    const share = await requireShare(env, body.token);
    rateLimit(share.token);
    if (!STATUSES.includes(body.status)) throw fail(400, "Unknown status");
    await setVideoStatus(env, share.projectId, share.videoId, body.status);
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
        queueNotification(ctx, env, { projectId, videoId, comment });
        return json({ comment: stripEmails([comment])[0] });
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
      if (!body.projectId || !body.videoId) throw fail(400, "projectId and videoId required");
      const token = "s-" + hex(crypto.getRandomValues(new Uint8Array(16)));
      const share = {
        token,
        projectId: String(body.projectId),
        videoId: String(body.videoId),
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

async function requireShare(env, token) {
  if (!token || !/^s-[0-9a-f]{32}$/.test(token)) throw fail(403, "Invalid link", "expired");
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
    // Kept server-side only, so replies can reach the person who wrote this.
    authorEmail: validEmail(input.authorEmail) ? String(input.authorEmail).trim().toLowerCase() : null,
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

async function mediaLink(env, share, versionN) {
  const project = await readProject(env, share.projectId);
  const video = project.videos.find((v) => v.id === share.videoId);
  if (!video) throw fail(404, "Video not found");
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

async function buildSession(env, share) {
  const project = await readProject(env, share.projectId);
  const video = project.videos.find((v) => v.id === share.videoId);
  if (!video) throw fail(404, "Video not found");
  const media = await mediaLink(env, share, video.currentVersion);
  const commentsDoc = await readComments(env, share.projectId, share.videoId);
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
    comments: stripEmails(commentsDoc.comments),
    mediaUrl: media.mediaUrl,
    mediaExpiresAt: media.mediaExpiresAt,
  };
}

function hex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── email notifications ─────────────────────────────────────────────────────
// Entirely optional: with no provider configured every path below no-ops, so
// commenting keeps working exactly as before. Sending is also never awaited by
// the request — a bounced email must not fail someone's comment.

let settingsCache = { data: null, fetchedAt: 0 };

// The owner's notification address lives in the same settings.json the app
// writes for the admin key, so there is no extra secret to keep in sync.
async function readSettings(env) {
  if (settingsCache.data && Date.now() - settingsCache.fetchedAt < 300000) return settingsCache.data;
  let data = {};
  try {
    const res = await downloadJson(env, "/settings.json");
    data = res?.data || {};
  } catch {
    data = {};
  }
  settingsCache = { data, fetchedAt: Date.now() };
  return data;
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const validEmail = (e) => typeof e === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim()) && e.length <= 254;

function timecode(seconds, fps) {
  const f = Math.round(Number(seconds) * fps);
  const rate = Math.round(fps) || 25;
  const ff = f % rate;
  const total = Math.floor(f / rate);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}:${pad(ff)}`;
}

// Swap this one function to change provider; everything else is generic.
async function sendEmail(env, { to, subject, html, text }) {
  if (!env.RESEND_API_KEY || !env.NOTIFY_FROM) return;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.NOTIFY_FROM, to, subject, html, text }),
  });
  if (!res.ok) throw new Error(`Email send failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
}

// A reviewer's note emails the owner; the owner's note emails everyone who has
// taken part on that video. Never the person who just wrote it.
async function notifyComment(env, { projectId, videoId, comment }) {
  if (!env.RESEND_API_KEY || !env.NOTIFY_FROM) return;

  const settings = await readSettings(env);
  const ownerEmail = settings.notifyEmail || "";
  const doc = await readComments(env, projectId, videoId);
  const project = await readProject(env, projectId).catch(() => null);
  const video = project?.videos?.find((v) => v.id === videoId);
  const site = (env.SITE_URL || "").replace(/\/$/, "");

  let recipients = [];
  let link = "";
  if (comment.isOwner) {
    // Everyone who commented as a reviewer, deduped, minus the author.
    const seen = new Set();
    for (const c of doc.comments) {
      const addr = (c.authorEmail || "").trim().toLowerCase();
      if (c.isOwner || !validEmail(addr) || seen.has(addr)) continue;
      seen.add(addr);
      recipients.push(addr);
    }
    // Reviewers can only get back in through a share link.
    const shares = (await readShares(env, true)).shares.filter(
      (s) => s.videoId === videoId && !s.revoked && (!s.expiresAt || Date.parse(s.expiresAt) > Date.now())
    );
    if (shares.length && site) link = `${site}/review.html?token=${shares[0].token}`;
  } else {
    if (validEmail(ownerEmail)) recipients = [ownerEmail.trim()];
    if (site) link = `${site}/#/p/${projectId}/v/${videoId}`;
  }
  if (!recipients.length) return;

  const who = comment.author || (comment.isOwner ? "The owner" : "A reviewer");
  const what = comment.parentId ? "replied on" : "commented on";
  const name = video?.name || "a video";
  const at = timecode(comment.timeSec, video?.fps || 25);
  const body = comment.text || "(drawing only)";

  const html = `
    <div style="font-family:system-ui,-apple-system,sans-serif;font-size:15px;line-height:1.55;color:#16181e">
      <p style="margin:0 0 14px"><strong>${escapeHtml(who)}</strong> ${what} <strong>${escapeHtml(name)}</strong>${
        project?.name ? ` in ${escapeHtml(project.name)}` : ""
      }.</p>
      <blockquote style="margin:0 0 16px;padding:10px 14px;border-left:3px solid #6b93ff;background:#f5f7fb">
        <div style="font:12px ui-monospace,monospace;color:#6b93ff;margin-bottom:4px">${at}</div>
        ${escapeHtml(body).replace(/\n/g, "<br>")}
      </blockquote>
      ${link ? `<p style="margin:0"><a href="${escapeHtml(link)}" style="color:#3355cc">Open the review</a></p>` : ""}
    </div>`;
  const text = `${who} ${what} ${name}.\n\n[${at}] ${body}\n${link ? `\n${link}\n` : ""}`;

  await sendEmail(env, {
    to: recipients,
    subject: `${who} ${comment.parentId ? "replied on" : "commented on"} ${name}`,
    html,
    text,
  });
}

// Fire-and-forget: keeps the comment response fast and swallows email trouble.
function queueNotification(ctx, env, payload) {
  const job = notifyComment(env, payload).catch((err) => console.log("notify failed:", err.message));
  if (ctx?.waitUntil) ctx.waitUntil(job);
}

// Reviewers must never receive each other's addresses.
const stripEmails = (comments) => comments.map(({ authorEmail, ...rest }) => rest);
