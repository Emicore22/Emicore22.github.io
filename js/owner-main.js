// Entry point for index.html — the owner app.
// Hash routes: #/projects · #/p/<projectId> · #/p/<projectId>/v/<videoId>

import { CONFIG } from "./config.js";
import { el, toast, modal, spinner } from "./ui.js";
import * as auth from "./auth.js";
import * as api from "./worker-api.js";
import { ownerStore } from "./store.js";
import { renderProjectGrid, renderProjectDetail, mountSidebar } from "./projects.js";
import { mountReviewScreen } from "./review-screen.js";
import { openShareDialog } from "./share.js";
import { pullAdminKey, pushAdminKey } from "./settings.js";

const app = document.getElementById("app");
const store = ownerStore();
let activeScreen = null;
let sidebar = null;
let appBody = null;

function header() {
  return el("header", { class: "app-header" },
    el("a", { class: "brand", href: "#/projects" }, CONFIG.APP_NAME),
    el("span", { class: "spacer" }),
    el("button", { class: "btn-link", onClick: openSettings }, "Settings"),
    el("button", {
      class: "btn-link",
      onClick: async () => {
        await auth.disconnect();
        location.hash = "";
        boot();
      },
    }, "Disconnect")
  );
}

function openSettings() {
  const keyInput = el("input", {
    class: "input", type: "password", value: api.getAdminKey(),
    placeholder: "ADMIN_KEY from your worker setup",
  });
  const save = el("button", { class: "btn btn-primary" }, "Save");
  const close = modal(el("div", {},
    el("h3", {}, "Settings"),
    el("p", { class: "dim hint" },
      "The admin key lets this app manage share links and comments through your Cloudflare Worker. ",
      "It must match the ADMIN_KEY secret you set with wrangler."),
    el("div", { class: "form-row" }, el("label", {}, "Admin key"), keyInput),
    el("p", { class: "dim hint" }, "Saved to your Dropbox, so you only enter it once — any browser you sign in with picks it up."),
    el("p", { class: "dim hint" }, api.workerConfigured() ? `Worker: ${CONFIG.WORKER_URL}` : "Worker URL not set in js/config.js — share links are disabled."),
    el("div", { class: "modal-actions" }, save)
  ));
  save.addEventListener("click", async () => {
    save.disabled = true;
    try {
      await pushAdminKey(keyInput.value.trim());
      toast("Settings saved to your Dropbox.");
      close();
    } catch (err) {
      // pushAdminKey stores locally first, so this browser still works.
      toast(`Saved on this device only — Dropbox write failed: ${err.message}`, "error");
      save.disabled = false;
    }
  });
}

function authGate() {
  const connectBtn = el("button", { class: "btn btn-primary btn-lg", onClick: () => auth.connect() }, "Connect Dropbox");
  app.replaceChildren(
    el("div", { class: "auth-gate" },
      el("div", { class: "auth-card" },
        el("h1", {}, CONFIG.APP_NAME),
        el("p", { class: "dim" }, "Personal video review. Your videos and comments stay in your own Dropbox."),
        CONFIG.DROPBOX_APP_KEY.startsWith("YOUR_")
          ? el("p", { class: "error-note" }, "Setup needed: add your Dropbox app key in js/config.js (see setup/SETUP.md).")
          : connectBtn
      )
    )
  );
}

function teardownScreen() {
  if (activeScreen) {
    activeScreen.destroy();
    activeScreen = null;
  }
}

async function route() {
  teardownScreen();
  const main = document.getElementById("main");
  const hash = location.hash.replace(/^#\/?/, "");
  const parts = hash.split("/").filter(Boolean);

  if (parts[0] === "p" && parts[1] && parts[2] === "v" && parts[3]) {
    const [_, projectId, __, videoId] = parts;
    // The player wants the width the sidebar would otherwise take; "← Back"
    // is the way out of a project here, same as it always was.
    appBody.classList.add("review-mode");
    sidebar.setActive(projectId);
    main.replaceChildren(spinner("Loading video…"));
    try {
      const project = await store.loadProject(projectId);
      const video = project.videos.find((v) => v.id === videoId);
      if (!video) throw new Error("Video not found in manifest");
      if (!video.versions.length) throw new Error("This video has no uploaded versions yet");
      main.replaceChildren();
      activeScreen = mountReviewScreen(main, {
        mode: "owner",
        store,
        projectId,
        projectName: project.name,
        video,
        authorName: () => "Emi",
        pollComments: api.adminConfigured(),
        headerExtras: [
          el("button", { class: "btn-link", onClick: () => (location.hash = `#/p/${projectId}`) }, "← Back"),
        ],
        onStatusChange: async (status) => {
          await store.updateProject(projectId, (p) => {
            const v = p.videos.find((x) => x.id === videoId);
            if (v) v.status = status;
            return p;
          });
        },
      });
      // Share button sits in the top strip next to the status pill.
      main.querySelector(".review-top").append(
        el("button", { class: "btn btn-primary btn-sm", onClick: () => openShareDialog({ projectId, video }) }, "Share")
      );
    } catch (err) {
      main.replaceChildren(el("p", { class: "error-note" }, `Could not open video: ${err.message}`));
    }
  } else if (parts[0] === "p" && parts[1]) {
    appBody.classList.remove("review-mode");
    sidebar.setActive(parts[1]);
    renderProjectDetail(main, store, parts[1], {
      onOpenVideo: (pid, vid) => (location.hash = `#/p/${pid}/v/${vid}`),
      onBack: () => (location.hash = "#/projects"),
    });
  } else {
    appBody.classList.remove("review-mode");
    sidebar.setActive(null);
    renderProjectGrid(main, store, {
      onOpen: (pid) => (location.hash = `#/p/${pid}`),
    });
  }
}

async function boot() {
  try {
    await auth.handleRedirect();
  } catch (err) {
    toast(`Dropbox login failed: ${err.message}`, "error");
  }
  if (!auth.isAuthed()) {
    authGate();
    return;
  }
  appBody = el("div", { class: "app-body" }, el("main", { id: "main" }));
  app.replaceChildren(header(), appBody);
  // Prepended, so the sidebar takes the first slot in app-body ahead of the
  // #main it was built around, rather than owning a container of its own.
  sidebar = mountSidebar(appBody, store, {
    onOpen: (pid) => (location.hash = `#/p/${pid}`),
    onAllProjects: () => (location.hash = "#/projects"),
  });
  // Before routing, so screens see the right adminConfigured() state.
  try {
    await pullAdminKey();
  } catch {
    // Offline or unreadable settings — fall back to whatever this browser has.
  }
  route();
}

window.addEventListener("hashchange", () => {
  if (auth.isAuthed()) route();
});
boot();
