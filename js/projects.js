// Owner project browser: project grid, project detail (video rows),
// in-app upload (≤800 MB) and "Rescan" for files dropped into Dropbox.

import { el, toast, modal, confirmDialog, contextMenu, fmtDate, spinner } from "./ui.js";
import { getAccessToken } from "./auth.js";
import * as dbx from "./dropbox.js";
import {
  createProject, deleteProject, deleteVideo, renameProject, newVideoEntry, mediaDir,
  createGroup, newGroup, renameGroup, deleteGroup, moveVideoToGroup,
} from "./store.js";
import { detectFps } from "./fps.js";
import { statusPill } from "./versions.js";
import { hashString } from "./authors.js";
import { openShareDialog } from "./share.js";
import { CONFIG } from "./config.js";

const MAX_INAPP_UPLOAD = 800 * 1024 * 1024;
const MAX_LABEL = `${Math.round(MAX_INAPP_UPLOAD / (1024 * 1024))} MB`;
const OVER_LIMIT_MSG = `Over ${MAX_LABEL} — drop the file into the project's media folder in Dropbox, then Rescan.`;
const VIDEO_FILE = /(^video\/(mp4|webm|quicktime)$)|(\.(mp4|webm|mov)$)/i;

// Cover art for a video card. There is no thumbnail to show — nobody has made
// one, and the file itself lives behind a temporary link — but the video does
// have a name, so the name picks the gradient. Same name, same colours, every
// time the page is drawn, which is what makes a card recognisable at a glance.
const POSTERS = [
  ["#6d4aff", "#a78bfa", "#3b1e8f"], // violet
  ["#ff7a59", "#ffb37a", "#d94a7a"], // coral
  ["#22d3ee", "#7dd3fc", "#2563eb"], // cyan
  ["#e352c8", "#f9a8d4", "#7c2d8f"], // magenta
  ["#5b8cff", "#93c5fd", "#3730a3"], // indigo
  ["#a855f7", "#f0abfc", "#6d28d9"], // orchid
];

function posterStyle(name) {
  const [g1, g2, g3] = POSTERS[hashString(name) % POSTERS.length];
  return `--g1:${g1}; --g2:${g2}; --g3:${g3}`;
}

// A frame a little way into the cut, rather than the very first one — the
// first frame of an edit is black more often than not.
const POSTER_AT = (duration) => Math.min(1, (duration || 0) * 0.1) || 0;

// How long the cut runs, as mm:ss. The timecode module deals in frames, which
// is the right answer on the review screen and far more than a card needs.
function clockLength(seconds) {
  const total = Math.round(seconds);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

// Three dots, drawn rather than typed. The bullet character renders at very
// different weights from font to font, and this one has to sit quietly in a
// footer next to 12px text.
function moreIcon() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 16 4");
  svg.setAttribute("class", "icon-dots");
  svg.setAttribute("aria-hidden", "true");
  for (const cx of [2, 8, 14]) {
    const dot = document.createElementNS(ns, "circle");
    dot.setAttribute("cx", cx);
    dot.setAttribute("cy", "2");
    dot.setAttribute("r", "1.6");
    dot.setAttribute("fill", "currentColor");
    svg.append(dot);
  }
  return svg;
}

const SVG_NS = "http://www.w3.org/2000/svg";

// A 2×2 cluster of dots for "All Projects" and a filled folder tab for each
// project — small, monochrome, and coloured by currentColor so a sidebar
// row's hover and active states carry the icon along with the label for free.
function gridIcon() {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("class", "icon-16");
  svg.setAttribute("aria-hidden", "true");
  for (const [x, y] of [[2, 2], [9, 2], [2, 9], [9, 9]]) {
    const r = document.createElementNS(SVG_NS, "rect");
    r.setAttribute("x", x);
    r.setAttribute("y", y);
    r.setAttribute("width", "5");
    r.setAttribute("height", "5");
    r.setAttribute("rx", "1.2");
    r.setAttribute("fill", "currentColor");
    svg.append(r);
  }
  return svg;
}

function folderIcon() {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("class", "icon-16");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", "M1.5 4a1 1 0 0 1 1-1h3.4l1.3 1.4H13a1 1 0 0 1 1 1v6.1a1 1 0 0 1-1 1H2.5a1 1 0 0 1-1-1V4z");
  path.setAttribute("fill", "currentColor");
  svg.append(path);
  return svg;
}

// The disclosure triangle on a project row. A plain chevron rather than a
// filled arrow, since it only ever means "there's more here" — rotated open
// by CSS on the button that owns it, not swapped for a second icon.
function chevronIcon() {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("class", "icon-chevron");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", "M6 4l4 4-4 4");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.6");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  return svg;
}

