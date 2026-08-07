/* The renderer.

   Nothing is cleared between frames, so a frame is not a picture of where the
   agents *are* but of everywhere they have *been*.

   Colour and line live on separate persistent canvases, and that separation is
   the whole design. Ink in water behaves nothing like a pencil line: colour
   diffuses and settles out in a second or two, while the track a swimmer cuts
   stays legible far longer. One shared decay rate can give you smears or
   long trails, never both — which is exactly the look this is after. So:

     • bloom layer — opaque, holds the paper colour, blooms drawn in the
       palette's blend mode, decays toward the paper at Bloom fade.
     • line layer  — transparent, hairlines and heads, decays by eating its own
       alpha at Trail fade, which is typically ten times slower.

   The view canvas composites the two and adds bleed/glow, grain and vignette
   on top, so the finish stays a finish rather than something baked into the
   accumulation — you can keep adjusting it over a paused painting. */

import { hsl } from './palettes.js';

const SPRITE = 128;

const BLEND_GAIN = {
  multiply: 1, 'source-over': 1, overlay: 0.9, 'soft-light': 1.2, screen: 0.65, lighter: 0.5,
};

export class Renderer {
  constructor(view) {
    this.view = view;
    this.vctx = view.getContext('2d', { alpha: false });
    this.paint = document.createElement('canvas');
    this.pctx = this.paint.getContext('2d');
    this.lines = document.createElement('canvas');
    this.lctx = this.lines.getContext('2d');
    this.blur = document.createElement('canvas');
    this.bctx = this.blur.getContext('2d');
    this.sprites = new Map();
    this.grainTile = null;
    this.w = 0;
    this.h = 0;
    // Fade is paid in instalments — see fadeStep.
    this.bloomDebt = { owed: 0, age: 0 };
    this.trailDebt = { owed: 0, age: 0 };
  }

  setSize(w, h) {
    if (this.w === w && this.h === h) return;
    this.w = w; this.h = h;
    for (const c of [this.view, this.paint, this.lines]) { c.width = w; c.height = h; }
    this.blur.width = Math.max(1, Math.round(w / 3));
    this.blur.height = Math.max(1, Math.round(h / 3));
    this.vignetteCache = null;
  }

  clear(P) {
    this.pctx.globalCompositeOperation = 'source-over';
    this.pctx.globalAlpha = 1;
    this.pctx.fillStyle = P.bg;
    this.pctx.fillRect(0, 0, this.w, this.h);
    this.lctx.globalCompositeOperation = 'source-over';
    this.lctx.globalAlpha = 1;
    this.lctx.clearRect(0, 0, this.w, this.h);
  }

