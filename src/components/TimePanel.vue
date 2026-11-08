<script setup lang="ts">
import { computed, ref } from 'vue'
import { NO_TOOLPATH } from '../engine/moveList'
import { DEFAULT_RAPID_RATE_MM_PER_MIN, estimateMachiningTime, rapidRateProblem } from '../engine/timeEstimate'
import { parseDecimalInput } from '../ui/decimalInput'
import { SOURCE_LABEL, type SettingSource } from '../ui/sourceLabel'
import type { LoadedJob } from '../workers/parseMessages'

const props = defineProps<{ loaded: LoadedJob }>()

const rapidRate = ref(DEFAULT_RAPID_RATE_MM_PER_MIN)
const rapidRateSource = ref<SettingSource>('assumed')
const text = ref(String(rapidRate.value))
const inputProblem = ref<string | null>(null)

function onRapidRate() {
  const v = parseDecimalInput(text.value)
  inputProblem.value = rapidRateProblem(v)
  if (inputProblem.value) return
  rapidRate.value = v
  rapidRateSource.value = 'user'
}

const estimate = computed(() =>
  estimateMachiningTime(props.loaded.job.moves, props.loaded.job.dwells, rapidRate.value),
)
const studioSeconds = computed(() => props.loaded.job.header.studioTimeEstimateSeconds)
const names = computed(() => new Map(props.loaded.summary.toolpaths.map((t) => [t.number, t.name])))
const hasDwells = computed(() => props.loaded.job.dwells.length > 0)

function duration(seconds: number): string {
  const total = Math.round(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return `${h} h ${m} min ${s} s`
}
const sec = (v: number) => `${v.toFixed(1)} s`
const mm = (v: number) => `${v.toFixed(1)} mm`

function toolpathName(number: number): string {
  if (number === NO_TOOLPATH) return 'Moves outside any toolpath'
  return names.value.get(number) || `Toolpath ${number}`
}

const difference = computed(() => {
  const studio = studioSeconds.value
  if (studio === null || studio <= 0) return null
  const d = estimate.value.total.totalSeconds - studio
  const sign = d >= 0 ? '+' : '-'
  return `${sign}${Math.abs(d).toFixed(1)} s (${sign}${Math.abs((d / studio) * 100).toFixed(1)} %)`
})
</script>

<template>
  <section>
    <h2>Machining time</h2>
    <p class="note">Acceleration is ignored, so the machine takes somewhat longer than these times.</p>
    <dl>
      <dt>Rapid rate ({{ SOURCE_LABEL[rapidRateSource] }})</dt>
      <dd><input v-model="text" type="text" inputmode="decimal" @change="onRapidRate" /> mm/min</dd>
    </dl>
    <p v-if="inputProblem" class="problem">{{ inputProblem }}</p>
    <p class="note">
      Enter the machine's rapid rate if you know it. The file does not contain it; the default is the maximum
      travel speed Makera states for its Carvera machines.
    </p>
    <dl>
      <dt>Total (calculated)</dt>
      <dd>{{ duration(estimate.total.totalSeconds) }} ({{ sec(estimate.total.totalSeconds) }})</dd>
      <dt>Feed moves (calculated)</dt>
      <dd>{{ sec(estimate.total.feedSeconds) }}, {{ mm(estimate.total.feedLengthMm) }}</dd>
      <dt>Rapids (calculated with the rapid rate)</dt>
      <dd>{{ sec(estimate.total.rapidSeconds) }}, {{ mm(estimate.total.rapidLengthMm) }}</dd>
      <template v-if="hasDwells">
        <dt>Dwells (calculated, P read as seconds: assumed)</dt>
        <dd>{{ sec(estimate.total.dwellSeconds) }}</dd>
      </template>
      <template v-if="estimate.total.noFeedLengthMm > 0">
        <dt>Cutting moves with no feed, given no time (calculated)</dt>
        <dd>{{ mm(estimate.total.noFeedLengthMm) }}</dd>
      </template>
      <template v-if="studioSeconds !== null">
        <dt>Makera Studio estimate (from file header)</dt>
        <dd>{{ duration(studioSeconds) }} ({{ studioSeconds }} s)</dd>
        <dt>Difference, calculated minus Studio</dt>
        <dd>{{ difference ?? 'not available' }}</dd>
      </template>
    </dl>
    <table>
      <thead>
        <tr>
          <th>Toolpath</th>
          <th>Feed</th>
          <th>Rapid</th>
          <th v-if="hasDwells">Dwell</th>
          <th>Total</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="t in estimate.toolpaths" :key="t.toolpath">
          <td>{{ toolpathName(t.toolpath) }}</td>
          <td>{{ sec(t.feedSeconds) }}</td>
          <td>{{ sec(t.rapidSeconds) }}</td>
          <td v-if="hasDwells">{{ sec(t.dwellSeconds) }}</td>
          <td>{{ duration(t.totalSeconds) }}</td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<style scoped>
h2 {
  font-size: 13px;
  margin: 0 0 4px;
}
dl {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 2px 10px;
  margin: 4px 0;
}
dt {
  color: #5b6470;
}
dd {
  margin: 0;
}
input {
  width: 7em;
}
.note {
  color: #5b6470;
  margin: 4px 0;
}
.problem {
  color: #b42318;
  margin: 4px 0;
}
table {
  border-collapse: collapse;
  width: 100%;
  margin-top: 6px;
}
th,
td {
  text-align: left;
  padding: 2px 6px 2px 0;
  border-bottom: 1px solid #eceef1;
}
td:not(:first-child),
th:not(:first-child) {
  text-align: right;
  white-space: nowrap;
}
</style>
