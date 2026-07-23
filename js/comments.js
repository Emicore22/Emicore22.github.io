// Comment sidebar: composer (with frozen timecode chip + annotate toggle),
// list with click-to-seek, resolve/delete (owner), version badges + filter.

import { el, fmtDate } from "./ui.js";
import { secondsToTimecode } from "./timecode.js";

export class CommentsPanel {
  constructor(mount, opts) {
    // opts: {mode, fps(), currentVersion(), currentTime(), onSeek(comment),
    //        onPost({text,timeSec}), onResolve(id,resolved), onDelete(id),
    //        onAnnotateToggle(active)}
    this.opts = opts;
    this.comments = [];
    this.frozenTime = null;      // set while the composer is in use
    this.selectedId = null;
    this.hideResolved = false;
    this.versionFilter = "all";
    this.annotating = false;

    this.tcChip = el("button", { class: "tc-chip", title: "Comment is pinned to this frame" }, "00:00:00:00");
    this.annotBtn = el("button", { class: "ctrl-btn annot-toggle", title: "Draw on frame" }, "✏️");
    this.textarea = el("textarea", {
      class: "composer-text",
      placeholder: "Leave a comment at the current frame…",
      rows: 2,
    });
    this.postBtn = el("button", { class: "btn btn-primary btn-sm" }, "Post");

    this.filterSelect = el("select", { class: "select select-sm" }, el("option", { value: "all" }, "All versions"));
    const hideResolvedLabel = el(
      "label", { class: "check-label" },
      el("input", { type: "checkbox", onChange: (e) => { this.hideResolved = e.target.checked; this.renderList(); } }),
      "Hide resolved"
    );

    this.listEl = el("div", { class: "comment-list" });

    this.root = el(
      "aside", { class: "comments-panel" },
      el("div", { class: "comments-head" },
        el("h3", {}, "Comments"),
        el("div", { class: "comments-filters" }, this.filterSelect, hideResolvedLabel)
      ),
      this.listEl,
      el("div", { class: "composer" },
        el("div", { class: "composer-top" }, this.tcChip, this.annotBtn),
        this.textarea,
        el("div", { class: "composer-actions" }, this.postBtn)
      )
    );
    mount.append(this.root);

    // ── behavior ──
    this.textarea.addEventListener("focus", () => {
      if (this.frozenTime == null) this.frozenTime = this.opts.currentTime();
      this._syncChip();
    });
    this.textarea.addEventListener("blur", () => {
      if (!this.textarea.value.trim() && !this.annotating) this.frozenTime = null;
    });
    this.tcChip.addEventListener("click", () => {
      // Re-pin the comment to wherever the playhead is now.
      this.frozenTime = this.opts.currentTime();
      this._syncChip();
    });
    this.annotBtn.addEventListener("click", () => {
      this.annotating = !this.annotating;
      if (this.annotating && this.frozenTime == null) this.frozenTime = this.opts.currentTime();
      this.annotBtn.classList.toggle("active", this.annotating);
      this.opts.onAnnotateToggle(this.annotating);
      this._syncChip();
    });
    this.postBtn.addEventListener("click", () => this._post());
    this.textarea.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) this._post();
    });
    this.filterSelect.addEventListener("change", () => {
      this.versionFilter = this.filterSelect.value;
      this.renderList();
    });

    this._chipTimer = setInterval(() => this._syncChip(), 200);
  }

  destroy() {
    clearInterval(this._chipTimer);
    this.root.remove();
  }

  focusComposer() {
    this.textarea.focus();
  }

  // Called by the review screen when annotation mode ends externally (Esc).
  setAnnotating(active) {
    this.annotating = active;
    this.annotBtn.classList.toggle("active", active);
    if (!active && !this.textarea.value.trim()) this.frozenTime = null;
  }

  get pinnedTime() {
    return this.frozenTime ?? this.opts.currentTime();
  }

  setVersions(versions, current) {
    this.filterSelect.replaceChildren(
      el("option", { value: "all" }, "All versions"),
      ...versions.map((v) => el("option", { value: String(v.n) }, `v${v.n} only`))
    );
    this.filterSelect.value = "all";
    this.currentShown = current;
  }

  setComments(comments) {
    this.comments = comments;
    this.renderList();
  }

  _syncChip() {
    this.tcChip.textContent = secondsToTimecode(this.pinnedTime, this.opts.fps());
    this.tcChip.classList.toggle("pinned", this.frozenTime != null);
  }

  async _post() {
    const text = this.textarea.value.trim();
    if (!text && !this.annotating) return;
    this.postBtn.disabled = true;
    try {
      await this.opts.onPost({ text, timeSec: this.pinnedTime });
      this.textarea.value = "";
      this.frozenTime = null;
      if (this.annotating) {
        this.annotating = false;
        this.annotBtn.classList.remove("active");
      }
      this._syncChip();
    } finally {
      this.postBtn.disabled = false;
    }
  }

  renderList() {
    const fps = this.opts.fps();
    const visible = this.comments
      .filter((c) => !(this.hideResolved && c.resolved))
      .filter((c) => this.versionFilter === "all" || String(c.version) === this.versionFilter)
      .sort((a, b) => a.timeSec - b.timeSec || a.createdAt.localeCompare(b.createdAt));

    if (!visible.length) {
      this.listEl.replaceChildren(el("p", { class: "dim empty-note" }, "No comments yet."));
      return;
    }

    this.listEl.replaceChildren(
      ...visible.map((c) => {
        const item = el(
          "div",
          { class: `comment${c.resolved ? " resolved" : ""}${c.id === this.selectedId ? " selected" : ""}` },
          el("div", { class: "comment-meta" },
            el("span", { class: "comment-author" }, c.author + (c.isOwner ? " ★" : "")),
            el("span", { class: "badge" }, `v${c.version}`),
            el("span", { class: "dim comment-date" }, fmtDate(c.createdAt))
          ),
          el("div", { class: "comment-body" },
            el("button", { class: "tc-chip tc-link" }, secondsToTimecode(c.timeSec, fps)),
            c.annotation ? el("span", { class: "annot-flag", title: "Has drawing" }, "✏️") : null,
            el("span", { class: "comment-text" }, c.text)
          )
        );

        item.querySelector(".tc-link").addEventListener("click", (e) => {
          e.stopPropagation();
          this._select(c);
        });
        item.addEventListener("click", () => this._select(c));

        if (this.opts.mode === "owner") {
          const actions = el("div", { class: "comment-actions" },
            el("label", { class: "check-label" },
              el("input", {
                type: "checkbox",
                checked: c.resolved,
                onChange: (e) => {
                  e.stopPropagation();
                  this.opts.onResolve(c.id, e.target.checked);
                },
                onClick: (e) => e.stopPropagation(),
              }),
              "Resolved"
            ),
            el("button", {
              class: "btn-link danger",
              onClick: (e) => {
                e.stopPropagation();
                if (confirm("Delete this comment?")) this.opts.onDelete(c.id);
              },
            }, "Delete")
          );
          item.append(actions);
        }
        return item;
      })
    );
  }

  _select(c) {
    this.selectedId = c.id;
    this.opts.onSeek(c);
    this.renderList();
  }
}
