<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'

const props = defineProps<{
  moveCount: number
  /** Move index the view currently shows: the state after moves [0, shownIndex). */
  shownIndex: number
  /** Move index last asked for; equals shownIndex once that frame has arrived. */
  requestedIndex: number
  /** Source line of the move just completed in the shown state, or null at the start. */
  currentLine: number | null
  toolpaths: { number: number; name: string; firstMove: number }[]
}>()
const emit = defineEmits<{ seek: [index: number] }>()

const SPEEDS = [100, 1000, 10000, 100000]
const playing = ref(false)
const speed = ref(1000)
let handle: number | null = null
let lastRequestAt = 0

// Closed loop: the next step is requested only after the previous frame is on screen, sized by
// the time that has passed, so playback never runs ahead of what the simulation can show.
function tick(now: number) {
  if (props.shownIndex === props.requestedIndex) {
    if (props.shownIndex >= props.moveCount) {
      pause()
      return
    }
    const step = Math.max(1, Math.floor(((now - lastRequestAt) / 1000) * speed.value))
    lastRequestAt = now
    emit('seek', Math.min(props.moveCount, props.shownIndex + step))
  }
  handle = requestAnimationFrame(tick)
}

function play() {
  if (props.shownIndex >= props.moveCount) emit('seek', 0)
  playing.value = true
  lastRequestAt = performance.now()
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
      :value="requestedIndex"
      aria-label="Position in the job"
      @input="onSlider"
    />
    <span class="position">
      Move {{ shownIndex.toLocaleString() }} of {{ moveCount.toLocaleString() }}<template v-if="currentLine !== null">
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
