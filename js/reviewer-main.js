// Entry point for review.html — the client-facing reviewer page.
// Opened as review.html?token=s-… ; talks only to the Cloudflare Worker.
//
// A token names either one video or a whole folder. A video-scoped token's
// session comes back with a `video`, and the reviewer lands straight in the
// player, exactly as this page has always worked. A folder-scoped token's
// session comes back with `videos` instead — a grid, so the reviewer picks
// where to start rather than being dropped into whichever one happened to
// be first.

import { CONFIG } from "./config.js";
import { el, modal, spinner } from "./ui.js";
import * as api from "./worker-api.js";
import { reviewerStore } from "./store.js";
import { mountReviewScreen } from "./review-screen.js";
import { posterStyle } from "./covers.js";
import { statusPill } from "./versions.js";

const NAME_KEY = "kf_reviewer_name";
const app = document.getElementById("app");
let main = null;
let activeScreen = null;

function fatal(title, message) {
  app.replaceChildren(
    el("div", { class: "auth-gate" },
      el("div", { class: "auth-card" },
        el("h1", {}, title),
        el("p", { class: "dim" }, message)
      )
    )
  );
}

function askName() {
  return new Promise((resolve) => {
    const input = el("input", { class: "input", placeholder: "Your name", maxLength: "60" });
    const btn = el("button", { class: "btn btn-primary" }, "Start reviewing");
    const close = modal(el("div", {},
      el("h3", {}, "Welcome"),
      el("p", { class: "dim hint" }, "Your name is shown next to your comments."),
      el("div", { class: "form-row" }, input),
      el("div", { class: "modal-actions" }, btn)
    ), { closable: false });
    const done = () => {
      const name = input.value.trim();
      if (!name) return;
      localStorage.setItem(NAME_KEY, name);
      close();
      resolve(name);
    };
    btn.addEventListener("click", done);
    input.addEventListener("keydown", (e) => e.key === "Enter" && done());
    setTimeout(() => input.focus(), 50);
  });
}

function teardownScreen() {
  if (activeScreen) {
    activeScreen.destroy();
    activeScreen = null;
  }
}

// The folder link's landing page — every video in the folder, so the
// reviewer picks one rather than being dropped into whichever came first.
function showFolderGrid(token, folderSession, name) {
  teardownScreen();

  async function openVideo(video) {
    main.replaceChildren(spinner(`Loading “${video.name}”…`));
    let full;
    try {
      full = await api.getSession(token, video.id);
    } catch (err) {
      main.replaceChildren(el("p", { class: "error-note" }, `Could not open “${video.name}”: ${err.message}`));
      return;
    }
    showVideo(token, full, name, folderSession);
  }

  const cards = folderSession.videos.map((video) => {
    const hasMedia = video.versions.length > 0;
    const open = hasMedia ? () => openVideo(video) : undefined;
    const detail = hasMedia ? [`v${video.currentVersion}`, `${video.fps} fps`] : ["No media yet"];
    return el("div", {
        class: "video-card",
        role: hasMedia ? "button" : undefined,
        tabindex: hasMedia ? "0" : undefined,
        "aria-label": hasMedia ? `Open ${video.name}` : undefined,
        onClick: open,
        onKeydown: hasMedia ? (e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
        } : undefined,
      },
      el("div", { class: "video-poster", style: posterStyle(video.name) }, statusPill(video.status)),
      el("div", { class: "video-card-body" },
        el("h3", { class: "video-card-name", title: video.name }, video.name),
        el("div", { class: "video-card-meta" }, el("span", { class: "dim" }, detail.join(" · ")))
      )
    );
  });

  main.replaceChildren(
    el("div", { class: "page" },
      el("div", { class: "page-head" }, el("h1", {}, folderSession.group.name)),
      cards.length
        ? el("div", { class: "video-grid" }, ...cards)
        : el("p", { class: "dim empty-note" }, "No videos in this folder yet.")
    )
  );
}

// A single video — the same screen a direct video link has always opened,
// plus a way back to the grid when this video was reached through one.
function showVideo(token, videoSession, name, folderSession) {
  teardownScreen();
  main.replaceChildren();

  // Only a folder-derived view needs its calls scoped to a specific video —
  // a plain video link's token already names its one video on its own.
  const store = reviewerStore(token, folderSession ? videoSession.video.id : null);
  activeScreen = mountReviewScreen(main, {
    mode: "reviewer",
    store,
    projectId: videoSession.project.id,
    projectName: videoSession.project.name,
    video: videoSession.video,
    authorName: () => localStorage.getItem(NAME_KEY) || "Reviewer",
    pollComments: true,
    headerExtras: folderSession
      ? [el("button", {
          class: "btn-link",
          onClick: async () => {
            // Re-fetched rather than reusing the folder grid this video was
            // opened from — a status changed just now on this screen should
            // already show correctly on its card the moment the grid is back.
            main.replaceChildren(spinner("Loading…"));
            try {
              const fresh = await api.getSession(token);
              showFolderGrid(token, fresh, name);
            } catch (err) {
              main.replaceChildren(el("p", { class: "error-note" }, `Could not load folder: ${err.message}`));
            }
          },
        }, "← All videos")]
      : [],
  });
  activeScreen.setComments(videoSession.comments);
}

async function boot() {
  const token = new URLSearchParams(location.search).get("token");
  if (!token) return fatal("Invalid link", "This review link is missing its token.");
  if (!api.workerConfigured()) return fatal("Not configured", "This review site is not fully set up yet (missing worker URL).");

  app.replaceChildren(spinner("Loading review…"));

  let session;
  try {
    session = await api.getSession(token);
  } catch (err) {
    if (err.status === 404 || err.status === 403 || err.code === "expired") {
      return fatal("Link expired", "This review link is no longer active. Ask for a fresh link.");
    }
    return fatal("Something went wrong", err.message);
  }

  let name = localStorage.getItem(NAME_KEY);
  if (!name) name = await askName();

  main = el("main", { id: "main" });
  app.replaceChildren(
    el("header", { class: "app-header" },
      el("span", { class: "brand" }, CONFIG.APP_NAME),
      el("span", { class: "dim" }, session.project.name),
      el("span", { class: "spacer" }),
      el("span", { class: "dim" }, name)
    ),
    main
  );

  // The worker decides the shape: a folder share's session carries `videos`,
  // a video share's carries `video` — same endpoint, and nothing here has to
  // separately track which kind of link this was.
  if (session.videos) {
    showFolderGrid(token, session, name);
  } else {
    showVideo(token, session, name, null);
  }
}

boot();
