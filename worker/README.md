# Kontraframe worker

This is the only server-side piece of Kontraframe. It runs on Cloudflare
Workers (free tier) and lets clients with a share link stream videos and post
comments **without** ever seeing your Dropbox credentials.

GitHub Pages does not run this — it must be deployed to Cloudflare once.

## Deploy (one time, ~10 minutes)

1. Create a free account at https://dash.cloudflare.com/sign-up (no card needed).
2. Install Node.js if you don't have it (https://nodejs.org), then in a terminal:

   ```sh
   npm install -g wrangler
   cd worker
   wrangler login          # opens the browser to authorize
   wrangler deploy         # prints your worker URL, e.g. https://kontraframe.<you>.workers.dev
   ```

3. Set the four secrets (each command prompts you to paste the value):

   ```sh
   wrangler secret put DROPBOX_APP_KEY        # from the Dropbox App Console
   wrangler secret put DROPBOX_APP_SECRET     # from the Dropbox App Console ("Show" next to App secret)
   wrangler secret put DROPBOX_REFRESH_TOKEN  # from setup/get-refresh-token.html — see SETUP.md step 4
   wrangler secret put ADMIN_KEY              # invent a long random password and save it
   ```

4. Paste the worker URL into `js/config.js` → `WORKER_URL`, commit, push.
5. In the owner app, open **Settings** and paste the same ADMIN_KEY once.

## Updating

Edit `worker.js`, then run `wrangler deploy` again from this folder.

## What it exposes

- `GET /api/session|media|comments` + `POST /api/comments` — require a valid,
  unexpired, unrevoked share token; reviewers never receive Dropbox paths or
  tokens, only short-lived streaming URLs.
- `POST/GET /admin/…` — require the ADMIN_KEY; used by your owner app to
  create/revoke share links and manage comments.

Comment writes are validated (size caps), rate-limited, and written with
Dropbox rev-conditional uploads (compare-and-swap with retry), so concurrent
reviewers can't clobber each other's comments.
