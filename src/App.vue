<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef } from 'vue'
import JobSummary from './components/JobSummary.vue'
import PlaybackControls from './components/PlaybackControls.vue'
import SimulationPanel from './components/SimulationPanel.vue'
import ToolTable from './components/ToolTable.vue'
import ToolpathViewer from './components/ToolpathViewer.vue'
import { DEFAULT_CELL_SIZE_MM, cellSizeProblem } from './engine/heightGrid'
import { NO_TOOLPATH } from './engine/moveList'
import { simulationStock } from './engine/stock'
import { buildToolTable, type ToolSetup } from './engine/toolTable'
import { parseFileInWorker, type LoadedJob } from './workers/parseMessages'
import { SimulationClient } from './workers/simulationClient'
import type { ToolMarker } from './viewer/toolpathScene'
import type { SimulationReady } from './workers/simulationMessages'

// shallowRef: the move list and grids hold large typed arrays that must not become reactive proxies.
const loaded = shallowRef<LoadedJob | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
const hiddenToolpaths = ref(new Set<number>())
const rapidsVisible = ref(true)

const tools = shallowRef<ToolSetup[]>([])
const cellSize = ref(DEFAULT_CELL_SIZE_MM)
const cellSizeSource = ref<'assumed' | 'user'>('assumed')

const simClient = new SimulationClient()
const simStatus = ref<'idle' | 'running' | 'ready' | 'error'>('idle')
const simProgress = ref(0)
const simError = ref<string | null>(null)
const simResult = shallowRef<SimulationReady | null>(null)
/** Move index last asked for, and the one the shown stock belongs to. */
const playIndex = ref(0)
const shownIndex = ref(0)
const frameTiming = ref<{ workerMs: number; requestToShownMs: number; renderMs: number } | null>(null)
let seekRequestedAt = 0
const viewer = ref<InstanceType<typeof ToolpathViewer> | null>(null)

onBeforeUnmount(() => simClient.stop())

const stock = computed(() => {
  const l = loaded.value
  if (!l) return null
  return simulationStock(l.job.header.stock, l.job.header.workOrigin, l.summary.bounds)
})
const stockBox = computed(() => stock.value?.box ?? null)
const cellSizeError = computed(() => (stock.value ? cellSizeProblem(stock.value.box, cellSize.value) : null))

const toolpathStarts = computed(() => {
  const l = loaded.value
  if (!l) return []
  const m = l.job.moves
  const firstMove = new Map<number, number>()
  for (let i = 0; i < m.count; i++) {
    if (!firstMove.has(m.toolpath[i])) firstMove.set(m.toolpath[i], i)
  }
  return l.summary.toolpaths
    .filter((tp) => firstMove.has(tp.number))
    .map((tp) => ({
      number: tp.number,
      name: tp.number === NO_TOOLPATH ? 'Moves outside any toolpath' : tp.name,
      firstMove: firstMove.get(tp.number)!,
    }))
})

const currentLine = computed(() => {
  const m = loaded.value?.job.moves
  return m && shownIndex.value > 0 ? m.line[shownIndex.value - 1] : null
})

const toolMarker = computed<ToolMarker | null>(() => {
  const m = loaded.value?.job.moves
  if (!m || m.count === 0 || simStatus.value !== 'ready') return null
  // At the move the shown stock belongs to, not the one last asked for.
  const i = shownIndex.value > 0 ? shownIndex.value - 1 : 0
  const arr = shownIndex.value > 0 ? m.end : m.start
  const tool = tools.value.find((t) => t.number === m.tool[i])
  if (!tool) return null
  return {
    tip: { x: arr[i * 3], y: arr[i * 3 + 1], z: arr[i * 3 + 2] },
    radius: tool.diameter / 2,
    length: tool.fluteLength,
  }
})

/** Stops any running simulation and removes its results from the screen. */
function resetSimulation() {
  simClient.stop()
  simStatus.value = 'idle'
  simProgress.value = 0
  simResult.value = null
  simError.value = null
  frameTiming.value = null
  playIndex.value = 0
  shownIndex.value = 0
  viewer.value?.clearStock()
}

function startSimulation() {
  const l = loaded.value
  resetSimulation()
  if (!l || !stock.value || cellSizeError.value) return
  simStatus.value = 'running'
  simProgress.value = 0
  // Plain copies: Vue proxies cannot be sent to a worker.
  const toolShapes = tools.value.map((t) => ({
    number: t.number,
    shape: { kind: t.kind, diameter: t.diameter, cornerRadius: t.cornerRadius, tipAngle: t.tipAngle },
  }))
  const box = stock.value.box
  simClient.start(
    l.job.moves,
    { min: { ...box.min }, max: { ...box.max } },
    cellSize.value,
    toolShapes,
    {
      onProgress: (done, total) => {
        simProgress.value = total > 0 ? done / total : 1
      },
      onReady: (r) => {
        simResult.value = r
        viewer.value?.setStockGrid(r.grid, r.heights)
        playIndex.value = r.moveIndex
        shownIndex.value = r.moveIndex
        simStatus.value = 'ready'
      },
      onFrame: (f) => {
        viewer.value?.applyStockRect(f.rect, f.data)
        shownIndex.value = f.moveIndex
        const requestToShownMs = performance.now() - seekRequestedAt
        // The render call runs on the next animation frame; read its time then.
        requestAnimationFrame(() => {
          frameTiming.value = {
            workerMs: f.workerMs,
            requestToShownMs,
            renderMs: viewer.value?.lastRenderMs() ?? 0,
          }
        })
      },
      onError: (message) => {
        simError.value = message
        simStatus.value = 'error'
      },
    },
  )
}

