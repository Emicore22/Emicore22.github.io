// ─── Kontraframe configuration ──────────────────────────────────────────────
// This is the only file you need to edit during setup (see setup/SETUP.md).

export const CONFIG = {
  // From the Dropbox App Console (https://www.dropbox.com/developers/apps).
  // The app key is public by design — safe to commit.
  DROPBOX_APP_KEY: "6agpqa1h9ouo95e",

  // Your deployed Cloudflare Worker URL, no trailing slash.
  // Leave empty until you complete the worker setup — the owner app works
  // without it (comments are then written straight to Dropbox), but share
  // links for clients require it.
  WORKER_URL: "https://kontraframe.kontraframe.workers.dev",

  // Shown in the header and page titles.
  APP_NAME: "Kontraframe",

  // Default frame rate for new videos (editable per video).
  DEFAULT_FPS: 25,
};
