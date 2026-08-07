/* App wiring: state in, frames out.

   One object — P — is the entire state of a piece: global parameters, the
   creature and palette ids, the seed, and every creature's own parameters.
   Presets, shareable links and the localStorage restore are all just P, which
   is why none of them needed special cases. */

import { Sim } from './sim.js';
import { Renderer } from './render.js';
import { Panel } from './ui.js';
import { Recorder, savePNG } from './export.js';
import { CREATURES, creatureById } from './creatures/index.js';
import { PALETTES, paletteById } from './palettes.js';
import {
  ASPECTS, QUALITIES, SCHEMA, decode, defaults, encode,
  ensureCreatureParams, flatControls, sanitize,
} from './params.js';
import { randomSeedWord, makeRng } from './rng.js';

const STORE_LAST = 'bioluma.last';
const STORE_PRESETS = 'bioluma.presets';

/* Changing one of these changes how many bodies there are or which agent
   belongs to which limb, so the swarm has to be rebuilt rather than nudged. */
const STRUCTURAL = new Set(['bodies', 'arms', 'tentacles', 'nodes', 'colonies',
  'swarms', 'schools', 'mantle', 'tail']);

const stage = document.getElementById('stage');
const canvas = document.getElementById('view');
const panelEl = document.getElementById('panel');
const hud = document.getElementById('hud');
const shell = document.getElementById('shell');

const sim = new Sim();
const renderer = new Renderer(canvas);
const recorder = new Recorder();

let P = loadInitialState();
let creature = creatureById(P.creature);
let palette = paletteById(P.palette);
ensureAllCreatureParams(P);

const panel = new Panel(panelEl, { onChange, onAction });
panel.build(P, creature);
refreshPresetList();

sizeStage(true);
sim.setDriver(creature, P);
renderer.clear(P);

/* ── state ─────────────────────────────────────────────────────────────────── */

function loadInitialState() {
  const hash = location.hash.replace(/^#/, '');
  if (hash) {
    const fromLink = decode(hash);
    if (fromLink) return fromLink;
  }
  try {
    const saved = localStorage.getItem(STORE_LAST);
    if (saved) return sanitize(JSON.parse(saved));
  } catch { /* a corrupt or blocked store just means starting fresh */ }
  return defaults();
}

function ensureAllCreatureParams(state) {
  for (const c of CREATURES) ensureCreatureParams(state, c);
}

let saveTimer = 0;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(STORE_LAST, JSON.stringify(P)); } catch { /* private mode */ }
  }, 400);
}

function onChange(key, value, scope) {
  if (scope === 'P') {
    P[key] = value;
    if (key === 'count' || key === 'seed') restart();
  } else {
    P.cp[scope][key] = value;
    if (STRUCTURAL.has(key)) restart();
  }
  persist();
}

function restart({ clear = true } = {}) {
  sim.reset(P);
  if (clear) renderer.clear(P);
}

function applyPalette(id) {
  palette = paletteById(id);
  P.palette = palette.id;
  P.bg = palette.bg;
  P.ink = palette.ink;
  P.blend = palette.blend;
}

/* Picking a creature also applies its suggested look. A shoal of eight hundred
   fish and a garden of seven anemones want genuinely different ink weights and
   densities — one set of global defaults flatters one and buries the other —
   and a creature you have just chosen should look like itself immediately.
   Presets and shared links carry their own values and skip this. */
function setCreature(id, { applyLook = false } = {}) {
  creature = creatureById(id);
  P.creature = creature.id;
  ensureCreatureParams(P, creature);
  if (applyLook) Object.assign(P, creature.look || {});
  panel.build(P, creature);
  refreshPresetList();
  sim.setDriver(creature, P);
  renderer.clear(P);
}

/* ── actions ───────────────────────────────────────────────────────────────── */

function onAction(name) {
  // Split on the first two colons only: preset names may contain them.
  const first = name.indexOf(':');
  const kind = first < 0 ? name : name.slice(0, first);
  const rest = first < 0 ? '' : name.slice(first + 1);
  const second = rest.indexOf(':');
  const arg = kind === 'preset' && second >= 0 ? rest.slice(0, second) : rest;
  const extra = kind === 'preset' && second >= 0 ? rest.slice(second + 1) : '';
  switch (kind) {
    case 'creature': setCreature(arg, { applyLook: true }); persist(); break;
    case 'palette':
      applyPalette(arg);
      panel.sync(P, creature);
      persist();
      break;
    case 'reseed':
      P.seed = randomSeedWord();
      panel.sync(P, creature);
      restart();
      persist();
      break;
    case 'togglePanel': togglePanel(); break;
    case 'share': share(); break;
    case 'preset':
      if (arg === 'save') savePreset();
      else if (arg === 'delete') deletePreset();
      else if (arg === 'load') loadPreset(extra);
      break;
    default: break;
  }
}

document.getElementById('reveal').addEventListener('click', () => togglePanel(false));

