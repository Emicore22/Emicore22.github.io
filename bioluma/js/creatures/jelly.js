/* Jellyfish — the bell does everything.

   A real medusa swims by contracting fast and relaxing slowly, so the pulse
   here is deliberately asymmetric: a sharp squeeze that produces thrust,
   followed by a long glide where drag and a little negative buoyancy pull it
   back down. That rise-and-sink is the whole reason a jellyfish is hypnotic,
   and a symmetric sine would lose it entirely.

   Bell agents ride the margin; the tentacles and oral arms are follow-the-
   leader chains hanging off it, so they stream, tangle and settle on their own. */

import { TAU, chain, driftBody, limbBudget, scatterBodies } from './common.js';

export default {
  id: 'jelly',
  name: 'Jellyfish',
  blurb: 'Bells that squeeze, glide and sink, trailing tangled tentacles.',
  look: { count: 800, hairAlpha: 0.08, blobSize: 0.8, blobAlpha: 0.055, bloomShare: 0.6, gather: 0.05 },
  params: [
    { key: 'bodies', label: 'Jellyfish', type: 'range', min: 1, max: 14, step: 1, def: 4 },
    { key: 'pulseRate', label: 'Pulse rate', type: 'range', min: 0.05, max: 3, step: 0.01, def: 0.6 },
    { key: 'thrust', label: 'Pulse thrust', type: 'range', min: 0, max: 3, step: 0.01, def: 0.5 },
    { key: 'squash', label: 'Bell squash', type: 'range', min: 0, max: 1, step: 0.01, def: 0.45 },
    { key: 'bell', label: 'Bell size', type: 'range', min: 0.02, max: 0.4, step: 0.005, def: 0.12 },
    { key: 'tentacles', label: 'Tentacles', type: 'range', min: 0, max: 24, step: 1, def: 10 },
    { key: 'tentLen', label: 'Tentacle length', type: 'range', min: 0.2, max: 4, step: 0.02, def: 1.4 },
    { key: 'sway', label: 'Tentacle sway', type: 'range', min: 0, max: 3, step: 0.01, def: 0.8 },
    { key: 'sink', label: 'Sink', type: 'range', min: -1, max: 1, step: 0.01, def: 0.25, hint: 'Negative floats the bells upward between pulses.' },
  ],

  init(sim, P) {
    const cp = P.cp.jelly;
    const rnd = sim.rnd;
    const n = Math.max(1, Math.round(cp.bodies));
    this.bodies = scatterBodies(sim, n, () => ({
      ang: -Math.PI / 2 + rnd.bell() * 0.6,
      phase: rnd() * TAU,
      size: sim.ref * cp.bell * (0.65 + rnd() * 0.7),
      pulse: 0,
      clock: rnd() * TAU,
    }));

    // Roughly a third of the agents form the bells, the rest hang beneath as
    // tentacle chains — enough bell to read as a body, enough tail to drift.
    const tentCount = cp.tentacles < 1 ? 0 : limbBudget(sim, n, cp.tentacles, 5, 0.66);
    this.chains = this.bodies.map(() => []);
    const bellShare = tentCount === 0 ? 1 : 0.34;
    let nextTentacle = 0;

    sim.agents.forEach((a, i) => {
      a.b = i % n;
      const b = this.bodies[a.b];
      a.nvx = 0; a.nvy = 0;
      if (rnd() < bellShare || tentCount === 0) {
        a.k = 0;
        a.u = rnd();
        a.d = rnd();
      } else {
        a.k = 1 + (nextTentacle++ % tentCount);
        const list = this.chains[a.b][a.k - 1] || (this.chains[a.b][a.k - 1] = []);
        list.push(a);
      }
      a.x = b.x + rnd.bell() * b.size;
      a.y = b.y + rnd.bell() * b.size;
    });

    for (const perBody of this.chains) {
      for (const list of perBody) {
        if (list) list.forEach((a, i) => { a.u = (i + 1) / list.length; });
      }
    }
  },

  update(sim, dt, P) {
    const cp = P.cp.jelly;
    const ref = sim.ref;
    const t = sim.t;

    for (const b of this.bodies) {
      b.clock += dt * cp.pulseRate * TAU;
      // Asymmetric waveform: the top of the cycle is a short, hard contraction.
      const phase = (b.clock % TAU + TAU) % TAU;
      const contract = phase < Math.PI * 0.5
        ? Math.sin(phase * 2) ** 2
        : Math.max(0, 1 - (phase - Math.PI * 0.5) / (Math.PI * 1.5)) * 0.12;
      b.pulse = contract;

      b.ang += sim.noise.noise3(b.ph, t * 0.1, 5.5) * dt * 0.5;
      const thrust = ref * 1.5 * cp.thrust * contract * P.scale;
      driftBody(b, sim, dt, P, { thrust, drag: 1.9 });
      b.vy += ref * 0.08 * cp.sink * dt;
    }

    // Bell margins.
    for (const a of sim.agents) {
      if (a.k !== 0) continue;
      const b = this.bodies[a.b];
      const size = b.size * P.scale;
      const squash = 1 - cp.squash * b.pulse;
      const ang = a.u * TAU;
      const r = size * (0.35 + a.d * 0.65) * (1 + 0.25 * b.pulse);
      const cos = Math.cos(b.ang + Math.PI / 2), sin = Math.sin(b.ang + Math.PI / 2);
      const lx = Math.cos(ang) * r;
      const ly = Math.sin(ang) * r * squash * 0.8 - size * 0.1 * b.pulse;
      const tx = b.x + lx * cos - ly * sin;
      const ty = b.y + lx * sin + ly * cos;
      if (b.jumped) { a.x = tx; a.y = ty; a.jump = true; continue; }
      const e = 1 - Math.exp(-P.follow * 30 * dt);
      a.x += (tx - a.x) * e;
      a.y += (ty - a.y) * e;
      sim.elastic(a, dt, P, 0.35);
    }

    // Tentacles: each chain hangs from a point on the bell margin.
    for (let bi = 0; bi < this.bodies.length; bi++) {
      const b = this.bodies[bi];
      const size = b.size * P.scale;
      const perBody = this.chains[bi];
      if (!perBody) continue;
      for (let ci = 0; ci < perBody.length; ci++) {
        const list = perBody[ci];
        if (!list || !list.length) continue;
        const spread = (ci / perBody.length - 0.5) * TAU;
        const ax = b.x + Math.cos(spread) * size * 0.55;
        const ay = b.y + Math.sin(spread) * size * 0.25 + size * 0.4;
        const seg = size * cp.tentLen * 0.9 / list.length;
        chain(list, ax, ay, seg, sim, dt, P, {
          sway: ref * cp.sway * 0.9,
          swayFreq: 0.8 + cp.pulseRate,
          gravity: ref * 0.05 * (0.4 + cp.sink),
          field: 0.7,
          jumped: b.jumped,
        });
      }
    }
  },
};
