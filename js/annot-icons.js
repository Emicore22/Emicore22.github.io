// Custom icons for the annotation tools — pen, arrow, box — kept out of raw
// emoji (✏️ ↗ ▭), which every platform renders differently (a full-colour
// pictograph on Windows, a different one on macOS) and which look nothing
// like the rest of the app's own monochrome, hand-drawn icon set.

const SVG_NS = "http://www.w3.org/2000/svg";

function strokePath(d) {
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", d);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.5");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  return path;
}

function outlineIcon(paths) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("class", "icon-16");
  svg.setAttribute("aria-hidden", "true");
  for (const d of paths) svg.append(strokePath(d));
  return svg;
}

// The three annotation-toolbar tools — same thin-line, currentColor style as
// the sidebar's chevron/grid/list icons, so drawing tools read as part of the
// same app rather than a different one bolted on.
export function penToolIcon() {
  return outlineIcon(["M4 12l6.5-6.5M9.5 3.5l3 3M3 13l1-3"]);
}
export function arrowToolIcon() {
  return outlineIcon(["M4 12L12 4", "M6 4H12V10"]);
}
export function boxToolIcon() {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("class", "icon-16");
  svg.setAttribute("aria-hidden", "true");
  const rect = document.createElementNS(SVG_NS, "rect");
  rect.setAttribute("x", "3");
  rect.setAttribute("y", "4");
  rect.setAttribute("width", "10");
  rect.setAttribute("height", "8");
  rect.setAttribute("rx", "1.5");
  rect.setAttribute("fill", "none");
  rect.setAttribute("stroke", "currentColor");
  rect.setAttribute("stroke-width", "1.5");
  svg.append(rect);
  return svg;
}

// The composer's "draw on frame" toggle sits in the player's own control row,
// beside play/pause/step/volume/full-screen — player.js's filled, 24×24
// Material-style icons, not this module's outline set, so it matches its
// row-mates instead of standing out among them.
export function penFilledIcon() {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d",
    "M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a.996.996 0 0 0 0-1.41l-2.34-2.34a.996.996 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z");
  path.setAttribute("fill", "currentColor");
  svg.append(path);
  return svg;
}
