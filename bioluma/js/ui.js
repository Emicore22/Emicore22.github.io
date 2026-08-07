/* The control panel. Every control is generated from the schema in params.js
   or from the active creature's own parameter list, so nothing here knows what
   a "tentacle" is — add a parameter to a creature and its slider appears. */

import { SCHEMA } from './params.js';
import { PALETTES, paletteSwatch } from './palettes.js';
import { CREATURES } from './creatures/index.js';

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== undefined && v !== null) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c) node.appendChild(c);
  return node;
}

const fmt = (v, step) => {
  if (step >= 1) return String(Math.round(v));
  const dp = step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3;
  return Number(v).toFixed(dp);
};

export class Panel {
  /** onChange(key, value, scope) — scope is 'P' for a global parameter or a
      creature id for one of that creature's own. onAction(name) for buttons. */
  constructor(root, { onChange, onAction }) {
    this.root = root;
    this.onChange = onChange;
    this.onAction = onAction;
    this.controls = new Map();
    this.buttons = { creature: new Map(), palette: new Map() };
  }

  build(P, creature) {
    this.controls.clear();
    this.buttons.creature.clear();
    this.buttons.palette.clear();
    this.root.textContent = '';

    this.root.append(
      this.header(),
      this.creaturePicker(P),
      this.section(creature.name, creature.params.map((c) => this.control(c, P.cp[creature.id][c.key], creature.id)), true, creature.blurb),
      this.palettePicker(P),
      ...SCHEMA.map((g) => this.section(g.group, g.controls.map((c) => this.control(c, P[c.key], 'P')), g.group === 'Swarm')),
      this.stageSection(P),
      this.presetSection(),
      this.footer(),
    );
  }

  header() {
    return el('header', { class: 'brand' }, [
      el('div', { class: 'brand-mark', text: '≈' }),
      el('div', {}, [
        el('h1', { text: 'Bioluma' }),
        el('p', { text: 'Sea-creature motion painting' }),
      ]),
      el('button', {
        class: 'icon-btn', title: 'Hide panel (H)', 'aria-label': 'Hide panel',
        onclick: () => this.onAction('togglePanel'),
      }, [el('span', { text: '‹' })]),
    ]);
  }

  creaturePicker(P) {
    const grid = el('div', { class: 'chip-grid' });
    for (const c of CREATURES) {
      const b = el('button', {
        class: 'chip' + (c.id === P.creature ? ' is-on' : ''),
        title: c.blurb,
        text: c.name,
        onclick: () => this.onAction('creature:' + c.id),
      });
      this.buttons.creature.set(c.id, b);
      grid.appendChild(b);
    }
    return el('section', { class: 'block' }, [
      el('h2', { class: 'block-title', text: 'Creature' }),
      grid,
    ]);
  }

  palettePicker(P) {
    const grid = el('div', { class: 'pal-grid' });
    for (const p of PALETTES) {
      const b = el('button', {
        class: 'pal' + (p.id === P.palette ? ' is-on' : ''),
        title: p.name,
        onclick: () => this.onAction('palette:' + p.id),
      }, [
        el('span', { class: 'pal-swatch' }),
        el('span', { class: 'pal-name', text: p.name }),
      ]);
      b.querySelector('.pal-swatch').style.background = paletteSwatch(p);
      this.buttons.palette.set(p.id, b);
      grid.appendChild(b);
    }
    return el('section', { class: 'block' }, [
      el('h2', { class: 'block-title', text: 'Palette' }),
      grid,
    ]);
  }

  section(title, controls, open = false, blurb = '') {
    const body = el('div', { class: 'sec-body' }, controls);
    if (blurb) body.prepend(el('p', { class: 'blurb', text: blurb }));
    const d = el('details', { class: 'sec' }, [
      el('summary', { text: title }),
      body,
    ]);
    if (open) d.setAttribute('open', '');
    return d;
  }

