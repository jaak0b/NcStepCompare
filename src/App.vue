<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import ComparisonPanel from './components/ComparisonPanel.vue'
import JobSummary from './components/JobSummary.vue'
import PartPanel from './components/PartPanel.vue'
import PlaybackControls from './components/PlaybackControls.vue'
import SimulationPanel from './components/SimulationPanel.vue'
import ToolTable from './components/ToolTable.vue'
import ToolpathViewer from './components/ToolpathViewer.vue'
import type { DeviationSummary, OrientationCandidate } from './engine/deviation'
import { cellSizeProblem } from './engine/heightGrid'
import { NO_TOOLPATH } from './engine/moveList'
import { defaultPlacement, placePositions, type PartPlacement } from './engine/partPlacement'
import { simulationStock, type Box3D } from './engine/stock'
import { meshBounds, tessellationDeflection, type StepPart } from './engine/stepModel'
import { buildToolTable, type ToolSetup } from './engine/toolTable'
import { useJobSetupStore } from './stores/jobSetup'
import { readStepInWorker } from './workers/stepMessages'
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

const setup = useJobSetupStore()
const tools = computed(() => setup.tools)
const cellSize = computed(() => setup.cellSize)

/** A STEP part loaded in this session; `id` is its entry in the saved setup. */
interface LoadedPart {
  id: string
  file: File
  part: StepPart
  /** True when the placement came from the saved setup instead of the defaults. */
  restored: boolean
}
const stepParts = shallowRef<LoadedPart[]>([])
const stepLoading = ref(false)
const stepError = ref<string | null>(null)
interface OrientState {
  running: boolean
  candidates: OrientationCandidate[] | null
  ms: number | null
  error: string | null
}
const orientStates = ref<Record<string, OrientState>>({})
/** Auto-orient request id to part id. */
const orientRequests = new Map<number, string>()
let nextOrientRequest = 1
const deviation = shallowRef<DeviationSummary | null>(null)
const comparisonTiming = ref<{ rasterizeMs: number; limitsMs: number } | null>(null)
const comparisonRunning = ref(false)
const comparisonError = ref<string | null>(null)
/** Id of the latest compare request; results of older ones are dropped. */
let latestCompare = 0

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
  deviation.value = null
  comparisonRunning.value = false
  comparisonTiming.value = null
  // The worker is gone, so no auto-orient answer will come; the user can run it again.
  orientRequests.clear()
  for (const id of Object.keys(orientStates.value)) {
    if (orientStates.value[id].running) orientStates.value[id] = { ...orientStates.value[id], running: false }
  }
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
        if (f.deviation) deviation.value = f.deviation
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
      onComparison: (r) => {
        if (r.requestId !== latestCompare) return
        viewer.value?.setStockLimits(r.limits)
        deviation.value = r.deviation
        comparisonTiming.value = r.limits ? { rasterizeMs: r.rasterizeMs, limitsMs: r.limitsMs } : null
        comparisonRunning.value = false
        comparisonError.value = null
      },
      onOrientations: (requestId, candidates, ms) => {
        const id = orientRequests.get(requestId)
        orientRequests.delete(requestId)
        if (!id) return
        orientStates.value[id] = { running: false, candidates, ms, error: null }
        const current = setup.placementOf(id)
        if (current && candidates.length > 0) {
          setup.setPlacement(id, {
            ...current,
            upAxis: candidates[0].upAxis,
            quarterTurns: candidates[0].quarterTurns,
          })
        }
      },
      onError: (message) => {
        simError.value = message
        simStatus.value = 'error'
      },
      onComparisonError: (message, during, requestId) => {
        if (during === 'comparison') {
          if (requestId !== latestCompare) return
          comparisonError.value = message
          comparisonRunning.value = false
          return
        }
        const id = orientRequests.get(requestId)
        orientRequests.delete(requestId)
        if (id) orientStates.value[id] = { running: false, candidates: null, ms: null, error: message }
      },
    },
  )
}