function togglePanel(force) {
  const hidden = force !== undefined ? force : !shell.classList.contains('panel-hidden');
  shell.classList.toggle('panel-hidden', hidden);
  requestAnimationFrame(() => sizeStage());
}

/* Randomising every slider uniformly produces sludge nine times in ten. This
   stays near each control's default most of the time and makes a full jump
   only occasionally, which is the difference between a variation and noise. */
function randomize() {
  const rnd = makeRng(Date.now() ^ (Math.random() * 1e9));
  const jitter = (c) => {
    const span = c.max - c.min;
    const v = rnd() < 0.22
      ? c.min + rnd() * span
      : c.def + rnd.bell() * span * 0.4;
    const q = Math.round(v / c.step) * c.step;
    return Math.max(c.min, Math.min(c.max, q));
  };

  for (const c of flatControls()) {
    if (['bg', 'ink', 'blend', 'count'].includes(c.key)) continue;   // palette's job
    if (c.type === 'select') { P[c.key] = rnd.pick(c.options)[0]; continue; }
    if (c.type === 'range') P[c.key] = jitter(c);
  }
  /* Guard rails. Uniform randomness over these four in particular is how you
     get a frame that is either mud or empty: dense blooms with a slow fade
     saturate within seconds, and a fast fade with thin ink never builds
     anything at all. Bounded, and with fade tied to density, every roll lands
     somewhere worth looking at. */
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  P.blobAlpha = clamp(P.blobAlpha, 0.04, 0.2);
  P.fade = clamp(Math.max(P.fade, P.blobAlpha * 0.5), 0.015, 0.09);
  P.hairAlpha = Math.min(P.hairAlpha, 0.35);
  P.trailFade = Math.min(P.trailFade, 0.02);
  P.speed = Math.max(P.speed, 0.4);

  const bag = P.cp[creature.id];
  for (const c of creature.params) {
    if (STRUCTURAL.has(c.key) && rnd() < 0.6) continue;              // keep the cast size
    bag[c.key] = jitter(c);
  }

  applyPalette(rnd.pick(PALETTES).id);
  P.seed = randomSeedWord();
  panel.sync(P, creature);
  restart();
  persist();
  flash('Randomised');
}

async function share() {
  const hash = encode(P);
  const url = `${location.origin}${location.pathname}#${hash}`;
  history.replaceState(null, '', `#${hash}`);
  try {
    await navigator.clipboard.writeText(url);
    flash('Link copied');
  } catch {
    flash('Link is in the address bar');
  }
}

/* ── presets ───────────────────────────────────────────────────────────────── */

function readPresets() {
  try { return JSON.parse(localStorage.getItem(STORE_PRESETS)) || {}; } catch { return {}; }
}

function writePresets(all) {
  try { localStorage.setItem(STORE_PRESETS, JSON.stringify(all)); } catch { flash('Storage unavailable'); }
}

function refreshPresetList(current = '') {
  panel.setPresets(Object.keys(readPresets()).sort(), current);
}

function savePreset() {
  const name = prompt('Name this preset', `${creature.name} · ${palette.name}`);
  if (!name) return;
  const all = readPresets();
  all[name] = JSON.parse(JSON.stringify(P));
  writePresets(all);
  refreshPresetList(name);
  flash(`Saved “${name}”`);
}

function deletePreset() {
  const name = panel.presetSelect && panel.presetSelect.value;
  if (!name) { flash('Pick a preset first'); return; }
  const all = readPresets();
  delete all[name];
  writePresets(all);
  refreshPresetList();
  flash(`Deleted “${name}”`);
}

function loadPreset(name) {
  const all = readPresets();
  if (!all[name]) return;
  P = sanitize(all[name]);
  ensureAllCreatureParams(P);
  palette = paletteById(P.palette);
  setCreature(P.creature);
  panel.sync(P, creature);
  refreshPresetList(name);
  persist();
  flash(`Loaded “${name}”`);
}

/* ── stage ─────────────────────────────────────────────────────────────────── */

function sizeStage(initial = false) {
  const aspect = (ASPECTS.find(([id]) => id === P.aspect) || ASPECTS[0])[1];
  const rect = stage.getBoundingClientRect();
  const quality = Number(P.quality) || 1200;

  let w, h;
  if (aspect === 0) {
    const r = Math.max(0.3, rect.width / Math.max(1, rect.height));
    w = r >= 1 ? quality : Math.round(quality * r);
    h = r >= 1 ? Math.round(quality / r) : quality;
  } else {
    w = aspect >= 1 ? quality : Math.round(quality * aspect);
    h = aspect >= 1 ? Math.round(quality / aspect) : quality;
  }

  if (w === renderer.w && h === renderer.h) return;
  renderer.setSize(w, h);
  sim.setSize(w, h);
  renderer.clear(P);
  if (!initial) restart({ clear: true });
}

const stageBar = document.getElementById('stagebar');
let recordButton;
let playButton;
buildStageBar();

