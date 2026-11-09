<script setup lang="ts">
import { computed, ref } from 'vue'
import { NO_TOOLPATH } from '../engine/moveList'
import {
  DEFAULT_DWELL_P_UNIT,
  DEFAULT_RAPID_RATE_MM_PER_MIN,
  estimateMachiningTime,
  rapidRateProblem,
  type DwellPUnit,
} from '../engine/timeEstimate'
import { decimalInputProblem, parseDecimalInput } from '../ui/decimalInput'
import { formatDuration } from '../ui/duration'
import { SOURCE_LABEL, type SettingSource } from '../ui/sourceLabel'
import type { LoadedJob } from '../workers/parseMessages'

const props = defineProps<{ loaded: LoadedJob }>()

const rapidRate = ref(DEFAULT_RAPID_RATE_MM_PER_MIN)
const rapidRateSource = ref<SettingSource>('assumed')
const text = ref(String(rapidRate.value))
const inputProblem = ref<string | null>(null)
const pUnit = ref<DwellPUnit>(DEFAULT_DWELL_P_UNIT)
const pUnitSource = ref<SettingSource>('assumed')

function onRapidRate() {
  const v = parseDecimalInput(text.value)
  inputProblem.value = decimalInputProblem(text.value) ?? rapidRateProblem(v)
  if (inputProblem.value) return
  rapidRate.value = v
  rapidRateSource.value = 'user'
}

function onPUnit(event: Event) {
  pUnit.value = (event.target as HTMLSelectElement).value as DwellPUnit
  pUnitSource.value = 'user'
}

const job = computed(() => props.loaded.job)
const estimate = computed(() =>
  estimateMachiningTime(job.value.moves, job.value.dwells, {
    rapidRateMmPerMin: rapidRate.value,
    dwellPUnit: pUnit.value,
  }),
)
const studioSeconds = computed(() => job.value.header.studioTimeEstimateSeconds)
const maxFeedRate = computed(
  () => job.value.header.otherRecords.find((r) => r.type === 'MAXFEEDRATE')?.fields.value ?? null,
)
const names = computed(() => new Map(props.loaded.summary.toolpaths.map((t) => [t.number, t.name])))
const hasDwells = computed(() => job.value.dwells.length > 0)
const rapidRateLabel = computed(() => (rapidRateSource.value === 'user' ? 'entered' : 'default'))

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
    <p class="note">
      This time is each move's length divided by its programmed feed, with rapids at the rapid rate below;
      acceleration is ignored. Makera Studio's estimate is not derived from the programmed feeds in this file, so
      the two can differ widely.
    </p>
    <dl>
      <dt>Rapid rate ({{ SOURCE_LABEL[rapidRateSource] }})</dt>
      <dd><input v-model="text" type="text" inputmode="decimal" @change="onRapidRate" /> mm/min</dd>
      <dt>Dwell P unit ({{ SOURCE_LABEL[pUnitSource] }})</dt>
      <dd>
        <select :value="pUnit" @change="onPUnit">
          <option value="seconds">seconds</option>
          <option value="milliseconds">milliseconds</option>
        </select>
      </dd>
    </dl>
    <p v-if="inputProblem" class="problem">{{ inputProblem }}</p>
    <p class="note">
      Enter your machine's rapid rate: the file does not contain it, and 3000 mm/min is only a placeholder. Makera
      firmware may read a G4 P dwell as milliseconds.
    </p>
    <dl>
      <dt>Total (calculated, rapids at the {{ rapidRateLabel }} rapid rate: assumed)</dt>
      <dd>{{ formatDuration(estimate.total.totalSeconds) }} ({{ sec(estimate.total.totalSeconds) }})</dd>
      <dt>Feed moves (calculated)</dt>
      <dd>{{ sec(estimate.total.feedSeconds) }}, {{ mm(estimate.total.feedLengthMm) }}</dd>
      <dt>Rapids (calculated at the {{ rapidRateLabel }} rapid rate: assumed)</dt>
      <dd>{{ sec(estimate.total.rapidSeconds) }}, {{ mm(estimate.total.rapidLengthMm) }}</dd>
      <template v-if="hasDwells">
        <dt>Dwells (calculated, P unit assumed)</dt>
        <dd>{{ sec(estimate.total.dwellSeconds) }}</dd>
      </template>
      <template v-if="estimate.total.noFeedLengthMm > 0">
        <dt>Cutting moves with no feed, given no time (calculated)</dt>
        <dd>{{ mm(estimate.total.noFeedLengthMm) }}</dd>
      </template>
      <template v-if="job.unstoredMotionLines > 0">
        <dt>Motion lines given no time: unknown position, unsupported motion or invalid arc (calculated)</dt>
        <dd>{{ job.unstoredMotionLines }}</dd>
      </template>
      <template v-if="studioSeconds !== null">
        <dt>Makera Studio estimate (from file header)</dt>
        <dd>{{ formatDuration(studioSeconds) }} ({{ studioSeconds }} s)</dd>
        <dt>Difference, calculated minus Studio</dt>
        <dd>{{ difference ?? 'not available' }}</dd>
      </template>
      <template v-if="maxFeedRate !== null">
        <dt>Maximum feed rate (from file header, as written, not used here)</dt>
        <dd>{{ maxFeedRate }}</dd>
      </template>
    </dl>
    <table>
      <thead>
        <tr>
          <th>Toolpath</th>
          <th>Feed</th>
          <th>Rapid (assumed rate)</th>
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
          <td>{{ formatDuration(t.totalSeconds) }}</td>
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