interface PlacedPart {
  id: string
  loaded: LoadedPart
  placement: PartPlacement
  positions: Float32Array
  indices: Uint32Array
  bounds: Box3D
}

/**
 * Placed parts are cached per part: an entry is rebuilt only when that part's placement or mesh
 * changes, so unchanged parts keep their identity and nothing downstream redoes work for them.
 */
const placedCache = new Map<string, PlacedPart>()
const placementKey = (p: PartPlacement) => `${p.upAxis}|${p.quarterTurns}|${p.centerX}|${p.centerY}|${p.bottomZ}`

/** Each loaded part placed in work coordinates. */
const placedParts = computed<PlacedPart[]>(() => {
  const out: PlacedPart[] = []
  for (const loaded of stepParts.value) {
    const placement = setup.placementOf(loaded.id)
    if (!placement) continue
    const cached = placedCache.get(loaded.id)
    if (cached && cached.loaded.part === loaded.part && placementKey(cached.placement) === placementKey(placement)) {
      out.push(cached)
      continue
    }
    const positions = placePositions(loaded.part.mesh, placement)
    const placed = { id: loaded.id, loaded, placement: { ...placement }, positions, indices: loaded.part.mesh.indices, bounds: meshBounds(positions) }
    placedCache.set(loaded.id, placed)
    out.push(placed)
  }
  for (const id of placedCache.keys()) if (!out.some((p) => p.id === id)) placedCache.delete(id)
  return out
})

const sameParts = (a: PlacedPart[], b: PlacedPart[] | undefined) =>
  !!b && a.length === b.length && a.every((p, k) => p === b[k])

/** Saved parts of this job whose STEP file has not been picked again since the reload. */
const waitingParts = computed(() =>
  setup.parts.filter((p) => p.ncFileName === setup.ncFileName && !stepParts.value.some((s) => s.id === p.id)),
)

function requestCompare() {
  if (simStatus.value !== 'ready') return
  latestCompare++
  comparisonRunning.value = placedParts.value.length > 0
  comparisonError.value = null
  simClient.compare(latestCompare, placedParts.value, setup.tolerances)
}

watch(placedParts, (parts, before) => {
  if (sameParts(parts, before)) return
  viewer.value?.setPartOutlines(parts)
  requestCompare()
})
watch(
  () => `${setup.tolerances.gouge}|${setup.tolerances.leftover}`,
  () => requestCompare(),
)
watch(simStatus, (status) => {
  if (status === 'ready' && placedParts.value.length > 0) requestCompare()
})

/** Tessellation chord deviation for the current tolerances. */
const deflection = computed(() => tessellationDeflection(setup.tolerances))

// A tolerance change that changes the deflection re-reads the loaded STEP files.
watch(deflection, async (d) => {
  for (const loaded of stepParts.value) {
    try {
      const part = await readStepInWorker(loaded.file, d)
      if (d !== deflection.value) return
      stepParts.value = stepParts.value.map((p) => (p.id === loaded.id ? { ...p, part } : p))
    } catch (err) {
      stepError.value = `Could not read ${loaded.file.name} again: ${err instanceof Error ? err.message : String(err)}`
    }
  }
})

