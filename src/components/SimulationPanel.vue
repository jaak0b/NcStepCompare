<script setup lang="ts">
import { ref, watch } from 'vue'
import type { SimulationReady } from '../workers/simulationMessages'
import { decimalInputProblem, parseDecimalInput } from '../ui/decimalInput'
import { SOURCE_LABEL } from '../ui/sourceLabel'

const props = defineProps<{
  status: 'idle' | 'running' | 'ready' | 'error'
  progress: number
  result: SimulationReady | null
  error: string | null
  stockSource: 'header' | 'assumed' | null
  cellSize: number
  cellSizeSource: 'assumed' | 'user'
  /** Why the entered cell size cannot be used, or null. */
  cellSizeProblem: string | null
  frameTiming: { workerMs: number; requestToShownMs: number; renderMs: number } | null
}>()
const emit = defineEmits<{ 'update:cellSize': [value: number] }>()

const text = ref(String(props.cellSize))
const inputProblem = ref<string | null>(null)
watch(
  () => props.cellSize,
  (v) => {
    text.value = String(v)
  },
)

function onCellSize() {
  const v = parseDecimalInput(text.value)
  if (!(v > 0)) {
    inputProblem.value = decimalInputProblem(text.value) ?? 'Enter a cell size above 0 mm, for example 0.05.'
    return
  }
  inputProblem.value = null
  emit('update:cellSize', v)
}

const mb = (bytes: number) => `${(bytes / 1e6).toFixed(0)} MB`
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
      <dt>Grid cell size ({{ SOURCE_LABEL[cellSizeSource] }})</dt>
      <dd>
        <input v-model="text" type="text" inputmode="decimal" @change="onCellSize" /> mm
      </dd>
    </dl>
    <p v-if="inputProblem" class="problem">{{ inputProblem }}</p>
    <p v-if="cellSizeProblem" class="problem">{{ cellSizeProblem }}</p>
    <p v-if="status === 'running'" class="note">
      Simulating: {{ Math.floor(progress * 100) }} %
      <progress :value="progress" max="1"></progress>
    </p>
    <p v-if="status === 'error'" class="problem">Simulation failed: {{ error }}</p>
    <template v-if="status === 'ready' && result">
      <dl>
        <dt>Simulation time (measured)</dt>
        <dd>{{ (result.simMs / 1000).toFixed(1) }} s</dd>
        <dt>Grid (calculated)</dt>
        <dd>
          {{ result.grid.nx.toLocaleString() }} x {{ result.grid.ny.toLocaleString() }} cells,
          {{ mb(result.grid.nx * result.grid.ny * 4) }}
        </dd>
        <dt>Display resolution</dt>
        <dd>Every grid cell</dd>
        <dt>Playback checkpoints (measured)</dt>
        <dd>{{ result.checkpointCount }}, {{ mb(result.checkpointBytes) }}</dd>
        <dt>Moves not simulated (calculated)</dt>
        <dd>{{ result.unsimulatedMoveCount.toLocaleString() }}</dd>
        <template v-if="frameTiming">
          <dt>Last playback frame (measured)</dt>
          <dd>
            {{ frameTiming.requestToShownMs.toFixed(0) }} ms from request to display, of which
            {{ frameTiming.workerMs.toFixed(0) }} ms simulation; render call
            {{ frameTiming.renderMs.toFixed(1) }} ms
          </dd>
        </template>
      </dl>
      <p v-for="p in result.toolProblems" :key="p.number" class="problem">
        T{{ p.number }} not simulated: {{ p.problem }}
      </p>
      <p v-if="result.unsimulatedMoveCount > 0" class="problem">
        Set a valid shape for every tool in the tool table. Moves without one remove no material.
      </p>
    </template>
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
