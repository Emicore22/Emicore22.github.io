// Comment sidebar: composer (with frozen timecode chip + annotate toggle),
// list with click-to-seek, resolve/delete (owner), version badges + filter.

import { el, fmtDate } from "./ui.js";
import { secondsToTimecode } from "./timecode.js";
import { authorInitials } from "./authors.js";

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

    // Replies live in the same flat list, tied to their parent by parentId.
    const replies = new Map();
    for (const c of this.comments) {
      if (!c.parentId) continue;
      if (!replies.has(c.parentId)) replies.set(c.parentId, []);
      replies.get(c.parentId).push(c);
    }
    for (const thread of replies.values()) {
      thread.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    }

    // Filters apply to the note; its replies follow it either way.
    const visible = this.comments
      .filter((c) => !c.parentId)
      .filter((c) => !(this.hideResolved && c.resolved))
      .filter((c) => this.versionFilter === "all" || String(c.version) === this.versionFilter)
      .sort((a, b) => a.timeSec - b.timeSec || a.createdAt.localeCompare(b.createdAt));

    if (!visible.length) {
      this.listEl.replaceChildren(el("p", { class: "dim empty-note" }, "No comments yet."));
      return;
    }

    this.listEl.replaceChildren(
      ...visible.map((c) => this._renderThread(c, replies.get(c.id) || [], fps))
    );
  }

  // Colour-coded initials, matching this author's ticks on the timeline.
  _avatar(name) {
    const color = this.opts.colorFor?.(name) || "var(--text-dim)";
    return el("span", {
      class: "avatar", style: `--avatar: ${color}`, title: name, "aria-hidden": "true",
    }, authorInitials(name));
  }

  _renderThread(c, thread, fps) {
    // Resolved state reads as a property of the note, so it sits in the header
    // rather than down among the actions. No label: it is the only checkbox on
    // a comment, and it turns green when ticked.
    const resolveBox = this.opts.mode === "owner"
      ? el("input", {
          type: "checkbox",
          class: "resolve-check",
          checked: c.resolved,
          title: c.resolved ? "Resolved — click to reopen" : "Mark as resolved",
          "aria-label": c.resolved ? "Resolved. Click to reopen" : "Mark as resolved",
          onChange: (e) => {
            e.stopPropagation();
            const on = e.target.checked;
            // Grey the note now rather than after the write lands: saving is a
            // round trip to Dropbox, and the dimming is the actual feedback.
            // The review screen puts it back if the write is refused.
            c.resolved = on;
            item.classList.toggle("resolved", on);
            e.target.title = on ? "Resolved — click to reopen" : "Mark as resolved";
            e.target.setAttribute("aria-label", on ? "Resolved. Click to reopen" : "Mark as resolved");
            this.opts.onResolve(c.id, on);
            // With the filter on, a resolved note should leave the list.
            if (this.hideResolved) this.renderList();
          },
          onClick: (e) => e.stopPropagation(),
        })
      : null;

    const item = el(
      "div",
      { class: `comment${c.resolved ? " resolved" : ""}${c.id === this.selectedId ? " selected" : ""}` },
      el("div", { class: "comment-meta" },
        this._avatar(c.author),
        el("span", { class: "comment-author" }, c.author + (c.isOwner ? " ★" : "")),
        el("span", { class: "badge" }, `v${c.version}`),
        el("span", { class: "dim comment-date" }, fmtDate(c.createdAt)),
        resolveBox
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

    if (thread.length) {
      item.append(el("div", { class: "comment-replies" },
        ...thread.map((r) => this._renderReply(r))));
    }

    const actions = el("div", { class: "comment-actions" },
      el("button", {
        class: "btn-link",
        onClick: (e) => {
          e.stopPropagation();
          this._toggleReplyBox(item, c);
        },
      }, "Reply")
    );

    if (this.opts.mode === "owner") {
      // Resolve now lives in the header; only Delete remains here.
      actions.append(
        el("button", {
          class: "btn-link danger",
          onClick: (e) => {
            e.stopPropagation();
            const warning = thread.length
              ? `Delete this comment and its ${thread.length} ${thread.length === 1 ? "reply" : "replies"}?`
              : "Delete this comment?";
            if (confirm(warning)) this.opts.onDelete(c.id);
          },
        }, "Delete")
      );
    }
    item.append(actions);
    return item;
  }

  _renderReply(r) {
    const reply = el("div", { class: "comment-reply" },
      el("div", { class: "comment-meta" },
        this._avatar(r.author),
        el("span", { class: "comment-author" }, r.author + (r.isOwner ? " ★" : "")),
        el("span", { class: "dim comment-date" }, fmtDate(r.createdAt))
      ),
      el("span", { class: "comment-text" }, r.text)
    );
    if (this.opts.mode === "owner") {
      reply.append(el("div", { class: "comment-actions" },
        el("button", {
          class: "btn-link danger",
          onClick: (e) => {
            e.stopPropagation();
            if (confirm("Delete this reply?")) this.opts.onDelete(r.id);
          },
        }, "Delete")
      ));
    }
    return reply;
  }

  // One reply box open at a time, inline under the note it belongs to.
  _toggleReplyBox(item, parent) {
    const existing = item.querySelector(".reply-box");
    if (existing) {
      existing.remove();
      this.replyingTo = null;
      return;
    }
    this.listEl.querySelectorAll(".reply-box").forEach((n) => n.remove());
    this.replyingTo = parent.id;

    const input = el("textarea", { class: "composer-text", rows: 2, placeholder: "Write a reply…" });
    const send = el("button", { class: "btn btn-primary btn-sm" }, "Reply");
    const cancel = el("button", { class: "btn btn-sm" }, "Cancel");
    const box = el("div", { class: "reply-box", onClick: (e) => e.stopPropagation() },
      input,
      el("div", { class: "composer-actions" }, cancel, send)
    );

    const submit = async () => {
      const text = input.value.trim();
      if (!text) return;
      send.disabled = true;
      cancel.disabled = true;
      try {
        await this.opts.onReply({ text, parentId: parent.id });
        this.replyingTo = null;
        // The list re-renders from the refreshed comments, dropping the box.
      } catch {
        send.disabled = false;
        cancel.disabled = false;
      }
    };
    send.addEventListener("click", submit);
    cancel.addEventListener("click", (e) => {
      e.stopPropagation();
      box.remove();
      this.replyingTo = null;
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
      if (e.key === "Escape") { e.stopPropagation(); box.remove(); this.replyingTo = null; }
    });

    item.append(box);
    input.focus();
  }

  // Public entry point for selecting a note from outside the panel — used by
  // the timeline markers, which need the same seek-and-highlight behaviour as
  // clicking the note itself.
  select(c) {
    this._select(c);
    this.listEl.querySelector(".comment.selected")?.scrollIntoView({ block: "nearest" });
  }

  _select(c) {
    this.selectedId = c.id;
    this.opts.onSeek(c);
    this.renderList();
  }
}
