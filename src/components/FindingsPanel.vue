<script setup lang="ts">
import { computed, ref } from 'vue'
import { FINDING_KINDS, FINDING_SEVERITY, type Finding, type FindingKind, type ValueBasis } from '../engine/findings/finding'
import { SOURCE_LABEL } from '../ui/sourceLabel'

const props = defineProps<{
  /** Sorted by group, then within the group. */
  findings: Finding[]
  selected: Finding | null
  /** True when STEP parts are placed, so the stock findings exist. */
  compared: boolean
  comparisonRunning: boolean
  toolpaths: { number: number; name: string }[]
}>()
const emit = defineEmits<{ select: [finding: Finding | null] }>()

const GROUP: Record<FindingKind, { title: string; note: string }> = {
  gouge: { title: 'Gouges', note: 'Cut deeper than the model by more than the gouge tolerance.' },
  rapid: { title: 'Rapids through material', note: 'A rapid (G0) removed stock that was still there at that moment.' },
  contact: {
    title: 'Non-cutting contact',
    note: 'Stock touched the tool higher above the tip than its flute length. The spindle and collet nut are not checked.',
  },
  spindleOff: { title: 'Cutting with the spindle off', note: 'A feed move removed stock while the spindle was off (M5).' },
  zeroFeed: { title: 'Cutting at a feed of 0', note: 'A feed move removed stock with a programmed feed of 0.' },
  leftover: {
    title: 'Material left over',
    note: 'Material above the model by more than the leftover tolerance. Outside the parts that includes tabs and the cut-out frame.',
  },
  engagement: {
    title: 'Engagement above the tool limits',
    note: 'Width or depth of cut above the limits in the tool table, one row per toolpath. Select a row to see its worst move. Thread mills and drills are not checked.',
  },
  plunge: {
    title: 'Plunges at the cutting feed',
    note: 'An end mill fed straight down into stock at the toolpath cutting feed or faster, one row per toolpath. Plunges at a lower feed are not listed.',
  },
  thread: {
    title: 'Threads',
    note: 'Holes cut wider than the model by a thread mill. They are expected for threaded holes and are not gouges.',
  },
  spoilboard: { title: 'Depth into the spoilboard', note: 'Lowest tool tip below the stock bottom, per toolpath.' },
  toolChange: { title: 'Tool changes', note: 'Every tool change (M6) in program order.' },
}

const SEVERITY_LABEL = { error: 'Error', warning: 'Warning', info: 'Info' }

/** Items shown per group before "Show all". */
const SHOWN_PER_GROUP = 50
const expanded = ref(new Set<FindingKind>())

const groups = computed(() =>
  FINDING_KINDS.map((kind) => ({ kind, items: props.findings.filter((f) => f.kind === kind) })).filter((g) => g.items.length > 0),
)

const toolpathNames = computed(() => new Map(props.toolpaths.map((t) => [t.number, t.name])))
const toolpathName = (n: number | null) => (n === null ? null : (toolpathNames.value.get(n) ?? null))

/** Stable key per finding object, so list rows keep their identity when the list changes. */
const keys = new WeakMap<Finding, number>()
let nextKey = 1
function keyOf(f: Finding): number {
  let k = keys.get(f)
  if (k === undefined) keys.set(f, (k = nextKey++))
  return k
}

const basisLabel = (b: ValueBasis) => (b === 'measured' || b === 'calculated' ? b : SOURCE_LABEL[b])

function shown(kind: FindingKind, items: Finding[]) {
  return expanded.value.has(kind) ? items : items.slice(0, SHOWN_PER_GROUP)
}

function showAll(kind: FindingKind) {
  expanded.value = new Set([...expanded.value, kind])
}

function toggle(f: Finding) {
  emit('select', props.selected === f ? null : f)
}
</script>

<template>
  <section>
    <h2>Findings</h2>
    <p class="note">Select a finding to show it in the view. A finding from a move also sets playback to after that move.</p>
    <p v-if="!compared" class="note">Place a STEP part to check for gouges, threads and leftover material.</p>
    <p v-else-if="comparisonRunning" class="note">Comparing the stock with the placed parts.</p>
    <p v-if="groups.length === 0 && compared && !comparisonRunning" class="note">No findings.</p>
    <p v-else-if="groups.length === 0 && !compared" class="note">No findings from the moves.</p>
    <details v-for="g in groups" :key="g.kind" :open="FINDING_SEVERITY[g.kind] !== 'info'" class="group">
      <summary>
        <span class="severity" :class="FINDING_SEVERITY[g.kind]">{{ SEVERITY_LABEL[FINDING_SEVERITY[g.kind]] }}</span>
        {{ GROUP[g.kind].title }} ({{ g.items.length }})
      </summary>
      <p class="note">{{ GROUP[g.kind].note }}</p>
      <p v-if="g.kind === 'thread'" class="note">Drawn in purple in the view.</p>
      <ul>
        <li v-for="f in shown(g.kind, g.items)" :key="keyOf(f)" :class="{ selected: f === selected }">
          <button type="button" @click="toggle(f)">
            <span v-if="toolpathName(f.toolpath)" class="toolpath">{{ toolpathName(f.toolpath) }}: </span>
            {{ f.rows[0].label }}: {{ f.rows[0].value }}
          </button>
          <dl v-if="f === selected">
            <template v-for="r in f.rows" :key="r.label">
              <dt>{{ r.label }} ({{ basisLabel(r.basis) }})</dt>
              <dd>{{ r.value }}</dd>
            </template>
          </dl>
        </li>
      </ul>
      <button v-if="!expanded.has(g.kind) && g.items.length > SHOWN_PER_GROUP" type="button" @click="showAll(g.kind)">
        Show all {{ g.items.length }}
      </button>
    </details>
  </section>
</template>

<style scoped>
h2 {
  font-size: 13px;
  margin: 0 0 4px;
}
.note {
  margin: 0 0 4px;
  color: #5b6470;
}
.group {
  border-top: 1px solid #e3e5e8;
  padding: 4px 0;
}
summary {
  cursor: pointer;
  font-weight: 600;
}
.severity {
  display: inline-block;
  min-width: 56px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
}
.severity.error {
  color: #b42318;
}
.severity.warning {
  color: #8a5a00;
}
.severity.info {
  color: #5b6470;
}
ul {
  list-style: none;
  margin: 0;
  padding: 0;
}
li button {
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  padding: 2px 4px;
  cursor: pointer;
  font: inherit;
}
li button:hover,
li.selected button {
  background: #f3e8ff;
}
.toolpath {
  color: #5b6470;
}
dl {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 2px 12px;
  margin: 2px 0 6px 12px;
}
dt {
  color: #5b6470;
}
dd {
  margin: 0;
}
</style>
