// Small DOM helpers shared by both pages.

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === "class") node.className = v;
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k in node && typeof v !== "string") {
      node[k] = v;
    } else {
      node.setAttribute(k, v);
    }
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(child));
  }
  return node;
}

export function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

let toastTimer = null;
export function toast(message, kind = "info") {
  let node = document.querySelector(".toast");
  if (!node) {
    node = el("div", { class: "toast" });
    document.body.append(node);
  }
  node.textContent = message;
  node.dataset.kind = kind;
  node.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove("show"), 3500);
}

// Opens a modal containing `content`; returns a close() function.
// Resolves clean teardown of Escape/backdrop handlers.
export function modal(content, { closable = true } = {}) {
  const backdrop = el("div", { class: "modal-backdrop" });
  const box = el("div", { class: "modal", role: "dialog" }, content);
  backdrop.append(box);
  document.body.append(backdrop);

  function close() {
    backdrop.remove();
    document.removeEventListener("keydown", onKey);
  }
  function onKey(e) {
    if (e.key === "Escape" && closable) close();
  }
  if (closable) {
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) close();
    });
    document.addEventListener("keydown", onKey);
  }
  return close;
}

// Confirmation for destructive actions; resolves true only if the user agrees.
// `body` takes strings (rendered as dim paragraphs) or ready-made nodes.
// Pass `requireText` to make the user type that word out first — for deletes
// that take other content down with them.
export function confirmDialog({ title, body = [], confirmLabel = "Delete", requireText = null }) {
  return new Promise((resolve) => {
    const confirm = el("button", { class: "btn btn-danger", disabled: !!requireText }, confirmLabel);
    const cancel = el("button", { class: "btn" }, "Cancel");
    const input = requireText
      ? el("input", { class: "input", placeholder: `Type “${requireText}” to confirm`, autofocus: true })
      : null;

    const lines = (Array.isArray(body) ? body : [body])
      .filter(Boolean)
      .map((b) => (typeof b === "string" ? el("p", { class: "dim" }, b) : b));

    const close = modal(
      el("div", {},
        el("h3", {}, title),
        ...lines,
        input ? el("div", { class: "form-row" }, input) : null,
        el("div", { class: "modal-actions" }, cancel, confirm)
      ),
      { closable: false }
    );

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      document.removeEventListener("keydown", onKey);
      close();
      resolve(value);
    };
    function onKey(e) {
      if (e.key === "Escape") finish(false);
    }
    document.addEventListener("keydown", onKey);

    if (input) {
      input.addEventListener("input", () => {
        confirm.disabled = input.value.trim() !== requireText;
      });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !confirm.disabled) finish(true);
      });
    }
    confirm.addEventListener("click", () => finish(true));
    cancel.addEventListener("click", () => finish(false));
    (input || cancel).focus();
  });
}

// A menu pinned to a point on screen — the card's right-click menu, and the
// same menu opened from a button so it is not the only way to find it.
// `items` takes {label, danger?, onSelect}; falsy entries are skipped.
let openMenu = null;

export function closeContextMenu() {
  if (!openMenu) return;
  const { node, teardown } = openMenu;
  openMenu = null;          // cleared first: teardown must not re-enter here
  teardown();
  node.remove();
}

export function contextMenu(x, y, items) {
  closeContextMenu();

  const menu = el("div", { class: "context-menu", role: "menu" },
    ...items.filter(Boolean).map((item) =>
      el("button", {
          class: `context-menu-item${item.danger ? " danger" : ""}`,
          role: "menuitem", type: "button",
          onClick: () => { closeContextMenu(); item.onSelect(); },
        }, item.label)
    )
  );
  document.body.append(menu);

  // Positioned after mounting, because keeping it on screen means measuring it.
  const pad = 8;
  const { width, height } = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(pad, Math.min(x, window.innerWidth - width - pad))}px`;
  menu.style.top = `${Math.max(pad, Math.min(y, window.innerHeight - height - pad))}px`;

  const onPointerDown = (e) => { if (!menu.contains(e.target)) closeContextMenu(); };
  const onKey = (e) => {
    if (e.key === "Escape") {
      // Swallowed, or an open dialog behind the menu would close along with it.
      e.stopPropagation();
      closeContextMenu();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const entries = [...menu.querySelectorAll(".context-menu-item")];
    const from = entries.indexOf(document.activeElement);
    const step = e.key === "ArrowDown" ? 1 : -1;
    entries[(from + step + entries.length) % entries.length]?.focus();
  };
  // The menu is pinned to the viewport, so anything that moves the card out
  // from under it leaves it pointing at nothing.
  const onReflow = () => closeContextMenu();

  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("scroll", onReflow, true);
  window.addEventListener("resize", onReflow);

  openMenu = {
    node: menu,
    teardown() {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onReflow, true);
      window.removeEventListener("resize", onReflow);
    },
  };

  menu.querySelector(".context-menu-item")?.focus();
  return closeContextMenu;
}

export function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function uid(prefix) {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return prefix ? `${prefix}-${hex}` : hex;
}

export function spinner(label = "Loading…") {
  return el("div", { class: "spinner-wrap" }, el("div", { class: "spinner" }), el("p", { class: "dim" }, label));
}
