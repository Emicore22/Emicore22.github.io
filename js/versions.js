// Version stack switcher + approval status pill.

import { el } from "./ui.js";

export const STATUSES = {
  in_review: { label: "In Review", cls: "status-review" },
  needs_changes: { label: "Needs Changes", cls: "status-changes" },
  approved: { label: "Approved", cls: "status-approved" },
};

export function versionSwitcher(versions, current, onChange) {
  const select = el(
    "select", { class: "select version-select", title: "Switch version" },
    ...versions.slice().reverse().map((v) =>
      el("option", { value: String(v.n), selected: v.n === current ? "selected" : null },
        `v${v.n}${v.label ? ` — ${v.label}` : ""}`)
    )
  );
  select.addEventListener("change", () => onChange(Number(select.value)));
  return select;
}

const statusClasses = Object.values(STATUSES).map((s) => s.cls);

// Editable: a select styled as the pill, so every status is one click away
// and the current one is always visible. Otherwise a plain read-only pill.
export function statusPill(status, { editable = false, onChange } = {}) {
  const meta = STATUSES[status] || STATUSES.in_review;
  if (!editable) {
    return el("span", { class: `status-pill ${meta.cls}` }, meta.label);
  }

  const select = el(
    "select", { class: `status-pill status-select ${meta.cls}`, title: "Change status" },
    ...Object.entries(STATUSES).map(([value, s]) =>
      el("option", { value, selected: value === status ? "selected" : null }, s.label)
    )
  );
  select.addEventListener("change", () => {
    // Recolour on the spot. Saving takes a round trip to Dropbox, and the
    // colour is the only feedback there is — waiting for the write to land
    // makes the menu feel broken. The caller reverts if the save fails.
    const next = STATUSES[select.value] || meta;
    select.classList.remove(...statusClasses);
    select.classList.add(next.cls);
    onChange(select.value);
  });
  return select;
}
