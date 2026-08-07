/* Anemone — the only rooted creature here. Everything else travels; this one
   stays put and lets the water do the moving, which makes it the driver to
   reach for when you want a composition rather than a swarm: radial, symmetric,
   mandala-ish, and very easy to loop.

   Tentacles are chains anchored to a fixed base, so the current is the only
   thing animating them — turn Turbulence down and the garden goes still. */

import { TAU, chain, limbBudget, scatterBodies } from './common.js';

export default {
  id: 'anemone',
  name: 'Anemone Garden',
  blurb: 'Rooted polyps whose tentacles are moved only by the current.',
  look: { count: 900, hairAlpha: 0.05, blobSize: 0.45, blobAlpha: 0.14, bloomShare: 0.85, fade: 0.05, flow: 0.35, gather: 0 },
  params: [
    { key: 'bodies', label: 'Polyps', type: 'range', min: 1, max: 24, step: 1, def: 7 },
    { key: 'tentacles', label: 'Tentacles', type: 'range', min: 3, max: 48, step: 1, def: 14 },
    { key: 'length', label: 'Tentacle length', type: 'range', min: 0.02, max: 0.6, step: 0.005, def: 0.2 },
    { key: 'stiff', label: 'Stiffness', type: 'range', min: 0.5, max: 8, step: 0.05, def: 2.6 },
    { key: 'breathe', label: 'Breathe', type: 'range', min: 0, max: 1, step: 0.01, def: 0.3 },
    { key: 'breatheRate', label: 'Breathe rate', type: 'range', min: 0.05, max: 3, step: 0.01, def: 0.35 },
    { key: 'spin', label: 'Spin', type: 'range', min: -2, max: 2, step: 0.01, def: 0.15 },
    { key: 'ring', label: 'Ring layout', type: 'range', min: 0, max: 1, step: 0.01, def: 0, hint: 'Pulls the polyps from a scatter into a ring around the centre.' },
    { key: 'drift', label: 'Base drift', type: 'range', min: 0, max: 1, step: 0.01, def: 0.1 },
  ],

  init(sim, P) {
    const cp = P.cp.anemone;
    const rnd = sim.rnd;
    const n = Math.max(1, Math.round(cp.bodies));
    this.bodies = scatterBodies(sim, n, (i) => ({
      size: sim.ref * (0.7 + rnd() * 0.6),
      spinPhase: rnd() * TAU,
      hx: sim.w * 0.5 + Math.cos(i / n * TAU) * sim.ref * 0.32,
      hy: sim.h * 0.5 + Math.sin(i / n * TAU) * sim.ref * 0.32,
    }));

    const tentCount = limbBudget(sim, n, cp.tentacles, 5);
    this.chains = this.bodies.map(() => []);
    sim.agents.forEach((a, i) => {
      a.b = i % n;
      a.k = 1 + (Math.floor(i / n) % tentCount);
      a.nvx = 0; a.nvy = 0;
      const list = this.chains[a.b][a.k - 1] || (this.chains[a.b][a.k - 1] = []);
      list.push(a);
      const b = this.bodies[a.b];
      a.x = b.x; a.y = b.y;
    });
    for (const perBody of this.chains) {
      for (const list of perBody) {
        if (list) list.forEach((a, i) => { a.u = (i + 1) / list.length; });
      }
    }
  },

  update(sim, dt, P) {
    const cp = P.cp.anemone;
    const ref = sim.ref;
    const t = sim.t;

    for (const b of this.bodies) {
      // Bases creep rather than swim, and can be pulled onto a ring for a
      // deliberately symmetrical layout.
      const dx = sim.noise.noise3(b.ph, t * 0.05, 2.2) * ref * 0.03 * cp.drift;
      const dy = sim.noise.noise3(b.ph + 5, t * 0.05, 9.4) * ref * 0.03 * cp.drift;
      b.x += dx * dt; b.y += dy * dt;
      b.x += (b.hx - b.x) * cp.ring * Math.min(1, dt * 1.5);
      b.y += (b.hy - b.y) * cp.ring * Math.min(1, dt * 1.5);
      b.jumped = false;
    }

    const breathe = 1 + Math.sin(t * cp.breatheRate * TAU) * cp.breathe * 0.5;

    for (let bi = 0; bi < this.bodies.length; bi++) {
      const b = this.bodies[bi];
      const perBody = this.chains[bi];
      if (!perBody) continue;
      const reach = ref * cp.length * P.scale * breathe;
      for (let ci = 0; ci < perBody.length; ci++) {
        const list = perBody[ci];
        if (!list || !list.length) continue;
        const ang = b.spinPhase + (ci / perBody.length) * TAU + t * cp.spin;
        const ax = b.x + Math.cos(ang) * reach * 0.12;
        const ay = b.y + Math.sin(ang) * reach * 0.12;
        // Without an outward bias the chain has no opinion about direction and
        // the current alone just knots it: a tangle where a crown should be.
        // The bias is what makes the tentacles stand up and radiate.
        const stand = ref * 0.9;
        chain(list, ax, ay, reach / list.length, sim, dt, P, {
          sway: ref * 0.12,
          swayFreq: 0.6,
          field: 1.6,
          drag: cp.stiff,
          biasX: Math.cos(ang) * stand,
          biasY: Math.sin(ang) * stand,
        });
      }
    }
  },
};