// A persistent list of every project down the left edge of the owner app, so
// moving between projects is a click in place rather than a trip back through
// the grid — closer to a file explorer's folder list than card-only browsing.
// Each project can be expanded in place to show its own folders underneath,
// one level deep, matching how folders work everywhere else in the app.
//
// The project list stays in sync from one place: every create, rename and
// delete goes through store.updateIndex, which fires kontraframe:index-changed
// once the write actually lands. An expanded project's folders stay in sync
// the same way, off store.updateProject's kontraframe:project-changed. Either
// listened for rather than kept as a separate copy of "what changes this" —
// which would drift the day a fourth way to edit shows up.
//
// Unlike the render* functions above, `mount` is not handed over entirely —
// the sidebar is prepended as a new first child, leaving whatever is already
// in `mount` (the routed #main) where it is.
export function mountSidebar(mount, store, { onOpen, onOpenGroup, onAllProjects }) {
  const list = el("nav", { class: "sidebar-list" });
  const allBtn = el(
    "button", { class: "sidebar-item sidebar-all", onClick: onAllProjects },
    gridIcon(), el("span", { class: "sidebar-item-label" }, "All Projects")
  );
  const root = el(
    "aside", { class: "sidebar" },
    allBtn,
    el("div", { class: "sidebar-head" },
      el("h4", {}, "Projects"),
      el("button", {
        class: "sidebar-add", title: "New project", "aria-label": "New project",
        onClick: () => newProjectDialog(store, onOpen),
      }, "+")
    ),
    list
  );
  mount.prepend(root);

  let activeProjectId = null;
  let activeGroupId = null;

  // One entry per project row, built the first time it's drawn and kept for
  // the sidebar's lifetime. Expansion state, and whatever folders were
  // already loaded, survive a rename elsewhere or another project appearing —
  // renderList reuses these nodes rather than rebuilding them from scratch.
  const rows = new Map();

  function projectRow(p) {
    let entry = rows.get(p.id);
    if (entry) return entry;

    const toggle = el("button", {
      class: "sidebar-toggle",
      title: "Show folders",
      "aria-label": `Show folders in ${p.name}`,
      "aria-expanded": "false",
      onClick: (e) => {
        e.stopPropagation();
        toggleExpanded(p.id);
      },
    }, chevronIcon());

    const item = el("button", {
      class: "sidebar-item",
      dataset: { projectId: p.id },
      title: p.name,
      onClick: () => onOpen(p.id),
    }, folderIcon(), el("span", { class: "sidebar-item-label" }, p.name));

    // .hidden, not the hidden attribute: .sidebar-subtree sets its own
    // display (flex, for the column of folder rows), and that author rule
    // and the browser's default [hidden] one carry equal specificity — as
    // the later-loaded stylesheet, this app's own rule silently won, so
    // subtree.hidden = true was flipping the attribute correctly and doing
    // nothing visible. The shared .hidden utility carries !important
    // specifically so a class like this can't relitigate the point.
    const subtree = el("div", { class: "sidebar-subtree hidden" });

    entry = { p, item, subtree, toggle, row: el("div", { class: "sidebar-row" }, toggle, item),
      loaded: false, expanded: false, groupRows: new Map() };
    rows.set(p.id, entry);
    return entry;
  }

  function renderGroups(entry, groups) {
    entry.groupRows.clear();
    if (!groups.length) {
      entry.subtree.replaceChildren(el("p", { class: "sidebar-empty" }, "No folders"));
      return;
    }
    entry.subtree.replaceChildren(
      ...groups.map((g) => {
        const active = entry.p.id === activeProjectId && g.id === activeGroupId;
        const row = el("button", {
          class: `sidebar-item sidebar-item-group${active ? " active" : ""}`,
          dataset: { groupId: g.id },
          title: g.name,
          onClick: () => onOpenGroup(entry.p.id, g.id),
        }, folderIcon(), el("span", { class: "sidebar-item-label" }, g.name));
        entry.groupRows.set(g.id, row);
        return row;
      })
    );
  }

  // forceOpen is how setActive reveals a folder that was navigated to some
  // other way (a bookmark, the folder's own back-link) without the reader
  // ever having clicked the disclosure triangle themselves.
  async function toggleExpanded(pid, forceOpen = false) {
    const entry = rows.get(pid);
    if (!entry) return;
    const next = forceOpen || !entry.expanded;
    entry.expanded = next;
    entry.subtree.classList.toggle("hidden", !next);
    entry.toggle.classList.toggle("expanded", next);
    entry.toggle.setAttribute("aria-expanded", String(next));
    if (!next || entry.loaded) return;

    // The subtree just became visible but is still empty, and the fetch
    // below takes a real round trip — without this the triangle turns and
    // then nothing happens for a moment, which reads as broken rather than
    // loading. Every click after this one is instant, because entry.loaded
    // skips straight past here.
    entry.subtree.replaceChildren(el("p", { class: "sidebar-empty" }, "Loading…"));

    entry.loaded = true; // set before the fetch resolves, so a second click
                          // while it's in flight doesn't start a second one
    try {
      const project = await store.loadProject(pid);
      renderGroups(entry, project.groups || []);
    } catch (err) {
      entry.loaded = false; // let a retry actually retry
      entry.subtree.replaceChildren(el("p", { class: "sidebar-error" }, `Could not load folders: ${err.message}`));
    }
  }

  function renderList(projects) {
    const live = new Set(projects.map((p) => p.id));
    for (const [id, entry] of rows) {
      if (live.has(id)) continue;
      entry.row.remove();
      entry.subtree.remove();
      rows.delete(id);
    }
    list.replaceChildren(
      ...projects.flatMap((p) => {
        const entry = projectRow(p);
        entry.p = p; // picks up a rename without losing load/expand state
        entry.item.title = p.name;
        entry.item.querySelector(".sidebar-item-label").textContent = p.name;
        entry.item.classList.toggle("active", p.id === activeProjectId && activeGroupId == null);
        return [entry.row, entry.subtree];
      })
    );
  }

  const onIndexChanged = (e) => renderList(e.detail.projects);
  window.addEventListener("kontraframe:index-changed", onIndexChanged);

  // Only a project whose folders are actually showing needs to hear about a
  // write to it — one that's collapsed, or belongs to someone else's expanded
  // row, picks up the current state anyway the next time it opens.
  const onProjectChanged = (e) => {
    const entry = rows.get(e.detail.id);
    if (!entry?.expanded) return;
    renderGroups(entry, e.detail.data.groups || []);
  };
  window.addEventListener("kontraframe:project-changed", onProjectChanged);

  store.loadIndex()
    .then((index) => renderList(index.projects))
    .catch(() => {
      // A sidebar that failed to load must not block the page beside it — that
      // page makes its own loadIndex() or loadProject() call and reports the
      // same failure there.
    });

  return {
    // id is null on the grid, where nothing in the sidebar should read as
    // current; groupId is set when a folder itself is the current page.
    setActive(id, groupId = null) {
      activeProjectId = id;
      activeGroupId = groupId;
      for (const [pid, entry] of rows) {
        entry.item.classList.toggle("active", pid === id && groupId == null);
        for (const [gid, row] of entry.groupRows) row.classList.toggle("active", pid === id && gid === groupId);
      }
      allBtn.classList.toggle("active", id === null);
      // Reveal the project you're looking at — its folders show without a
      // separate click on the triangle, which is the whole point of a
      // sidebar meant to double as a hierarchy view. The triangle still
      // works afterward for a reader who wants to fold it back away.
      if (id) toggleExpanded(id, true);
    },
    destroy() {
      window.removeEventListener("kontraframe:index-changed", onIndexChanged);
      window.removeEventListener("kontraframe:project-changed", onProjectChanged);
      root.remove();
    },
  };
}

