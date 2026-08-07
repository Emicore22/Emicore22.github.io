/* Fish school — Reynolds' three rules (separate, align, cohere) with two
   additions that matter more than the rules themselves for how it reads:

   • body undulation, a lateral sine offset perpendicular to heading, phased
     per fish, which is what makes a shoal shimmer rather than slide;
   • darting, an occasional burst that propagates as neighbours align to the
     fish that bolted — the flash of panic that runs through a real school.

   Neighbours come from the shared grid, so this stays linear in agent count. */

import { TAU, scatterBodies } from './common.js';

export default {
  id: 'fish',
  name: 'Fish School',
  blurb: 'Shoals that shimmer, split around obstacles, and bolt without warning.',
  look: { count: 800, hairAlpha: 0.11, blobSize: 0.7, blobAlpha: 0.075, bloomShare: 0.5, gather: 0.1 },
  params: [
    { key: 'schools', label: 'Schools', type: 'range', min: 1, max: 8, step: 1, def: 2 },
    { key: 'radius', label: 'Neighbour range', type: 'range', min: 0.01, max: 0.3, step: 0.005, def: 0.07 },
    { key: 'separation', label: 'Separation', type: 'range', min: 0, max: 3, step: 0.01, def: 1.1 },
    { key: 'alignment', label: 'Alignment', type: 'range', min: 0, max: 3, step: 0.01, def: 1.2 },
    { key: 'cohesion', label: 'Cohesion', type: 'range', min: 0, max: 3, step: 0.01, def: 0.8 },
    { key: 'cruise', label: 'Cruise speed', type: 'range', min: 0.01, max: 1, step: 0.005, def: 0.16 },
    { key: 'dart', label: 'Dart strength', type: 'range', min: 0, max: 3, step: 0.01, def: 1 },
    { key: 'dartRate', label: 'Dart rate', type: 'range', min: 0, max: 2, step: 0.01, def: 0.25 },
    { key: 'tailAmp', label: 'Body wave', type: 'range', min: 0, max: 4, step: 0.01, def: 1 },
    { key: 'tailFreq', label: 'Tail beat', type: 'range', min: 0, max: 20, step: 0.1, def: 8 },
  ],

  init(sim, P) {
    const cp = P.cp.fish;
    const rnd = sim.rnd;
    const ns = Math.max(1, Math.round(cp.schools));
    this.leaders = scatterBodies(sim, ns);
    for (const a of sim.agents) {
      a.b = rnd.int(0, ns - 1);
      a.k = 0;
      const l = this.leaders[a.b];
      a.bx = l.x + rnd.bell() * sim.ref * 0.18;
      a.by = l.y + rnd.bell() * sim.ref * 0.18;
      a.x = a.bx; a.y = a.by;
      const ang = l.ang + rnd.bell() * 0.5;
      const sp = sim.ref * cp.cruise;
      a.sx = Math.cos(ang) * sp;
      a.sy = Math.sin(ang) * sp;
      a.timer = rnd() * 6;
      a.dart = 0;
    }
  },

  update(sim, dt, P) {
    const cp = P.cp.fish;
    const ref = sim.ref;
    const agents = sim.agents;
    const R = ref * cp.radius * P.scale;
    const cruise = ref * cp.cruise;
    const scratch = this._wrap || (this._wrap = { x: 0, y: 0 });

    for (const l of this.leaders) {
      l.ang += sim.noise.noise3(l.ph, sim.t * 0.12, 19.2) * dt * 1.1;
      l.x += Math.cos(l.ang) * cruise * 0.6 * dt;
      l.y += Math.sin(l.ang) * cruise * 0.6 * dt;
      sim.wrap(l, 0.05);
    }

    sim.grid.build(agents, R);

    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      let sepX = 0, sepY = 0, aliX = 0, aliY = 0, cohX = 0, cohY = 0, n = 0;

      sim.grid.near(a.bx, a.by, (o) => {
        if (o === a) return;
        const dx = a.bx - o.bx, dy = a.by - o.by;
        const d2 = dx * dx + dy * dy;
        if (d2 > R * R || d2 === 0) return;
        const d = Math.sqrt(d2);
        sepX += dx / d * (1 - d / R);
        sepY += dy / d * (1 - d / R);
        if (o.b === a.b) {
          aliX += o.sx; aliY += o.sy;
          cohX += o.bx; cohY += o.by;
          n++;
        }
      });

      const acc = ref * 1.6;
      a.sx += sepX * cp.separation * acc * dt;
      a.sy += sepY * cp.separation * acc * dt;

      if (n > 0) {
        const inv = 1 / n;
        a.sx += (aliX * inv - a.sx) * cp.alignment * 2.2 * dt;
        a.sy += (aliY * inv - a.sy) * cp.alignment * 2.2 * dt;
        const dx = cohX * inv - a.bx, dy = cohY * inv - a.by;
        a.sx += dx * cp.cohesion * 1.4 * dt;
        a.sy += dy * cp.cohesion * 1.4 * dt;
      }

      // Every fish keeps a loose tether to its school's leader, so shoals stay
      // shoals instead of dissolving into an even scatter over the frame.
      const l = this.leaders[a.b] || this.leaders[0];
      const lx = l.x - a.bx, ly = l.y - a.by;
      const ld = Math.hypot(lx, ly) || 1;
      const tether = Math.min(1, ld / (ref * 0.45)) * cruise * 2.2;
      a.sx += lx / ld * tether * dt;
      a.sy += ly / ld * tether * dt;

      const f = sim.fieldForce(a.bx, a.by, P);
      a.sx += f.x * dt; a.sy += f.y * dt;
      const j = sim.jitterForce(a, P);
      a.sx += j.x * 0.5 * dt; a.sy += j.y * 0.5 * dt;

      a.timer -= dt * cp.dartRate;
      if (a.timer <= 0) {
        a.timer = 2 + sim.rnd() * 8;
        a.dart = 1;
      }
      if (a.dart > 0) {
        const sp = Math.hypot(a.sx, a.sy) || 1;
        const burst = ref * 2.2 * cp.dart * a.dart;
        a.sx += a.sx / sp * burst * dt;
        a.sy += a.sy / sp * burst * dt;
        a.dart -= dt * 2.5;
      }

      // Speed is regulated toward a cruise rather than hard-clamped: fish
      // accelerate and coast, they do not travel at a constant rate.
      const sp = Math.hypot(a.sx, a.sy) || 1;
      const target = cruise * (1 + a.dart * 2.5);
      const k = 1 + (target / sp - 1) * Math.min(1, 3 * dt);
      a.sx *= k; a.sy *= k;

      a.bx += a.sx * dt; a.by += a.sy * dt;
      scratch.x = a.bx; scratch.y = a.by;
      if (sim.wrap(scratch, 0.06)) { a.bx = scratch.x; a.by = scratch.y; a.jump = true; }

      const nx = -a.sy / sp, ny = a.sx / sp;
      const swim = Math.sin(sim.t * cp.tailFreq + a.ph) * ref * 0.006 * cp.tailAmp * P.scale;
      a.x = a.bx + nx * swim;
      a.y = a.by + ny * swim;
    }
  },
};
