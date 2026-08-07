/* Krill — a plankton swarm. Thousands of near-identical swimmers with no body
   plan to speak of: they cohere loosely into clouds, shove each other apart at
   close range, ride the current, and flick forward in little bursts. The
   densest, most painterly of the drivers, and the one that behaves most like
   pigment suspended in water. */

import { TAU, scatterBodies } from './common.js';

export default {
  id: 'krill',
  name: 'Krill Swarm',
  blurb: 'Dense clouds of plankton riding the current, flicking forward in bursts.',
  look: {},
  params: [
    { key: 'swarms', label: 'Swarms', type: 'range', min: 1, max: 10, step: 1, def: 3 },
    { key: 'cohesion', label: 'Cohesion', type: 'range', min: 0, max: 2, step: 0.01, def: 0.55 },
    { key: 'separation', label: 'Separation', type: 'range', min: 0, max: 2, step: 0.01, def: 0.7 },
    { key: 'flick', label: 'Flick strength', type: 'range', min: 0, max: 2, step: 0.01, def: 0.6 },
    { key: 'flickRate', label: 'Flick rate', type: 'range', min: 0.05, max: 6, step: 0.05, def: 1.4 },
    { key: 'wiggle', label: 'Wiggle', type: 'range', min: 0, max: 4, step: 0.01, def: 1 },
    { key: 'roam', label: 'Swarm roaming', type: 'range', min: 0, max: 2, step: 0.01, def: 0.6 },
  ],

  init(sim, P) {
    const cp = P.cp.krill;
    const rnd = sim.rnd;
    this.centers = scatterBodies(sim, Math.max(1, Math.round(cp.swarms)));
    for (const a of sim.agents) {
      a.b = rnd.int(0, this.centers.length - 1);
      a.k = 0;
      a.sx = rnd.bell() * sim.ref * 0.02;
      a.sy = rnd.bell() * sim.ref * 0.02;
      a.timer = rnd() * 2;
      a.bx = a.x; a.by = a.y;
      const c = this.centers[a.b];
      a.bx = c.x + rnd.bell() * sim.ref * 0.25;
      a.by = c.y + rnd.bell() * sim.ref * 0.25;
      a.x = a.bx; a.y = a.by;
    }
  },

  update(sim, dt, P) {
    const cp = P.cp.krill;
    const ref = sim.ref;
    const agents = sim.agents;

    for (const c of this.centers) {
      c.ang += sim.noise.noise3(c.ph, sim.t * 0.1, 7.7) * dt * 0.9;
      const push = ref * 0.05 * cp.roam;
      c.vx += Math.cos(c.ang) * push * dt;
      c.vy += Math.sin(c.ang) * push * dt;
      const f = sim.fieldForce(c.x, c.y, P);
      c.vx += f.x * 0.6 * dt; c.vy += f.y * 0.6 * dt;
      const d = Math.exp(-0.9 * dt);
      c.vx *= d; c.vy *= d;
      c.x += c.vx * dt; c.y += c.vy * dt;
      sim.wrap(c, 0.05);
    }

    const sepR = ref * 0.02 * (0.5 + cp.separation);
    sim.grid.build(agents, sepR);

    const damp = Math.exp(-1.5 * dt);
    const scratch = this._wrap || (this._wrap = { x: 0, y: 0 });
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      const c = this.centers[a.b] || this.centers[0];

      const f = sim.fieldForce(a.bx, a.by, P);
      a.sx += f.x * dt; a.sy += f.y * dt;

      const j = sim.jitterForce(a, P);
      a.sx += j.x * dt; a.sy += j.y * dt;

      // Cohesion is soft and distance-limited: a swarm should breathe, not
      // collapse onto its own centre of mass.
      const dx = c.x - a.bx, dy = c.y - a.by;
      const dist = Math.hypot(dx, dy) || 1;
      const pull = cp.cohesion * ref * 0.06 * Math.min(1, dist / (ref * 0.4));
      a.sx += dx / dist * pull * dt;
      a.sy += dy / dist * pull * dt;

      if (cp.separation > 0) {
        let px = 0, py = 0;
        sim.grid.near(a.x, a.y, (o) => {
          if (o === a) return;
          const ox = a.x - o.x, oy = a.y - o.y;
          const d2 = ox * ox + oy * oy;
          if (d2 > 0 && d2 < sepR * sepR) {
            const w = 1 - Math.sqrt(d2) / sepR;
            px += ox * w; py += oy * w;
          }
        });
        const pd = Math.hypot(px, py);
        if (pd > 0.0001) {
          const g = cp.separation * ref * 0.5 * dt;
          a.sx += px / pd * g; a.sy += py / pd * g;
        }
      }

      a.timer -= dt * cp.flickRate;
      if (a.timer <= 0) {
        a.timer = 0.4 + sim.rnd() * 1.6;
        const sp = Math.hypot(a.sx, a.sy) || 1;
        const burst = ref * 0.22 * cp.flick * (0.4 + sim.rnd());
        a.sx += a.sx / sp * burst;
        a.sy += a.sy / sp * burst;
      }

      a.sx *= damp; a.sy *= damp;
      a.bx += a.sx * dt; a.by += a.sy * dt;

      // The edges are applied to the base position, so the tail wiggle below
      // is never fighting the wrap.
      scratch.x = a.bx; scratch.y = a.by;
      if (sim.wrap(scratch, 0.08)) {
        a.bx = scratch.x; a.by = scratch.y;
        a.jump = true;
      }

      const sp = Math.hypot(a.sx, a.sy) || 1;
      const nx = -a.sy / sp, ny = a.sx / sp;
      const w = Math.sin(sim.t * 9 + a.ph) * ref * 0.004 * cp.wiggle;
      a.x = a.bx + nx * w;
      a.y = a.by + ny * w;
    }
  },
};
