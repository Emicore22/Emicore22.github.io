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

// Owner gets a clickable pill cycling through a menu; reviewer gets read-only.
export function statusPill(status, { editable = false, onChange } = {}) {
  const meta = STATUSES[status] || STATUSES.in_review;
  const pill = el("button", { class: `status-pill ${meta.cls}`, disabled: editable ? null : "disabled" }, meta.label);
  if (editable) {
    pill.addEventListener("click", () => {
      const keys = Object.keys(STATUSES);
      const next = keys[(keys.indexOf(status) + 1) % keys.length];
      onChange(next);
    });
    pill.title = "Click to change status";
  }
  return pill;
}
