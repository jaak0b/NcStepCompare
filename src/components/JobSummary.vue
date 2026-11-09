<script setup lang="ts">
import { computed } from 'vue'
import { NO_TOOLPATH } from '../engine/moveList'
import type { StockShape } from '../engine/makeraHeader'
import type { Box3D } from '../engine/stock'
import type { LoadedJob } from '../workers/parseMessages'

const props = defineProps<{
  loaded: LoadedJob
  stockBox: Box3D | null
  hiddenToolpaths: Set<number>
  rapidsVisible: boolean
}>()

const emit = defineEmits<{
  toggleToolpath: [number: number]
  setAllToolpaths: [visible: boolean]
  'update:rapidsVisible': [visible: boolean]
}>()

const MAX_WARNINGS_SHOWN = 200
const STOCK_SHAPE_LABEL: Partial<Record<StockShape, string>> = { box: 'Box', cylinder: 'Cylinder' }

const header = computed(() => props.loaded.job.header)
const warnings = computed(() => props.loaded.job.warnings)
const bounds = computed(() => props.loaded.summary.bounds)

const mm = (v: number) => `${v.toFixed(2)} mm`
const range = (a: number, b: number) => `${a.toFixed(2)} to ${b.toFixed(2)} mm`
const toolLabel = (n: number) => (n < 0 ? 'none' : `T${n}`)

function toolpathName(number: number, name: string): string {
  if (number === NO_TOOLPATH) return 'Moves outside any toolpath'
  return name
}
</script>

<template>
  <div class="summary">
    <section>
      <h2>File</h2>
      <dl>
        <dt>File</dt>
        <dd>{{ loaded.fileName }}</dd>
        <dt>Lines</dt>
        <dd>{{ loaded.job.lineCount.toLocaleString() }}</dd>
        <dt>Moves (after arc flattening)</dt>
        <dd>{{ loaded.job.moves.count.toLocaleString() }}</dd>
        <dt>Load and parse time (measured)</dt>
        <dd>{{ Math.round(loaded.parseMs) }} ms</dd>
      </dl>
    </section>

    <section v-if="!loaded.job.hasMakeraHeader">
      <p class="note">This file has no Makera header. Stock, work origin and tool data are not available.</p>
    </section>

    <section v-if="header.stock">
      <h2>Stock (from file header)</h2>
      <dl>
        <dt>Shape</dt>
        <dd>{{ STOCK_SHAPE_LABEL[header.stock.shape] ?? header.stock.studioShape }}</dd>
        <dt>Size X</dt>
        <dd>{{ mm(header.stock.lengthX) }}</dd>
        <dt>Size Y</dt>
        <dd>{{ mm(header.stock.widthY) }}</dd>
        <dt>Size Z</dt>
        <dd>{{ mm(header.stock.heightZ) }}</dd>
      </dl>
    </section>

    <section v-if="header.workOrigin">
      <h2>Work origin (from file header)</h2>
      <dl>
        <dt>Position</dt>
        <dd>{{ header.workOrigin.description }}</dd>
      </dl>
    </section>

    <section v-if="stockBox">
      <h2>Stock in work coordinates (calculated from the file header)</h2>
      <dl>
        <dt>X</dt>
        <dd>{{ range(stockBox.min.x, stockBox.max.x) }}</dd>
        <dt>Y</dt>
        <dd>{{ range(stockBox.min.y, stockBox.max.y) }}</dd>
        <dt>Z</dt>
        <dd>{{ range(stockBox.min.z, stockBox.max.z) }}</dd>
      </dl>
    </section>

    <section v-if="bounds">
      <h2>Toolpath extent (calculated from the G-code)</h2>
      <dl>
        <dt>X</dt>
        <dd>{{ range(bounds.min.x, bounds.max.x) }}</dd>
        <dt>Y</dt>
        <dd>{{ range(bounds.min.y, bounds.max.y) }}</dd>
        <dt>Z</dt>
        <dd>{{ range(bounds.min.z, bounds.max.z) }}</dd>
      </dl>
    </section>

    <section>
      <h2>Toolpaths</h2>
      <div class="toggles">
        <label>
          <input
            type="checkbox"
            :checked="rapidsVisible"
            @change="emit('update:rapidsVisible', ($event.target as HTMLInputElement).checked)"
          />
          Show rapids
        </label>
        <button type="button" @click="emit('setAllToolpaths', true)">Show all</button>
        <button type="button" @click="emit('setAllToolpaths', false)">Hide all</button>
      </div>
      <table>
        <thead>
          <tr>
            <th>Show</th>
            <th>#</th>
            <th>Name</th>
            <th>Tool</th>
            <th>Cutting moves</th>
            <th>Rapids</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="tp in loaded.summary.toolpaths" :key="tp.number">
            <td>
              <input
                type="checkbox"
                :checked="!hiddenToolpaths.has(tp.number)"
                @change="emit('toggleToolpath', tp.number)"
              />
            </td>
            <td>{{ tp.number === 0 ? '' : tp.number }}</td>
            <td>{{ toolpathName(tp.number, tp.name) }}</td>
            <td>
              {{ tp.toolsUsed.length > 0 ? tp.toolsUsed.map(toolLabel).join(', ') : tp.headerToolNumber !== null ? `T${tp.headerToolNumber}` : '' }}
            </td>
            <td>{{ tp.cuttingCount.toLocaleString() }}</td>
            <td>{{ tp.rapidCount.toLocaleString() }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section>
      <h2>Warnings ({{ warnings.length }})</h2>
      <p v-if="warnings.length === 0" class="note">No warnings.</p>
      <p v-else-if="warnings.length > MAX_WARNINGS_SHOWN" class="note">
        Showing the first {{ MAX_WARNINGS_SHOWN }} warnings.
      </p>
      <ul class="warnings">
        <li v-for="(w, i) in warnings.slice(0, MAX_WARNINGS_SHOWN)" :key="i">
          <span class="line">Line {{ w.line }}:</span> {{ w.message }}
          <code>{{ w.text }}</code>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.summary {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
h2 {
  font-size: 13px;
  margin: 0 0 4px;
}
dl {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 2px 12px;
  margin: 0;
}
dt {
  color: #5b6470;
}
dd {
  margin: 0;
}
table {
  border-collapse: collapse;
  width: 100%;
}
th,
td {
  text-align: left;
  padding: 2px 6px;
  border-bottom: 1px solid #e3e5e8;
  white-space: nowrap;
}
.toggles {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 4px;
}
.note {
  margin: 0;
  color: #5b6470;
}
.warnings {
  margin: 0;
  padding-left: 18px;
}
.warnings code {
  display: block;
  color: #5b6470;
}
.line {
  font-weight: 600;
}
</style>
