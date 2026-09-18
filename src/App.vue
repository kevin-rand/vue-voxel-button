<script setup>
import { ref } from 'vue'
import VoxelizeButton from './components/VoxelizeButton.vue'

const shatters = ref(0)
const last = ref('idle')

/* look */
const voxelSize = ref(0) // 0 = the component picks a cube size from the label font
const surface = ref('#6d3bf5')
const surfaceAlt = ref('#a855f7')
const radius = ref(14)
const disabled = ref(false)

/* motion */
const depth = ref(1)
const duration = ref(0) // 0 = the built-in ≈1.7s timeline
const easing = ref('back')
const dissolve = ref(0) // 0 = off, otherwise shrink per 1/60s
const autoReform = ref(true)

const buttons = []
const register = (el, i) => {
  if (el) buttons[i] = el
}
const reassemble = () => buttons.forEach((b) => b?.reset())

const durationLabel = () => (duration.value === 0 ? 'default' : `${duration.value}s`)
const dissolveLabel = () => (dissolve.value === 0 ? 'off' : `${Math.round(dissolve.value * 100)}%/frame`)
</script>

<template>
  <main class="stage">
    <header class="stage__head">
      <p class="kicker">Crush</p>
      <h1>Voxelize</h1>
      <p class="lede">
        Hover a button to trace hairline fractures under the pointer. Click it and the whole thing
        comes apart into little cubes — then snaps back together, dissolves, or stays broken.
      </p>
    </header>

    <div class="row">
      <VoxelizeButton
        :ref="(el) => register(el, 0)"
        label="Voxelize"
        :voxel-size="voxelSize"
        :radius="radius"
        :depth="depth"
        :duration="duration"
        :easing="easing"
        :dissolve="dissolve"
        :auto-reform="autoReform"
        :surface="surface"
        :surface-alt="surfaceAlt"
        :disabled="disabled"
        @shatter="(shatters++, last = 'shatter')"
        @restored="last = 'reformed'"
      />

      <VoxelizeButton
        :ref="(el) => register(el, 1)"
        class="btn--mint"
        :voxel-size="voxelSize"
        :radius="radius"
        :depth="depth"
        :duration="duration"
        :easing="easing"
        :dissolve="dissolve"
        :auto-reform="autoReform"
        :disabled="disabled"
        @shatter="(shatters++, last = 'shatter')"
        @restored="last = 'reformed'"
      >
        Reform
      </VoxelizeButton>

      <VoxelizeButton
        :ref="(el) => register(el, 2)"
        class="btn--ember"
        label="Obliterate"
        :voxel-size="voxelSize"
        :radius="radius"
        :depth="depth"
        :duration="duration"
        :easing="easing"
        :dissolve="dissolve"
        :auto-reform="autoReform"
        :disabled="disabled"
        @shatter="(shatters++, last = 'shatter')"
        @restored="last = 'reformed'"
      />
    </div>

    <div class="controls">
      <label class="control">
        <span>cube size <em>{{ voxelSize === 0 ? 'auto' : `${voxelSize}px` }}</em></span>
        <input v-model.number="voxelSize" type="range" min="0" max="14" step="1" />
      </label>

      <label class="control">
        <span>radius <em>{{ radius }}px</em></span>
        <input v-model.number="radius" type="range" min="0" max="34" step="1" />
      </label>

      <label class="control">
        <span>surface</span>
        <input v-model="surface" type="color" />
      </label>

      <label class="control">
        <span>alt</span>
        <input v-model="surfaceAlt" type="color" />
      </label>

      <label class="control control--check">
        <input v-model="disabled" type="checkbox" />
        <span>disabled</span>
      </label>
    </div>

    <div class="controls">
      <label class="control">
        <span>camera</span>
        <select v-model.number="depth">
          <option :value="1">toward</option>
          <option :value="0">flat</option>
          <option :value="-1">away</option>
        </select>
      </label>

      <label class="control">
        <span>duration <em>{{ durationLabel() }}</em></span>
        <input v-model.number="duration" type="range" min="0" max="5" step="0.25" />
      </label>

      <label class="control">
        <span>easing</span>
        <select v-model="easing">
          <option value="back">back</option>
          <option value="linear">linear</option>
          <option value="out">out</option>
          <option value="in">in</option>
          <option value="inout">in&nbsp;out</option>
        </select>
      </label>

      <label class="control">
        <span>dissolve <em>{{ dissolveLabel() }}</em></span>
        <input v-model.number="dissolve" type="range" min="0" max="0.12" step="0.01" />
      </label>

      <label class="control control--check">
        <input v-model="autoReform" type="checkbox" />
        <span>auto-reform</span>
      </label>

      <button class="ghost" type="button" @click="reassemble">reassemble</button>
    </div>

    <p class="hint">
      the first button is driven by the colour props, the others by CSS variables · with
      auto-reform off, use reassemble to bring the pieces back
    </p>

    <p class="log">
      <span>{{ shatters }}</span> shatters · last event: <code>{{ last }}</code>
    </p>
  </main>
</template>
