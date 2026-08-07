/* Octopus — a mantle that jets in bursts, dragging eight arms behind it.

   The arms are procedural rather than physical: each agent sits at a fixed
   distance along its arm and the arm's angle is a travelling sine wave, so
   curl runs from the base to the tip the way a real arm unfurls. Agents then
   *ease* toward that ideal point instead of snapping to it, and the lag is
   what makes the arms feel like flesh. Tips lag more than bases. */

import { TAU, driftBody, ease, scatterBodies, wander } from './common.js';

export default {
  id: 'octopus',
  name: 'Octopus',
  blurb: 'Jetting mantles trailing eight curling arms.',
  look: { count: 600, hairAlpha: 0.045, blobSize: 0.8, blobAlpha: 0.05, bloomShare: 0.7, fade: 0.07, follow: 0.3, gather: 0.15 },
  params: [
    { key: 'bodies', label: 'Octopuses', type: 'range', min: 1, max: 12, step: 1, def: 4 },
    { key: 'arms', label: 'Arms', type: 'range', min: 2, max: 16, step: 1, def: 8 },
    { key: 'armLen', label: 'Arm length', type: 'range', min: 0.05, max: 2, step: 0.01, def: 0.45 },
    { key: 'curl', label: 'Arm curl', type: 'range', min: 0, max: 4, step: 0.01, def: 0.9 },
    { key: 'waves', label: 'Curl waves', type: 'range', min: 0.2, max: 4, step: 0.05, def: 1.35 },
    { key: 'armFreq', label: 'Arm rhythm', type: 'range', min: 0, max: 6, step: 0.01, def: 0.5 },
    { key: 'spread', label: 'Arm spread', type: 'range', min: 0.1, max: 1, step: 0.01, def: 0.78, hint: 'Low values sweep the arms behind the body like a comet.' },
    { key: 'jet', label: 'Jet strength', type: 'range', min: 0, max: 3, step: 0.01, def: 0.7 },
    { key: 'jetRate', label: 'Jet rate', type: 'range', min: 0.05, max: 3, step: 0.05, def: 0.55 },
    { key: 'mantle', label: 'Mantle density', type: 'range', min: 0, max: 0.6, step: 0.01, def: 0.16 },
  ],

  init(sim, P) {
    const cp = P.cp.octopus;
    const rnd = sim.rnd;
    const n = Math.max(1, Math.round(cp.bodies));
    const arms = Math.max(2, Math.round(cp.arms));
    this.arms = arms;
    this.bodies = scatterBodies(sim, n, () => ({
      size: sim.ref * (0.13 + rnd() * 0.09),
      jetTimer: rnd() * 2,
      pulse: 0,
    }));

    sim.agents.forEach((a, i) => {
      a.b = i % n;
      const inMantle = rnd() < cp.mantle;
      a.k = inMantle ? -1 : (Math.floor(i / n) % arms);
      // Biased outward so the tips — where the interesting motion is — are
      // where most of the paint lands.
      a.u = inMantle ? rnd() : Math.pow(rnd(), 0.65);
      const b = this.bodies[a.b];
      a.x = b.x; a.y = b.y;
    });
  },

  update(sim, dt, P) {
    const cp = P.cp.octopus;
    const arms = this.arms;
    const t = sim.t;

    for (const b of this.bodies) {
      wander(b, sim, dt, 0.55);
      b.jetTimer -= dt * cp.jetRate;
      if (b.jetTimer <= 0) {
        b.jetTimer = 0.7 + sim.rnd() * 1.2;
        b.pulse = 1;
        b.ang += sim.rnd.bell() * 0.45;
      }
      b.pulse *= Math.exp(-dt * 3.2);
      const thrust = sim.ref * (0.03 + cp.jet * 1.1 * b.pulse) * P.scale;
      driftBody(b, sim, dt, P, { thrust, drag: 1.1 });
    }

    for (const a of sim.agents) {
      const b = this.bodies[a.b];
      const size = b.size * P.scale;
      let tx, ty;

      if (a.k < 0) {
        // Mantle: a small squashing cloud around the body, tightest at the
        // moment of the jet.
        const ang = a.ph + t * 0.7;
        const r = size * 0.3 * a.u;
        tx = b.x + Math.cos(ang) * r * (1 - 0.45 * b.pulse);
        ty = b.y + Math.sin(ang) * r * (1 + 0.55 * b.pulse);
      } else {
        const spoke = (a.k / arms - 0.5) * TAU * cp.spread;
        const wave = Math.sin(t * cp.armFreq + b.ph + a.k * 0.8 - a.u * cp.waves * TAU)
          * cp.curl * a.u;
        const ang = b.ang + Math.PI + spoke + wave;
        const reach = size * (0.25 + a.u * cp.armLen * 2.4) * (1 - 0.3 * b.pulse * (1 - a.u));
        tx = b.x + Math.cos(ang) * reach;
        ty = b.y + Math.sin(ang) * reach;
      }

      if (b.jumped) { a.x = tx; a.y = ty; a.jump = true; continue; }

      const e = ease(P.follow * 26 * (1 - 0.55 * a.u), dt);
      a.x += (tx - a.x) * e;
      a.y += (ty - a.y) * e;
      sim.elastic(a, dt, P, 0.45);
    }
  },
};
