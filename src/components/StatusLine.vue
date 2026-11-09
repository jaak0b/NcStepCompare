<script setup lang="ts">
import { computed } from 'vue'
import type { Finding } from '../engine/findings/finding'

const props = defineProps<{
  jobLoaded: boolean
  refused: boolean
  warningCount: number
  simStatus: 'idle' | 'running' | 'ready' | 'error'
  /** Simulation progress, 0 to 1. */
  simProgress: number
  simMs: number | null
  findings: Finding[]
  compared: boolean
  comparisonRunning: boolean
}>()

const count = (kind: Finding['kind']) => props.findings.filter((f) => f.kind === kind).length

const simulation = computed(() => {
  switch (props.simStatus) {
    case 'running':
      return `Simulating ${Math.round(props.simProgress * 100)} %`
    case 'ready':
      return props.simMs === null ? 'Simulation done' : `Simulation done in ${(props.simMs / 1000).toFixed(1)} s`
    case 'error':
      return 'Simulation failed'
    default:
      return 'Not simulated'
  }
})

const comparison = computed(() => {
  if (props.comparisonRunning) return 'Comparing'
  if (!props.compared) return 'No STEP part placed'
  return `Gouges ${count('gouge')}, threads ${count('thread')}, leftover ${count('leftover')}`
})
</script>

<template>
  <p class="status-line" role="status">
    <template v-if="refused"><span class="bad">Job refused</span></template>
    <template v-else-if="!jobLoaded">No job loaded</template>
    <template v-else>
      <span>{{ simulation }}</span>
      <span :class="{ bad: compared && count('gouge') > 0 }">{{ comparison }}</span>
      <span>Parse warnings {{ warningCount }}</span>
    </template>
  </p>
</template>

<style scoped>
.status-line {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  margin: 0;
  padding: 6px 8px;
  background: #f3f5f7;
  border-radius: 4px;
  font-size: 12px;
  color: #1f2328;
}
.bad {
  color: #b42318;
  font-weight: 600;
}
</style>