// Shared by both cards — same dialog, different thing being renamed.
// `onSave` does the writing and is left to throw; the dialog stays open and
// says so, since the name the user typed is still in the box to try again.
function renameDialog({ title, hint, value, onSave }) {
  const input = el("input", { class: "input", value });
  const save = el("button", { class: "btn btn-primary" }, "Rename");
  const close = modal(el("div", {},
    el("h3", {}, title),
    hint ? el("p", { class: "dim hint" }, hint) : null,
    el("div", { class: "form-row" }, input),
    el("div", { class: "modal-actions" }, save)
  ));

  async function submit() {
    const name = input.value.trim();
    if (!name || name === value) return close();
    save.disabled = true;
    try {
      await onSave(name);
      close();
      toast(`Renamed to “${name}”.`);
    } catch (err) {
      toast(`Could not rename: ${err.message}`, "error");
      save.disabled = false;
    }
  }

  save.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => e.key === "Enter" && submit());
  input.focus();
  input.select();
}

// Without this, a file dropped outside the drop zone makes the browser
// navigate away from the app to the file itself.
let dropGuardInstalled = false;
function installDropGuard() {
  if (dropGuardInstalled) return;
  dropGuardInstalled = true;
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => e.preventDefault());
}

export function renderProjectGrid(mount, store, { onOpen }) {
  const draw = () => {
    mount.replaceChildren(spinner("Loading projects…"));
    store.loadIndex().then((index) => {
      const grid = el("div", { class: "project-grid" },
        // A div rather than a button: the card holds its own delete button,
        // and nesting buttons is invalid.
        ...index.projects.map((p) =>
          el("div", {
              class: "project-card", role: "button", tabindex: "0",
              onClick: () => onOpen(p.id),
              onContextmenu: (e) => {
                e.preventDefault();
                openProjectMenu(store, p, draw, e.clientX, e.clientY);
              },
              onKeydown: (e) => {
                // Only when the card itself has focus — the menu button inside
                // it answers to Enter and Space too, and bubbles through here.
                if (e.target !== e.currentTarget) return;
                if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(p.id); }
              },
            },
            el("h3", {}, p.name),
            el("div", { class: "card-foot" },
              el("p", { class: "dim" }, `Created ${fmtDate(p.createdAt)}`),
              el("span", { class: "spacer" }),
              el("button", {
                class: "btn-link card-menu-btn",
                title: "More actions",
                "aria-label": `More actions for ${p.name}`,
                "aria-haspopup": "menu",
                onClick: (e) => {
                  e.stopPropagation();
                  const r = e.currentTarget.getBoundingClientRect();
                  openProjectMenu(store, p, draw, r.left, r.bottom + 4);
                },
              }, moreIcon())
            )
          )
        ),
        el("button", { class: "project-card project-card-new", onClick: () => newProjectDialog(store, onOpen) },
          el("span", { class: "plus" }, "+"), "New project")
      );
      mount.replaceChildren(
        el("div", { class: "page" }, el("h1", {}, "Projects"), grid)
      );
    }).catch((err) => {
      mount.replaceChildren(el("p", { class: "error-note" }, `Could not load projects: ${err.message}`));
    });
  };
  draw();
}

function openProjectMenu(store, project, after, x, y) {
  contextMenu(x, y, [
    {
      label: "Rename…",
      onSelect: () => renameDialog({
        title: "Rename project",
        // The folder was named from the project's first name and keeps it;
        // nothing points at the name, so nothing breaks either way.
        hint: "Changes the name shown in Kontraframe. The project's folder in Dropbox keeps the name it was created with.",
        value: project.name,
        onSave: async (name) => {
          await renameProject(store, project.id, name);
          after?.();
        },
      }),
    },
    { label: "Delete", danger: true, onSelect: () => askDeleteProject(store, project, after) },
  ]);
}

// Shared by the grid card and the project page. `after` runs once the project
// is gone (redraw the grid, or navigate away from the dead project).
async function askDeleteProject(store, project, after) {
  // The index entry has no video count, so read the project to say precisely
  // what is about to be destroyed.
  let videos = null;
  try {
    videos = (await store.loadProject(project.id)).videos;
  } catch {
    // Unreadable project — deleting is still the right call, just say less.
  }
  // An empty project is a cheap mistake to undo, so it gets a plain confirm;
  // one holding videos gets the full warning and the type-the-name guard.
  const hasVideos = videos?.length > 0;
  const ok = await confirmDialog({
    title: `Delete “${project.name}”?`,
    body: hasVideos
      ? [
          `Deletes ${count(videos.length, "video")}, all comments, and every uploaded file in this project's Dropbox folder.`,
          "Any share links for this project stop working.",
          "Dropbox keeps deleted files for at least 30 days, so you can still restore them at dropbox.com.",
        ]
      : [
          videos
            ? "This project has no videos. Deletes its Dropbox folder."
            : "Deletes this project's Dropbox folder, including any comments and uploaded files in it.",
        ],
    confirmLabel: "Delete project",
    requireText: hasVideos ? project.name : null,
  });
  if (!ok) return;

  try {
    const { revoked, filesRemoved } = await deleteProject(store, project.id);
    toast(deleteMessage(`“${project.name}”`, revoked, filesRemoved), filesRemoved ? "info" : "error");
    after?.();
  } catch (err) {
    toast(`Could not delete project: ${err.message}`, "error");
  }
}

const count = (n, noun) => `${n} ${noun}${n === 1 ? "" : "s"}`;

function deleteMessage(what, revoked, filesRemoved) {
  if (!filesRemoved) return `Removed ${what}, but its files could not be deleted from Dropbox.`;
  const shares = revoked ? ` ${count(revoked, "share link")} revoked.` : "";
  return `Deleted ${what}.${shares}`;
}

function newProjectDialog(store, onOpen) {
  const input = el("input", { class: "input", placeholder: "Project name", autofocus: true });
  const create = el("button", { class: "btn btn-primary" }, "Create");
  const close = modal(el("div", {},
    el("h3", {}, "New project"),
    el("div", { class: "form-row" }, input),
    el("div", { class: "modal-actions" }, create)
  ));
  create.addEventListener("click", async () => {
    const name = input.value.trim();
    if (!name) return;
    create.disabled = true;
    try {
      const project = await createProject(store, name);
      close();
      onOpen(project.id);
    } catch (err) {
      toast(`Could not create project: ${err.message}`, "error");
      create.disabled = false;
    }
  });
  input.addEventListener("keydown", (e) => e.key === "Enter" && create.click());
}

