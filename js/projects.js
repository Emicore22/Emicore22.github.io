// Owner project browser: project grid, project detail (video rows),
// in-app upload (≤800 MB) and "Rescan" for files dropped into Dropbox.

import { el, toast, modal, confirmDialog, fmtDate, spinner } from "./ui.js";
import { getAccessToken } from "./auth.js";
import * as dbx from "./dropbox.js";
import { createProject, deleteProject, deleteVideo, newVideoEntry, mediaDir } from "./store.js";
import { detectFps } from "./fps.js";
import { statusPill } from "./versions.js";
import { hashString } from "./authors.js";
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
              onKeydown: (e) => {
                if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(p.id); }
              },
            },
            el("button", {
              class: "btn-link danger card-delete",
              title: `Delete “${p.name}”`,
              "aria-label": `Delete project ${p.name}`,
              onClick: (e) => { e.stopPropagation(); askDeleteProject(store, p, draw); },
            }, "Delete"),
            el("h3", {}, p.name),
            el("p", { class: "dim" }, `Created ${fmtDate(p.createdAt)}`)
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

export function renderProjectDetail(mount, store, projectId, { onOpenVideo, onBack }) {
  mount.replaceChildren(spinner("Loading project…"));

  async function draw() {
    const project = await store.loadProject(projectId);
    const cards = project.videos.map((v) => {
      const open = () => onOpenVideo(project.id, v.id);
      const latest = v.versions.at(-1);
      return el("div", {
          class: "video-card", role: "button", tabindex: "0",
          "aria-label": `Open ${v.name}`,
          onClick: open,
          onKeydown: (e) => {
            // Only when the card itself has focus. The status menu and the
            // buttons inside it answer to Enter and Space too, and their
            // keypresses bubble through here on the way up.
            if (e.target !== e.currentTarget) return;
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
          },
        },
        el("div", { class: "video-poster", style: posterStyle(v.name) },
          videoStatusPill(v),
          el("button", {
            class: "btn-link danger card-delete",
            title: `Delete “${v.name}”`,
            "aria-label": `Delete video ${v.name}`,
            onClick: (e) => { e.stopPropagation(); askDeleteVideo(project, v); },
          }, "Delete"),
          el("div", { class: "video-poster-label" },
            el("h3", {}, v.name),
            el("p", {}, v.versions.length ? `v${v.currentVersion} · ${v.fps} fps` : "No media yet")
          )
        ),
        el("div", { class: "video-card-foot" },
          el("span", { class: "dim" }, latest ? `Updated ${fmtDate(latest.uploadedAt)}` : "Not uploaded"),
          el("span", { class: "spacer" }),
          el("button", {
            class: "btn-link",
            onClick: (e) => { e.stopPropagation(); addVideoDialog(project, v); },
          }, "+ version")
        )
      );
    });

    const page = el("div", { class: "page drop-target" },
      el("div", { class: "page-head" },
        el("button", { class: "btn-link", onClick: onBack }, "← Projects"),
        el("h1", {}, project.name),
        el("span", { class: "spacer" }),
        el("button", { class: "btn-link danger", onClick: () => askDeleteProject(store, project, onBack) }, "Delete project"),
        el("button", { class: "btn", onClick: () => rescan(project) }, "Rescan folder"),
        el("button", { class: "btn btn-primary", onClick: () => addVideoDialog(project) }, "+ Add video")
      ),
      cards.length
        ? el("div", { class: "video-grid" }, ...cards)
        : el("p", { class: "dim empty-note" },
            `No videos yet. Add one below ${MAX_LABEL} here (or drag & drop it onto this page), or drop bigger files into `,
            el("code", {}, `Dropbox/Apps/…/projects/${project.id}/media/`),
            " and hit Rescan.")
    );
    wireDropZone(page, project);
    mount.replaceChildren(page);
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
          draw();
        }
      },
    });
    // Opening the menu is not a request to open the video behind it.
    pill.addEventListener("click", (e) => e.stopPropagation());
    return pill;
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
        const entry = existingVideo || newVideoEntry(name, Number(fpsInput.value));
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
