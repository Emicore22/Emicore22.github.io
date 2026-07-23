// Owner project browser: project grid, project detail (video rows),
// in-app upload (≤150 MB) and "Rescan" for files dropped into Dropbox.

import { el, toast, modal, fmtDate, spinner } from "./ui.js";
import { getAccessToken } from "./auth.js";
import * as dbx from "./dropbox.js";
import { createProject, newVideoEntry, mediaDir } from "./store.js";
import { STATUSES } from "./versions.js";
import { CONFIG } from "./config.js";

const MAX_INAPP_UPLOAD = 150 * 1024 * 1024;

export function renderProjectGrid(mount, store, { onOpen }) {
  mount.replaceChildren(spinner("Loading projects…"));
  store.loadIndex().then((index) => {
    const grid = el("div", { class: "project-grid" },
      ...index.projects.map((p) =>
        el("button", { class: "project-card", onClick: () => onOpen(p.id) },
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
    const rows = project.videos.map((v) => {
      const status = STATUSES[v.status] || STATUSES.in_review;
      return el("div", { class: "video-row", role: "button", tabindex: "0", onClick: () => onOpenVideo(project.id, v.id) },
        el("span", { class: "video-row-name" }, v.name),
        el("span", { class: "badge" }, v.versions.length ? `v${v.currentVersion}` : "no media"),
        el("span", { class: `status-pill ${status.cls}` }, status.label),
        el("span", { class: "dim" }, `${v.fps} fps`),
        el("span", { class: "spacer" }),
        el("button", {
          class: "btn btn-sm",
          onClick: (e) => { e.stopPropagation(); addVideoDialog(project, v); },
        }, "+ version")
      );
    });

    mount.replaceChildren(
      el("div", { class: "page" },
        el("div", { class: "page-head" },
          el("button", { class: "btn-link", onClick: onBack }, "← Projects"),
          el("h1", {}, project.name),
          el("span", { class: "spacer" }),
          el("button", { class: "btn", onClick: () => rescan(project) }, "Rescan folder"),
          el("button", { class: "btn btn-primary", onClick: () => addVideoDialog(project) }, "+ Add video")
        ),
        rows.length
          ? el("div", { class: "video-list" }, ...rows)
          : el("p", { class: "dim empty-note" },
              "No videos yet. Add one below 150 MB here, or drop bigger files into ",
              el("code", {}, `Dropbox/Apps/…/projects/${project.id}/media/`),
              " and hit Rescan.")
      )
    );
  }

  function addVideoDialog(project, existingVideo = null) {
    const nameInput = el("input", { class: "input", placeholder: "Video name", value: existingVideo?.name || "" });
    const fpsInput = el("input", { class: "input input-sm", type: "number", step: "0.001", min: "1", value: String(existingVideo?.fps || CONFIG.DEFAULT_FPS) });
    const labelInput = el("input", { class: "input", placeholder: existingVideo ? "Version label (e.g. Client notes round 1)" : "Version label (optional)" });
    const fileInput = el("input", { class: "input", type: "file", accept: "video/mp4,video/webm,video/quicktime" });
    const progress = el("progress", { class: "upload-progress hidden", max: "1", value: "0" });
    const upload = el("button", { class: "btn btn-primary" }, existingVideo ? "Upload new version" : "Upload");

    const close = modal(el("div", {},
      el("h3", {}, existingVideo ? `New version of “${existingVideo.name}”` : "Add video"),
      el("p", { class: "dim hint" }, "Export H.264 MP4 (AAC audio) for browser playback — not ProRes or HEVC."),
      existingVideo ? null : el("div", { class: "form-row" }, el("label", {}, "Name"), nameInput),
      el("div", { class: "form-row" }, el("label", {}, "Frame rate"), fpsInput),
      el("div", { class: "form-row" }, el("label", {}, "Label"), labelInput),
      el("div", { class: "form-row" }, fileInput),
      progress,
      el("div", { class: "modal-actions" }, upload)
    ));

    upload.addEventListener("click", async () => {
      const file = fileInput.files[0];
      if (!file) return toast("Choose a video file first.", "error");
      if (file.size > MAX_INAPP_UPLOAD) {
        return toast("Over 150 MB — drop the file into the project's media folder in Dropbox, then Rescan.", "error");
      }
      const name = existingVideo?.name || nameInput.value.trim() || file.name.replace(/\.[^.]+$/, "");
      upload.disabled = true;
      progress.classList.remove("hidden");
      try {
        const entry = existingVideo || newVideoEntry(name, Number(fpsInput.value));
        const n = (existingVideo?.versions.at(-1)?.n || 0) + 1;
        const safeName = file.name.replace(/[^\w.-]+/g, "_");
        const path = `${mediaDir(projectId, entry.id)}/v${n}-${safeName}`;
        const accessToken = await getAccessToken();
        const meta = await dbx.uploadFile(path, file, {
          accessToken,
          onProgress: (f) => (progress.value = f),
        });
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
        upload.disabled = false;
      }
    });
  }

  // Register media files added directly in Dropbox (e.g. >150 MB exports).
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
