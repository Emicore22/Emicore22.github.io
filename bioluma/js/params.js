/* The parameter schema. Everything the UI shows, everything the URL carries and
   everything a preset stores is derived from this one list — add a control here
   and it appears in the panel, in shared links and in saved presets with no
   other edit. Creature-specific parameters live with their creature module and
   are merged in under P.cp[creatureId]. */

export const SCHEMA = [
  {
    group: 'Swarm', controls: [
      { key: 'count', label: 'Agents', type: 'range', min: 40, max: 2400, step: 10, def: 300 },
      { key: 'speed', label: 'Speed', type: 'range', min: 0, max: 3, step: 0.01, def: 1 },
      { key: 'scale', label: 'Creature scale', type: 'range', min: 0.2, max: 3, step: 0.01, def: 1 },
      { key: 'follow', label: 'Body lag', type: 'range', min: 0.02, max: 1, step: 0.01, def: 0.24, hint: 'How loosely agents trail their creature. Low values smear.' },
      { key: 'jitter', label: 'Jitter', type: 'range', min: 0, max: 3, step: 0.01, def: 0.18 },
    ],
  },
  {
    group: 'Current', controls: [
      { key: 'flow', label: 'Turbulence', type: 'range', min: 0, max: 3, step: 0.01, def: 0.5 },
      { key: 'flowScale', label: 'Eddy size', type: 'range', min: 0.2, max: 6, step: 0.01, def: 2.2 },
      { key: 'flowSpeed', label: 'Current drift', type: 'range', min: 0, max: 2, step: 0.01, def: 0.35 },
      { key: 'swirl', label: 'Swirl', type: 'range', min: -2, max: 2, step: 0.01, def: 0.3, hint: 'Rotation around the frame centre.' },
      { key: 'gather', label: 'Gather', type: 'range', min: -1, max: 1, step: 0.01, def: 0.28, hint: 'Negative scatters outward, positive pulls to centre.' },
      { key: 'pointer', label: 'Pointer pull', type: 'range', min: -3, max: 3, step: 0.01, def: 0 },
    ],
  },
  {
    group: 'Bloom', controls: [
      { key: 'blobSize', label: 'Bloom size', type: 'range', min: 0, max: 6, step: 0.01, def: 0.85 },
      { key: 'blobAlpha', label: 'Bloom density', type: 'range', min: 0, max: 1, step: 0.005, def: 0.13 },
      { key: 'bloomShare', label: 'Bloom share', type: 'range', min: 0, max: 1, step: 0.01, def: 0.45, hint: 'How many of the swimmers carry colour. The rest leave only a line.' },
      { key: 'sizeVar', label: 'Size variance', type: 'range', min: 0, max: 1, step: 0.01, def: 0.85 },
      { key: 'fade', label: 'Bloom fade', type: 'range', min: 0, max: 0.25, step: 0.001, def: 0.045, hint: 'How fast colour settles out of the water. Low values build up until the frame saturates.' },
      {
        key: 'blend', label: 'Blend', type: 'select', def: 'multiply',
        options: [['multiply', 'Multiply (ink on paper)'], ['screen', 'Screen (light in water)'],
        ['lighter', 'Add (neon)'], ['overlay', 'Overlay'], ['soft-light', 'Soft light'],
        ['source-over', 'Normal']],
      },
    ],
  },
  {
    group: 'Line', controls: [
      { key: 'hairAlpha', label: 'Trail ink', type: 'range', min: 0, max: 1, step: 0.005, def: 0.16 },
      { key: 'hairWidth', label: 'Trail weight', type: 'range', min: 0.1, max: 4, step: 0.05, def: 0.6 },
      { key: 'headSize', label: 'Head size', type: 'range', min: 0, max: 8, step: 0.05, def: 1.5 },
      { key: 'trailFade', label: 'Trail fade', type: 'range', min: 0, max: 0.1, step: 0.0005, def: 0.004, hint: 'Zero draws forever. Lines live on their own layer, so they outlast the colour.' },
    ],
  },
  {
    group: 'Colour', controls: [
      { key: 'hueDrift', label: 'Hue drift', type: 'range', min: -60, max: 60, step: 0.5, def: 0, hint: 'Degrees of hue rotation per second across the whole piece.' },
      { key: 'hueJitter', label: 'Hue spread', type: 'range', min: 0, max: 90, step: 1, def: 12 },
      { key: 'sat', label: 'Saturation', type: 'range', min: 0, max: 1.6, step: 0.01, def: 1 },
      { key: 'light', label: 'Lightness', type: 'range', min: -30, max: 30, step: 0.5, def: 0 },
      {
        key: 'colorBy', label: 'Colour by', type: 'select', def: 'agent',
        options: [['body', 'Creature'], ['limb', 'Limb / part'], ['agent', 'Per agent'],
        ['speed', 'Speed'], ['depth', 'Depth']],
      },
      { key: 'bg', label: 'Paper', type: 'color', def: '#f5f2e9' },
      { key: 'ink', label: 'Line ink', type: 'color', def: '#2c2740' },
    ],
  },
  {
    group: 'Finish', controls: [
      { key: 'glow', label: 'Glow', type: 'range', min: 0, max: 1, step: 0.01, def: 0.18 },
      { key: 'glowRadius', label: 'Glow radius', type: 'range', min: 1, max: 40, step: 0.5, def: 14 },
      { key: 'grain', label: 'Grain', type: 'range', min: 0, max: 1, step: 0.01, def: 0.12 },
      { key: 'vignette', label: 'Vignette', type: 'range', min: 0, max: 1, step: 0.01, def: 0.1 },
    ],
  },
];

