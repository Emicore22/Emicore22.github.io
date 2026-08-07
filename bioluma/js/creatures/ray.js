/* Manta ray — the slow one. Everything else in this app twitches; the ray is
   here for long, banked, gliding arcs.

   Agents are laid out across a wing membrane in span/chord coordinates, and
   the flap is a wave travelling outward from the spine, so the tips lead and
   the roots follow. The vertical travel of the flap is kept as a depth value
   per agent: the renderer reads it for size and colour, which is what sells a
   flat 2-D wing as a thing moving through water. */

import { TAU, chain, driftBody, scatterBodies } from './common.js';

export default {
  id: 'ray',
  name: 'Manta Ray',
  blurb: 'Slow banking glides, wings flapping in a wave from spine to tip.',
  look: { count: 800, hairAlpha: 0.05, blobSize: 0.8, blobAlpha: 0.055, bloomShare: 0.6, gather: 0.1 },
  params: [
    { key: 'bodies', label: 'Rays', type: 'range', min: 1, max: 10, step: 1, def: 3 },
    { key: 'span', label: 'Wing span', type: 'range', min: 0.05, max: 0.8, step: 0.01, def: 0.26 },
    { key: 'chord', label: 'Wing depth', type: 'range', min: 0.05, max: 1, step: 0.01, def: 0.42 },
    { key: 'sweep', label: 'Wing sweep', type: 'range', min: -1, max: 1.5, step: 0.01, def: 0.55 },
    { key: 'flap', label: 'Flap depth', type: 'range', min: 0, max: 2, step: 0.01, def: 0.8 },
    { key: 'flapRate', label: 'Flap rate', type: 'range', min: 0, max: 4, step: 0.01, def: 0.5 },
    { key: 'travel', label: 'Flap travel', type: 'range', min: 0, max: 4, step: 0.01, def: 1.4, hint: 'How far the wave lags between spine and wing tip.' },
    { key: 'glide', label: 'Glide speed', type: 'range', min: 0, max: 1, step: 0.005, def: 0.14 },
    { key: 'bank', label: 'Banking', type: 'range', min: 0, max: 2, step: 0.01, def: 0.7 },
    { key: 'tail', label: 'Tail length', type: 'range', min: 0, max: 4, step: 0.02, def: 1.6 },
  ],

  init(sim, P) {
    const cp = P.cp.ray;
    const rnd = sim.rnd;
    const n = Math.max(1, Math.round(cp.bodies));
    this.bodies = scatterBodies(sim, n, () => ({
      size: sim.ref * (0.55 + rnd() * 0.35),
      roll: 0,
    }));

    this.tails = this.bodies.map(() => []);
    sim.agents.forEach((a, i) => {
      a.b = i % n;
      a.nvx = 0; a.nvy = 0;
      if (rnd() < 0.08 && cp.tail > 0) {
        a.k = 1;
        this.tails[a.b].push(a);
      } else {
        a.k = 0;
        // Sampled with a bias toward the tips, where the flap amplitude — and
        // so the motion worth painting — is greatest.
        a.u = Math.sign(rnd.bell()) * Math.pow(rnd(), 0.6);
        a.d = rnd();
      }
      const b = this.bodies[a.b];
      a.x = b.x; a.y = b.y;
    });
    for (const list of this.tails) list.forEach((a, i) => { a.u = (i + 1) / list.length; });
  },

  update(sim, dt, P) {
    const cp = P.cp.ray;
    const ref = sim.ref;
    const t = sim.t;

    for (const b of this.bodies) {
      const steer = sim.noise.noise3(b.ph, t * 0.07, 31.7);
      b.ang += steer * dt * 0.8;
      b.roll += (steer * cp.bank - b.roll) * Math.min(1, dt * 2);
      const beat = Math.sin(t * cp.flapRate * TAU + b.ph);
      b.beat = beat;
      // Thrust peaks on the downstroke, so the ray surges gently in time with
      // its own wings instead of sliding at a constant rate.
      const thrust = ref * cp.glide * (1.2 + 0.8 * Math.max(0, -beat)) * P.scale;
      driftBody(b, sim, dt, P, { thrust, drag: 1.1 });
    }

    for (const a of sim.agents) {
      if (a.k !== 0) continue;
      const b = this.bodies[a.b];
      const size = b.size * P.scale;
      const span = size * cp.span;
      const chordLen = size * cp.chord;

      const au = Math.abs(a.u);
      // Wing outline: swept back toward the tips, trailing edge scalloped.
      const along = (a.d - 0.35) * chordLen * (1 - 0.55 * au) - au * chordLen * cp.sweep;
      const across = a.u * span;
      const wave = Math.sin(t * cp.flapRate * TAU + b.ph - au * cp.travel * 2.4);
      const lift = wave * cp.flap * span * 0.45 * Math.pow(au, 1.6);
      const depth = 0.5 + 0.5 * wave * Math.pow(au, 1.6);
      a.d2 = depth;                       // read by the renderer for size/colour
      const roll = b.roll * a.u * span * 0.3;

      const cos = Math.cos(b.ang), sin = Math.sin(b.ang);
      const lx = along + lift * 0.35;
      const ly = across + roll;
      const tx = b.x + lx * cos - ly * sin;
      const ty = b.y + lx * sin + ly * cos - lift * 0.55;

      if (b.jumped) { a.x = tx; a.y = ty; a.jump = true; continue; }
      const e = 1 - Math.exp(-P.follow * 30 * dt);
      a.x += (tx - a.x) * e;
      a.y += (ty - a.y) * e;
      sim.elastic(a, dt, P, 0.3);
    }

    for (let bi = 0; bi < this.bodies.length; bi++) {
      const list = this.tails[bi];
      if (!list || !list.length) continue;
      const b = this.bodies[bi];
      const size = b.size * P.scale;
      const ax = b.x - Math.cos(b.ang) * size * cp.chord * 0.6;
      const ay = b.y - Math.sin(b.ang) * size * cp.chord * 0.6;
      chain(list, ax, ay, size * cp.tail * 0.5 / list.length, sim, dt, P, {
        sway: ref * 0.25,
        swayFreq: cp.flapRate * 2 + 0.5,
        field: 0.4,
        drag: 3.5,
        jumped: b.jumped,
      });
    }
  },
};
