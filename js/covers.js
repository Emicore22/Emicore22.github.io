// Gradient cover art for a video or folder card. There is no thumbnail to
// show by default — nobody has made one, and the file itself lives behind a
// temporary link — but a name is always there, so the name picks the
// gradient. Same name, same colours, every time the card is drawn, which is
// what makes it recognisable at a glance.
//
// Shared by the owner's project browser and the reviewer's folder grid —
// the two are meant to look like the same card, seen from either side.

import { hashString } from "./authors.js";

const POSTERS = [
  ["#6d4aff", "#a78bfa", "#3b1e8f"], // violet
  ["#ff7a59", "#ffb37a", "#d94a7a"], // coral
  ["#22d3ee", "#7dd3fc", "#2563eb"], // cyan
  ["#e352c8", "#f9a8d4", "#7c2d8f"], // magenta
  ["#5b8cff", "#93c5fd", "#3730a3"], // indigo
  ["#a855f7", "#f0abfc", "#6d28d9"], // orchid
];

export function posterStyle(name) {
  const [g1, g2, g3] = POSTERS[hashString(name) % POSTERS.length];
  return `--g1:${g1}; --g2:${g2}; --g3:${g3}`;
}
