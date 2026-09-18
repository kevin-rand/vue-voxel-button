<script setup>
/**
 * VoxelizeButton — a button that cracks under the pointer and shatters into
 * little cubes when clicked.
 *
 * Everything visual is either a prop or a CSS custom property:
 *   surface / surface-alt / ink   face gradient and label colour
 *   radius                        corner radius (number = px, string = any length)
 *   depth                         where the debris goes on the camera axis
 *
 * The same values can be set from CSS instead (`--vx-surface`,
 * `--vx-surface-alt`, `--vx-ink`, `border-radius`) and the engine will follow.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { createVoxelEngine } from '../lib/voxelEngine.js'

const props = defineProps({
  /** Rendered label. Equivalent to using the default slot. */
  label: { type: String, default: 'Voxelize' },
  /** Edge length of one cube in CSS px. 0 = auto, sized from the label font. */
  voxelSize: { type: Number, default: 0 },
  /** Hairline gap left between cubes. */
  gap: { type: Number, default: 0.45 },
  /** Radius (px) around the pointer where seams start to fracture. */
  stressRadius: { type: Number, default: 26 },
  /** Camera axis: 1 pops at the viewer, 0 stays flat, -1 falls away. */
  depth: { type: Number, default: 1 },
  /** Total flight time in seconds. 0 = default (≈1.7s); slower reads as slow motion. */
  duration: { type: Number, default: 0 },
  /** Reassembly curve: 'back' | 'linear' | 'in' | 'out' | 'inout'. */
  easing: { type: String, default: 'back' },
  /** 0 = off. 0.05 shrinks every cube by 5% per 1/60s until it disappears. */
  dissolve: { type: Number, default: 0 },
  /** false = the pieces stay where they land until reset() is called. */
  autoReform: { type: Boolean, default: true },
  /** Face colour. Empty = use the --vx-surface custom property. */
  surface: { type: String, default: '' },
  /** Second gradient stop. Empty = use --vx-surface-alt. */
  surfaceAlt: { type: String, default: '' },
  /** Label colour (also the colour of the letter cubes). Empty = --vx-ink. */
  ink: { type: String, default: '' },
  /** Corner radius: number = px, string = any CSS length. null = from CSS. */
  radius: { type: [Number, String], default: null },
  disabled: { type: Boolean, default: false },
  type: { type: String, default: 'button' },
})

const emit = defineEmits(['shatter', 'restored'])

const root = ref(null)
const labelEl = ref(null)
const canvasEl = ref(null)
let engine = null

const themeStyle = computed(() => {
  const style = {}
  if (props.surface) style['--vx-surface'] = props.surface
  if (props.surfaceAlt) style['--vx-surface-alt'] = props.surfaceAlt
  if (props.ink) style['--vx-ink'] = props.ink
  if (props.radius !== null && props.radius !== '') {
    style.borderRadius = typeof props.radius === 'number' ? `${props.radius}px` : props.radius
  }
  return style
})

onMounted(() => {
  engine = createVoxelEngine({
    root: root.value,
    canvas: canvasEl.value,
    label: labelEl.value,
    voxelSize: props.voxelSize,
    gap: props.gap,
    stressRadius: props.stressRadius,
    depth: props.depth,
    duration: props.duration,
    easing: props.easing,
    dissolve: props.dissolve,
    autoReform: props.autoReform,
  })
  engine.on('shatter', () => emit('shatter'))
  engine.on('restored', () => emit('restored'))
})

defineExpose({
  /** Reassemble now — the way back when `auto-reform` is false. */
  reset: () => engine?.reform(),
  /** Detonate in the middle of the face. */
  shatter: () => engine?.explode(),
})

onBeforeUnmount(() => {
  engine?.destroy()
  engine = null
})

watch(
  () => [
    props.voxelSize,
    props.gap,
    props.stressRadius,
    props.depth,
    props.duration,
    props.easing,
    props.dissolve,
    props.autoReform,
  ],
  () =>
    engine?.setOptions({
      voxelSize: props.voxelSize,
      gap: props.gap,
      stressRadius: props.stressRadius,
      depth: props.depth,
      duration: props.duration,
      easing: props.easing,
      dissolve: props.dissolve,
      autoReform: props.autoReform,
    }),
)

// Colours and radius are read back out of the DOM, so let the render land first
// (`sync` re-measures on the next frame).
watch(() => [props.surface, props.surfaceAlt, props.ink, props.radius], () => engine?.sync())
</script>

<template>
  <button
    ref="root"
    class="voxelize"
    :type="type"
    :style="themeStyle"
    :disabled="disabled"
  >
    <span class="voxelize__face" aria-hidden="true" />
    <span ref="labelEl" class="voxelize__label"><slot>{{ label }}</slot></span>
    <canvas ref="canvasEl" class="voxelize__canvas" aria-hidden="true" />
  </button>
</template>

<style scoped>
/* The defaults live in the var() fallbacks rather than as declarations here:
   this rule carries a scope attribute, so declaring --vx-* would out-specify a
   single-class theme such as `.btn--mint { --vx-surface: #0f9d8f }`. */
.voxelize {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0.85rem 1.6rem;
  border: 0;
  border-radius: var(--vx-radius, 14px);
  background: none;
  color: var(--vx-ink, #ffffff);
  font: inherit;
  font-size: 0.92rem;
  font-weight: 650;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  cursor: pointer;
  overflow: visible; /* let debris fly outside the button box */
  isolation: isolate;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

.voxelize__face {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: linear-gradient(100deg, var(--vx-surface, #6d3bf5), var(--vx-surface-alt, #a855f7));
  box-shadow:
    0 12px 26px -14px rgba(20, 6, 60, 0.85),
    inset 0 1px 0 rgba(255, 255, 255, 0.28);
  transition: transform 0.22s ease, box-shadow 0.22s ease;
}

.voxelize__label {
  position: relative;
  z-index: 1;
}

/* The engine sizes and offsets this canvas itself, bleeding it past the
   button on all sides so airborne cubes never get clipped. */
.voxelize__canvas {
  position: absolute;
  left: 0;
  top: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  z-index: 2;
}

.voxelize:hover:not(:disabled) .voxelize__face {
  transform: translateY(-1px);
  box-shadow:
    0 18px 32px -14px rgba(20, 6, 60, 0.9),
    inset 0 1px 0 rgba(255, 255, 255, 0.34);
}

.voxelize:active:not(:disabled) .voxelize__face {
  transform: translateY(0) scale(0.985);
}

.voxelize:focus-visible {
  outline: 2px solid color-mix(in oklab, var(--vx-ink, #ffffff) 70%, transparent);
  outline-offset: 3px;
}

.voxelize:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

/* While the cubes are airborne the real face gets out of the way instantly.
   Deliberately not animated: the soft edges come from the canvas fading the
   reassembled mosaic out over the face, so this never depends on a running
   CSS transition to become visible again. */
.voxelize.is-shattered .voxelize__face,
.voxelize.is-shattered .voxelize__label {
  opacity: 0;
  transition: none;
}
</style>
