// Owner share dialog: create/copy/revoke client review links (via worker).

import { el, toast, modal, fmtDate } from "./ui.js";
import * as api from "./worker-api.js";

export function openShareDialog({ projectId, video }) {
  if (!api.workerConfigured()) {
    toast("Share links need the Cloudflare Worker — see setup/SETUP.md (step 4–6).", "error");
    return;
  }
  if (!api.getAdminKey()) {
    toast("Enter your admin key in Settings first (top-right menu).", "error");
    return;
  }

  const labelInput = el("input", { class: "input", placeholder: "Who is this for? (e.g. Jane @ ACME)" });
  const expirySelect = el("select", { class: "select" },
    el("option", { value: "7" }, "Expires in 7 days"),
    el("option", { value: "30", selected: "selected" }, "Expires in 30 days"),
    el("option", { value: "90" }, "Expires in 90 days")
  );
  const createBtn = el("button", { class: "btn btn-primary" }, "Create link");
  const resultBox = el("div", { class: "share-result hidden" });
  const listBox = el("div", { class: "share-list" }, el("p", { class: "dim" }, "Loading existing links…"));

  modal(el("div", { class: "share-dialog" },
    el("h3", {}, `Share “${video.name}”`),
    el("p", { class: "dim hint" }, "Anyone with the link can watch and comment — no account needed."),
    el("div", { class: "form-row" }, labelInput),
    el("div", { class: "form-row" }, expirySelect, createBtn),
    resultBox,
    el("h4", {}, "Existing links"),
    listBox
  ));

  createBtn.addEventListener("click", async () => {
    createBtn.disabled = true;
    try {
      const days = Number(expirySelect.value);
      const expiresAt = new Date(Date.now() + days * 86400 * 1000).toISOString();
      const res = await api.createShare({ projectId, videoId: video.id, label: labelInput.value.trim(), expiresAt });
      const url = `${location.origin}/review.html?token=${res.token}`;
      const urlInput = el("input", { class: "input share-url", value: url, readOnly: true });
      resultBox.replaceChildren(
        urlInput,
        el("button", {
          class: "btn btn-sm",
          onClick: async () => {
            await navigator.clipboard.writeText(url);
            toast("Link copied.");
          },
        }, "Copy")
      );
      resultBox.classList.remove("hidden");
      urlInput.select();
      refreshList();
    } catch (err) {
      toast(`Could not create link: ${err.message}`, "error");
    } finally {
      createBtn.disabled = false;
    }
  });

  async function refreshList() {
    try {
      const res = await api.listShares();
      const mine = res.shares.filter((s) => s.videoId === video.id && !s.revoked);
      if (!mine.length) {
        listBox.replaceChildren(el("p", { class: "dim" }, "No active links for this video."));
        return;
      }
      listBox.replaceChildren(...mine.map((s) =>
        el("div", { class: "share-item" },
          el("span", {}, s.label || "Unnamed link"),
          el("span", { class: "dim" }, `expires ${fmtDate(s.expiresAt)}`),
          el("span", { class: "spacer" }),
          el("button", {
            class: "btn-link",
            onClick: async () => {
              await navigator.clipboard.writeText(`${location.origin}/review.html?token=${s.token}`);
              toast("Link copied.");
            },
          }, "Copy"),
          el("button", {
            class: "btn-link danger",
            onClick: async () => {
              try {
                await api.revokeShare(s.token);
                toast("Link revoked.");
                refreshList();
              } catch (err) {
                toast(`Could not revoke: ${err.message}`, "error");
              }
            },
          }, "Revoke")
        )
      ));
    } catch (err) {
      listBox.replaceChildren(el("p", { class: "error-note" }, `Could not load links: ${err.message}`));
    }
  }
  refreshList();
}
