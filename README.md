# Kontraframe

A personal, self-hosted video review platform in the spirit of Frame.io —
built for motion design work, with **zero hosting costs**:

- **GitHub Pages** serves the app (this repo — plain HTML/CSS/JS, no build step).
- **Your Dropbox** stores everything: videos, comments, projects, share links.
- **One free Cloudflare Worker** lets clients review via a share link, no
  account needed.

## Features

- 🎞 **Frame-accurate player** — step frame-by-frame (`←`/`→`), true
  `HH:MM:SS:FF` timecode, per-video frame rate
- 💬 **Timestamped comments** — pinned to the exact frame; click a comment to
  jump there
- ✏️ **Drawing annotations** — pen, arrow, and box directly on a paused frame,
  attached to comments, resolution-independent
- 🔗 **Client share links** — send a link; clients watch and comment without
  signing up. Links expire and can be revoked
- 📚 **Version stacking** — v1/v2/v3 per shot with a version switcher; comments
  are badged and filterable by version
- ✅ **Approval status** — In Review / Needs Changes / Approved per video,
  resolve/unresolve per comment

## Keyboard shortcuts

| Key | Action |
|---|---|
| `Space` | Play / pause |
| `←` / `→` | Step one frame |
| `Shift` + `←`/`→` | Jump 1 second |
| `J` / `K` / `L` | Back 10 s / pause / play (2× on second press) |
| `C` | Focus the comment box |
| `Esc` | Cancel drawing |

## Getting started

See **[setup/SETUP.md](setup/SETUP.md)** — one-time setup (~20 min):
Dropbox app → app key in `js/config.js` → optional Cloudflare Worker for
share links (see `worker/README.md`).

## Important workflow note

Dropbox streams your files **as uploaded** — always export review copies as
**H.264 MP4 with AAC audio**. ProRes and HEVC won't play in browsers.
Timecode is non-drop-frame; at 29.97/23.976 the frame counter may differ from
your NLE's drop-frame display.

## Repo map

```
index.html      owner app        review.html   client review page
js/             all app modules  css/app.css   theme (edit :root tokens to restyle)
worker/         Cloudflare Worker (deployed separately, see worker/README.md)
setup/          one-time setup guide + refresh-token helper page
bioluma/        Bioluma — a separate app, see below
```

## Also in this repo

**[Bioluma](bioluma/)** — a generative motion tool where sea creatures drive
the visuals: octopuses, shoals, jellyfish and plankton painting colour blooms
and hairline trails on paper. Rich palettes, everything tweakable, PNG and video
export. Shares nothing with Kontraframe but the host: open `bioluma/index.html`
or visit `/bioluma`.

## Local development

```sh
python3 -m http.server 8000
# open http://localhost:8000 (add the localhost redirect URI in Dropbox first)
```
