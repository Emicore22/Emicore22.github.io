/* The simulation. It owns the agents — the little swimmers that leave paint —
   and the water they swim in. What *moves* them is a creature driver
   (js/creatures/*.js); everything shared between creatures lives here: the
   current, the seeded randomness, the neighbour lookup and the edges.

   An agent is a plain object rather than a class instance and the array is
   reused across resets: at two thousand agents times sixty frames the garbage
   from re-allocating would be the single biggest cost in the loop. */

import { makeRng } from './rng.js';
import { Noise } from './noise.js';

export const TAU = Math.PI * 2;
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;

/** Uniform-grid neighbour lookup, rebuilt each frame. Used by the schooling
    drivers, which would otherwise be O(n²) and unusable past a few hundred. */
export class Grid {
  constructor() { this.cells = new Map(); this.size = 1; }

  build(agents, cellSize) {
    this.cells.clear();
    this.size = Math.max(1, cellSize);
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      const key = ((a.x / this.size) | 0) * 73856093 ^ ((a.y / this.size) | 0) * 19349663;
      let bucket = this.cells.get(key);
      if (!bucket) this.cells.set(key, (bucket = []));
      bucket.push(a);
    }
  }

  /** Calls fn for every agent in the 3×3 block of cells around (x, y). */
  near(x, y, fn) {
    const cx = (x / this.size) | 0, cy = (y / this.size) | 0;
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        const bucket = this.cells.get((cx + ox) * 73856093 ^ (cy + oy) * 19349663);
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) fn(bucket[i]);
      }
    }
  }
}

export class Sim {
  constructor() {
    this.agents = [];
    this.grid = new Grid();
    this.w = 1000;
    this.h = 1250;
    this.t = 0;
    this.frame = 0;
    this.pointer = { x: 0, y: 0, inside: false, down: false };
    this.driver = null;
    this._f = { x: 0, y: 0 };
    this.setSeed('bioluma');
  }

  /** Reference length — every size in the app is expressed against the short
      edge, so a piece looks the same at 720 and at 2160. */
  get ref() { return Math.min(this.w, this.h); }

  setSeed(seed) {
    this.seed = seed;
    this.rnd = makeRng(String(seed));
    this.noise = new Noise(makeRng(String(seed) + '~flow'));
  }

  setSize(w, h) {
    const first = !this._sized;
    const sx = w / this.w, sy = h / this.h;
    this.w = w; this.h = h;
    this._sized = true;
    // Keep the composition when the stage is resized rather than snapping
    // everything back to the middle.
    if (!first) for (const a of this.agents) { a.x *= sx; a.y *= sy; a.px *= sx; a.py *= sy; }
  }

  setDriver(driver, P) {
    this.driver = driver;
    this.reset(P);
  }

  /** Rebuilds the swarm from scratch: new seed, new agent count, new creature. */
  reset(P) {
    this.setSeed(P.seed);
    this.t = 0;
    this.frame = 0;
    const n = Math.round(P.count);
    const rnd = this.rnd;

    if (this.agents.length > n) this.agents.length = n;
    while (this.agents.length < n) this.agents.push({});

    for (let i = 0; i < n; i++) {
      const a = this.agents[i];
      a.i = i;
      a.x = a.px = this.w * rnd();
      a.y = a.py = this.h * rnd();
      a.vx = 0; a.vy = 0;
      a.ox = 0; a.oy = 0; a.ovx = 0; a.ovy = 0;   // elastic offset from the current
      a.b = 0; a.k = 0; a.u = rnd(); a.d = rnd(); // body, limb, position along limb, depth
      a.ci = i;                                   // palette index when colouring per agent
      a.hj = rnd.bell();                          // hue jitter, -1..1
      a.br = rnd();                               // below Bloom share? then it carries colour
      a.sz = 0.5 + rnd() * rnd() * 2;             // size multiplier, skewed small
      a.ph = rnd() * TAU;                         // phase offset for anything oscillating
      a.jump = true;                              // suppress the trail for one frame
      a.hidden = false;
    }

    if (this.driver) this.driver.init(this, P);
    for (const a of this.agents) { a.px = a.x; a.py = a.y; a.jump = true; }
  }