  /* A tinted radial sprite, cached. Drawing 2,000 gradients a frame is not
     viable; drawing 2,000 copies of ~40 cached bitmaps is trivial. Colours are
     quantised into that many buckets, which is far below what the eye resolves
     through a soft-edged blob at 8% opacity. */
  sprite(h, s, l) {
    const hq = Math.round(((h % 360) + 360) % 360 / 3) * 3;
    const sq = Math.round(s / 6) * 6;
    const lq = Math.round(l / 6) * 6;
    const key = hq * 100000 + sq * 100 + lq;
    let c = this.sprites.get(key);
    if (c) return c;
    if (this.sprites.size > 700) this.sprites.clear();

    c = document.createElement('canvas');
    c.width = c.height = SPRITE;
    const ctx = c.getContext('2d');
    const r = SPRITE / 2;
    const g = ctx.createRadialGradient(r, r, 0, r, r, r);
    // Soft, but not endlessly soft. A linear falloff reads as a disc with an
    // edge, and an edge is the one thing these blobs must not have; a very long
    // tail is worse, because every blob then leaves a faint wash across
    // everything it passes and the paper silts up within seconds.
    g.addColorStop(0, hsl([hq, sq, lq], { alpha: 1 }));
    g.addColorStop(0.12, hsl([hq, sq, lq], { alpha: 0.72 }));
    g.addColorStop(0.3, hsl([hq, sq, lq], { alpha: 0.3 }));
    g.addColorStop(0.55, hsl([hq, sq, lq], { alpha: 0.075 }));
    g.addColorStop(0.8, hsl([hq, sq, lq], { alpha: 0.012 }));
    g.addColorStop(1, hsl([hq, sq, lq], { alpha: 0 }));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, SPRITE, SPRITE);
    this.sprites.set(key, c);
    return c;
  }

  /* Canvas pixels are 8-bit, so a fill at 0.4% opacity moves a channel by less
     than half a level and rounds away to nothing. Faded frame after frame, the
     faint end of the range therefore never clears at all: pale washes and old
     trails sit on the canvas forever while the strong colour above them decays
     normally, and the piece silts up.

     So the fade is owed rather than paid every frame. Debt accrues at the rate
     the slider asks for and is only spent once it is large enough to actually
     move a pixel — or once enough frames have passed that holding it back would
     be visible. Same total decay, but every instalment lands. */
  fadeStep(debt, rate, minStep = 0.08, maxAge = 10) {
    debt.owed += rate;
    debt.age++;
    if (debt.owed <= 0) return 0;
    if (debt.owed < minStep && debt.age < maxAge) return 0;
    const alpha = Math.min(1, debt.owed);
    debt.owed = 0;
    debt.age = 0;
    return alpha;
  }

  /** Which palette entry an agent paints with, per the Colour by control. */
  colorIndex(a, P, len) {
    switch (P.colorBy) {
      case 'limb': return a.k < 0 ? 0 : a.k;
      case 'agent': return a.ci;
      case 'speed': {
        const sp = Math.hypot(a.vx, a.vy) / (this.ref * 0.012 + 0.0001);
        return Math.min(len - 1, Math.max(0, Math.floor(sp)));
      }
      case 'depth': return Math.floor((a.d2 !== undefined ? a.d2 : a.d) * len);
      default: return a.b;
    }
  }

  frame(sim, P, pal) {
    const { pctx, lctx, w, h } = this;
    const ref = Math.min(w, h);
    this.ref = ref;
    const agents = sim.agents;
    const len = pal.colors.length;
    const drift = P.hueDrift * sim.t;
    // A segment longer than this is an agent teleporting across a wrapped
    // edge, not a swimmer, so it gets no line.
    const maxSeg = ref * 0.2;

    /* 1 — blooms, on the colour layer */
    const bloomFade = this.fadeStep(this.bloomDebt, P.fade);
    if (bloomFade > 0) {
      pctx.globalCompositeOperation = 'source-over';
      pctx.globalAlpha = bloomFade;
      pctx.fillStyle = P.bg;
      pctx.fillRect(0, 0, w, h);
    }

    if (P.blobAlpha > 0 && P.blobSize > 0 && P.bloomShare > 0) {
      pctx.globalCompositeOperation = P.blend;
      // Additive modes race to white far faster than multiply crawls to black,
      // so the same density that looks rich on paper blows out in water. The
      // compensation keeps a palette swap from needing a re-tune.
      pctx.globalAlpha = P.blobAlpha * (BLEND_GAIN[P.blend] || 1);
      const base = ref * 0.055 * P.blobSize;
      for (let i = 0; i < agents.length; i++) {
        const a = agents[i];
        if (a.hidden || a.br > P.bloomShare) continue;
        const c = pal.colors[((this.colorIndex(a, P, len) % len) + len) % len];
        const sprite = this.sprite(
          c[0] + drift + a.hj * P.hueJitter,
          c[1] * P.sat,
          c[2] + P.light);
        const size = base * (1 + (a.sz - 1) * P.sizeVar);
        pctx.drawImage(sprite, a.x - size, a.y - size, size * 2, size * 2);
      }
    }

    /* 2 — trails and heads, on the line layer. Fading here eats the layer's
       own alpha, which is why lines dissolve rather than bleaching toward the
       paper colour the way the blooms do. */
    const trailFade = this.fadeStep(this.trailDebt, P.trailFade, 0.05, 20);
    if (trailFade > 0) {
      lctx.globalCompositeOperation = 'destination-out';
      lctx.globalAlpha = trailFade;
      lctx.fillStyle = '#000';
      lctx.fillRect(0, 0, w, h);
    }

    lctx.globalCompositeOperation = 'source-over';

    if (P.hairAlpha > 0 && P.hairWidth > 0) {
      lctx.globalAlpha = P.hairAlpha;
      lctx.strokeStyle = P.ink;
      lctx.lineWidth = P.hairWidth * (ref / 1200);
      lctx.lineCap = 'round';
      lctx.beginPath();
      for (let i = 0; i < agents.length; i++) {
        const a = agents[i];
        if (a.jump || a.hidden) continue;
        const dx = a.x - a.px, dy = a.y - a.py;
        if (dx * dx + dy * dy > maxSeg * maxSeg) continue;
        lctx.moveTo(a.px, a.py);
        lctx.lineTo(a.x, a.y);
      }
      lctx.stroke();
    }

    this.composite(P, sim, pal);
  }

  /* Heads are drawn to the view, not to either accumulation layer: an agent has
     one head, now, and painting it into the history would smear every trail
     into a string of beads. This is also the only pass drawn at full opacity —
     the eye needs something crisp to track through all that softness. */
  heads(P, sim, pal) {
    if (!(P.headSize > 0) || !sim) return;
    const { vctx, ref } = this;
    const agents = sim.agents;
    const len = pal.colors.length;
    const drift = P.hueDrift * sim.t;
    const hr = P.headSize * (ref / 1400);

    vctx.globalCompositeOperation = 'source-over';
    vctx.globalAlpha = 0.85;
    vctx.fillStyle = P.ink;
    vctx.beginPath();
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      if (a.hidden) continue;
      const r = hr * (0.55 + a.sz * 0.5);
      vctx.moveTo(a.x + r, a.y);
      vctx.arc(a.x, a.y, r, 0, Math.PI * 2);
    }
    vctx.fill();

    // A bright core on the swimmers carrying colour — the specks of light in
    // the reference, and what keeps a still frame from reading as flat.
    vctx.globalAlpha = 0.9;
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      if (a.hidden || a.br > P.bloomShare) continue;
      const c = pal.colors[((this.colorIndex(a, P, len) % len) + len) % len];
      const r = hr * (0.3 + a.sz * 0.22);
      vctx.fillStyle = hsl([c[0] + drift + a.hj * P.hueJitter, c[1] * P.sat, Math.min(96, c[2] + P.light + 14)]);
      vctx.beginPath();
      vctx.arc(a.x - r * 0.3, a.y - r * 0.3, r, 0, Math.PI * 2);
      vctx.fill();
    }
    vctx.globalAlpha = 1;
  }

  /** Bleed/glow, grain and vignette — applied to the view every frame so they
      never accumulate, and so the sliders stay live over a static painting. */
  composite(P, sim, pal) {
    const { vctx, w, h } = this;
    this.ref = Math.min(w, h);
    vctx.globalCompositeOperation = 'source-over';
    vctx.globalAlpha = 1;
    vctx.drawImage(this.paint, 0, 0);
    vctx.drawImage(this.lines, 0, 0);

    if (P.glow > 0 && this.bctx.filter !== undefined) {
      const { bctx, blur } = this;
      bctx.globalCompositeOperation = 'source-over';
      bctx.globalAlpha = 1;
      bctx.filter = `blur(${Math.max(0.5, P.glowRadius / 3)}px)`;
      bctx.clearRect(0, 0, blur.width, blur.height);
      bctx.drawImage(this.paint, 0, 0, blur.width, blur.height);
      bctx.drawImage(this.lines, 0, 0, blur.width, blur.height);
      bctx.filter = 'none';
      // On dark water a blurred copy added back is a glow; on pale paper the
      // same copy multiplied back is ink bleeding into the fibres. Picking by
      // background luminance means one slider does the right thing either way.
      vctx.globalCompositeOperation = luminance(P.bg) > 0.45 ? 'multiply' : 'lighter';
      vctx.globalAlpha = P.glow * (luminance(P.bg) > 0.45 ? 0.85 : 1);
      vctx.drawImage(blur, 0, 0, w, h);
      vctx.globalCompositeOperation = 'source-over';
      vctx.globalAlpha = 1;
    }

    this.heads(P, sim, pal);

    if (P.grain > 0) {
      if (!this.grainPattern) {
        this.grainTile = this.grainTile || makeGrain();
        this.grainPattern = vctx.createPattern(this.grainTile, 'repeat');
      }
      vctx.globalCompositeOperation = 'overlay';
      vctx.globalAlpha = P.grain * 0.3;
      vctx.save();
      // Re-seating the tile each frame turns static texture into film grain.
      // The offset is negative so the covered area is the frame plus one tile,
      // not the frame plus four.
      vctx.translate(-(Math.random() * 256 | 0), -(Math.random() * 256 | 0));
      vctx.fillStyle = this.grainPattern;
      vctx.fillRect(0, 0, w + 256, h + 256);
      vctx.restore();
      vctx.globalAlpha = 1;
      vctx.globalCompositeOperation = 'source-over';
    }

    if (P.vignette > 0) {
      if (!this.vignetteCache) {
        const g = vctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.25,
          w / 2, h / 2, Math.max(w, h) * 0.75);
        g.addColorStop(0, 'rgba(0,0,0,0)');
        g.addColorStop(1, 'rgba(0,0,0,1)');
        this.vignetteCache = g;
      }
      vctx.globalCompositeOperation = 'multiply';
      vctx.globalAlpha = P.vignette * 0.85;
      vctx.fillStyle = this.vignetteCache;
      vctx.fillRect(0, 0, w, h);
      vctx.globalAlpha = 1;
      vctx.globalCompositeOperation = 'source-over';
    }
  }
}

function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function makeGrain() {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 110 + Math.random() * 70;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}
