// Fetch client for the Cloudflare Worker (worker/worker.js).
// Reviewer endpoints authenticate with a share token; admin endpoints with
// the ADMIN_KEY the owner enters once in Settings (stored in localStorage).

import { CONFIG } from "./config.js";

const ADMIN_KEY_STORAGE = "kf_admin_key";

export function getAdminKey() {
  return localStorage.getItem(ADMIN_KEY_STORAGE) || "";
}

export function setAdminKey(key) {
  if (key) localStorage.setItem(ADMIN_KEY_STORAGE, key);
  else localStorage.removeItem(ADMIN_KEY_STORAGE);
}

export function workerConfigured() {
  return !!CONFIG.WORKER_URL;
}

export function adminConfigured() {
  return workerConfigured() && !!getAdminKey();
}

async function request(path, { method = "GET", body, admin = false } = {}) {
  if (!CONFIG.WORKER_URL) throw new Error("Worker URL not configured (js/config.js)");
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  if (admin) headers["Authorization"] = `Bearer ${getAdminKey()}`;
  const res = await fetch(`${CONFIG.WORKER_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Worker request failed (${res.status})`);
    err.status = res.status;
    err.code = data.code;
    throw err;
  }
  return data;
}

// ── Reviewer (share-token) endpoints ────────────────────────────────────────

export function getSession(token) {
  return request(`/api/session?token=${encodeURIComponent(token)}`);
}

export function getMedia(token, version) {
  return request(`/api/media?token=${encodeURIComponent(token)}&version=${version}`);
}

export function getComments(token) {
  return request(`/api/comments?token=${encodeURIComponent(token)}`);
}

export function postComment(token, comment) {
  return request("/api/comments", { method: "POST", body: { token, ...comment } });
}

// ── Owner (admin) endpoints ─────────────────────────────────────────────────

export function adminComment(payload) {
  // payload: {action: "add"|"resolve"|"delete", projectId, videoId, ...}
  return request("/admin/comments", { method: "POST", body: payload, admin: true });
}

export function createShare({ projectId, videoId, label, expiresAt }) {
  return request("/admin/shares", {
    method: "POST",
    body: { projectId, videoId, label, expiresAt },
    admin: true,
  });
}

export function listShares() {
  return request("/admin/shares", { admin: true });
}

export function revokeShare(token) {
  return request("/admin/shares/revoke", { method: "POST", body: { token }, admin: true });
}
