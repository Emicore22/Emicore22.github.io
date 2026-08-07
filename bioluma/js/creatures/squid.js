/* Squid — the fastest driver here, and the one built around silence.

   A squid glides, then jets: a hard burst of thrust, a change of heading, then
   a long coast while drag bleeds it off. Most of the frame is the coast, which
   is what makes the bursts land. The mantle is a tapered ellipse of agents with
   a fin ripple running down its edge; the arms are chains streaming off the
   head, so at speed they pull into a straight bundle and at rest they open. */

import { TAU, chain, driftBody, limbBudget, scatterBodies } from './common.js';

export default {
  id: 'squid',
  name: 'Squid',
  blurb: 'Long glides broken by hard jets, arms streaming behind.',
  look: { count: 700, hairAlpha: 0.06, blobSize: 0.8, blobAlpha: 0.06, bloomShare: 0.6, gather: 0.05 },
  params: [
    { key: 'bodies', label: 'Squid', type: 'range', min: 1, max: 12, step: 1, def: 3 },
    { key: 'jet', label: 'Jet strength', type: 'range', min: 0, max: 4, step: 0.01, def: 1.5 },
    { key: 'jetRate', label: 'Jet rate', type: 'range', min: 0.05, max: 3, step: 0.05, def: 0.4 },
    { key: 'turn', label: 'Turn on jet', type: 'range', min: 0, max: 3, step: 0.01, def: 1 },
    { key: 'mantleLen', label: 'Mantle length', type: 'range', min: 0.05, max: 1, step: 0.01, def: 0.3 },
    { key: 'mantleWide', label: 'Mantle width', type: 'range', min: 0.05, max: 1, step: 0.01, def: 0.3 },
    { key: 'fin', label: 'Fin ripple', type: 'range', min: 0, max: 3, step: 0.01, def: 1 },
    { key: 'finFreq', label: 'Fin beat', type: 'range', min: 0, max: 20, step: 0.1, def: 6 },
    { key: 'arms', label: 'Arms', type: 'range', min: 0, max: 16, step: 1, def: 8 },
    { key: 'armLen', label: 'Arm length', type: 'range', min: 0.2, max: 4, step: 0.02, def: 1.5 },
  ],

  init(sim, P) {
    const cp = P.cp.squid;
    const rnd = sim.rnd;
    const n = Math.max(1, Math.round(cp.bodies));
    this.bodies = scatterBodies(sim, n, () => ({
      size: sim.ref * (0.1 + rnd() * 0.07),
      jetTimer: rnd() * 2,
      pulse: 0,
    }));

    const armCount = cp.arms < 1 ? 0 : limbBudget(sim, n, cp.arms, 5, 0.55);
    this.chains = this.bodies.map(() => []);
    const mantleShare = armCount === 0 ? 1 : 0.45;
    let nextArm = 0;

    sim.agents.forEach((a, i) => {
      a.b = i % n;
      const b = this.bodies[a.b];
      a.nvx = 0; a.nvy = 0;
      if (rnd() < mantleShare || armCount === 0) {
        a.k = 0;
        a.u = rnd();               // along the mantle, 0 at the head
        a.d = rnd.bell();          // across it, -1..1
      } else {
        a.k = 1 + (nextArm++ % armCount);
        const list = this.chains[a.b][a.k - 1] || (this.chains[a.b][a.k - 1] = []);
        list.push(a);
      }
      a.x = b.x; a.y = b.y;
    });

    for (const perBody of this.chains) {
      for (const list of perBody) {
        if (list) list.forEach((a, i) => { a.u = (i + 1) / list.length; });
      }
    }
  },

  update(sim, dt, P) {
    const cp = P.cp.squid;
    const ref = sim.ref;
    const t = sim.t;

    for (const b of this.bodies) {
      b.jetTimer -= dt * cp.jetRate;
      if (b.jetTimer <= 0) {
        b.jetTimer = 0.8 + sim.rnd() * 2.2;
        b.pulse = 1;
        b.ang += sim.rnd.bell() * 1.2 * cp.turn;
      }
      b.pulse *= Math.exp(-dt * 4.5);
      b.ang += sim.noise.noise3(b.ph, t * 0.2, 13.3) * dt * 0.7;
      const thrust = ref * (0.05 + cp.jet * 3.2 * b.pulse) * P.scale;
      driftBody(b, sim, dt, P, { thrust, drag: 0.75 });
    }

    for (const a of sim.agents) {
      if (a.k !== 0) continue;
      const b = this.bodies[a.b];
      const size = b.size * P.scale;
      const cos = Math.cos(b.ang), sin = Math.sin(b.ang);

      // Tapered: widest a third of the way back, pinched at the tail.
      const taper = Math.sin(Math.min(1, a.u) * Math.PI * 0.92) ** 0.7;
      const ripple = Math.sin(t * cp.finFreq - a.u * 5 + b.ph) * cp.fin * 0.35 * a.u;
      const along = -a.u * size * cp.mantleLen * 6 * (1 + 0.25 * b.pulse);
      const across = a.d * size * cp.mantleWide * 3 * taper * (1 - 0.3 * b.pulse) + ripple * size;

      const tx = b.x + cos * along - sin * across;
      const ty = b.y + sin * along + cos * across;

      if (b.jumped) { a.x = tx; a.y = ty; a.jump = true; continue; }
      const e = 1 - Math.exp(-P.follow * 34 * dt);
      a.x += (tx - a.x) * e;
      a.y += (ty - a.y) * e;
      sim.elastic(a, dt, P, 0.3);
    }

    for (let bi = 0; bi < this.bodies.length; bi++) {
      const b = this.bodies[bi];
      const size = b.size * P.scale;
      const perBody = this.chains[bi];
      if (!perBody) continue;
      const speed = Math.hypot(b.vx, b.vy);
      // The faster it goes, the tighter the arms bundle behind the head.
      const openness = 1 / (1 + speed / (ref * 0.25));
      for (let ci = 0; ci < perBody.length; ci++) {
        const list = perBody[ci];
        if (!list || !list.length) continue;
        const spread = (ci / perBody.length - 0.5) * TAU * 0.5 * openness;
        const ang = b.ang + spread;
        const ax = b.x + Math.cos(ang) * size * 0.5;
        const ay = b.y + Math.sin(ang) * size * 0.5;
        const seg = size * cp.armLen * 1.6 / list.length;
        chain(list, ax, ay, seg, sim, dt, P, {
          sway: ref * 0.5 * openness,
          swayFreq: 1.6,
          field: 0.5,
          drag: 3,
          jumped: b.jumped,
        });
      }
    }
  },
};
