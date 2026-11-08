<script setup lang="ts">
import { ref, watch } from 'vue'
import type { OrientationCandidate } from '../engine/deviation'
import { QUARTER_TURNS, UP_AXES, type PartPlacement, type QuarterTurns, type UpAxis } from '../engine/partPlacement'
import type { Box3D } from '../engine/stock'
import type { StepPart } from '../engine/stepModel'
import { parseDecimalInput } from '../ui/decimalInput'

const props = defineProps<{
  part: StepPart
  placement: PartPlacement
  placedBounds: Box3D
  /** Why auto-orient cannot run now, or null when it can. */
  autoOrientBlocked: string | null
  orient: { running: boolean; candidates: OrientationCandidate[] | null; ms: number | null; error: string | null }
}>()
const emit = defineEmits<{
  'update:placement': [placement: PartPlacement]
  autoOrient: []
  remove: []
}>()

type CoordField = 'centerX' | 'centerY' | 'bottomZ'
const COORD_FIELDS: { field: CoordField; label: string }[] = [
  { field: 'centerX', label: 'Centre X (mm)' },
  { field: 'centerY', label: 'Centre Y (mm)' },
  { field: 'bottomZ', label: 'Bottom Z (mm)' },
]

const texts = ref<Record<CoordField, string>>({ centerX: '', centerY: '', bottomZ: '' })
const inputProblem = ref<string | null>(null)
watch(
  () => props.placement,
  (p) => {
    texts.value = { centerX: String(p.centerX), centerY: String(p.centerY), bottomZ: String(p.bottomZ) }
  },
  { immediate: true },
)

function onCoord(field: CoordField) {
  const v = parseDecimalInput(texts.value[field])
  if (!Number.isFinite(v)) {
    inputProblem.value = 'Enter a number in mm, for example 38.5.'
    return
  }
  inputProblem.value = null
  emit('update:placement', { ...props.placement, [field]: v })
}

function onUpAxis(event: Event) {
  emit('update:placement', { ...props.placement, upAxis: (event.target as HTMLSelectElement).value as UpAxis })
}

function onTurns(event: Event) {
  const turns = Number((event.target as HTMLSelectElement).value) as QuarterTurns
  emit('update:placement', { ...props.placement, quarterTurns: turns })
}

const mm = (v: number) => v.toFixed(3)
const size = (b: Box3D) =>
  `${(b.max.x - b.min.x).toFixed(3)} x ${(b.max.y - b.min.y).toFixed(3)} x ${(b.max.z - b.min.z).toFixed(3)} mm`
const orientationName = (c: { upAxis: UpAxis; quarterTurns: QuarterTurns }) =>
  `${c.upAxis} up, ${c.quarterTurns * 90} deg`
</script>

<template>
  <div class="part">
    <div class="title">
      <strong>{{ part.label }}</strong>
      <button type="button" class="remove" @click="emit('remove')">Remove</button>
    </div>
    <dl>
      <dt>File</dt>
      <dd>{{ part.fileName }}</dd>
      <dt>Unit in file</dt>
      <dd>
        <template v-if="part.fileUnit === 'millimetre'">millimetre</template>
        <span v-else-if="part.fileUnit" class="problem">{{ part.fileUnit }}, converted to mm</span>
        <span v-else class="problem">not declared, read as mm</span>
      </dd>
      <dt>Triangles (calculated)</dt>
      <dd>{{ part.triangleCount.toLocaleString('en-US') }}</dd>
      <dt>Model bounding box (from the STEP file)</dt>
      <dd>
        {{ size(part.bounds) }}<br />
        X {{ mm(part.bounds.min.x) }} to {{ mm(part.bounds.max.x) }}, Y {{ mm(part.bounds.min.y) }} to
        {{ mm(part.bounds.max.y) }}, Z {{ mm(part.bounds.min.z) }} to {{ mm(part.bounds.max.z) }}
      </dd>
      <dt>Read time (measured)</dt>
      <dd>{{ (part.readMs / 1000).toFixed(2) }} s</dd>
    </dl>
    <div class="fields">
      <label>Up axis of the model</label>
      <select :value="placement.upAxis" @change="onUpAxis">
        <option v-for="a in UP_AXES" :key="a" :value="a">{{ a }}</option>
      </select>
      <label>Rotation about Z</label>
      <select :value="placement.quarterTurns" @change="onTurns">
        <option v-for="t in QUARTER_TURNS" :key="t" :value="t">{{ t * 90 }} deg</option>
      </select>
      <template v-for="f in COORD_FIELDS" :key="f.field">
        <label>{{ f.label }}</label>
        <input v-model="texts[f.field]" type="text" inputmode="decimal" @change="onCoord(f.field)" />
      </template>
    </div>
    <p v-if="inputProblem" class="problem">{{ inputProblem }}</p>
    <dl>
      <dt>Placed bounding box (calculated)</dt>
      <dd>
        X {{ mm(placedBounds.min.x) }} to {{ mm(placedBounds.max.x) }}, Y {{ mm(placedBounds.min.y) }} to
        {{ mm(placedBounds.max.y) }}, Z {{ mm(placedBounds.min.z) }} to {{ mm(placedBounds.max.z) }}
      </dd>
    </dl>
    <div class="orient">
      <button type="button" :disabled="!!autoOrientBlocked || orient.running" @click="emit('autoOrient')">
        Auto-orient
      </button>
      <span v-if="autoOrientBlocked" class="note">{{ autoOrientBlocked }}</span>
      <span v-else-if="orient.running" class="note">Trying 24 orientations.</span>
    </div>
    <p v-if="orient.error" class="problem">Auto-orient failed: {{ orient.error }}</p>
    <template v-if="orient.candidates">
      <p class="note">
        Best 3 of 24 orientations, by mean absolute deviation from the final stock over the part outline
        (measured, {{ ((orient.ms ?? 0) / 1000).toFixed(1) }} s). The best one is applied.
      </p>
      <ol class="candidates">
        <li v-for="c in orient.candidates.slice(0, 3)" :key="c.upAxis + c.quarterTurns">
          {{ orientationName(c) }}: {{ c.meanAbsDeviation.toFixed(3) }} mm
        </li>
      </ol>
    </template>
  </div>
</template>

<style scoped>
.part {
  border-top: 1px solid #e3e5e8;
  padding: 6px 0;
}
.title {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}
dl {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 2px 12px;
  margin: 4px 0;
}
dt {
  color: #5b6470;
}
dd {
  margin: 0;
}
.fields {
  display: grid;
  grid-template-columns: max-content 110px;
  gap: 2px 8px;
  align-items: center;
  margin-top: 4px;
}
.fields input,
.fields select {
  width: 100%;
  box-sizing: border-box;
}
.orient {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-top: 4px;
}
.note {
  color: #5b6470;
  margin: 4px 0 0;
}
.problem {
  color: #b42318;
  margin: 4px 0 0;
}
.candidates {
  margin: 2px 0 0;
  padding-left: 20px;
}
</style>
