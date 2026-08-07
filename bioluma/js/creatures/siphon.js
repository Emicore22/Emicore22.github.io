/* Siphonophore — the colony. A siphonophore is not one animal but a chain of
   clones, each doing one job, strung along a shared stem metres long.

   So: a noise-steered head tows a spine of nodes, each node holding the last
   at a fixed distance, and the agents are zooids budded off the spine at their
   own angle and radius, pulsing in a wave that travels down the colony. The
   spine never doubles back on itself, which is why this driver draws long
   clean ribbons where the others draw clouds. */

import { TAU, scatterBodies } from './common.js';

export default {
  id: 'siphon',
  name: 'Siphonophore',
  blurb: 'Colonies that snake in long ribbons, zooids pulsing down the stem.',
  look: { count: 900, hairAlpha: 0.055, blobSize: 0.5, blobAlpha: 0.12, bloomShare: 0.85, fade: 0.05, gather: 0 },
  params: [
    { key: 'colonies', label: 'Colonies', type: 'range', min: 1, max: 10, step: 1, def: 3 },
    { key: 'nodes', label: 'Stem segments', type: 'range', min: 8, max: 160, step: 1, def: 60 },
    { key: 'segment', label: 'Segment length', type: 'range', min: 0.002, max: 0.06, step: 0.001, def: 0.012 },
    { key: 'speed', label: 'Swim speed', type: 'range', min: 0.02, max: 1.2, step: 0.005, def: 0.22 },
    { key: 'sinuosity', label: 'Sinuosity', type: 'range', min: 0, max: 4, step: 0.01, def: 1.2 },
    { key: 'coil', label: 'Coil', type: 'range', min: -3, max: 3, step: 0.01, def: 0.6, hint: 'A steady bias on the heading. Push it and the colony spirals.' },
    { key: 'girth', label: 'Zooid spread', type: 'range', min: 0, max: 0.1, step: 0.001, def: 0.022 },
    { key: 'pulse', label: 'Zooid pulse', type: 'range', min: 0, max: 2, step: 0.01, def: 0.7 },
    { key: 'pulseWave', label: 'Pulse travel', type: 'range', min: 0, max: 20, step: 0.1, def: 6 },
    { key: 'taper', label: 'Taper', type: 'range', min: 0, max: 1, step: 0.01, def: 0.55 },
  ],

  init(sim, P) {
    const cp = P.cp.siphon;
    const rnd = sim.rnd;
    const n = Math.max(1, Math.round(cp.colonies));
    const nodeCount = Math.max(4, Math.round(cp.nodes));

    this.heads = scatterBodies(sim, n);
    this.spines = this.heads.map((h) => {
      const nodes = [];
      for (let i = 0; i < nodeCount; i++) nodes.push({ x: h.x, y: h.y });
      return nodes;
    });

    sim.agents.forEach((a, i) => {
      a.b = i % n;
      a.k = 0;
      a.node = (i / n | 0) % nodeCount;
      a.side = rnd() < 0.5 ? -1 : 1;
      a.rad = rnd();
      a.u = a.node / nodeCount;
      const h = this.heads[a.b];
      a.x = h.x; a.y = h.y;
    });
  },

  update(sim, dt, P) {
    const cp = P.cp.siphon;
    const ref = sim.ref;
    const t = sim.t;
    const seg = ref * cp.segment * P.scale;
    const speed = ref * cp.speed;

    for (let i = 0; i < this.heads.length; i++) {
      const h = this.heads[i];
      h.ang += (sim.noise.noise3(h.ph, t * 0.25, 3.9) * cp.sinuosity + cp.coil) * dt * 1.6;
      const f = sim.fieldForce(h.x, h.y, P);
      h.x += (Math.cos(h.ang) * speed + f.x * 0.35) * dt;
      h.y += (Math.sin(h.ang) * speed + f.y * 0.35) * dt;
      h.jumped = sim.wrap(h, 0.04);

      const nodes = this.spines[i];
      let px = h.x, py = h.y;
      for (let k = 0; k < nodes.length; k++) {
        const nd = nodes[k];
        if (h.jumped) { nd.x = px; nd.y = py; continue; }
        const dx = nd.x - px, dy = nd.y - py;
        const d = Math.hypot(dx, dy) || 1;
        nd.x = px + dx / d * seg;
        nd.y = py + dy / d * seg;
        nd.nx = -dy / d; nd.ny = dx / d;   // stem normal, for budding zooids
        px = nd.x; py = nd.y;
      }
    }

    for (const a of sim.agents) {
      const h = this.heads[a.b];
      const nodes = this.spines[a.b];
      const nd = nodes[Math.min(a.node, nodes.length - 1)];
      const along = a.node / nodes.length;
      const pulse = 1 + Math.sin(t * 3 + a.ph - along * cp.pulseWave) * cp.pulse * 0.5;
      const width = ref * cp.girth * P.scale * (1 - cp.taper * along) * (0.3 + a.rad) * pulse;
      const tx = nd.x + (nd.nx || 0) * width * a.side;
      const ty = nd.y + (nd.ny || 0) * width * a.side;

      if (h.jumped) { a.x = tx; a.y = ty; a.jump = true; continue; }
      const e = 1 - Math.exp(-P.follow * 40 * dt);
      a.x += (tx - a.x) * e;
      a.y += (ty - a.y) * e;
      sim.elastic(a, dt, P, 0.3);
    }
  },
};
