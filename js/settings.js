// Owner settings that follow the Dropbox account instead of the browser.
//
// The admin key used to live only in localStorage, so a browser that cleared
// its storage — Safari drops it after about a week of not visiting — or simply
// a second machine meant typing the key in again. It now lives in the app's
// own Dropbox folder, the one thing the owner is always signed in to, with
// localStorage kept as the local cache that every read still goes through.
//
// Once the file exists Dropbox is the source of truth, so clearing the key on
// one machine clears it everywhere rather than being undone by the next sync.

import * as dbx from "./dropbox.js";
import * as api from "./worker-api.js";

const SETTINGS_PATH = "/settings.json";

// Called on boot: brings this browser in line with the account.
export async function pullAdminKey() {
  const res = await dbx.downloadJson(SETTINGS_PATH);
  if (!res) {
    // Never configured. Promote a key already typed on this device so the
    // upgrade costs the owner nothing.
    const local = api.getAdminKey();
    if (local) await pushAdminKey(local);
    return api.getAdminKey();
  }
  notifyEmail = res.data?.notifyEmail ?? "";
  const remote = res.data?.adminKey ?? "";
  if (remote !== api.getAdminKey()) api.setAdminKey(remote);
  return remote;
}

// Stores locally first so the app keeps working even if Dropbox write fails.
export async function pushAdminKey(key) {
  api.setAdminKey(key);
  await dbx.updateJson(
    SETTINGS_PATH,
    (data) => ({ ...data, adminKey: key, updatedAt: new Date().toISOString() }),
    () => ({ schema: 1, adminKey: key })
  );
}

// Where the worker emails the owner when a reviewer comments. Read from the
// same file, and read by the worker itself — the browser only edits it.
let notifyEmail = "";

export function getNotifyEmail() {
  return notifyEmail;
}

export async function pushNotifyEmail(email) {
  notifyEmail = email;
  await dbx.updateJson(
    SETTINGS_PATH,
    (data) => ({ ...data, notifyEmail: email, updatedAt: new Date().toISOString() }),
    () => ({ schema: 1, notifyEmail: email })
  );
}