  control(c, value, scope) {
    const id = `${scope}-${c.key}`;
    if (c.type === 'select') {
      const sel = el('select', { id, onchange: (e) => this.onChange(c.key, e.target.value, scope) },
        c.options.map(([v, label]) => el('option', { value: v, text: label })));
      sel.value = value;
      this.controls.set(id, { set: (v) => { sel.value = v; } });
      return el('label', { class: 'ctl ctl-row', for: id, title: c.hint || '' }, [
        el('span', { class: 'ctl-label', text: c.label }), sel,
      ]);
    }

    if (c.type === 'color') {
      const input = el('input', { type: 'color', id, value, oninput: (e) => this.onChange(c.key, e.target.value, scope) });
      this.controls.set(id, { set: (v) => { input.value = v; } });
      return el('label', { class: 'ctl ctl-row', for: id, title: c.hint || '' }, [
        el('span', { class: 'ctl-label', text: c.label }), input,
      ]);
    }

    const out = el('output', { class: 'ctl-val', text: fmt(value, c.step) });
    const input = el('input', {
      type: 'range', id, min: c.min, max: c.max, step: c.step, value,
      oninput: (e) => {
        const v = Number(e.target.value);
        out.textContent = fmt(v, c.step);
        this.onChange(c.key, v, scope);
      },
    });
    // Double-click a slider to put it back where it started.
    input.addEventListener('dblclick', () => {
      input.value = c.def;
      out.textContent = fmt(c.def, c.step);
      this.onChange(c.key, c.def, scope);
    });
    this.controls.set(id, {
      set: (v) => { input.value = v; out.textContent = fmt(v, c.step); },
    });
    return el('div', { class: 'ctl', title: c.hint || '' }, [
      el('label', { class: 'ctl-head', for: id }, [
        el('span', { class: 'ctl-label', text: c.label }), out,
      ]),
      input,
    ]);
  }

  stageSection(P) {
    const seed = el('input', {
      type: 'text', class: 'seed', value: P.seed, spellcheck: 'false',
      onchange: (e) => this.onChange('seed', e.target.value.trim() || 'bioluma', 'P'),
    });
    this.controls.set('P-seed', { set: (v) => { seed.value = v; } });
    return this.section('Seed', [
      el('div', { class: 'ctl ctl-row' }, [
        seed,
        el('button', { class: 'btn btn-ghost', text: 'Shuffle', onclick: () => this.onAction('reseed') }),
      ]),
      el('p', { class: 'blurb', text: 'The seed fixes every random choice. Same seed and settings, same piece.' }),
    ], false);
  }

  presetSection() {
    this.presetSelect = el('select', {
      class: 'preset-select',
      onchange: (e) => { if (e.target.value) this.onAction('preset:load:' + e.target.value); },
    });
    return this.section('Presets', [
      el('div', { class: 'ctl ctl-row' }, [this.presetSelect]),
      el('div', { class: 'btn-row' }, [
        el('button', { class: 'btn', text: 'Save', onclick: () => this.onAction('preset:save') }),
        el('button', { class: 'btn btn-ghost', text: 'Delete', onclick: () => this.onAction('preset:delete') }),
        el('button', { class: 'btn btn-ghost', text: 'Copy link', onclick: () => this.onAction('share') }),
      ]),
    ], false);
  }

  footer() {
    return el('div', { class: 'panel-foot' }, [
      el('p', {
        class: 'keys',
        html: '<b>Space</b> pause · <b>H</b> panel · <b>R</b> randomise · <b>C</b> clear · '
          + '<b>S</b> save PNG · <b>V</b> record · <b>F</b> fullscreen · drag on canvas to steer',
      }),
    ]);
  }

  setPresets(names, current) {
    if (!this.presetSelect) return;
    this.presetSelect.textContent = '';
    this.presetSelect.appendChild(el('option', { value: '', text: names.length ? 'Load a preset…' : 'No presets saved' }));
    for (const n of names) this.presetSelect.appendChild(el('option', { value: n, text: n }));
    this.presetSelect.value = current && names.includes(current) ? current : '';
  }

  /** Pushes values back into the widgets after a randomise, preset or link. */
  sync(P, creature) {
    for (const [id, c] of this.controls) {
      const [scope, ...rest] = id.split('-');
      const key = rest.join('-');
      if (scope === 'P') { if (P[key] !== undefined) c.set(P[key]); }
      else if (P.cp[scope] && P.cp[scope][key] !== undefined) c.set(P.cp[scope][key]);
    }
    for (const [id, b] of this.buttons.creature) b.classList.toggle('is-on', id === P.creature);
    for (const [id, b] of this.buttons.palette) b.classList.toggle('is-on', id === P.palette);
    void creature;
  }
}
