<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'

const props = defineProps<{
  moveCount: number
  /** The view shows the state after moves [0, index). */
  index: number
  /** Source line of the move just completed, or null at the start. */
  currentLine: number | null
  toolpaths: { number: number; name: string; firstMove: number }[]
}>()
const emit = defineEmits<{ seek: [index: number] }>()

const SPEEDS = [100, 1000, 10000, 100000]
const playing = ref(false)
const speed = ref(1000)
let handle: number | null = null
let last = 0
let carry = 0

function tick(now: number) {
  const dt = (now - last) / 1000
  last = now
  carry += dt * speed.value
  const step = Math.floor(carry)
  carry -= step
  const next = Math.min(props.moveCount, props.index + step)
  if (step > 0) emit('seek', next)
  if (next >= props.moveCount) {
    pause()
    return
  }
  handle = requestAnimationFrame(tick)
}

function play() {
  if (props.index >= props.moveCount) emit('seek', 0)
  playing.value = true
  carry = 0
  last = performance.now()
  handle = requestAnimationFrame(tick)
}

function pause() {
  playing.value = false
  if (handle !== null) cancelAnimationFrame(handle)
  handle = null
}

function onSlider(event: Event) {
  emit('seek', Number((event.target as HTMLInputElement).value))
}

function onJump(event: Event) {
  const select = event.target as HTMLSelectElement
  if (select.value !== '') emit('seek', Number(select.value))
  select.value = ''
}

onBeforeUnmount(pause)
</script>

<template>
  <div class="playback">
    <button type="button" class="play" @click="playing ? pause() : play()">{{ playing ? 'Pause' : 'Play' }}</button>
    <input
      class="slider"
      type="range"
      min="0"
      :max="moveCount"
      step="1"
      :value="index"
      aria-label="Position in the job"
      @input="onSlider"
    />
    <span class="position">
      Move {{ index.toLocaleString() }} of {{ moveCount.toLocaleString() }}<template v-if="currentLine !== null">
        (line {{ currentLine.toLocaleString() }})</template
      >
    </span>
    <label>
      Speed
      <select v-model.number="speed">
        <option v-for="s in SPEEDS" :key="s" :value="s">{{ s.toLocaleString() }} moves/s</option>
      </select>
    </label>
    <select aria-label="Jump to toolpath" @change="onJump">
      <option value="">Jump to toolpath start</option>
      <option v-for="tp in toolpaths" :key="tp.number" :value="tp.firstMove">{{ tp.name }}</option>
    </select>
  </div>
</template>

<style scoped>
.playback {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  padding: 6px 8px;
  background: #fff;
  border-top: 1px solid #d6d9dd;
}
.play {
  min-width: 56px;
}
.slider {
  flex: 1 1 240px;
}
.position {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
</style>
