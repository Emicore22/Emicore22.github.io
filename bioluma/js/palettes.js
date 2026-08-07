/* Palettes are the single biggest lever on how a piece reads, so each one
   carries its whole world: the paper it is painted on, the ink the hairlines
   are drawn in, and the blend mode that makes those colours behave.

   Colours are HSL triples rather than hex so hue drift, jitter and desaturation
   are one addition away at render time.

   blend: 'multiply' behaves like transparent ink on light paper — overlaps go
   darker and richer. 'screen' and 'lighter' behave like light on dark water —
   overlaps bloom toward white. Pairing the wrong one with a background is the
   fastest way to a muddy frame, so the palette decides it. */

export const PALETTES = [
  {
    id: 'reef', name: 'Reef Bloom', blend: 'multiply',
    bg: '#f5f2e9', ink: '#2c2740',
    colors: [[318, 92, 62], [270, 82, 64], [212, 88, 62], [186, 78, 56],
      [52, 95, 58], [26, 92, 60], [342, 88, 68], [162, 62, 52]],
  },
  {
    id: 'abyss', name: 'Abyssal Neon', blend: 'screen',
    bg: '#070b14', ink: '#8fb8ff',
    colors: [[188, 95, 55], [206, 92, 58], [286, 88, 62], [322, 90, 60],
      [96, 78, 52], [166, 85, 50], [244, 80, 62]],
  },
  {
    id: 'nudi', name: 'Nudibranch', blend: 'multiply',
    bg: '#fbf7f2', ink: '#3a1f2e',
    colors: [[334, 96, 60], [16, 94, 60], [40, 96, 58], [82, 72, 48],
      [258, 84, 62], [196, 88, 54], [356, 82, 64]],
  },
  {
    id: 'biolum', name: 'Bioluminescent', blend: 'screen',
    bg: '#04120f', ink: '#79e8c8',
    colors: [[168, 88, 56], [150, 80, 58], [186, 90, 58], [48, 90, 62],
      [200, 70, 52], [128, 70, 54], [88, 75, 56]],
  },
  {
    id: 'coral', name: 'Coral Dusk', blend: 'multiply',
    bg: '#f7ece2', ink: '#40252a',
    colors: [[8, 88, 64], [346, 78, 66], [32, 92, 62], [178, 62, 48],
      [292, 58, 60], [14, 70, 52], [56, 80, 62]],
  },
  {
    id: 'kelp', name: 'Kelp Forest', blend: 'multiply',
    bg: '#eef0e4', ink: '#20301f',
    colors: [[142, 62, 40], [88, 58, 44], [44, 82, 50], [22, 76, 48],
      [178, 58, 38], [64, 48, 52], [318, 44, 52]],
  },
  {
    id: 'krill', name: 'Arctic Krill', blend: 'multiply',
    bg: '#eef2f7', ink: '#1e2a44',
    colors: [[222, 82, 58], [248, 68, 66], [280, 52, 68], [340, 62, 72],
      [200, 74, 60], [230, 40, 46], [188, 60, 66]],
  },
  {
    id: 'inkgold', name: 'Ink & Gold', blend: 'screen',
    bg: '#0d0c0a', ink: '#d9bd7a',
    colors: [[44, 88, 58], [34, 84, 54], [22, 72, 48], [50, 40, 72],
      [186, 44, 46], [8, 66, 50], [56, 92, 64]],
  },
  {
    id: 'tidepool', name: 'Tide Pool', blend: 'multiply',
    bg: '#eaf3f0', ink: '#123534',
    colors: [[176, 78, 50], [158, 68, 52], [6, 84, 64], [46, 92, 58],
      [268, 62, 62], [198, 82, 56], [128, 52, 50]],
  },
  {
    id: 'trench', name: 'Midnight Trench', blend: 'lighter',
    bg: '#05060f', ink: '#6f7dd8',
    colors: [[262, 88, 52], [286, 84, 48], [318, 82, 50], [206, 88, 52],
      [178, 80, 46], [232, 76, 54]],
  },
  {
    id: 'mantle', name: 'Sun Mantle', blend: 'multiply',
    bg: '#fdf6e6', ink: '#3c2a10',
    colors: [[38, 96, 58], [16, 92, 58], [352, 84, 62], [268, 70, 62],
      [196, 84, 56], [62, 92, 54], [140, 56, 48]],
  },
  {
    id: 'squid', name: 'Squid Ink', blend: 'screen',
    bg: '#0a0810', ink: '#b8a6ff',
    colors: [[268, 84, 58], [300, 78, 56], [212, 86, 58], [188, 72, 52],
      [332, 76, 58], [246, 70, 62], [42, 70, 58]],
  },
];

export const paletteById = (id) => PALETTES.find((p) => p.id === id) || PALETTES[0];

/** `[h, s, l]` → a CSS colour, with the render-time modifiers folded in. */
export function hsl([h, s, l], { hueShift = 0, sat = 1, light = 0, alpha = 1 } = {}) {
  const hh = ((h + hueShift) % 360 + 360) % 360;
  const ss = Math.max(0, Math.min(100, s * sat));
  const ll = Math.max(0, Math.min(100, l + light));
  return alpha >= 1
    ? `hsl(${hh.toFixed(1)} ${ss.toFixed(1)}% ${ll.toFixed(1)}%)`
    : `hsla(${hh.toFixed(1)} ${ss.toFixed(1)}% ${ll.toFixed(1)}% / ${alpha})`;
}

/** Background swatch for the palette buttons in the panel. */
export function paletteSwatch(p) {
  const stops = p.colors.slice(0, 5)
    .map((c, i, a) => `${hsl(c)} ${(i / a.length * 100).toFixed(0)}% ${((i + 1) / a.length * 100).toFixed(0)}%`)
    .join(',');
  return `linear-gradient(90deg, ${stops})`;
}