function seek(index: number) {
  if (simStatus.value !== 'ready') return
  playIndex.value = index
  seekRequestedAt = performance.now()
  simClient.seek(index)
}

async function onFileChosen(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  loading.value = true
  error.value = null
  // The old job goes away now, so a failed load never leaves its simulation on screen.
  resetSimulation()
  loaded.value = null
  try {
    const result = await parseFileInWorker(file)
    hiddenToolpaths.value = new Set()
    loaded.value = result
    const used = [...new Set(result.summary.toolpaths.flatMap((t) => t.toolsUsed))]
    tools.value = buildToolTable(result.job.header.tools, used)
    startSimulation()
  } catch (err) {
    error.value = `Could not read ${file.name}: ${err instanceof Error ? err.message : String(err)}`
  } finally {
    loading.value = false
    input.value = ''
  }
}

function onToolsEdited(next: ToolSetup[]) {
  tools.value = next
  startSimulation()
}

function onCellSize(value: number) {
  cellSize.value = value
  cellSizeSource.value = 'user'
  startSimulation()
}

function toggleToolpath(number: number) {
  const next = new Set(hiddenToolpaths.value)
  if (next.has(number)) next.delete(number)
  else next.add(number)
  hiddenToolpaths.value = next
}

function setAllToolpaths(visible: boolean) {
  hiddenToolpaths.value = visible
    ? new Set()
    : new Set(loaded.value?.summary.toolpaths.map((t) => t.number) ?? [])
}
</script>

<template>
  <div class="layout">
    <aside class="side">
      <header>
        <h1>NcStepCompare</h1>
        <label class="file">
          Open G-code file (.nc)
          <input type="file" accept=".nc,.gcode,.ngc,.tap,.txt" :disabled="loading" @change="onFileChosen" />
        </label>
        <p v-if="loading" class="status">Reading and parsing the file.</p>
        <p v-if="error" class="error">{{ error }}</p>
      </header>
      <template v-if="loaded">
        <SimulationPanel
          :status="simStatus"
          :progress="simProgress"
          :result="simResult"
          :error="simError"
          :stock-source="stock?.source ?? null"
          :cell-size="cellSize"
          :cell-size-source="cellSizeSource"
          :cell-size-problem="cellSizeError"
          :frame-timing="frameTiming"
          @update:cell-size="onCellSize"
        />
        <ToolTable :tools="tools" @update="onToolsEdited" />
        <JobSummary
          v-model:rapids-visible="rapidsVisible"
          :loaded="loaded"
          :stock-box="stock?.source === 'header' ? stockBox : null"
          :hidden-toolpaths="hiddenToolpaths"
          @toggle-toolpath="toggleToolpath"
          @set-all-toolpaths="setAllToolpaths"
        />
      </template>
      <p v-else-if="!loading" class="status">Open a .nc file to view its toolpaths.</p>
    </aside>
    <main class="view">
      <div class="viewer-area">
        <ToolpathViewer
          ref="viewer"
          :loaded="loaded"
          :stock-box="stockBox"
          :hidden-toolpaths="hiddenToolpaths"
          :rapids-visible="rapidsVisible"
          :tool-marker="toolMarker"
        />
      </div>
      <PlaybackControls
        v-if="loaded && simStatus === 'ready'"
        :move-count="loaded.job.moves.count"
        :shown-index="shownIndex"
        :requested-index="playIndex"
        :current-line="currentLine"
        :toolpaths="toolpathStarts"
        @seek="seek"
      />
    </main>
  </div>
</template>

<style scoped>
.layout {
  display: grid;
  grid-template-columns: minmax(360px, 520px) 1fr;
  height: 100vh;
}
.side {
  overflow: auto;
  padding: 12px;
  border-right: 1px solid #d6d9dd;
  background: #fff;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
h1 {
  font-size: 18px;
  margin: 0 0 8px;
}
.file {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 8px;
  font-weight: 600;
}
.status {
  color: #5b6470;
}
.error {
  color: #b42318;
}
.view {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
.viewer-area {
  position: relative;
  flex: 1;
  min-height: 0;
}
@media (max-width: 800px) {
  .layout {
    grid-template-columns: 1fr;
    grid-template-rows: auto 70vh;
    height: auto;
  }
}
</style>
