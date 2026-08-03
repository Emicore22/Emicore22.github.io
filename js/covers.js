// Gradient cover art for a video or folder card. There is no thumbnail to
// show by default — nobody has made one, and the file itself lives behind a
// temporary link — but a name is always there, so the name picks the
// gradient. Same name, same colours, every time the card is drawn, which is
// what makes it recognisable at a glance.
//
// Shared by the owner's project browser and the reviewer's folder grid —
// the two are meant to look like the same card, seen from either side, and
// that includes the real frame that fades in over the gradient once a card's
// video has actually decoded — posterFrameVideo below is that frame.

import { hashString } from "./authors.js";
import { el } from "./ui.js";

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

// A frame a little way into the cut, rather than the very first one — the
// first frame of an edit is black more often than not.
const POSTER_AT = (duration) => Math.min(1, (duration || 0) * 0.1) || 0;

// How long the cut runs, as mm:ss. The timecode module deals in frames, which
// is the right answer on the review screen and far more than a card needs.
export function clockLength(seconds) {
  const total = Math.round(seconds);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

// The gradient stays underneath. It is what shows while the frame is on its
// way, and what stays if Dropbox declines the link or the browser cannot
// decode the file — ProRes and HEVC never will, and this app is used with
// exports straight out of an NLE.
// The part every poster frame shares, video card or mosaic tile alike: a
// muted <video> that decodes to a frame a little way in and fades from
// nothing to that frame once it's actually there, never a flash of black.
// preload:"metadata" is what keeps this cheap — the browser reads just
// enough of the file to know its duration and dimensions, not the frames.
export function posterFrameVideo(extra) {
  const preview = el("video", {
    class: "video-preview",
    muted: true, playsInline: true, preload: "metadata",
    tabindex: "-1", "aria-hidden": "true",
    ...extra,
  });
  let posterTime = 0;
  preview.addEventListener("loadedmetadata", () => {
    posterTime = POSTER_AT(preview.duration);
    preview.currentTime = posterTime;
  });
  preview.addEventListener("seeked", () => preview.classList.add("ready"), { once: true });
  return { preview, getPosterTime: () => posterTime };
}
