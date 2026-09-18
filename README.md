# Voxelize

A Vue 3.5 button with Gildarts-grade "Crush" magic: hover it and hairline fractures
trace along the voxel seams under your pointer; click it and the surface comes apart
into little cubes that tumble, hang in the air, and snap back together.

![phases: crack → burst → hang → reform → settle](https://img.shields.io/badge/phases-crack%20%E2%86%92%20burst%20%E2%86%92%20hang%20%E2%86%92%20reform%20%E2%86%92%20settle-6d3bf5)

## Look at it

```bash
npm install && npm run dev     # Vite dev server (Node 18+)
```

Or, with no install at all:

```bash
npm run demo                   # tiny static server for demo.html
```

`demo.html` is a zero-build harness: Vue 3.5 from a CDN plus the same engine module,
so the effect can be opened in any browser without a bundler.

## Use it

```vue
<script setup>
import VoxelizeButton from './components/VoxelizeButton.vue'
</script>

<template>
  <VoxelizeButton label="Voxelize" @click="doThing()" @shatter="..." @restored="..." />
</template>
```

### Props

| prop           | type                 | default      | meaning                                                        |
| -------------- | -------------------- | ------------ | -------------------------------------------------------------- |
| `label`        | `string`             | `'Voxelize'` | Rendered label (equivalent to the default slot).                |
| `voxelSize`    | `number`             | `0`          | Cube edge in px. **0 = auto**, derived from the label's font size so the shattered letterforms stay legible. |
| `gap`          | `number`             | `0.45`       | Hairline gap between cubes.                                     |
| `stressRadius` | `number`             | `26`         | Radius (px) around the pointer where seams start to fracture.    |
| `depth`        | `number`             | `1`          | Camera axis for the debris: `1` pops at the viewer, `0` stays flat, `-1` falls away. Any value in `-2…2` works. |
| `duration`     | `number`             | `0`          | Total flight time in seconds. `0` = the built-in ≈1.7s timeline. Velocities are rescaled with it, so longer is slow motion rather than a bigger explosion. |
| `easing`       | `string`             | `'back'`     | Reassembly curve: `'back'` (overshoot), `'linear'`, `'out'`, `'in'`, `'inout'`. |
| `dissolve`     | `number`             | `0`          | `0` = off. `0.05` shrinks every cube by 5% per 1/60s until it disappears instead of reassembling. |
| `autoReform`   | `boolean`            | `true`       | `false` = the pieces stay where they land until `reset()` is called. |
| `surface`      | `string`             | `''`         | Face colour (gradient start). Empty = use `--vx-surface`.        |
| `surfaceAlt`   | `string`             | `''`         | Face colour (gradient end). Empty = use `--vx-surface-alt`.      |
| `ink`          | `string`             | `''`         | Label colour, and the colour of the letter cubes. Empty = `--vx-ink`. |
| `radius`       | `number \| string`   | `null`       | Corner radius: number = px, string = any CSS length (`'999px'` for a pill). `null` = from CSS. |
| `disabled`     | `boolean`            | `false`      | Behave like a normal disabled button (no shatter).               |
| `type`         | `string`             | `'button'`   | Native button type.                                             |

The cube grid is rebuilt when `voxelSize`, `gap`, `stressRadius` or `depth` change; the
colour and radius props are read back out of the DOM, so they are picked up on the next
frame.

### Events

| event      | when                                                                  |
| ---------- | --------------------------------------------------------------------- |
| `shatter`  | the face has just vanished and the cubes go airborne                  |
| `restored` | the cubes have reassembled and the real face is fading back in        |

### Exposed methods

```js
const btn = useTemplateRef('btn')
await nextTick()
btn.value.shatter()   // detonate in the middle of the face
btn.value.reset()     // reassemble now — the way back when auto-reform is off
```

Native `click`, `focus`, `blur`, etc. fall through to the root `<button>` as usual, so
`@click` behaves exactly like a plain button — the shatter is decoration, not a gate.

### Theming

Either pass the props, or set the custom properties — the props are just sugar that
writes these variables onto the element:

```css
.btn--ember {
  --vx-surface: #b91c1c;      /* left stop of the face gradient */
  --vx-surface-alt: #fb923c;  /* right stop */
  --vx-ink: #ffffff;          /* label colour; also the "ink" cubes */
  --vx-radius: 999px;         /* same as the radius prop */
}
```

The engine reads those same variables when it rasterises the label, so the cube mosaic
matches the button face — recolour the button and the cubes that fly off it are the new
colour too.

## How it works

`src/lib/voxelEngine.js` is framework agnostic and holds all of the behaviour;
`src/components/VoxelizeButton.vue` is a ~25 line wrapper.

1. **Build** — the button is measured and diced into a grid of cubes. The label is
   rasterised into an offscreen canvas (using `innerText`, so `text-transform` applies)
   and point-sampled, so the engine knows which cubes are ink and which are surface.
2. **Crack** (`0.11s`) — clicking spawns a web of axis-aligned fractures along the
   seams, glowing outward from the click point while the real face is still visible.
3. **Burst** (`0.55s`) — the real face is swapped out instantly and every cube is given
   a velocity away from the epicentre, scaled to the button's short side, with gravity
   and drag. Cubes are drawn as three shaded quads with a fake isometric extrusion, and
   `z` feeds a cheap dolly-zoom projection. All the debris drifts forward off the impact,
   and pieces near the blast point get a bigger surge, so the cloud pops *toward* the
   viewer instead of staying flat on the page (`Z_NEAR` / `Z_FAR` and the `surge` term in
   `burst()` are the knobs).
4. **Hang** (`0.26s`) — gravity nearly switches off and the cloud drifts.
5. **Reform** (`0.62s`, or **Dissolve** / **Linger**) — by default the cubes fly home in a
   wave that starts at the crack point, eased by `easing` (`back` overshoots, so they snap
   into place). With `dissolve` set they instead shrink away to nothing, and with
   `autoReform: false` they just stop where they are and the loop parks itself until
   `reset()` is called.
6. **Settle** (`0.18s`) — the assembled mosaic cross-fades into the real DOM face.

Every phase length is multiplied by `duration / 1.72`, and all the physics rates
(gravity, drag, tumble, the shrink toward the final cube size) are divided by the same
factor — which is what makes a longer `duration` read as slow motion instead of a bigger
blast. Option changes never rebuild the cube grid, so dragging a slider cannot interrupt a
flight in progress.

Hovering is a separate, cheaper path: a trail of short jagged fractures is spawned along
the pointer's path, and the voxel seams inside `stressRadius` of the cursor get dark
crack lines plus a chisel highlight with a little jitter. Surface marks are clipped to the
button's border radius; only debris is allowed outside it.

### Details worth knowing

- The canvas is deliberately **larger than the button** (it bleeds by ~1.65× the short
  side) so airborne cubes are never clipped. The engine positions and sizes it itself.
- Phases run on **wall-clock time**, and physics is sub-stepped, so a dropped frame
  cannot stretch or skip a phase.
- `prefers-reduced-motion: reduce` shrinks velocities and gravity down to a token pop.
- The canvas is a decorative overlay: `aria-hidden`, `pointer-events: none`, and the
  real `<button>` underneath keeps focus, keyboard activation (which detonates at the
  centre of the face) and screen-reader behaviour.

## Engine API

If you want the effect on something that is not this button:

```js
import { createVoxelEngine } from './src/lib/voxelEngine.js'

const engine = createVoxelEngine({
  root,
  canvas,
  label,
  voxelSize: 0, // auto
  depth: 1, // camera axis, -2…2
  duration: 0, // seconds; 0 = default ≈1.7s
  easing: 'back', // or your own (t) => t
  dissolve: 0, // 0.05 = shrink 5% per 1/60s
  autoReform: true, // false = hold until reform()
})
engine.on('shatter', () => {})
engine.explode(x, y)          // canvas-local CSS pixels (omit for the centre)
engine.reform()               // send the pieces home now
engine.setOptions({ gap: 0.6 })
engine.sync()                 // re-measure + re-sample the label
engine.destroy()
```

`easing` also accepts a function, which is handy for a custom curve:

```js
easing: (t) => t * t * (3 - 2 * t)   // smoothstep
```

While the cubes are in flight the engine puts `is-shattered` on the root element — that
is what the stylesheet uses to hide the real face and label.
