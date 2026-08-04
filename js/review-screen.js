// The review screen shared by the owner app (index.html) and the reviewer
// page (review.html): player + annotation toolbar + comment sidebar +
// version switcher + status pill.

import { el, toast } from "./ui.js";
import { Player } from "./player.js";
import { Annotator, ANNOT_COLORS } from "./annotations.js";
import { CommentsPanel } from "./comments.js";
import { versionSwitcher, statusPill } from "./versions.js";
import { buildAuthorColors, colorResolver, authorInitials } from "./authors.js";
import { penToolIcon, arrowToolIcon, boxToolIcon } from "./annot-icons.js";

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
  // One colour per author, deconflicted across everyone on this video, so the
  // sidebar avatars and the timeline ticks always agree.
  let authorColors = new Map();
  const colorFor = (name) => colorResolver(authorColors)(name);

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
  const TOOL_ICON = { pen: penToolIcon, arrow: arrowToolIcon, rect: boxToolIcon };
  const TOOL_LABEL = { pen: "Pen", arrow: "Arrow", rect: "Box" };
  const toolBtns = ["pen", "arrow", "rect"].map((tool) =>
    el("button", {
      class: `tool-btn${tool === "pen" ? " active" : ""}`,
      dataset: { tool },
      onClick: () => {
        currentTool = tool;
        annotator.setTool(tool);
        toolbar.querySelectorAll(".tool-btn").forEach((b) => b.classList.toggle("active", b.dataset.tool === tool));
      },
    }, TOOL_ICON[tool](), TOOL_LABEL[tool])
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
    colorFor,
    fps: () => player.fps,
    currentTime: () => player.currentTime,
    onSeek: (c) => {
      player.seekTo(c.timeSec);
      player.setActiveMarker(c.parentId || c.id);
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
    // Replies carry no timecode or drawing of their own — the worker pins
    // them to the note they answer.
    onReply: async ({ text, parentId }) => {
      try {
        await store.addComment(opts.projectId, video.id, {
          author: opts.authorName(),
          timeSec: comments.find((c) => c.id === parentId)?.timeSec ?? 0,
          text,
          annotation: null,
          version: shownVersion,
          parentId,
        });
        await refreshComments();
      } catch (err) {
        toast(`Could not post reply: ${err.message}`, "error");
        throw err;
      }
    },
    // The panel has already greyed the note and updated the model; this only
    // persists it, and undoes the change if the write is refused.
    onResolve: async (id, resolved) => {
      try {
        await store.setResolved(opts.projectId, video.id, id, resolved);
      } catch (err) {
        const c = comments.find((c) => c.id === id);
        if (c) c.resolved = !resolved;
        panel.setComments(comments);
        toast(`Could not update comment: ${err.message}`, "error");
      }
    },
    onDelete: async (id) => {
      try {
        await store.deleteComment(opts.projectId, video.id, id);
        // Mirrors the server: a deleted note takes its replies with it.
        comments = comments.filter((c) => c.id !== id && c.parentId !== id);
        panel.setComments(comments);
        // The note also owns a tick on the scrubber, which would otherwise sit
        // there pointing at nothing until something else redrew the rail.
        syncMarkers();
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
  // Reviewers set status too — signing off is the point of the link. The owner
  // writes project.json directly; the reviewer goes through the worker.
  const applyStatus = mode === "owner"
    ? opts.onStatusChange
    : store.setStatus?.bind(store);

  // Guards against a slow save from an earlier pick reverting a later one.
  let statusSeq = 0;

  function renderStatus() {
    const next = statusPill(video.status, {
      editable: !!applyStatus,
      onChange: async (status) => {
        const previous = video.status;
        if (status === previous) return;
        // The pill has already recoloured itself; treat the change as applied
        // and only undo it if the write is refused.
        const seq = ++statusSeq;
        video.status = status;
        try {
          await applyStatus(status);
        } catch (err) {
          if (seq !== statusSeq) return; // a newer pick owns the state now
          video.status = previous;
          renderStatus();
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
      syncMarkers();
    } catch (err) {
      toast(`Could not load v${n}: ${err.message}`, "error");
    }
  }

  // The reviewer poll re-reads this every 30 s whether or not anyone has
  // written anything. Rendering an identical list would not just be wasted
  // work: it rebuilds every note, so an open reply box and its half-typed
  // text would disappear under the reviewer twice a minute.
  let commentsStamp = null;

  async function refreshComments() {
    try {
      const next = await store.loadComments(opts.projectId, video.id);
      const stamp = JSON.stringify(next);
      if (stamp === commentsStamp) return;
      commentsStamp = stamp;
      comments = next;
      panel.setComments(comments);
      syncMarkers();
    } catch (err) {
      toast(`Could not load comments: ${err.message}`, "error");
    }
  }

  // Ticks on the scrubber, one per note, in that author's colour. Replies are
  // skipped: they sit at their parent's timecode, so they would stack up as
  // duplicate ticks on the same spot. Only the version on screen is shown —
  // another cut's timecodes do not describe this one.
  function syncMarkers() {
    // Rebuilt from the current roster, in first-comment order.
    authorColors = buildAuthorColors(
      comments.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((c) => c.author)
    );
    player.setMarkers(
      comments
        .filter((c) => !c.parentId && c.version === shownVersion)
        .map((c) => ({
          id: c.id,
          timeSec: c.timeSec,
          color: colorFor(c.author),
          label: `${c.author}: ${(c.text || "drawing").slice(0, 60)}`,
          initials: authorInitials(c.author),
          onSelect: () => panel.select(c),
        }))
    );
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
      syncMarkers();
    },
  };
}
