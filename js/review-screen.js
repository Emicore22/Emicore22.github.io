// The review screen shared by the owner app (index.html) and the reviewer
// page (review.html): player + annotation toolbar + comment sidebar +
// version switcher + status pill.

import { el, toast } from "./ui.js";
import { Player } from "./player.js";
import { Annotator, ANNOT_COLORS } from "./annotations.js";
import { CommentsPanel } from "./comments.js";
import { versionSwitcher, statusPill } from "./versions.js";

export function mountReviewScreen(mount, opts) {
  // opts: {
  //   mode: "owner" | "reviewer",
  //   store,                        // ownerStore() or reviewerStore(token)
  //   projectId, projectName,
  //   video,                        // manifest entry {id,name,fps,status,currentVersion,versions}
  //   authorName: () => string,
  //   headerExtras: [elements],     // e.g. back link, share button
  //   onStatusChange: (status) => Promise,   // owner only
  //   pollComments: boolean,        // reviewer: refresh every 30 s
  // }
  const { mode, store, video } = opts;
  let shownVersion = video.currentVersion;
  let comments = [];
  let statusEl;

  // ── layout ──────────────────────────────────────────────────────────────
  const playerMount = el("div", { class: "player-area" });
  const topStrip = el(
    "div", { class: "review-top" },
    ...(opts.headerExtras || []),
    el("h2", { class: "video-title" }, video.name),
    el("span", { class: "spacer" })
  );
  const stage = el("div", { class: "review-stage" }, playerMount);
  const layout = el("div", { class: "review-layout" }, topStrip, stage);
  mount.append(layout);

  // ── player + annotator ──────────────────────────────────────────────────
  const player = new Player(playerMount, { fps: video.fps });
  const annotator = new Annotator(player.videoWrap, player.video);

  // Annotation toolbar (hidden until draw mode is on)
  let currentTool = "pen";
  const toolBtns = ["pen", "arrow", "rect"].map((tool) =>
    el("button", {
      class: `tool-btn${tool === "pen" ? " active" : ""}`,
      dataset: { tool },
      onClick: () => {
        currentTool = tool;
        annotator.setTool(tool);
        toolbar.querySelectorAll(".tool-btn").forEach((b) => b.classList.toggle("active", b.dataset.tool === tool));
      },
    }, { pen: "✏️ Pen", arrow: "↗ Arrow", rect: "▭ Box" }[tool])
  );
  const colorBtns = ANNOT_COLORS.map((color, i) =>
    el("button", {
      class: `color-btn${i === 0 ? " active" : ""}`,
      style: `background:${color}`,
      onClick: (e) => {
        annotator.setColor(color);
        toolbar.querySelectorAll(".color-btn").forEach((b) => b.classList.toggle("active", b === e.currentTarget));
      },
    })
  );
  const toolbar = el(
    "div", { class: "annot-toolbar hidden" },
    ...toolBtns,
    el("span", { class: "toolbar-sep" }),
    ...colorBtns,
    el("span", { class: "spacer" }),
    el("button", { class: "btn-link", onClick: () => stopAnnotating() }, "Cancel drawing")
  );
  playerMount.prepend(toolbar);

  function startAnnotating() {
    player.pause();
    annotator.clearShown();
    annotator.setTool(currentTool);
    toolbar.classList.remove("hidden");
    panel.setAnnotating(true);
  }
  function stopAnnotating() {
    annotator.cancelPending();
    toolbar.classList.add("hidden");
    panel.setAnnotating(false);
  }

  // ── comments panel ──────────────────────────────────────────────────────
  const panel = new CommentsPanel(stage, {
    mode,
    fps: () => player.fps,
    currentTime: () => player.currentTime,
    onSeek: (c) => {
      player.seekTo(c.timeSec);
      annotator.showShapes(c.annotation?.shapes || null);
    },
    onPost: async ({ text, timeSec }) => {
      const shapes = annotator.takePending();
      if (!text && !shapes.length) return;
      try {
        await store.addComment(opts.projectId, video.id, {
          author: opts.authorName(),
          timeSec,
          text,
          annotation: shapes.length ? { shapes } : null,
          version: shownVersion,
        });
        stopAnnotating();
        await refreshComments();
      } catch (err) {
        toast(`Could not post comment: ${err.message}`, "error");
        throw err;
      }
    },
    onResolve: async (id, resolved) => {
      try {
        await store.setResolved(opts.projectId, video.id, id, resolved);
        const c = comments.find((c) => c.id === id);
        if (c) c.resolved = resolved;
        panel.setComments(comments);
      } catch (err) {
        toast(`Could not update comment: ${err.message}`, "error");
      }
    },
    onDelete: async (id) => {
      try {
        await store.deleteComment(opts.projectId, video.id, id);
        comments = comments.filter((c) => c.id !== id);
        panel.setComments(comments);
      } catch (err) {
        toast(`Could not delete comment: ${err.message}`, "error");
      }
    },
    onAnnotateToggle: (active) => (active ? startAnnotating() : stopAnnotating()),
  });
  panel.setVersions(video.versions, shownVersion);

  // Clear any displayed annotation as soon as playback resumes.
  player.onPlayStateChange = (playing) => {
    if (playing) annotator.clearShown();
  };

  // ── header widgets: version switcher + status pill ──────────────────────
  function renderStatus() {
    const next = statusPill(video.status, {
      editable: mode === "owner" && !!opts.onStatusChange,
      onChange: async (status) => {
        try {
          await opts.onStatusChange(status);
          video.status = status;
          renderStatus();
        } catch (err) {
          toast(`Could not change status: ${err.message}`, "error");
        }
      },
    });
    if (statusEl) statusEl.replaceWith(next);
    else topStrip.append(next);
    statusEl = next;
  }
  if (video.versions.length > 1 || mode === "owner") {
    topStrip.append(versionSwitcher(video.versions, shownVersion, (n) => switchVersion(n)));
  }
  renderStatus();

  // ── download ────────────────────────────────────────────────────────────
  // Streams straight from Dropbox: temporary links are served with
  // Content-Disposition: attachment, so an anchor pointing at one saves the
  // file under its original name. Pulling it into a blob first would need CORS
  // Dropbox doesn't grant on these links, and would hold the whole file in
  // memory. A fresh link is fetched per click because they expire.
  const downloadBtn = el("button", { class: "btn btn-sm", title: "Download this version" }, "Download");
  downloadBtn.addEventListener("click", async () => {
    downloadBtn.disabled = true;
    downloadBtn.textContent = "Preparing…";
    try {
      const media = await mediaForVersion(shownVersion);
      // Empty download attribute: keep Dropbox's filename, which already
      // carries the version prefix from upload.
      const link = el("a", { href: media.url, download: "" });
      document.body.append(link);
      link.click();
      link.remove();
    } catch (err) {
      toast(`Could not start download: ${err.message}`, "error");
    } finally {
      downloadBtn.disabled = false;
      downloadBtn.textContent = "Download";
    }
  });
  topStrip.append(downloadBtn);

  // ── media loading ───────────────────────────────────────────────────────
  async function mediaForVersion(n) {
    if (mode === "owner") {
      const entry = video.versions.find((v) => v.n === n);
      return store.mediaLink(entry.path);
    }
    return store.mediaLinkForVersion(n);
  }

  async function switchVersion(n) {
    try {
      const media = await mediaForVersion(n);
      shownVersion = n;
      player.load(media, () => mediaForVersion(shownVersion));
    } catch (err) {
      toast(`Could not load v${n}: ${err.message}`, "error");
    }
  }

  async function refreshComments() {
    try {
      comments = await store.loadComments(opts.projectId, video.id);
      panel.setComments(comments);
    } catch (err) {
      toast(`Could not load comments: ${err.message}`, "error");
    }
  }

  // ── keyboard: C = comment, Esc = cancel drawing ─────────────────────────
  const onKey = (e) => {
    const t = e.target;
    const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
    if (e.key === "Escape" && panel.annotating) {
      stopAnnotating();
    } else if ((e.key === "c" || e.key === "C") && !typing) {
      e.preventDefault();
      panel.focusComposer();
    }
  };
  document.addEventListener("keydown", onKey);

  // ── reviewer polling ────────────────────────────────────────────────────
  let pollTimer = null;
  if (opts.pollComments) {
    pollTimer = setInterval(() => {
      if (document.visibilityState === "visible") refreshComments();
    }, 30000);
  }

  // ── boot ────────────────────────────────────────────────────────────────
  switchVersion(shownVersion);
  refreshComments();

  return {
    destroy() {
      document.removeEventListener("keydown", onKey);
      if (pollTimer) clearInterval(pollTimer);
      panel.destroy();
      annotator.destroy();
      player.destroy();
      layout.remove();
    },
    setComments(list) {
      comments = list;
      panel.setComments(list);
    },
  };
}
