# Kontraframe — one-time setup

Everything below is done once. Total time: ~20 minutes. Nothing costs money.

There are two halves:

- **Steps 1–3** get the owner app working (browse, upload, play, comment — just you).
- **Steps 4–6** add client share links (needs the free Cloudflare Worker).

You can stop after step 3 and do the rest later.

---

## 1. Create your Dropbox app

1. Go to https://www.dropbox.com/developers/apps → **Create app**.
2. Choose **Scoped access** → **App folder** → name it `kontraframe`
   (the name becomes your folder: `Dropbox/Apps/kontraframe/`).
3. **Permissions** tab — tick these, then Submit:
   - `files.metadata.read`
   - `files.content.read`
   - `files.content.write`
4. **Settings** tab — under *OAuth 2 → Redirect URIs*, add **all of these**
   (exact match matters — the login redirects back to whichever URL you're on):
   - `https://emicore22.github.io/`
   - `https://emicore22.github.io/index.html`
   - `https://emicore22.github.io/setup/get-refresh-token.html`
   - `http://localhost:8000/` (for local testing, optional)
5. Copy the **App key** (shown on the Settings tab).

> Permissions must be submitted **before** you log in — tokens issued earlier
> won't have them.

## 2. Configure the app

Edit `js/config.js` and paste your App key into `DROPBOX_APP_KEY`.
Commit and push. GitHub Pages serves the site at https://emicore22.github.io.

## 3. First login

Open https://emicore22.github.io → **Connect Dropbox** → approve.
Create a project and upload a small MP4 to confirm playback works.

> **Export rule:** browsers can only play what you upload as-is. Always export
> **H.264 MP4 with AAC audio** for review. ProRes and HEVC will not play.

That's the personal tool done. The rest enables client share links.

---

## 4. Get a refresh token for the worker

The worker needs long-lived, server-side access to your Dropbox.

1. Open https://emicore22.github.io/setup/get-refresh-token.html
2. Paste your App key → **Authorize with Dropbox** → approve.
3. Copy the refresh token it shows. Keep it secret — treat it like a password.

## 5. Deploy the Cloudflare Worker

Follow `worker/README.md`. Short version:

```sh
npm install -g wrangler
cd worker
wrangler login
wrangler deploy                              # note the printed URL
wrangler secret put DROPBOX_APP_KEY          # from step 1
wrangler secret put DROPBOX_APP_SECRET       # Dropbox App Console → Settings → App secret → Show
wrangler secret put DROPBOX_REFRESH_TOKEN    # from step 4
wrangler secret put ADMIN_KEY                # invent a long random password; save it
```

If your GitHub Pages address is not `https://emicore22.github.io`, also update
`ALLOWED_ORIGIN` in `worker/wrangler.toml` before deploying.

## 6. Wire it together

1. Paste the worker URL into `js/config.js` → `WORKER_URL` (no trailing slash).
   Commit, push.
2. In the owner app, open **Settings** (top right) and paste your ADMIN_KEY.

## 7. Smoke test

1. Open a video → **Share** → create a link → copy it.
2. Open the link in a private/incognito window: the video should play with no
   login, and posting a comment should appear in your owner app within ~30 s.

---

## Troubleshooting

- **OAuth error page at Dropbox** — the redirect URI doesn't exactly match one
  registered in the App Console (check trailing slashes and `index.html`).
- **Video won't play** — almost always the codec. Re-export as H.264 MP4 + AAC.
- **"Link expired" for a fresh link** — check the worker secrets are all set
  (`wrangler secret list`) and that `WORKER_URL` in `js/config.js` is correct.
- **Share button says worker not configured** — `WORKER_URL` is empty in
  `js/config.js`, or you haven't saved the ADMIN_KEY in Settings.
- **Upload fails at exactly 150 MB** — that's the in-app limit. Drop the file
  into `Dropbox/Apps/kontraframe/projects/<project>/media/<video-id>/` named
  `v2-something.mp4`, then use **Rescan folder**.
