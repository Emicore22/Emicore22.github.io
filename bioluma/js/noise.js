/* Classic Perlin noise, seeded from the app's RNG so a seed reproduces the
   same flow field. Used for drift, turbulence and the curl field the swarms
   swim through — gradient noise rather than value noise because the grid
   artefacts of the latter are visible once you integrate motion through it. */

const GRAD3 = [
  [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0],
  [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
  [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1],
];

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a, b, t) => a + (b - a) * t;

export class Noise {
  constructor(rnd) {
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const t = p[i]; p[i] = p[j]; p[j] = t;
    }
    // Doubled so the lookups below never need a wrap test.
    this.perm = new Uint8Array(512);
    this.gi = new Uint8Array(512);
    for (let i = 0; i < 512; i++) {
      this.perm[i] = p[i & 255];
      this.gi[i] = this.perm[i] % 12;
    }
  }

  /** 3-D Perlin in roughly [-1, 1]. Feed time as z for evolving 2-D fields. */
  noise3(x, y, z) {
    const X = Math.floor(x) & 255, Y = Math.floor(y) & 255, Z = Math.floor(z) & 255;
    x -= Math.floor(x); y -= Math.floor(y); z -= Math.floor(z);
    const u = fade(x), v = fade(y), w = fade(z);
    const perm = this.perm, gi = this.gi;

    const A = perm[X] + Y, AA = perm[A] + Z, AB = perm[A + 1] + Z;
    const B = perm[X + 1] + Y, BA = perm[B] + Z, BB = perm[B + 1] + Z;

    const g = (h, px, py, pz) => {
      const q = GRAD3[gi[h]];
      return q[0] * px + q[1] * py + q[2] * pz;
    };

    return lerp(
      lerp(
        lerp(g(AA, x, y, z), g(BA, x - 1, y, z), u),
        lerp(g(AB, x, y - 1, z), g(BB, x - 1, y - 1, z), u), v),
      lerp(
        lerp(g(AA + 1, x, y, z - 1), g(BA + 1, x - 1, y, z - 1), u),
        lerp(g(AB + 1, x, y - 1, z - 1), g(BB + 1, x - 1, y - 1, z - 1), u), v),
      w);
  }

  /** Fractal sum — two octaves is plenty for motion and stays cheap per agent. */
  fbm(x, y, z, octaves = 2) {
    let sum = 0, amp = 1, norm = 0, f = 1;
    for (let i = 0; i < octaves; i++) {
      sum += amp * this.noise3(x * f, y * f, z * f);
      norm += amp;
      amp *= 0.5;
      f *= 2.03;
    }
    return sum / norm;
  }

  /** Divergence-free 2-D field: swirls and eddies with no sinks to pile up in. */
  curl(x, y, z, out) {
    const e = 0.0007;
    const n1 = this.noise3(x, y + e, z), n2 = this.noise3(x, y - e, z);
    const n3 = this.noise3(x + e, y, z), n4 = this.noise3(x - e, y, z);
    out.x = (n1 - n2) / (2 * e);
    out.y = -(n3 - n4) / (2 * e);
    return out;
  }
}
