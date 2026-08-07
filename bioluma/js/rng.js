/* A small seeded PRNG. Every random choice in the app draws from one of these,
   so a seed plus a parameter set reproduces a piece exactly — which is the
   whole point of a generative tool you might want to re-render later. */

/** Hashes an arbitrary string into the 32-bit state a generator starts from. */
export function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32 — fast, tiny, and good enough for visual noise. */
export function makeRng(seed) {
  let a = (typeof seed === 'string' ? hashSeed(seed) : seed >>> 0) || 1;
  const rnd = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rnd.range = (lo, hi) => lo + (hi - lo) * rnd();
  rnd.int = (lo, hi) => Math.floor(lo + (hi - lo + 1) * rnd());
  rnd.pick = (arr) => arr[Math.floor(rnd() * arr.length) % arr.length];
  /* Two-sided falloff: most values land near zero, which is what you want for
     per-agent jitter that should read as variation rather than chaos. */
  rnd.bell = () => (rnd() + rnd() + rnd()) / 1.5 - 1;
  return rnd;
}

/** A short human-typeable seed, so the seed field stays friendly. */
export function randomSeedWord() {
  const a = ['tidal', 'abyssal', 'coral', 'pelagic', 'benthic', 'lunar', 'saline',
    'drifting', 'nacre', 'kelp', 'brine', 'reef', 'siphon', 'medusa'];
  const b = ['bloom', 'swarm', 'current', 'trench', 'shoal', 'plume', 'wake',
    'tide', 'lantern', 'veil', 'pulse', 'spiral'];
  const p = (arr) => arr[Math.floor(Math.random() * arr.length)];
  return `${p(a)}-${p(b)}-${Math.floor(Math.random() * 900 + 100)}`;
}
