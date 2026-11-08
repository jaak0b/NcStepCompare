<script setup lang="ts">
import type { CutterShapeKind } from '../engine/toolShape'
import {
  toolProblems,
  withToolKind,
  withToolValue,
  type ToolField,
  type ToolSetup,
  type ValueSource,
} from '../engine/toolTable'
import { parseDecimalInput } from '../ui/decimalInput'

const props = defineProps<{ tools: ToolSetup[] }>()
const emit = defineEmits<{ update: [tools: ToolSetup[]] }>()

const KINDS: CutterShapeKind[] = ['flat end mill', 'ball end', 'drill', 'V-bit', 'thread mill']

const SOURCE_LABEL: Record<ValueSource, string> = {
  header: 'header',
  user: 'edited',
  assumed: 'assumed',
  missing: 'missing',
}

type NumberField = Exclude<ToolField, 'kind'>

const NUMBER_FIELDS: { field: NumberField; label: string; applies: (t: ToolSetup) => boolean }[] = [
  { field: 'diameter', label: 'Diameter (mm)', applies: () => true },
  { field: 'fluteLength', label: 'Flute length (mm)', applies: () => true },
  { field: 'shoulderLength', label: 'Shoulder length (mm)', applies: () => true },
  { field: 'cornerRadius', label: 'Corner radius (mm)', applies: (t) => t.kind === 'flat end mill' },
  { field: 'tipAngle', label: 'Tip angle (deg)', applies: (t) => t.kind === 'drill' || t.kind === 'V-bit' },
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
    <p v-if="tools.length === 0" class="note">The program loads no tools (no M6).</p>
    <div v-for="t in tools" :key="t.number" class="tool">
      <div class="title">
        <strong>T{{ t.number }}</strong> <span class="name">{{ t.name }}</span>
      </div>
      <p v-for="p in toolProblems(t)" :key="p" class="problem">{{ p }}</p>
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
          <span class="source header">header</span>
        </template>
        <template v-if="t.studioType !== null">
          <label>Makera Studio type</label>
          <span>{{ t.studioType }}</span>
          <span class="source header">header</span>
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
.source.user {
  color: #1f6fd1;
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
