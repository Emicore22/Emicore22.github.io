# Bioluma

A generative motion tool where **sea creatures do the animating**. An octopus
jets and drags eight curling arms; a shoal shimmers and bolts; jellyfish
squeeze, glide and sink. Each one moves a swarm of tiny swimmers, and the
swimmers leave paint — soft colour blooms and hairline trails on paper.

No build step, no dependencies, no server. Plain ES modules and a 2-D canvas.

**Open `bioluma/index.html`** (or serve the repo: `python3 -m http.server 8000`
→ <http://localhost:8000/bioluma/>).

## Creatures

Each is a *motion driver* — it decides where the swimmers go, and it brings its
own parameters and its own suggested look, applied when you pick it.

| Creature | Motion |
|---|---|
| **Krill Swarm** | Plankton clouds: cohesion, separation, current, forward flicks |
| **Fish School** | Boids plus body undulation and darting that spreads through the shoal |
| **Octopus** | Jetting mantle, eight arms as travelling sine waves, tips lagging |
| **Jellyfish** | Asymmetric bell pulse — hard squeeze, long glide — with chained tentacles |
| **Squid** | Long coasts broken by hard jets; arms bundle at speed, open at rest |
| **Manta Ray** | Slow banked glides, flap travelling from spine to wingtip |
| **Siphonophore** | A noise-steered head towing a stem of zooids in long ribbons |
| **Anemone Garden** | Rooted polyps; only the current moves the tentacles |

## Controls

Grouped in the panel, all live:

- **Swarm** — agent count, speed, creature scale, body lag, jitter
- **Current** — turbulence and eddy size (a curl-noise field), drift, swirl,
  gather, pointer pull
- **Bloom** — size, density, what share of swimmers carry colour, variance,
  fade, blend mode
- **Line** — trail ink, weight, head size, trail fade
- **Colour** — hue drift and spread, saturation, lightness, what colour maps to,
  paper and ink
- **Finish** — glow/bleed, grain, vignette (composited on the view, so they
  stay adjustable over a paused painting)

Twelve palettes, each carrying its own paper, ink and blend mode. Double-click
any slider to reset it.

### Keyboard

| Key | Action |
|---|---|
| `Space` | Pause / play |
| `H` | Hide the panel |
| `R` | Randomise |
| `C` | Clear the canvas |
| `S` | Save a PNG |
| `V` | Start / stop recording |
| `F` | Fullscreen |

Drag on the canvas to steer the swarm (turn **Pointer pull** up first).

## Getting work out

- **PNG** at the full render resolution — up to 2160 on the long edge.
- **Record** captures the canvas live to WebM at a high bitrate (these frames
  are almost all soft gradient, which is the worst case for a codec — the
  default bitrate would band badly).
- **Copy link** puts the entire state in the URL. **Presets** save it to this
  browser.
- Seeds are words: the same seed and settings reproduce a piece exactly.

## How it works

```
js/sim.js          agents, the current (curl noise), neighbour grid, edges
js/creatures/*.js  one motion driver each — writes x/y on every agent
js/render.js       two persistent canvases + the finishing pass
js/params.js       the schema everything else is generated from
js/ui.js           panel built from that schema
js/main.js         state, loop, keyboard, presets, links
```

Two things are worth knowing before you change anything:

**Colour and line decay separately.** Ink in water diffuses and settles out in a
second or two, while the track a swimmer cuts stays legible far longer. One
shared decay rate gives you smears *or* long trails, never both — so blooms live
on an opaque layer that fades toward the paper, and lines on a transparent one
that eats its own alpha about ten times slower.

**The fade is paid in instalments.** Canvas pixels are 8-bit, so a fill at 0.4%
opacity moves a channel by less than half a level and rounds away to nothing —
the faint end of the range would never clear, and the paper would silt up with a
haze that no fade could remove. Debt accrues at the rate the slider asks for and
is spent only once it is large enough to actually move a pixel.

Adding a creature: drop a module in `js/creatures/` exporting
`{ id, name, blurb, look, params, init, update }` and add it to
`creatures/index.js`. Its sliders, its share links and its presets come for free.
