<script setup lang="ts">
import { cutterProfile, type CutterShapeKind } from '../engine/toolShape'
import type { ToolField, ToolSetup, ValueSource } from '../engine/toolTable'

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

function problem(t: ToolSetup): string | null {
  const p = cutterProfile(t)
  return typeof p === 'string' ? p : null
}

function edit(number: number, field: ToolField, value: string) {
  const next = props.tools.map((t) => {
    if (t.number !== number) return t
    const copy: ToolSetup = { ...t, sources: { ...t.sources, [field]: 'user' } }
    if (field === 'kind') copy.kind = value as CutterShapeKind
    else copy[field] = Number(value)
    return copy
  })
  emit('update', next)
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
      <p v-if="problem(t)" class="problem">Not simulated: {{ problem(t) }}</p>
      <div class="fields">
        <label>Type</label>
        <select :value="t.kind" @change="edit(t.number, 'kind', ($event.target as HTMLSelectElement).value)">
          <option v-for="k in KINDS" :key="k" :value="k">{{ k }}</option>
        </select>
        <span class="source" :class="t.sources.kind">{{ SOURCE_LABEL[t.sources.kind] }}</span>
        <template v-for="f in NUMBER_FIELDS" :key="f.field">
          <template v-if="f.applies(t)">
            <label>{{ f.label }}</label>
            <input
              type="number"
              step="any"
              min="0"
              :value="t[f.field]"
              @change="edit(t.number, f.field, ($event.target as HTMLInputElement).value)"
            />
            <span class="source" :class="t.sources[f.field]">{{ SOURCE_LABEL[t.sources[f.field]] }}</span>
          </template>
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
