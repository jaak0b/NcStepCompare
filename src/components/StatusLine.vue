<script setup lang="ts">
import { computed } from 'vue'
import { FINDING_SEVERITY, type Finding, type FindingKind } from '../engine/findings/finding'

const props = defineProps<{
  jobLoaded: boolean
  /** Why the last G-code file was not loaded, or null. */
  loadError: string | null
  refused: boolean
  warningCount: number
  simStatus: 'idle' | 'running' | 'ready' | 'error'
  /** Simulation progress, 0 to 1. */
  simProgress: number
  simMs: number | null
  cellSizeProblem: string | null
  findings: Finding[]
  partsPlaced: boolean
  comparisonRunning: boolean
  /** True once a comparison finished for the current simulation, parts and tolerances. */
  comparisonDone: boolean
  comparisonError: string | null
  stepError: string | null
  toolEditProblem: string | null
}>()

/** Findings per kind and error-severity findings, counted in one pass. */
const counts = computed(() => {
  const byKind: Partial<Record<FindingKind, number>> = {}
  let errors = 0
  for (const f of props.findings) {
    byKind[f.kind] = (byKind[f.kind] ?? 0) + 1
    if (FINDING_SEVERITY[f.kind] === 'error') errors++
  }
  return { byKind, errors }
})
const kindCount = (kind: FindingKind) => counts.value.byKind[kind] ?? 0

/** Problems that need attention, each with the tab holding the details. */
const problems = computed(() => {
  const out: { text: string; tab: string }[] = []
  if (props.loadError) out.push({ text: props.refused ? 'Job refused' : 'G-code file not read', tab: 'Job' })
  if (props.toolEditProblem) out.push({ text: 'Saved tool edits problem', tab: 'Tools' })
  if (props.stepError) out.push({ text: 'STEP file not read', tab: 'Parts' })
  if (props.simStatus === 'error') out.push({ text: 'Simulation failed', tab: 'Info' })
  if (props.cellSizeProblem) out.push({ text: 'Grid cell size not usable', tab: 'Info' })
  if (props.comparisonError) out.push({ text: 'Comparison failed', tab: 'Check' })
  return out
})

const simulation = computed(() => {
  switch (props.simStatus) {
    case 'running':
      return `Simulating ${Math.round(props.simProgress * 100)} %`
    case 'ready':
      return props.simMs === null ? 'Simulation done' : `Simulation done in ${(props.simMs / 1000).toFixed(1)} s`
    case 'error':
      return null // listed with the problems
    default:
      return props.cellSizeProblem ? null : 'Not simulated (details on the Info tab)'
  }
})

/** State of the comparison, or null when the counts are shown instead. */
const comparison = computed(() => {
  if (!props.partsPlaced) return 'No STEP part placed'
  if (props.simStatus !== 'ready') return props.simStatus === 'running' ? 'Waiting for the simulation' : null
  if (props.comparisonRunning) return 'Comparing'
  if (props.comparisonError) return null // listed with the problems
  if (!props.comparisonDone) return 'Not compared yet'
  return null
})
const showCounts = computed(() => props.simStatus === 'ready' && props.partsPlaced && props.comparisonDone)
</script>

<template>
  <div class="status-line" role="status">
    <span v-for="p in problems" :key="p.text" class="bad">{{ p.text }} (details on the {{ p.tab }} tab)</span>
    <template v-if="jobLoaded">
      <span v-if="simulation">{{ simulation }}</span>
      <span v-if="simStatus === 'ready'" :class="{ bad: counts.errors > 0 }">
        {{ comparisonDone ? 'Error findings' : 'Error findings from the moves' }} {{ counts.errors }}
      </span>
      <span v-if="comparison">{{ comparison }}</span>
      <template v-if="showCounts">
        <span :class="{ bad: kindCount('gouge') > 0 }">Gouge findings {{ kindCount('gouge') }}</span>
        <span>Thread findings {{ kindCount('thread') }}</span>
        <span>Material left over findings {{ kindCount('leftover') }}</span>
      </template>
      <span>Warnings {{ warningCount }}</span>
    </template>
    <span v-else-if="!loadError">No job loaded</span>
  </div>
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
