<script setup lang="ts">
import { ref, watch } from 'vue'
import { toleranceBelowCellSize, type DeviationSummary, type Tolerances } from '../engine/deviation'
import { parseDecimalInput } from '../ui/decimalInput'
import { SOURCE_LABEL, type SettingSource } from '../ui/sourceLabel'
import { DEVIATION_COLORS } from '../viewer/stockSurface'

const props = defineProps<{
  tolerances: Tolerances
  sources: { gouge: SettingSource; leftover: SettingSource }
  cellSize: number
  /** Deviation at the shown move, or null before the comparison is ready. */
  deviation: DeviationSummary | null
  shownMove: number
  timing: { rasterizeMs: number; limitsMs: number } | null
  /** Tessellation chord deviation of the STEP meshes, mm. */
  deflection: number
  running: boolean
  error: string | null
  outlinesVisible: boolean
}>()
const emit = defineEmits<{
  tolerance: [which: keyof Tolerances, value: number]
  'update:outlinesVisible': [visible: boolean]
}>()

const texts = ref({ gouge: '', leftover: '' })
const inputProblem = ref<string | null>(null)
watch(
  () => props.tolerances,
  (t) => {
    texts.value = { gouge: String(t.gouge), leftover: String(t.leftover) }
  },
  { immediate: true },
)

function onTolerance(which: keyof Tolerances) {
  const v = parseDecimalInput(texts.value[which])
  if (!(v > 0)) {
    inputProblem.value = 'Enter a tolerance above 0 mm, for example 0.05.'
    return
  }
  inputProblem.value = null
  emit('tolerance', which, v)
}

const label = (s: SettingSource) => SOURCE_LABEL[s]
const cells = (n: number) => n.toLocaleString('en-US')
</script>

<template>
  <section>
    <h2>Comparison with the STEP model</h2>
    <dl>
      <dt>Gouge tolerance ({{ label(sources.gouge) }})</dt>
      <dd><input v-model="texts.gouge" type="text" inputmode="decimal" @change="onTolerance('gouge')" /> mm</dd>
      <dt>Leftover tolerance ({{ label(sources.leftover) }})</dt>
      <dd>
        <input v-model="texts.leftover" type="text" inputmode="decimal" @change="onTolerance('leftover')" /> mm
      </dd>
    </dl>
    <p v-if="inputProblem" class="problem">{{ inputProblem }}</p>
    <p v-if="toleranceBelowCellSize(cellSize, tolerances)" class="problem">
      Set the cell size to at most the smaller tolerance. With larger cells the check looks at each cell on its
      own, so a wall that is within tolerance but runs close to a cell centre shows as a line of gouge or
      leftover one cell wide.
    </p>
    <label class="toggle">
      <input
        type="checkbox"
        :checked="outlinesVisible"
        @change="emit('update:outlinesVisible', ($event.target as HTMLInputElement).checked)"
      />
      Show the STEP model outline
    </label>
    <p v-if="running" class="note">Comparing the stock with the placed parts.</p>
    <p v-if="error" class="problem">Comparison failed: {{ error }}</p>
    <template v-if="deviation">
      <dl>
        <dt>Shown stock</dt>
        <dd>after move {{ cells(shownMove) }}</dd>
        <dt>Cells inside part outlines (calculated)</dt>
        <dd>{{ cells(deviation.footprintCells) }}</dd>
        <dt>Gouge cells (measured)</dt>
        <dd>{{ cells(deviation.gougeCells) }}</dd>
        <dt>Deepest gouge below the model (measured)</dt>
        <dd>{{ deviation.maxGougeDepth.toFixed(3) }} mm</dd>
        <dt>Leftover cells, inside and outside the part outlines (measured)</dt>
        <dd>{{ cells(deviation.leftoverCells) }}</dd>
        <dt>Highest leftover above the model or the stock bottom (measured)</dt>
        <dd>{{ deviation.maxLeftover.toFixed(3) }} mm</dd>
        <dt>STEP tessellation deviation (calculated, a tenth of the smaller tolerance)</dt>
        <dd>{{ deflection.toFixed(4) }} mm</dd>
        <template v-if="timing">
          <dt>Model rasterisation time (measured)</dt>
          <dd>{{ timing.rasterizeMs.toFixed(0) }} ms</dd>
          <dt>Tolerance zone time (measured)</dt>
          <dd>{{ timing.limitsMs.toFixed(0) }} ms</dd>
        </template>
      </dl>
      <p class="note">
        A cell is a gouge or leftover when the machined surface is farther than the tolerance from the model
        surface along X, Y and Z. Depths are measured vertically.
      </p>
      <p class="note">
        Outside the part outlines the expected surface is the stock bottom. Material left there, such as
        tabs or the cut-out frame, counts as leftover; a cut there is never a gouge.
      </p>
      <div class="legend">
        <span><i :style="{ background: DEVIATION_COLORS.gouge }"></i>Gouge: cut deeper than the model</span>
        <span><i :style="{ background: DEVIATION_COLORS.leftover }"></i>Leftover: material above the model</span>
        <span><i :style="{ background: DEVIATION_COLORS.within }"></i>Within tolerance</span>
      </div>
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
.toggle {
  display: block;
  margin: 4px 0;
}
.note {
  margin: 0 0 4px;
  color: #5b6470;
}
.problem {
  margin: 0 0 4px;
  color: #b42318;
}
.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  font-size: 12px;
}
.legend i {
  display: inline-block;
  width: 12px;
  height: 12px;
  margin-right: 4px;
  vertical-align: middle;
  border-radius: 2px;
}
</style>