  step(dt, P) {
    const sdt = dt * P.speed;
    this.t += sdt;
    this.frame++;

    for (let i = 0; i < this.agents.length; i++) {
      const a = this.agents[i];
      a.px = a.x; a.py = a.y; a.jump = false;
    }

    if (this.driver) this.driver.update(this, sdt, P);

    for (let i = 0; i < this.agents.length; i++) {
      const a = this.agents[i];
      a.vx = a.x - a.px; a.vy = a.y - a.py;
    }
  }

  /* ── the water ──────────────────────────────────────────────────────────── */

  /** Acceleration of the current at a point, in px/s². Turbulence is a curl
      field (no sinks, so nothing piles up), plus an optional rotation about
      the centre, a radial gather, and the pointer. */
  fieldForce(x, y, P, out = this._f) {
    const ref = this.ref;
    const s = P.flowScale > 0 ? 1 / (ref * P.flowScale * 0.9) : 0;
    this.noise.curl(x * s, y * s, this.t * P.flowSpeed * 0.25, out);

    const k = P.flow * ref * 0.0016;
    let fx = out.x * k, fy = out.y * k;

    const cx = this.w * 0.5, cy = this.h * 0.5;
    const dx = x - cx, dy = y - cy;
    const dist = Math.hypot(dx, dy) || 1;

    if (P.swirl) {
      const g = P.swirl * ref * 0.0022 * Math.min(1, dist / (ref * 0.5));
      fx += -dy / dist * g;
      fy += dx / dist * g;
    }
    if (P.gather) {
      const g = P.gather * ref * 0.0026 * Math.min(1.6, dist / (ref * 0.35));
      fx += -dx / dist * g;
      fy += -dy / dist * g;
    }
    if (P.pointer && this.pointer.inside) {
      const px = this.pointer.x - x, py = this.pointer.y - y;
      const pd = Math.hypot(px, py) || 1;
      const falloff = 1 / (1 + (pd / (ref * 0.28)) ** 2);
      const g = P.pointer * ref * 0.02 * falloff * (this.pointer.down ? 2.5 : 1);
      fx += px / pd * g;
      fy += py / pd * g;
    }
    out.x = fx; out.y = fy;
    return out;
  }

  /** A per-agent offset that the current tugs on but a spring always brings
      home. Body-shaped creatures use this so the current ruffles their limbs
      without dissolving the animal. */
  elastic(a, dt, P, strength = 1, springiness = 3.2) {
    const f = this.fieldForce(a.x + a.ox, a.y + a.oy, P, this._f);
    a.ovx += (f.x * strength - a.ox * springiness) * dt;
    a.ovy += (f.y * strength - a.oy * springiness) * dt;
    const damp = Math.exp(-2.6 * dt);
    a.ovx *= damp; a.ovy *= damp;
    a.ox += a.ovx * dt; a.oy += a.ovy * dt;
    a.x += a.ovx * dt; a.y += a.ovy * dt;
  }

  /** Fine-grained wobble, in px/s². Keeps identical agents from moving as one. */
  jitterForce(a, P, out = this._f) {
    const j = P.jitter * this.ref * 0.02;
    const n = this.noise;
    const q = a.i * 0.07;
    out.x = n.noise3(q, this.t * 0.9, 11.3) * j;
    out.y = n.noise3(q, this.t * 0.9, 47.7) * j;
    return out;
  }

  /** Toroidal edges with a margin, so creatures cruise off one side and back in
      the other instead of piling up against a wall. */
  wrap(o, margin = 0.12) {
    const mx = this.w * margin, my = this.h * margin;
    let jumped = false;
    if (o.x < -mx) { o.x += this.w + mx * 2; jumped = true; }
    else if (o.x > this.w + mx) { o.x -= this.w + mx * 2; jumped = true; }
    if (o.y < -my) { o.y += this.h + my * 2; jumped = true; }
    else if (o.y > this.h + my) { o.y -= this.h + my * 2; jumped = true; }
    return jumped;
  }

  /** Convenience for drivers: a fresh scattered spawn point. */
  spawn(o) {
    o.x = this.rnd() * this.w;
    o.y = this.rnd() * this.h;
  }
}
