// One colour per person, derived from their name.
//
// Shared by the comment list and the timeline markers so the same author reads
// the same in both — that shared identity is the whole point, otherwise a
// coloured tick on the scrubber means nothing.

// Distinct hues that hold up on the dark surfaces and stay clear of the
// status colours (blue / amber / green), which carry their own meaning.
const PALETTE = [
  "#f0883e", // orange
  "#a371f7", // purple
  "#39c5cf", // cyan
  "#f778ba", // pink
  "#e3b341", // yellow
  "#7ee787", // mint
  "#ff7b72", // coral
  "#79c0ff", // sky
];

// FNV-1a: small, stable, and spreads short names better than summing codes.
// Exported because the video cards pick their cover art the same way — from a
// name, and needing the same name to keep giving the same answer.
export function hashString(str) {
  return hash(str);
}

function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const key = (name) => String(name || "").trim().toLowerCase() || "?";

// A hash alone collides far too readily to call the result "unique": eight
// slots and three people is already a coin-flip. So the hash only picks a
// preferred slot, and anyone landing on a taken one probes forward. Two people
// on the same video therefore never share a colour until there are more of
// them than slots.
//
// `names` is taken in a stable order (first appearance), so an arriving author
// takes a free slot instead of shuffling everyone else's colour.
export function buildAuthorColors(names) {
  const taken = new Set();
  const map = new Map();
  for (const name of names) {
    const k = key(name);
    if (map.has(k)) continue;
    let slot = hash(k) % PALETTE.length;
    for (let i = 0; i < PALETTE.length && taken.has(slot); i++) {
      slot = (slot + 1) % PALETTE.length;
    }
    taken.add(slot);
    map.set(k, PALETTE[slot]);
  }
  return map;
}

// Fallback for a lone name with no roster to deconflict against.
export function authorColor(name) {
  return PALETTE[hash(key(name)) % PALETTE.length];
}

// Resolver used by the UI: prefers the deconflicted map, falls back to the
// bare hash for an author who isn't in it yet (e.g. a comment mid-post).
export function colorResolver(map) {
  return (name) => map.get(key(name)) || authorColor(name);
}

// Up to two letters, so "Jane Doe" reads JD but "Joel" reads J.
export function authorInitials(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  const first = [...parts[0]][0] || "?";
  const second = parts.length > 1 ? [...parts[parts.length - 1]][0] : "";
  return (first + second).toUpperCase();
}
