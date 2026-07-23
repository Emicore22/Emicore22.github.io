// Entry point for review.html — the client-facing reviewer page.
// Opened as review.html?token=s-… ; talks only to the Cloudflare Worker.

import { CONFIG } from "./config.js";
import { el, modal, spinner } from "./ui.js";
import * as api from "./worker-api.js";
import { reviewerStore } from "./store.js";
import { mountReviewScreen } from "./review-screen.js";

const NAME_KEY = "kf_reviewer_name";
const app = document.getElementById("app");

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

  const store = reviewerStore(token);
  app.replaceChildren(
    el("header", { class: "app-header" },
      el("span", { class: "brand" }, CONFIG.APP_NAME),
      el("span", { class: "dim" }, session.project.name),
      el("span", { class: "spacer" }),
      el("span", { class: "dim" }, name)
    ),
    el("main", { id: "main" })
  );

  const screen = mountReviewScreen(document.getElementById("main"), {
    mode: "reviewer",
    store,
    projectId: session.project.id,
    projectName: session.project.name,
    video: session.video,
    authorName: () => localStorage.getItem(NAME_KEY) || "Reviewer",
    pollComments: true,
  });
  screen.setComments(session.comments);
}

boot();
