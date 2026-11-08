<script setup lang="ts">
import type { SimulationReady } from '../workers/simulationMessages'

defineProps<{
  status: 'idle' | 'running' | 'ready' | 'error'
  progress: number
  result: SimulationReady | null
  error: string | null
  stockSource: 'header' | 'assumed' | null
  cellSize: number
  cellSizeSource: 'assumed' | 'user'
}>()
const emit = defineEmits<{ 'update:cellSize': [value: number] }>()

function onCellSize(event: Event) {
  const v = Number((event.target as HTMLInputElement).value)
  if (v > 0) emit('update:cellSize', v)
}
</script>

<template>
  <section>
    <h2>Simulation</h2>
    <p v-if="stockSource === null" class="problem">
      Not simulated: no stock in the file header, and the toolpath never goes below Z 0.
    </p>
    <p v-else-if="stockSource === 'assumed'" class="note">
      Stock assumed from the toolpath extent: the file has no stock in its header.
    </p>
    <dl>
      <dt>Grid cell size ({{ cellSizeSource === 'user' ? 'edited' : 'assumed default' }})</dt>
      <dd>
        <input type="number" min="0.01" step="0.01" :value="cellSize" @change="onCellSize" /> mm
      </dd>
    </dl>
    <p v-if="status === 'running'" class="note">
      Simulating: {{ Math.floor(progress * 100) }} %
      <progress :value="progress" max="1"></progress>
    </p>
    <p v-if="status === 'error'" class="problem">Simulation failed: {{ error }}</p>
    <dl v-if="status === 'ready' && result">
      <dt>Simulation time (measured)</dt>
      <dd>{{ (result.simMs / 1000).toFixed(1) }} s</dd>
      <dt>Grid</dt>
      <dd>{{ result.gridNx.toLocaleString() }} x {{ result.gridNy.toLocaleString() }} cells</dd>
      <dt>Display cell size</dt>
      <dd>{{ result.frame.cellSize.toFixed(2) }} mm (lowest point of each block shown)</dd>
      <dt>Playback checkpoints</dt>
      <dd>{{ result.checkpointCount }}, {{ (result.checkpointBytes / 1e6).toFixed(0) }} MB</dd>
      <dt>Moves not simulated</dt>
      <dd>{{ result.unsimulatedMoveCount.toLocaleString() }}</dd>
    </dl>
    <p v-if="status === 'ready' && result && result.unsimulatedMoveCount > 0" class="problem">
      Set a valid shape for every tool in the tool table. Moves without one remove no material.
    </p>
  </section>
</template>

<style scoped>
h2 {
  font-size: 13px;
  margin: 0 0 4px;
}
dl {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 2px 12px;
  margin: 0 0 4px;
}
dt {
  color: #5b6470;
}
dd {
  margin: 0;
}
dd input {
  width: 70px;
}
.note {
  margin: 0 0 4px;
  color: #5b6470;
}
.problem {
  margin: 0 0 4px;
  color: #b42318;
}
progress {
  width: 100%;
}
</style>
