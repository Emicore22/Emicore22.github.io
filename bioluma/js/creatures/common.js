/* Shared machinery for the creature drivers.

   A driver is an object with { id, name, blurb, params, init(sim, P),
   update(sim, dt, P) }. It may keep whatever state it likes on itself — only
   one driver is active at a time, and switching re-runs init. Its job is to
   write x/y on every agent each frame; the simulation derives velocity from
   the movement and the renderer turns it into paint. */

import { TAU, clamp, lerp } from '../sim.js';

export { TAU, clamp, lerp };

/** Steers a heading with smooth noise instead of random walks — random walks
    look nervous, noise looks like an animal deciding where to go. */
export function wander(body, sim, dt, amount) {
  body.ang += sim.noise.noise3(body.ph, sim.t * 0.16, 3.1) * amount * dt;
}

/** Moves a creature body: thrust along its heading, plus the current, plus
    drag, plus toroidal edges. Sets body.jumped when it crossed an edge so the
    renderer can drop the trail segment instead of drawing a streak. */
export function driftBody(body, sim, dt, P, { thrust = 0, drag = 1.2 } = {}) {
  if (thrust) {
    body.vx += Math.cos(body.ang) * thrust * dt;
    body.vy += Math.sin(body.ang) * thrust * dt;
  }
  const f = sim.fieldForce(body.x, body.y, P);
  body.vx += f.x * dt;
  body.vy += f.y * dt;
  const damp = Math.exp(-drag * dt);
  body.vx *= damp; body.vy *= damp;
  body.x += body.vx * dt;
  body.y += body.vy * dt;
  body.jumped = sim.wrap(body);
}

/** Exponential ease that behaves the same at any frame rate. */
export function ease(rate, dt) {
  return 1 - Math.exp(-rate * dt);
}

/** Moves an agent toward a target with framerate-independent lag. */
export function seek(a, tx, ty, rate, dt) {
  const e = ease(rate, dt);
  a.x += (tx - a.x) * e;
  a.y += (ty - a.y) * e;
}

/** Follow-the-leader chain: each node drifts on its own, then is pulled back
    to a fixed distance from the node ahead of it. Cheap, unconditionally
    stable, and the lag between nodes is exactly what makes tentacles read as
    tentacles rather than as rigid spokes. */
export function chain(nodes, ax, ay, seg, sim, dt, P, opts = {}) {
  const {
    sway = 0, swayFreq = 1.2, gravity = 0, drag = 2.4, field = 0.5, jumped = false,
    biasX = 0, biasY = 0,   // a steady pull along the limb's own direction
  } = opts;
  let px = ax, py = ay;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (jumped) {           // the anchor teleported across an edge: bring the
      n.x = px; n.y = py;   // whole tail with it, and skip its trail this frame
      n.jump = true;
      n.nvx = 0; n.nvy = 0;
      continue;
    }
    const along = (i + 1) / nodes.length;
    const f = sim.fieldForce(n.x, n.y, P);
    n.nvx += (f.x * field + biasX) * dt;
    n.nvy += (f.y * field + biasY + gravity) * dt;
    if (sway) {
      const s = Math.sin(sim.t * swayFreq + n.ph + along * 5.5) * sway * along;
      n.nvx += s * dt;
      n.nvy += Math.cos(sim.t * swayFreq * 0.8 + n.ph) * sway * 0.4 * along * dt;
    }
    const damp = Math.exp(-drag * dt);
    n.nvx *= damp; n.nvy *= damp;
    n.x += n.nvx * dt;
    n.y += n.nvy * dt;

    let dx = n.x - px, dy = n.y - py;
    const d = Math.hypot(dx, dy) || 1;
    n.x = px + dx / d * seg;
    n.y = py + dy / d * seg;
    px = n.x; py = n.y;
  }
}

/** Splits the agent list into per-body groups, in place and allocation-free
    after the first call. Returns an array of arrays of agents. */
export function groupAgents(sim, bodyCount) {
  const groups = Array.from({ length: bodyCount }, () => []);
  for (let i = 0; i < sim.agents.length; i++) {
    const a = sim.agents[i];
    a.b = i % bodyCount;
    groups[a.b].push(a);
  }
  return groups;
}

/* A tentacle needs nodes to look like a tentacle: two-node chains read as
   scribbles, not limbs. Asking for twenty tentacles on eight bodies out of an
   agent budget of three hundred is a request that cannot be honoured, so the
   count is capped at what the budget can actually make. Raising Agents raises
   the ceiling, which is the behaviour that matches the sliders' meaning. */
export function limbBudget(sim, bodyCount, requested, minNodes = 5, share = 1) {
  const usable = Math.floor(sim.agents.length * share);
  const ceiling = Math.max(1, Math.floor(usable / (bodyCount * minNodes)));
  return Math.max(1, Math.min(Math.round(requested), ceiling));
}

/** Spreads a set of bodies over the stage without clumping in the middle. */
export function scatterBodies(sim, n, extra = () => ({})) {
  const rnd = sim.rnd;
  const bodies = [];
  for (let i = 0; i < n; i++) {
    bodies.push({
      x: rnd.range(0.1, 0.9) * sim.w,
      y: rnd.range(0.1, 0.9) * sim.h,
      vx: 0, vy: 0,
      ang: rnd() * TAU,
      ph: rnd() * TAU,
      size: sim.ref * (0.5 + rnd() * 0.9),
      jumped: false,
      ...extra(i, rnd),
    });
  }
  return bodies;
}