/* Not shown as sliders — these live in the header and the stage strip. */
export const META = {
  creature: 'krill',
  palette: 'reef',
  seed: 'tidal-bloom-104',
  aspect: '4:5',
  quality: 1200,
  paused: false,
};

export const ASPECTS = [
  ['1:1', 1], ['4:5', 4 / 5], ['9:16', 9 / 16], ['16:9', 16 / 9], ['3:2', 3 / 2], ['fill', 0],
];

export const QUALITIES = [['720', 720], ['1080', 1080], ['1200', 1200], ['1440', 1440], ['2160', 2160]];

export function flatControls() {
  return SCHEMA.flatMap((g) => g.controls);
}

export function defaults() {
  const P = { ...META, cp: {} };
  for (const c of flatControls()) P[c.key] = c.def;
  return P;
}

/** Fills in any creature parameter the current P is missing (new creature, old link). */
export function ensureCreatureParams(P, creature) {
  const bag = P.cp[creature.id] || (P.cp[creature.id] = {});
  for (const c of creature.params || []) {
    if (bag[c.key] === undefined) bag[c.key] = c.def;
  }
  return bag;
}

/** Clamp anything arriving from a URL or an old preset back into range. */
export function sanitize(P) {
  const out = defaults();
  const byKey = new Map(flatControls().map((c) => [c.key, c]));
  for (const [k, v] of Object.entries(P || {})) {
    if (k === 'cp') { out.cp = (v && typeof v === 'object') ? v : {}; continue; }
    const c = byKey.get(k);
    if (c) {
      if (c.type === 'range') out[k] = Math.max(c.min, Math.min(c.max, Number(v) || 0));
      else if (c.type === 'select') out[k] = c.options.some(([o]) => o === v) ? v : c.def;
      else if (c.type === 'color') out[k] = /^#[0-9a-f]{6}$/i.test(String(v)) ? v : c.def;
      else out[k] = v;
    } else if (k in META) {
      out[k] = v;
    }
  }
  return out;
}

/* URL round-tripping. JSON in base64url keeps links opaque but debuggable, and
   avoids inventing a positional format that would break the moment the schema
   gains a control. */
export function encode(P) {
  const json = JSON.stringify(P);
  const bytes = new TextEncoder().encode(json);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decode(str) {
  try {
    const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '='.repeat((4 - b64.length % 4) % 4));
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    return sanitize(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return null;
  }
}
