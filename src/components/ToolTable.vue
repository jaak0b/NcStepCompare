<script setup lang="ts">
import { CUTTER_SHAPE_KINDS as KINDS, type CutterShapeKind } from '../engine/toolShape'
import {
  toolProblems,
  withToolKind,
  withToolValue,
  type ToolField,
  type ToolSetup,
} from '../engine/toolTable'
import { parseDecimalInput } from '../ui/decimalInput'
import { SOURCE_LABEL } from '../ui/sourceLabel'

const props = defineProps<{ tools: ToolSetup[] }>()
const emit = defineEmits<{ update: [tools: ToolSetup[]]; reset: [number: number] }>()

/** True when the entry carries the user's own values (they are saved for the next job). */
const hasEdits = (t: ToolSetup) => Object.values(t.sources).some((s) => s === 'user' || s === 'saved')



type NumberField = Exclude<ToolField, 'kind'>

const NUMBER_FIELDS: { field: NumberField; label: string; applies: (t: ToolSetup) => boolean }[] = [
  { field: 'diameter', label: 'Diameter (mm)', applies: () => true },
  { field: 'fluteLength', label: 'Flute length (mm)', applies: () => true },
  { field: 'shoulderLength', label: 'Shoulder length (mm)', applies: () => true },
  { field: 'cornerRadius', label: 'Corner radius (mm)', applies: (t) => t.kind === 'flat end mill' },
  { field: 'tipAngle', label: 'Tip angle (deg)', applies: (t) => t.kind === 'drill' || t.kind === 'V-bit' },
  { field: 'pitch', label: 'Pitch (mm)', applies: (t) => t.kind === 'thread mill' },
  { field: 'profileAngle', label: 'Profile angle (deg)', applies: (t) => t.kind === 'thread mill' },
  { field: 'teeth', label: 'Teeth', applies: (t) => t.kind === 'thread mill' },
  { field: 'toothTipFlat', label: 'Tooth tip flat (mm)', applies: (t) => t.kind === 'thread mill' },
  { field: 'neckDiameter', label: 'Neck diameter (mm)', applies: (t) => t.kind === 'thread mill' },
  { field: 'toothOffset', label: 'Tip-to-tooth offset (mm)', applies: (t) => t.kind === 'thread mill' },
  { field: 'widthOfCutLimit', label: 'Width of cut limit (mm)', applies: () => true },
  { field: 'depthOfCutLimit', label: 'Depth of cut limit (mm)', applies: () => true },
]

const shown = (v: number) => (Number.isFinite(v) ? String(v) : '')

function replace(number: number, change: (t: ToolSetup) => ToolSetup) {
  emit(
    'update',
    props.tools.map((t) => (t.number === number ? change(t) : t)),
  )
}

function onKind(number: number, event: Event) {
  const kind = (event.target as HTMLSelectElement).value as CutterShapeKind
  replace(number, (t) => withToolKind(t, kind))
}

function onValue(number: number, field: NumberField, event: Event) {
  const value = parseDecimalInput((event.target as HTMLInputElement).value)
  replace(number, (t) => withToolValue(t, field, value))
}
</script>

<template>
  <section>
    <h2>Tool table</h2>
    <p class="note">Edits restart the simulation.</p>
    <p class="note">
      Width and depth of cut limits default to 50 % and 100 % of the diameter. Set them to the values you
      intend for each tool.
    </p>
    <p v-if="tools.length === 0" class="note">The program loads no tools (no M6).</p>
    <div v-for="t in tools" :key="t.number" class="tool">
      <div class="title">
        <strong>T{{ t.number }}</strong> <span class="name">{{ t.name }}</span>
        <button v-if="hasEdits(t)" type="button" class="reset" @click="emit('reset', t.number)">
          Reset to file values
        </button>
      </div>
      <p v-for="p in toolProblems(t)" :key="p" class="problem">{{ p }}</p>
      <p v-if="t.kind === 'thread mill'" class="note">
        Tooth values are ISO 68-1 starting values, calculated from the pitch and diameter. Check them
        against the thread mill's data sheet.
      </p>
      <div class="fields">
        <label>Type</label>
        <select :value="t.kind" @change="onKind(t.number, $event)">
          <option v-for="k in KINDS" :key="k" :value="k">{{ k }}</option>
        </select>
        <span class="source" :class="t.sources.kind">{{ SOURCE_LABEL[t.sources.kind] }}</span>
        <template v-for="f in NUMBER_FIELDS" :key="f.field">
          <template v-if="f.applies(t)">
            <label>{{ f.label }}</label>
            <input
              type="text"
              inputmode="decimal"
              :value="shown(t[f.field])"
              @change="onValue(t.number, f.field, $event)"
            />
            <span class="source" :class="t.sources[f.field]">{{ SOURCE_LABEL[t.sources[f.field]] }}</span>
          </template>
        </template>
        <template v-if="t.shankDiameter !== null">
          <label>Shank diameter (mm)</label>
          <span>{{ t.shankDiameter }}</span>
          <span class="source header">{{ SOURCE_LABEL.header }}</span>
        </template>
        <template v-if="t.studioType !== null">
          <label>Makera Studio type</label>
          <span>{{ t.studioType }}</span>
          <span class="source header">{{ SOURCE_LABEL.header }}</span>
        </template>
      </div>
    </div>
  </section>
</template>

<style scoped>
h2 {
  font-size: 13px;
  margin: 0 0 4px;
}
.note {
  margin: 0 0 6px;
  color: #5b6470;
}
.tool {
  border-top: 1px solid #e3e5e8;
  padding: 6px 0;
}
.name {
  color: #5b6470;
}
.fields {
  display: grid;
  grid-template-columns: max-content 110px max-content;
  gap: 2px 8px;
  align-items: center;
  margin-top: 4px;
}
.fields input,
.fields select {
  width: 100%;
  box-sizing: border-box;
}
.source {
  font-size: 12px;
  color: #5b6470;
}
.source.user,
.source.saved {
  color: #1f6fd1;
}
.reset {
  margin-left: 8px;
  font-size: 12px;
}
.source.assumed {
  color: #8a5a00;
}
.source.missing,
.problem {
  color: #b42318;
}
.problem {
  margin: 4px 0 0;
}
</style>