// groupId is null at a project's root, or a folder's id to show only what's
// inside it. Folders are one level deep and live entirely in this function —
// videos stay in one flat array with an optional groupId (see store.js)
// rather than nesting, so nothing outside browsing needs to know they exist.
export function renderProjectDetail(mount, store, projectId, { onOpenVideo, onOpenGroup, onBack, groupId = null }) {
  mount.replaceChildren(spinner("Loading project…"));

  // Cover previews are fetched only for cards that reach the viewport: each one
  // costs a temporary-link call and then however much of the file the browser
  // needs to decode a frame, and a project can hold a lot of videos.
  const previewLoaders = new WeakMap();
  let previewObserver = null;

  // Every folder create, rename, delete and video move rebuilds this page
  // from the one in-memory copy of the project rather than re-fetching it —
  // but rebuilding also recreates every video card, and a fresh card asks
  // Dropbox for a fresh temporary link even for a video that was already on
  // screen a moment ago. That repeated round trip, not the small write
  // itself, is what actually made these feel slow. A link is good for about
  // four hours, so caching it here — keyed by path, for as long as this page
  // is open — means only a video genuinely new to the screen ever waits on
  // Dropbox again.
  const mediaLinkCache = new Map(); // path -> {url, expiresAt}
  async function cachedMediaLink(path) {
    const cached = mediaLinkCache.get(path);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached;
    const link = await store.mediaLink(path);
    mediaLinkCache.set(path, link);
    return link;
  }

  // A redraw throws the old cards away, but a detached <video> can go on
  // pulling bytes down until it is collected. Cut them loose first.
  function releasePreviews() {
    for (const preview of mount.querySelectorAll(".video-preview")) {
      preview.pause?.();
      preview.removeAttribute("src");
      preview.load?.();
    }
  }

  function watchPreviews() {
    previewObserver?.disconnect();
    previewObserver = new IntersectionObserver((entries, obs) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        obs.unobserve(entry.target);          // one load per card, ever
        previewLoaders.get(entry.target)?.();
      }
    }, { rootMargin: "250px" });
    return previewObserver;
  }

  // The gradient stays underneath. It is what shows while the frame is on its
  // way, and what stays if Dropbox declines the link or the browser cannot
  // decode the file — ProRes and HEVC never will, and this app is used with
  // exports straight out of an NLE.
  // The part every poster frame shares, video card or mosaic tile alike: a
  // muted <video> that decodes to a frame a little way in and fades from
  // nothing to that frame once it's actually there, never a flash of black.
  // preload:"metadata" is what keeps this cheap — the browser reads just
  // enough of the file to know its duration and dimensions, not the frames.
  function posterFrameVideo(extra) {
    const preview = el("video", {
      class: "video-preview",
      muted: true, playsInline: true, preload: "metadata",
      tabindex: "-1", "aria-hidden": "true",
      ...extra,
    });
    let posterTime = 0;
    preview.addEventListener("loadedmetadata", () => {
      posterTime = POSTER_AT(preview.duration);
      preview.currentTime = posterTime;
    });
    preview.addEventListener("seeked", () => preview.classList.add("ready"), { once: true });
    return { preview, getPosterTime: () => posterTime };
  }

  function attachPreview(card, poster, video) {
    const source = video.versions.at(-1);
    if (!source) return;

    const { preview, getPosterTime } = posterFrameVideo({ loop: true });
    poster.prepend(preview);

    // How long the cut runs — known only once the file's metadata arrives, so
    // the badge appears with the frame rather than being promised before it.
    const badge = poster.querySelector(".video-duration");
    preview.addEventListener("loadedmetadata", () => {
      if (badge && Number.isFinite(preview.duration) && preview.duration > 0) {
        badge.textContent = clockLength(preview.duration);
        badge.classList.add("ready");
      }
    });

    previewLoaders.set(card, async () => {
      try {
        const { url } = await cachedMediaLink(source.path);
        if (card.isConnected) preview.src = url;
      } catch {
        // No link, no preview — the gradient is already doing the job.
      }
    });

    // A preview that plays on hover is motion the reader did not ask for.
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    card.addEventListener("pointerenter", () => { preview.play?.().catch(() => {}); });
    card.addEventListener("pointerleave", () => {
      preview.pause?.();
      if (preview.readyState) preview.currentTime = getPosterTime();
    });
  }

  // A folder's mosaic tiles get a static frame each — real footage instead of
  // a colour guessed from the video's name, so the cover actually says which
  // videos are in here. No hover playback: four decoded videos scrubbing at
  // once in a card this small would be noise, not information, and the tile
  // is a way to recognise a folder, not to review what's in it.
  function attachMosaicPreviews(card, tiles, items) {
    // One loader for the whole card, not one per tile — up to four small
    // frames belonging to the same folder become visible together (a folder
    // tile is never half on screen), so there's nothing to gain from giving
    // the observer four things to watch instead of the one it already does
    // for every other card.
    const jobs = [];
    for (let i = 0; i < tiles.length; i++) {
      const source = items[i].versions.at(-1);
      if (!source) continue; // an item with nothing uploaded keeps its gradient
      const { preview } = posterFrameVideo({});
      tiles[i].prepend(preview);
      jobs.push(async () => {
        try {
          const { url } = await cachedMediaLink(source.path);
          if (card.isConnected) preview.src = url;
        } catch {
          // No link, no frame — the tile's own gradient is already doing the job.
        }
      });
    }
    if (jobs.length) previewLoaders.set(card, () => Promise.all(jobs.map((job) => job())));
  }

  // currentProject is the one copy of this page's state. draw() is the only
  // thing that fetches it; every fast-path mutation below (a folder created,
  // a video moved) edits this object directly and calls renderPage on it
  // instead of re-fetching what the write already told it — the same reason
  // a status-pill pick has always recoloured itself before the save lands.
  let currentProject = null;

  async function draw() {
    currentProject = await store.loadProject(projectId);
    renderPage(currentProject);
  }

  function renderPage(project) {
    const currentGroup = groupId ? project.groups.find((g) => g.id === groupId) : null;
    if (groupId && !currentGroup) throw new Error("Folder not found");
    // Undefined groupId (a video saved before folders existed) reads the same
    // as null — both mean "the project root" — so an old project's videos
    // show up there without a migration.
    const videosHere = project.videos.filter((v) => (v.groupId || null) === groupId);

    const cards = videosHere.map((v) => {
      const open = () => onOpenVideo(project.id, v.id);
      const latest = v.versions.at(-1);
      // Everything the card says about itself now sits under the frame instead
      // of on top of it — a name laid over the picture competes with the one
      // thing the card is there to show.
      const detail = v.versions.length
        ? [`v${v.currentVersion}`, `${v.fps} fps`, latest ? fmtDate(latest.uploadedAt) : null]
        : ["No media yet"];

      const poster = el("div", { class: "video-poster", style: posterStyle(v.name) },
        videoStatusPill(v),
        el("span", { class: "video-duration" })
      );
      const card = el("div", {
          class: "video-card", role: "button", tabindex: "0",
          "aria-label": `Open ${v.name}`,
          onClick: open,
          onContextmenu: (e) => {
            e.preventDefault();
            openCardMenu(project, v, e.clientX, e.clientY);
          },
          onKeydown: (e) => {
            // Only when the card itself has focus. The status menu and the
            // buttons inside it answer to Enter and Space too, and their
            // keypresses bubble through here on the way up.
            if (e.target !== e.currentTarget) return;
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
          },
        },
        poster,
        el("div", { class: "video-card-body" },
          el("h3", { class: "video-card-name", title: v.name }, v.name),
          el("div", { class: "video-card-meta" },
            el("span", { class: "dim" }, detail.filter(Boolean).join(" · ")),
            el("span", { class: "spacer" }),
            // Right-click is the natural gesture here, but it is invisible —
            // this gives the same menu something you can see. Everything else
            // the card can do lives inside it.
            el("button", {
              class: "btn-link card-menu-btn",
              title: "More actions",
              "aria-label": `More actions for ${v.name}`,
              "aria-haspopup": "menu",
              onClick: (e) => {
                e.stopPropagation();
                const r = e.currentTarget.getBoundingClientRect();
                openCardMenu(project, v, r.left, r.bottom + 4);
              },
            }, moreIcon())
          )
        )
      );
      attachPreview(card, poster, v);
      wireDrag(card, v);
      return card;
    });

    // Folders only exist at the root — one level deep — so they drop out
    // entirely once you're inside one, and so does the way to make a new one.
    const folderCards = groupId ? [] : project.groups.map((g) => buildFolderCard(project, g));
    const tiles = [...folderCards, ...cards];

    const backBtn = el("button", {
      class: "btn-link",
      onClick: onBack,
    }, groupId ? `← ${project.name}` : "← Projects");
    // Drag a video onto "← ProjectName" to send it back to the root — the
    // only way out of a folder by drag, since there is nothing else in this
    // view to drop it on.
    if (groupId) wireGroupDropTarget(backBtn, project, null);

    const page = el("div", { class: "page drop-target" },
      el("div", { class: "page-head" },
        backBtn,
        el("h1", {}, groupId ? currentGroup.name : project.name),
        el("span", { class: "spacer" }),
        groupId ? null : el("button", {
          class: "btn-link danger", onClick: () => askDeleteProject(store, project, onBack),
        }, "Delete project"),
        el("button", { class: "btn", onClick: () => rescan(project) }, "Rescan folder"),
        el("button", { class: "btn btn-primary", onClick: () => addVideoDialog(project) }, "+ Add video")
      ),
      tiles.length
        ? el("div", { class: "video-grid" }, ...tiles)
        : el("p", { class: "dim empty-note" },
            groupId
              ? "No videos in this folder yet. Add one below, or move one in from a video's own menu."
              : [
                  `No videos yet. Add one below ${MAX_LABEL} here (or drag & drop it onto this page), or drop bigger files into `,
                  el("code", {}, `Dropbox/Apps/…/projects/${project.id}/media/`),
                  ". Right-click anywhere on this page to start a folder.",
                ])
    );
    wireDropZone(page, project);
    // New folder lives on the empty page itself, not a permanent tile in the
    // grid — right-click anywhere that isn't a card. Folders are root-only,
    // so there is nothing to offer once you're inside one.
    if (!groupId) {
      page.addEventListener("contextmenu", (e) => {
        if (e.target.closest(".video-card")) return; // the card's own menu already handled this
        e.preventDefault();
        contextMenu(e.clientX, e.clientY, [
          { label: "New folder…", onSelect: () => newFolderDialog(project) },
        ]);
      });
    }
    releasePreviews();
    mount.replaceChildren(page);

    // Only once the cards are in the document — an element that is not laid out
    // yet never intersects anything, so observing earlier would load nothing.
    // tiles is folder cards and video cards together — a folder's mosaic loads
    // exactly the same lazy, once-in-view way a video card's own frame does.
    const observer = watchPreviews();
    for (const tile of tiles) observer.observe(tile);
  }

  // A menu, not a label — the same pill the review screen uses. Approving a cut
  // is the one thing you want to do from here without opening the video first.
  function videoStatusPill(video) {
    // Guards against a slow save from an earlier pick reverting a later one.
    let seq = 0;
    const pill = statusPill(video.status, {
      editable: true,
      onChange: async (status) => {
        const previous = video.status;
        if (status === previous) return;
        // The pill has already recoloured itself; treat the change as applied
        // and only undo it if the write is refused.
        const mine = ++seq;
        video.status = status;
        try {
          await store.updateProject(projectId, (p) => {
            const target = p.videos.find((x) => x.id === video.id);
            if (target) target.status = status;
            return p;
          });
        } catch (err) {
          if (mine !== seq) return; // a newer pick owns the state now
          video.status = previous;
          toast(`Could not change status: ${err.message}`, "error");
          renderPage(currentProject);
        }
      },
    });
    // Opening the menu is not a request to open the video behind it.
    pill.addEventListener("click", (e) => e.stopPropagation());
    return pill;
  }

  function openCardMenu(project, video, x, y) {
    const items = [];
    // Only offered once there's actually something to send — a share link
    // to a video with no uploaded frames has nothing for a reviewer to open.
    if (video.versions.length) {
      items.push({ label: "Share…", onSelect: () => openShareDialog({ projectId: project.id, video }) });
    }
    items.push(
      { label: "Add a version…", onSelect: () => addVideoDialog(project, video) },
      { label: "Rename…", onSelect: () => renameVideoDialog(video) },
    );
    // Only offered when there's actually somewhere to go — a project with no
    // folders and a video that's already at the root has neither a folder to
    // move into nor one to move out of.
    const destinations = project.groups.filter((g) => g.id !== video.groupId);
    if (destinations.length || video.groupId) {
      items.push({ label: "Move to…", onSelect: () => openMoveMenu(project, video, x, y) });
    }
    items.push({ label: "Delete", danger: true, onSelect: () => askDeleteVideo(project, video) });
    contextMenu(x, y, items);
  }

  // A second flat menu at the same point, rather than a submenu — contextMenu
  // only knows how to be a list, and a list of "which folder" needed nowhere
  // near enough options to be worth teaching it nesting for.
  function openMoveMenu(project, video, x, y) {
    const items = [];
    if (video.groupId) {
      items.push({ label: "No folder", onSelect: () => moveVideo(project, video, null) });
    }
    for (const g of project.groups) {
      if (g.id === video.groupId) continue;
      items.push({ label: g.name, onSelect: () => moveVideo(project, video, g.id) });
    }
    contextMenu(x, y, items);
  }

  async function moveVideo(project, video, destGroupId) {
    // Optimistic: the card already looks like it moved — a drag or a menu
    // pick is a small, fast gesture, and waiting on Dropbox's round trip
    // before anything on screen moves would make it feel like it didn't
    // register. Only undone if the write is refused.
    const previous = video.groupId;
    if (previous === destGroupId) return;
    video.groupId = destGroupId;
    renderPage(currentProject);
    try {
      await moveVideoToGroup(store, project.id, video.id, destGroupId);
    } catch (err) {
      video.groupId = previous;
      toast(`Could not move “${video.name}”: ${err.message}`, "error");
      renderPage(currentProject);
    }
  }

  function renameVideoDialog(video) {
    renameDialog({
      title: "Rename video",
      // Worth saying plainly: the uploaded file keeps its own name, and so do
      // the share links pointing at it. Only the label in here changes.
      hint: "Changes the name shown in Kontraframe. The uploaded file in Dropbox keeps the name it was uploaded with.",
      value: video.name,
      onSave: async (name) => {
        await store.updateProject(projectId, (p) => {
          const target = p.videos.find((x) => x.id === video.id);
          if (target) target.name = name;
          return p;
        });
        draw();
      },
    });
  }

  // A folder's cover: up to four of its own videos' posters, tiled — a peek
  // inside rather than inventing a fifth colour just for the folder itself.
  function buildFolderCover(group, items) {
    if (!items.length) {
      return el("div", { class: "video-poster folder-mosaic empty", style: posterStyle(group.name) },
        folderIcon());
    }
    const shown = items.slice(0, 4);
    return el("div", { class: "video-poster folder-mosaic" },
      ...shown.map((v) => {
        // A lone tile fills the whole cover; two split it in half. Three or
        // four fall into the plain 2×2 grid — a gap in the last cell reads
        // fine, the way a half-full shelf does.
        const span = shown.length === 1 ? "; grid-column:1/3; grid-row:1/3"
          : shown.length === 2 ? "; grid-row:1/3" : "";
        return el("span", { class: "mosaic-tile", style: posterStyle(v.name) + span });
      })
    );
  }

  function buildFolderCard(project, group) {
    const items = project.videos.filter((v) => v.groupId === group.id);
    const open = () => onOpenGroup(project.id, group.id);
    const cover = buildFolderCover(group, items);
    const card = el("div", {
        class: "video-card", role: "button", tabindex: "0",
        "aria-label": `Open folder ${group.name}`,
        onClick: open,
        onContextmenu: (e) => {
          e.preventDefault();
          openGroupMenu(project, group, e.clientX, e.clientY);
        },
        onKeydown: (e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
        },
      },
      cover,
      el("div", { class: "video-card-body" },
        el("h3", { class: "video-card-name", title: group.name }, group.name),
        el("div", { class: "video-card-meta" },
          el("span", { class: "dim" }, count(items.length, "item")),
          el("span", { class: "spacer" }),
          el("button", {
            class: "btn-link card-menu-btn",
            title: "More actions",
            "aria-label": `More actions for ${group.name}`,
            "aria-haspopup": "menu",
            onClick: (e) => {
              e.stopPropagation();
              const r = e.currentTarget.getBoundingClientRect();
              openGroupMenu(project, group, r.left, r.bottom + 4);
            },
          }, moreIcon())
        )
      )
    );
    wireGroupDropTarget(card, project, group.id);
    attachMosaicPreviews(card, [...cover.querySelectorAll(".mosaic-tile")], items);
    return card;
  }

  function openGroupMenu(project, group, x, y) {
    contextMenu(x, y, [
      {
        label: "Rename…",
        onSelect: () => renameDialog({
          title: "Rename folder",
          hint: "Changes the name shown in Kontraframe. Folders are organisation only — this doesn't create or rename anything in Dropbox.",
          value: group.name,
          // Not awaited: renameDialog closes and toasts success as soon as
          // this resolves, and the point is for that to happen the instant
          // the row itself recolours, not once Dropbox has confirmed it.
          // The write still runs, and still reverts and says so if refused —
          // it just does that on its own schedule instead of blocking here.
          onSave: async (name) => {
            const previous = group.name;
            group.name = name;
            renderPage(currentProject);
            renameGroup(store, project.id, group.id, name).catch((err) => {
              group.name = previous;
              toast(`Could not rename “${previous}”: ${err.message}`, "error");
              renderPage(currentProject);
            });
          },
        }),
      },
      { label: "Delete", danger: true, onSelect: () => askDeleteGroup(project, group) },
    ]);
  }

  async function askDeleteGroup(project, group) {
    const n = project.videos.filter((v) => v.groupId === group.id).length;
    const ok = await confirmDialog({
      title: `Delete “${group.name}”?`,
      body: [
        n
          ? `Removes this folder. ${count(n, "video")} inside it move back to the project — nothing is deleted.`
          : "Removes this empty folder.",
      ],
      confirmLabel: "Delete folder",
    });
    if (!ok) return;
    // Optimistic, same as creating one: the tile is gone and its videos are
    // back at the root immediately, mirroring exactly what deleteGroup does
    // server-side. Only undone if the write is refused.
    const previousGroups = project.groups;
    const previousVideos = project.videos;
    project.groups = project.groups.filter((g) => g.id !== group.id);
    project.videos = project.videos.map((v) => (v.groupId === group.id ? { ...v, groupId: null } : v));
    renderPage(currentProject);
    try {
      await deleteGroup(store, project.id, group.id);
      toast(`Deleted “${group.name}”.`);
    } catch (err) {
      project.groups = previousGroups;
      project.videos = previousVideos;
      toast(`Could not delete folder: ${err.message}`, "error");
      renderPage(currentProject);
    }
  }

  // Drag source. A custom MIME type, not "text/plain" — dropping a video card
  // must never be mistaken for dropping a URL or pasted text, on this page
  // or, if a card is ever dragged past the window, on another one.
  const DRAG_TYPE = "application/x-kontraframe-video-id";

  function wireDrag(card, video) {
    card.draggable = true;
    card.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData(DRAG_TYPE, video.id);
      e.dataTransfer.effectAllowed = "move";
      card.classList.add("dragging");
    });
    card.addEventListener("dragend", () => card.classList.remove("dragging"));
  }

  // Drop target, shared by a folder tile and the "← ProjectName" breadcrumb —
  // the only two places a video can land: a specific folder, or null for out
  // of one. dataTransfer's actual value is unreadable before drop (only its
  // types are, which is all dragover needs to decide whether to allow it).
  function wireGroupDropTarget(node, project, destGroupId) {
    const accepts = (e) => e.dataTransfer.types.includes(DRAG_TYPE);
    node.addEventListener("dragover", (e) => {
      if (!accepts(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    });
    node.addEventListener("dragenter", (e) => accepts(e) && node.classList.add("drop-target-active"));
    node.addEventListener("dragleave", () => node.classList.remove("drop-target-active"));
    node.addEventListener("drop", (e) => {
      if (!accepts(e)) return;
      e.preventDefault();
      e.stopPropagation();
      node.classList.remove("drop-target-active");
      const vid = e.dataTransfer.getData(DRAG_TYPE);
      const video = project.videos.find((v) => v.id === vid);
      if (!video || video.groupId === destGroupId) return; // already there
      moveVideo(project, video, destGroupId);
    });
  }

  function newFolderDialog(project) {
    const input = el("input", { class: "input", placeholder: "Folder name", autofocus: true });
    const create = el("button", { class: "btn btn-primary" }, "Create");
    const close = modal(el("div", {},
      el("h3", {}, "New folder"),
      el("div", { class: "form-row" }, input),
      el("div", { class: "modal-actions" }, create)
    ));
    create.addEventListener("click", async () => {
      const name = input.value.trim();
      if (!name) return;
      create.disabled = true;
      // Optimistic: the folder appears the instant you ask for it, on the
      // same reasoning as the status pill and a video's move — a create is
      // a small, fast gesture that should feel like one, and the write to
      // Dropbox happens invisibly behind it. Only undone if it's refused.
      const group = newGroup(name);
      project.groups = [...(project.groups || []), group];
      close();
      renderPage(currentProject);
      try {
        await createGroup(store, project.id, group);
      } catch (err) {
        project.groups = project.groups.filter((g) => g.id !== group.id);
        toast(`Could not create folder: ${err.message}`, "error");
        renderPage(currentProject);
      }
    });
    input.addEventListener("keydown", (e) => e.key === "Enter" && create.click());
  }

  async function askDeleteVideo(project, video) {
    const uploaded = video.versions.length;
    const ok = await confirmDialog({
      title: `Delete “${video.name}”?`,
      body: [
        uploaded
          ? `Deletes ${count(uploaded, "uploaded version")} and all comments on this video.`
          : "Deletes this video and any comments on it. No media was uploaded.",
        "Share links for this video stop working.",
        uploaded
          ? "Dropbox keeps deleted files for at least 30 days, so you can still restore them at dropbox.com."
          : null,
      ],
      confirmLabel: "Delete video",
    });
    if (!ok) return;

    try {
      const { revoked, filesRemoved } = await deleteVideo(store, project.id, video.id);
      toast(deleteMessage(`“${video.name}”`, revoked, filesRemoved), filesRemoved ? "info" : "error");
      draw();
    } catch (err) {
      toast(`Could not delete video: ${err.message}`, "error");
    }
  }

  // Drag & drop upload: dropping a video anywhere on the page opens the
  // regular upload dialog with the file preselected.
  function wireDropZone(page, project) {
    installDropGuard();
    const overlay = el("div", { class: "drop-overlay hidden" },
      el("div", { class: "drop-overlay-box" }, "Drop video to upload"));
    page.append(overlay);

    const hasFiles = (e) => e.dataTransfer?.types?.includes("Files");
    let depth = 0;
    const hide = () => { depth = 0; overlay.classList.add("hidden"); };

    page.addEventListener("dragenter", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      overlay.classList.remove("hidden");
    });
    page.addEventListener("dragover", (e) => hasFiles(e) && e.preventDefault());
    page.addEventListener("dragleave", (e) => {
      if (!hasFiles(e)) return;
      if (--depth <= 0) hide();
    });
    page.addEventListener("drop", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      hide();
      const files = [...e.dataTransfer.files];
      const file = files.find((f) => VIDEO_FILE.test(f.type) || VIDEO_FILE.test(f.name));
      if (!file) return toast("That doesn't look like a video — drop an MP4, WebM or MOV file.", "error");
      if (file.size > MAX_INAPP_UPLOAD) {
        return toast(OVER_LIMIT_MSG, "error");
      }
      if (files.length > 1) toast("One file at a time — using the first video.");
      addVideoDialog(project, null, file);
    });
  }

  function addVideoDialog(project, existingVideo = null, droppedFile = null) {
    const droppedName = droppedFile ? droppedFile.name.replace(/\.[^.]+$/, "") : "";
    const nameInput = el("input", { class: "input", placeholder: "Video name", value: existingVideo?.name || droppedName });
    const fpsInput = el("input", { class: "input input-sm", type: "number", step: "0.001", min: "1", value: String(existingVideo?.fps || CONFIG.DEFAULT_FPS) });
    const labelInput = el("input", { class: "input", placeholder: existingVideo ? "Version label (e.g. Client notes round 1)" : "Version label (optional)" });
    const fileInput = el("input", { class: "input", type: "file", accept: "video/mp4,video/webm,video/quicktime" });
    if (droppedFile) {
      const dt = new DataTransfer();
      dt.items.add(droppedFile);
      fileInput.files = dt.files;
    }
    const progress = el("progress", { class: "upload-progress hidden", max: "1", value: "0" });
    const progressText = el("p", { class: "dim hint upload-progress-text hidden" }, "");
    const fpsHint = el("p", { class: "dim hint fps-hint hidden" }, "");
    const upload = el("button", { class: "btn btn-primary" }, existingVideo ? "Upload new version" : "Upload");

    const close = modal(el("div", {},
      el("h3", {}, existingVideo ? `New version of “${existingVideo.name}”` : "Add video"),
      el("p", { class: "dim hint" }, "Export H.264 MP4 (AAC audio) for browser playback — not ProRes or HEVC."),
      existingVideo ? null : el("div", { class: "form-row" }, el("label", {}, "Name"), nameInput),
      el("div", { class: "form-row" }, el("label", {}, "Frame rate"), fpsInput),
      fpsHint,
      el("div", { class: "form-row" }, el("label", {}, "Label"), labelInput),
      el("div", { class: "form-row" }, fileInput),
      progress,
      progressText,
      el("div", { class: "modal-actions" }, upload)
    ));

    // Read the real frame rate off the chosen file. A rate the user typed in
    // themselves is never overwritten — it's only reported against.
    let fpsEdited = false;
    fpsInput.addEventListener("input", () => { fpsEdited = true; });

    let detectRun = 0;
    async function detectFileFps(file) {
      const run = ++detectRun;
      if (!file) {
        fpsHint.classList.add("hidden");
        return;
      }
      fpsHint.classList.remove("hidden");
      fpsHint.textContent = "Reading frame rate…";

      let result = null;
      try {
        result = await detectFps(file);
      } catch {
        result = null;
      }
      if (run !== detectRun) return; // a newer file was picked meanwhile

      if (!result) {
        fpsHint.textContent = "Couldn't read the frame rate from this file — check the value above.";
        return;
      }
      if (fpsEdited) {
        fpsHint.textContent = `This file looks like ${result.fps} fps — keeping the rate you typed.`;
        return;
      }
      const previous = Number(fpsInput.value);
      fpsInput.value = String(result.fps);
      const how = result.source === "container"
        ? `Detected ${result.fps} fps from the file.`
        : `Measured about ${result.fps} fps by playing the file.`;
      // Changing an existing video's rate is worth calling out explicitly.
      fpsHint.textContent = existingVideo && previous && previous !== result.fps
        ? `${how} “${existingVideo.name}” was set to ${previous} fps — uploading applies the new rate.`
        : how;
    }

    fileInput.addEventListener("change", () => detectFileFps(fileInput.files[0]));
    if (droppedFile) detectFileFps(droppedFile);

    upload.addEventListener("click", async () => {
      const file = fileInput.files[0];
      if (!file) return toast("Choose a video file first.", "error");
      if (file.size > MAX_INAPP_UPLOAD) {
        return toast(OVER_LIMIT_MSG, "error");
      }
      const name = existingVideo?.name || nameInput.value.trim() || file.name.replace(/\.[^.]+$/, "");
      upload.disabled = true;
      progress.classList.remove("hidden");
      progressText.classList.remove("hidden");
      const totalMB = file.size / (1024 * 1024);
      try {
        // A video added while looking at a folder lands in it — the same way
        // dropping a file into an open folder puts it there, not at the root.
        const entry = existingVideo || newVideoEntry(name, Number(fpsInput.value), groupId);
        const n = (existingVideo?.versions.at(-1)?.n || 0) + 1;
        const safeName = file.name.replace(/[^\w.-]+/g, "_");
        const path = `${mediaDir(projectId, entry.id)}/v${n}-${safeName}`;
        const accessToken = await getAccessToken();
        const meta = await dbx.uploadFile(path, file, {
          accessToken,
          onProgress: (f) => {
            progress.value = f;
            progressText.textContent =
              `${Math.round(f * 100)}% — ${(f * totalMB).toFixed(0)} of ${totalMB.toFixed(0)} MB. Keep this tab open.`;
          },
        });
        progressText.textContent = "Finishing up…";
        const version = { n, path: meta.path_display ?? path, uploadedAt: new Date().toISOString(), label: labelInput.value.trim() };
        await store.updateProject(projectId, (p) => {
          const existing = p.videos.find((v) => v.id === entry.id);
          if (existing) {
            existing.versions.push(version);
            existing.currentVersion = n;
            existing.fps = Number(fpsInput.value) || existing.fps;
          } else {
            p.videos.push({ ...entry, versions: [version], currentVersion: n });
          }
          return p;
        });
        close();
        toast(`Uploaded v${n} of “${name}”.`);
        draw();
      } catch (err) {
        toast(`Upload failed: ${err.message}`, "error");
        progress.classList.add("hidden");
        progressText.classList.add("hidden");
        upload.disabled = false;
      }
    });
  }

  // Register media files added directly in Dropbox (e.g. oversized exports).
  async function rescan(project) {
    toast("Scanning media folders…");
    try {
      let added = 0;
      for (const video of project.videos) {
        const known = new Set(video.versions.map((v) => v.path.toLowerCase()));
        const entries = await dbx.listFolder(mediaDir(projectId, video.id));
        for (const entry of entries) {
          if (entry[".tag"] !== "file" || known.has(entry.path_lower)) continue;
          const m = /^v(\d+)-/.exec(entry.name);
          const n = m ? Number(m[1]) : (video.versions.at(-1)?.n || 0) + 1;
          await store.updateProject(projectId, (p) => {
            const v = p.videos.find((x) => x.id === video.id);
            if (v && !v.versions.some((x) => x.n === n)) {
              v.versions.push({ n, path: entry.path_display, uploadedAt: new Date().toISOString(), label: "" });
              v.versions.sort((a, b) => a.n - b.n);
              v.currentVersion = Math.max(v.currentVersion, n);
            }
            return p;
          });
          added++;
        }
      }
      toast(added ? `Registered ${added} new file(s).` : "No new files found. Name files v1-…, v2-… inside each video's folder.");
      if (added) draw();
    } catch (err) {
      toast(`Rescan failed: ${err.message}`, "error");
    }
  }

  draw().catch((err) => {
    mount.replaceChildren(el("p", { class: "error-note" }, `Could not load project: ${err.message}`));
  });
}
