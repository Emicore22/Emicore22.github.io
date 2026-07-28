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