async function onStepChosen(event: Event) {
  const input = event.target as HTMLInputElement
  const files = [...(input.files ?? [])]
  input.value = ''
  const box = stockBox.value
  if (files.length === 0 || !box) return
  stepLoading.value = true
  stepError.value = null
  const problems: string[] = []
  for (const file of files) {
    try {
      const part = await readStepInWorker(file, deflection.value)
      const inUse = new Set(stepParts.value.map((p) => p.id))
      const saved = setup.findSaved(file.name, file.size, inUse)
      const id = saved?.id ?? setup.addPart(file.name, file.size, defaultPlacement(box))
      stepParts.value = [...stepParts.value, { id, file, part, restored: !!saved }]
    } catch (err) {
      problems.push(`Could not read ${file.name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  stepError.value = problems.length > 0 ? problems.join(' ') : null
  stepLoading.value = false
}

function onPlacement(id: string, placement: PartPlacement) {
  setup.setPlacement(id, placement)
}

function removePart(id: string) {
  stepParts.value = stepParts.value.filter((p) => p.id !== id)
  setup.removePart(id)
  delete orientStates.value[id]
}

function autoOrient(id: string) {
  const loaded = stepParts.value.find((p) => p.id === id)
  const placement = setup.placementOf(id)
  if (!loaded || !placement || simStatus.value !== 'ready') return
  const requestId = nextOrientRequest++
  orientRequests.set(requestId, id)
  orientStates.value[id] = { running: true, candidates: null, ms: null, error: null }
  simClient.autoOrient(requestId, loaded.part.mesh, placement)
}

function orientState(id: string): OrientState {
  return orientStates.value[id] ?? { running: false, candidates: null, ms: null, error: null }
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
    // Parts belong to a job: another .nc file starts without the parts loaded for this one.
    if (file.name !== setup.ncFileName) {
      stepParts.value = []
      orientStates.value = {}
    }
    setup.applyLoadedJob(file.name, buildToolTable(result.job.header.tools, used))
    startSimulation()
  } catch (err) {
    error.value = `Could not read ${file.name}: ${err instanceof Error ? err.message : String(err)}`
  } finally {
    loading.value = false
    input.value = ''
  }
}

function onToolsEdited(next: ToolSetup[]) {
  setup.tools = next
  startSimulation()
}

function onCellSize(value: number) {
  setup.cellSize = value
  setup.cellSizeSource = 'user'
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
        <p v-if="setup.storageProblem" class="error">{{ setup.storageProblem }}</p>
      </header>
      <template v-if="loaded">
        <SimulationPanel
          :status="simStatus"
          :progress="simProgress"
          :result="simResult"
          :error="simError"
          :stock-source="stock?.source ?? null"
          :cell-size="cellSize"
          :cell-size-source="setup.cellSizeSource"
          :cell-size-problem="cellSizeError"
          :frame-timing="frameTiming"
          @update:cell-size="onCellSize"
        />
        <section>
          <h2>STEP parts</h2>
          <label class="file">
            Add STEP files (.step, .stp)
            <input
              type="file"
              accept=".step,.stp"
              multiple
              :disabled="stepLoading || !stockBox"
              @change="onStepChosen"
            />
          </label>
          <p v-if="!stockBox" class="status">Available once the job has a stock.</p>
          <p v-if="stepLoading" class="status">Reading the STEP files.</p>
          <p v-if="stepError" class="error">{{ stepError }}</p>
          <p v-for="w in waitingParts" :key="w.id" class="status">
            Pick {{ w.fileName }} again to use its saved placement.
            <button type="button" @click="setup.removePart(w.id)">Forget</button>
          </p>
          <PartPanel
            v-for="p in placedParts"
            :key="p.id"
            :part="p.loaded.part"
            :restored="p.loaded.restored"
            :placement="p.placement"
            :placed-bounds="p.bounds"
            :auto-orient-blocked="simStatus === 'ready' ? null : 'Available once the simulation has finished.'"
            :orient="orientState(p.id)"
            @update:placement="onPlacement(p.id, $event)"
            @auto-orient="autoOrient(p.id)"
            @remove="removePart(p.id)"
          />
        </section>
        <ComparisonPanel
          v-if="placedParts.length > 0"
          :tolerances="setup.tolerances"
          :sources="setup.toleranceSources"
          :cell-size="cellSize"
          :deviation="deviation"
          :shown-move="shownIndex"
          :timing="comparisonTiming"
          :deflection="deflection"
          :running="comparisonRunning"
          :error="comparisonError"
          :outlines-visible="setup.outlinesVisible"
          @tolerance="(which, v) => setup.setTolerance(which, v)"
          @update:outlines-visible="setup.outlinesVisible = $event"
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
          :outlines-visible="setup.outlinesVisible"
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
h2 {
  font-size: 13px;
  margin: 0 0 4px;
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