function buildStageBar() {
  const mk = (label, options, value, onSet) => {
    const sel = document.createElement('select');
    for (const [id, text] of options) {
      const opt = document.createElement('option');
      opt.value = id; opt.textContent = text;
      sel.appendChild(opt);
    }
    sel.value = value;
    sel.addEventListener('change', () => onSet(sel.value));
    const wrap = document.createElement('label');
    wrap.className = 'bar-field';
    wrap.innerHTML = `<span>${label}</span>`;
    wrap.appendChild(sel);
    return wrap;
  };

  const btn = (text, title, fn, cls = '') => {
    const b = document.createElement('button');
    b.className = `btn ${cls}`.trim();
    b.textContent = text;
    b.title = title;
    b.addEventListener('click', fn);
    return b;
  };

  playButton = btn(P.paused ? 'Play' : 'Pause', 'Space', () => {
    P.paused = !P.paused;
    syncPlayLabel();
  });
  recordButton = btn('Record', 'V — capture a video of the canvas', toggleRecord, 'btn-rec');

  stageBar.append(
    mk('Format', ASPECTS.map(([id]) => [id, id === 'fill' ? 'Fill' : id]), P.aspect, (v) => {
      P.aspect = v; sizeStage(); persist();
    }),
    mk('Res', QUALITIES.map(([label, v]) => [String(v), `${label}p`]), String(P.quality), (v) => {
      P.quality = Number(v); sizeStage(); persist();
    }),
    playButton,
    btn('Clear', 'C', () => renderer.clear(P), 'btn-ghost'),
    btn('Restart', 'Rebuild the swarm', () => restart(), 'btn-ghost'),
    btn('Randomise', 'R', randomize),
    btn('PNG', 'S — save a still', () => savePNG(canvas, `bioluma-${P.creature}`), 'btn-ghost'),
    recordButton,
  );
  if (!Recorder.supported()) {
    recordButton.disabled = true;
    recordButton.title = 'This browser cannot record canvas video';
  }
}

function toggleRecord() {
  if (recorder.active) {
    recorder.stop();
    recordButton.classList.remove('is-rec');
    recordButton.textContent = 'Record';
    flash('Saving video…');
    return;
  }
  try {
    recorder.start(canvas, { name: `bioluma-${P.creature}`, onStop: () => flash('Video saved') });
    recordButton.classList.add('is-rec');
    flash('Recording');
  } catch (err) {
    flash(err.message);
  }
}

/* ── input ─────────────────────────────────────────────────────────────────── */

function toCanvas(e) {
  const r = canvas.getBoundingClientRect();
  sim.pointer.x = (e.clientX - r.left) / r.width * canvas.width;
  sim.pointer.y = (e.clientY - r.top) / r.height * canvas.height;
}

canvas.addEventListener('pointermove', (e) => { toCanvas(e); sim.pointer.inside = true; });
canvas.addEventListener('pointerdown', (e) => {
  toCanvas(e);
  sim.pointer.inside = true;
  sim.pointer.down = true;
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointerup', () => { sim.pointer.down = false; });
canvas.addEventListener('pointerleave', () => { sim.pointer.inside = false; sim.pointer.down = false; });

addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea')) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  switch (e.key.toLowerCase()) {
    case ' ': e.preventDefault(); P.paused = !P.paused; syncPlayLabel(); break;
    case 'h': togglePanel(); break;
    case 'r': randomize(); break;
    case 'c': renderer.clear(P); break;
    case 's': savePNG(canvas, `bioluma-${P.creature}`); break;
    case 'v': toggleRecord(); break;
    case 'f': toggleFullscreen(); break;
    default: break;
  }
});

function syncPlayLabel() {
  if (playButton) playButton.textContent = P.paused ? 'Play' : 'Pause';
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.();
}

addEventListener('resize', () => sizeStage());

/* ── loop ──────────────────────────────────────────────────────────────────── */

let last = performance.now();
let fpsAvg = 60;

function tick(now) {
  requestAnimationFrame(tick);
  // Clamped so a backgrounded tab does not resume with one enormous step that
  // flings every agent off the canvas.
  const dt = Math.min(0.05, Math.max(0.0005, (now - last) / 1000));
  last = now;
  fpsAvg += (1 / dt - fpsAvg) * 0.06;

  if (!P.paused) {
    sim.step(dt, P);
    renderer.frame(sim, P, palette);
  } else {
    // Keep compositing while paused so the finish controls stay live over a
    // static painting.
    renderer.composite(P, sim, palette);
  }

  if (sim.frame % 12 === 0 || P.paused) {
    hud.textContent = `${Math.round(fpsAvg)} fps · ${sim.agents.length} agents · `
      + `${renderer.w}×${renderer.h}${recorder.active ? ` · REC ${recorder.elapsed.toFixed(1)}s` : ''}`;
  }
}
requestAnimationFrame(tick);

/* ── toasts ────────────────────────────────────────────────────────────────── */

let toastTimer = 0;
function flash(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('is-on'), 1800);
}

// Handy in the console, and the only global the app defines.
window.bioluma = { get P() { return P; }, sim, renderer, restart, SCHEMA };
