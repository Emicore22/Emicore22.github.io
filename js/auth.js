// Dropbox OAuth 2 PKCE flow + token lifecycle for the owner app.
// Tokens live in localStorage; refresh happens transparently in dbxFetch().

import { CONFIG } from "./config.js";

const TOKENS_KEY = "kf_tokens";
const VERIFIER_KEY = "kf_pkce_verifier";
const AUTH_URL = "https://www.dropbox.com/oauth2/authorize";
const TOKEN_URL = "https://api.dropboxapi.com/oauth2/token";

function b64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function redirectUri() {
  // Same file, same origin — works on GitHub Pages and localhost alike.
  return location.origin + location.pathname;
}

function loadTokens() {
  try {
    return JSON.parse(localStorage.getItem(TOKENS_KEY)) || null;
  } catch {
    return null;
  }
}

function saveTokens(t) {
  localStorage.setItem(TOKENS_KEY, JSON.stringify(t));
}

export function isAuthed() {
  const t = loadTokens();
  return !!(t && t.refresh_token);
}

// Kick off the PKCE dance (full-page redirect to Dropbox).
export async function connect() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = b64url(digest);

  const params = new URLSearchParams({
    client_id: CONFIG.DROPBOX_APP_KEY,
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    token_access_type: "offline",
    redirect_uri: redirectUri(),
  });
  location.href = `${AUTH_URL}?${params}`;
}

// Call on page load; completes the flow if we just returned from Dropbox.
// Returns true if a code exchange happened.
export async function handleRedirect() {
  const params = new URLSearchParams(location.search);
  const code = params.get("code");
  if (!code) return false;

  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  sessionStorage.removeItem(VERIFIER_KEY);
  // Clean the URL either way so a stale ?code doesn't linger.
  history.replaceState(null, "", location.pathname + location.hash);
  if (!verifier) return false;

  const body = new URLSearchParams({
    code,
    grant_type: "authorization_code",
    code_verifier: verifier,
    client_id: CONFIG.DROPBOX_APP_KEY,
    redirect_uri: redirectUri(),
  });
  const res = await fetch(TOKEN_URL, { method: "POST", body });
  if (!res.ok) throw new Error(`Dropbox token exchange failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  saveTokens({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + (data.expires_in - 60) * 1000,
  });
  return true;
}

async function refreshAccessToken() {
  const t = loadTokens();
  if (!t?.refresh_token) throw new Error("Not connected to Dropbox");
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: t.refresh_token,
    client_id: CONFIG.DROPBOX_APP_KEY,
  });
  const res = await fetch(TOKEN_URL, { method: "POST", body });
  if (!res.ok) {
    if (res.status === 400 || res.status === 401) {
      // Refresh token revoked/invalid — force a fresh login.
      localStorage.removeItem(TOKENS_KEY);
      throw new Error("Dropbox session expired — please reconnect.");
    }
    throw new Error(`Dropbox token refresh failed (${res.status})`);
  }
  const data = await res.json();
  const next = { ...t, access_token: data.access_token, expires_at: Date.now() + (data.expires_in - 60) * 1000 };
  saveTokens(next);
  return next.access_token;
}

export async function getAccessToken() {
  const t = loadTokens();
  if (!t?.refresh_token) throw new Error("Not connected to Dropbox");
  if (t.access_token && Date.now() < t.expires_at) return t.access_token;
  return refreshAccessToken();
}

// Authenticated fetch against Dropbox. Refreshes + retries once on 401,
// honors Retry-After once on 429.
export async function dbxFetch(url, options = {}, _retried = false) {
  const token = await getAccessToken();
  const res = await fetch(url, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` },
  });
  if (res.status === 401 && !_retried) {
    await refreshAccessToken();
    return dbxFetch(url, options, true);
  }
  if (res.status === 429 && !_retried) {
    const wait = Number(res.headers.get("Retry-After") || 2);
    await new Promise((r) => setTimeout(r, wait * 1000));
    return dbxFetch(url, options, true);
  }
  return res;
}

export async function disconnect() {
  try {
    await dbxFetch("https://api.dropboxapi.com/2/auth/token/revoke", { method: "POST" });
  } catch {
    // Best effort — clear local state regardless.
  }
  localStorage.removeItem(TOKENS_KEY);
}
