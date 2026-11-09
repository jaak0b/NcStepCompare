<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import ComparisonPanel from './components/ComparisonPanel.vue'
import FindingsPanel from './components/FindingsPanel.vue'
import JobSummary from './components/JobSummary.vue'
import PartPanel from './components/PartPanel.vue'
import PlaybackControls from './components/PlaybackControls.vue'
import SimulationPanel from './components/SimulationPanel.vue'
import StatusLine from './components/StatusLine.vue'
import TimePanel from './components/TimePanel.vue'
import ToolTable from './components/ToolTable.vue'
import ToolpathViewer from './components/ToolpathViewer.vue'
import WorkflowTabs from './components/WorkflowTabs.vue'
import type { OrientationCandidate } from './engine/autoOrient'
import { sortFindings, type Finding } from './engine/findings/finding'
import { DEFAULT_GOUGE_TOLERANCE_MM, DEFAULT_LEFTOVER_TOLERANCE_MM, type DeviationSummary, type Tolerances } from './engine/deviation'
import type { SettingSource } from './ui/sourceLabel'
import { DEFAULT_CELL_SIZE_MM, cellSizeProblem } from './engine/heightGrid'
import { NO_TOOLPATH } from './engine/moveList'
import { defaultPlacement, placePositions, type PartPlacement } from './engine/partPlacement'
import { simulationStock, type Box3D } from './engine/stock'
import { meshBounds, tessellationDeflection, type StepPart } from './engine/stepModel'
import { buildToolTable, toolEditKey, toolEdits, withSavedEdits, type ToolSetup } from './engine/toolTable'
import { loadToolEdits, storeToolEdits } from './ui/toolEditStorage'
import { readStepInWorker } from './workers/stepMessages'
import { JobRefusedError, parseFileInWorker, type LoadedJob } from './workers/parseMessages'
import { SimulationClient } from './workers/simulationClient'
import type { ToolMarker } from './viewer/toolpathScene'
import type { SimulationReady } from './workers/simulationMessages'

// shallowRef: the move list and grids hold large typed arrays that must not become reactive proxies.
const loaded = shallowRef<LoadedJob | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
/** True when the parser refused the last file (for example a rotary axis). */
const jobRefused = ref(false)
type WorkflowTab = 'job' | 'tools' | 'parts' | 'check' | 'info'
const TABS: { id: WorkflowTab; label: string }[] = [
  { id: 'job', label: 'Job' },
  { id: 'tools', label: 'Tools' },
  { id: 'parts', label: 'Parts' },
  { id: 'check', label: 'Check' },
  { id: 'info', label: 'Info' },
]
const activeTab = ref<WorkflowTab>('job')
const hiddenToolpaths = ref(new Set<number>())
const rapidsVisible = ref(true)

const tools = shallowRef<ToolSetup[]>([])
const savedToolEdits = loadToolEdits()
let toolEditsByKey = savedToolEdits.edits
/** Why saved tool edits could not be read or written, or null. */
const toolEditProblem = ref<string | null>(savedToolEdits.problem)

/** Tool table built from the loaded file alone, without any edits. */
function fileToolTable(): ToolSetup[] {
  const l = loaded.value
  if (!l) return []
  const used = [...new Set(l.summary.toolpaths.flatMap((t) => t.toolsUsed))]
  return buildToolTable(l.job.header.tools, used)
}

/** Saves the user's values of every tool in the table, and drops saved edits a tool no longer has. */
function saveToolEdits(next: ToolSetup[]) {
  const all = { ...toolEditsByKey }
  for (const t of next) {
    const e = toolEdits(t)
    if (Object.keys(e).length > 0) all[toolEditKey(t)] = e
    else delete all[toolEditKey(t)]
  }
  toolEditsByKey = all
  toolEditProblem.value = storeToolEdits(all)
}
const cellSize = ref(DEFAULT_CELL_SIZE_MM)
const cellSizeSource = ref<SettingSource>('assumed')
const tolerances = ref<Tolerances>({ gouge: DEFAULT_GOUGE_TOLERANCE_MM, leftover: DEFAULT_LEFTOVER_TOLERANCE_MM })
const toleranceSources = ref<Record<keyof Tolerances, SettingSource>>({ gouge: 'assumed', leftover: 'assumed' })
const outlinesVisible = ref(true)
const missingVisible = ref(false)
const playback = ref<InstanceType<typeof PlaybackControls> | null>(null)
/** Placement per loaded part id. */
const placements = ref<Record<string, PartPlacement>>({})
let nextPartId = 1

const placementOf = (id: string): PartPlacement | null => placements.value[id] ?? null

/** Changes a part's placement; nothing happens when it is unchanged. */
function setPlacement(id: string, p: PartPlacement) {
  const old = placements.value[id]
  if (
    old &&
    old.upAxis === p.upAxis &&
    old.quarterTurns === p.quarterTurns &&
    old.centerX === p.centerX &&
    old.centerY === p.centerY &&
    old.bottomZ === p.bottomZ
  ) {
    return
  }
  placements.value = { ...placements.value, [id]: { ...p } }
}

function setTolerance(which: keyof Tolerances, value: number) {
  if (tolerances.value[which] === value) return
  tolerances.value = { ...tolerances.value, [which]: value }
  toleranceSources.value = { ...toleranceSources.value, [which]: 'user' }
}

/** A loaded STEP part. Several parts may come from files with the same name. */
interface LoadedPart {
  id: string
  file: File
  part: StepPart
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
/** Findings from the moves (with the simulation) and from the final stock (with the comparison). */
const moveFindings = shallowRef<Finding[]>([])
const stockFindings = shallowRef<Finding[]>([])
const findings = computed(() => sortFindings([...stockFindings.value, ...moveFindings.value]))
const selectedFinding = shallowRef<Finding | null>(null)

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
  moveFindings.value = []
  stockFindings.value = []
  selectFinding(null)
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
    name: t.name,
    kind: t.kind,
    diameter: t.diameter,
    cornerRadius: t.cornerRadius,
    tipAngle: t.tipAngle,
    fluteLength: t.fluteLength,
    widthOfCutLimit: t.widthOfCutLimit,
    depthOfCutLimit: t.depthOfCutLimit,
    pitch: t.pitch,
    profileAngle: t.profileAngle,
    teeth: t.teeth,
    toothTipFlat: t.toothTipFlat,
    neckDiameter: t.neckDiameter,
    toothOffset: t.toothOffset,
    sources: { ...t.sources },
  }))
  const box = stock.value.box
  simClient.start(
    l.job.moves,
    { min: { ...box.min }, max: { ...box.max } },
    cellSize.value,
    toolShapes,
    l.job.toolChanges.map((c) => ({ ...c })),
    {
      onProgress: (done, total) => {
        simProgress.value = total > 0 ? done / total : 1
      },
      onReady: (r) => {
        simResult.value = r
        moveFindings.value = r.findings
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
        viewer.value?.setStockLimits(r.limits, r.classes)
        viewer.value?.setMissingMaterial(r.missing)
        deviation.value = r.deviation
        stockFindings.value = r.findings
        comparisonTiming.value = r.limits ? { rasterizeMs: r.rasterizeMs, limitsMs: r.limitsMs } : null
        comparisonRunning.value = false
        comparisonError.value = null
      },
      onOrientations: (requestId, candidates, ms) => {
        const id = orientRequests.get(requestId)
        orientRequests.delete(requestId)
        if (!id) return
        orientStates.value[id] = { running: false, candidates, ms, error: null }
        const current = placementOf(id)
        if (current && candidates.length > 0) {
          const best = candidates[0]
          setPlacement(id, {
            ...current,
            upAxis: best.upAxis,
            quarterTurns: best.quarterTurns,
            centerX: Number(best.centerX.toFixed(6)),
            centerY: Number(best.centerY.toFixed(6)),
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
          // The stock findings and the missing material belonged to the comparison that failed.
          clearStockFindings()
          viewer.value?.setMissingMaterial(null)
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
    const placement = placementOf(loaded.id)
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


/** Removes the stock findings (gouge, thread, leftover), and the selection when it is one of them. */
function clearStockFindings() {
  if (selectedFinding.value && stockFindings.value.includes(selectedFinding.value)) selectFinding(null)
  stockFindings.value = []
}

function requestCompare() {
  if (simStatus.value !== 'ready') return
  latestCompare++
  comparisonRunning.value = placedParts.value.length > 0
  // The old stock findings no longer match the parts or tolerances; the new ones come with the result.
  clearStockFindings()
  comparisonError.value = null
  simClient.compare(latestCompare, placedParts.value, tolerances.value)
}

watch(placedParts, (parts, before) => {
  if (sameParts(parts, before)) return
  viewer.value?.setPartOutlines(parts)
  requestCompare()
})
watch(
  () => `${tolerances.value.gouge}|${tolerances.value.leftover}`,
  () => requestCompare(),
)
watch(simStatus, (status) => {
  if (status === 'ready' && placedParts.value.length > 0) requestCompare()
})

/** Tessellation chord deviation for the current tolerances. */
const deflection = computed(() => tessellationDeflection(tolerances.value))

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
      const id = String(nextPartId++)
      setPlacement(id, defaultPlacement(box))
      stepParts.value = [...stepParts.value, { id, file, part }]
    } catch (err) {
      problems.push(`Could not read ${file.name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  stepError.value = problems.length > 0 ? problems.join(' ') : null
  stepLoading.value = false
}

function onPlacement(id: string, placement: PartPlacement) {
  setPlacement(id, placement)
}

function removePart(id: string) {
  stepParts.value = stepParts.value.filter((p) => p.id !== id)
  const { [id]: _removed, ...rest } = placements.value
  placements.value = rest
  delete orientStates.value[id]
}

function autoOrient(id: string) {
  const loaded = stepParts.value.find((p) => p.id === id)
  const placement = placementOf(id)
  if (!loaded || !placement || simStatus.value !== 'ready') return
  const requestId = nextOrientRequest++
  orientRequests.set(requestId, id)
  orientStates.value[id] = { running: true, candidates: null, ms: null, error: null }
  simClient.autoOrient(requestId, loaded.part.mesh, placement)
}

function orientState(id: string): OrientState {
  return orientStates.value[id] ?? { running: false, candidates: null, ms: null, error: null }
}

/** Shows a finding: the camera frames it, and a move finding also sets playback to after its last move. */
function selectFinding(f: Finding | null) {
  selectedFinding.value = f
  viewer.value?.showFinding(f?.box ?? null)
  if (!f) return
  // The finding's state stays on screen: playback stops there.
  playback.value?.pause()
  const count = loaded.value?.job.moves.count ?? 0
  // A move finding shows the stock after its move; a stock finding describes the finished job.
  seek(f.moves ? f.moves.last + 1 : count)
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
  jobRefused.value = false
  // The old job goes away now, so a failed load never leaves its simulation on screen.
  resetSimulation()
  loaded.value = null
  try {
    const result = await parseFileInWorker(file)
    hiddenToolpaths.value = new Set()
    loaded.value = result
    tools.value = fileToolTable().map((t) => {
      const saved = toolEditsByKey[toolEditKey(t)]
      return saved ? withSavedEdits(t, saved) : t
    })
    startSimulation()
  } catch (err) {
    jobRefused.value = err instanceof JobRefusedError
    error.value = err instanceof JobRefusedError
      ? `Job refused (${file.name}): ${err.message}`
      : `Could not read ${file.name}: ${err instanceof Error ? err.message : String(err)}`
  } finally {
    loading.value = false
    input.value = ''
  }
}

function onToolsEdited(next: ToolSetup[]) {
  tools.value = next
  saveToolEdits(next)
  startSimulation()
}

/** Deletes a tool's saved edits and goes back to the values from the file. */
function resetTool(number: number) {
  const fromFile = fileToolTable().find((t) => t.number === number)
  if (!fromFile) return
  const next = tools.value.map((t) => (t.number === number ? fromFile : t))
  tools.value = next
  saveToolEdits(next)
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
        <StatusLine
          :job-loaded="loaded !== null"
          :refused="jobRefused"
          :warning-count="loaded?.job.warnings.length ?? 0"
          :sim-status="simStatus"
          :sim-progress="simProgress"
          :sim-ms="simResult?.simMs ?? null"
          :findings="findings"
          :compared="placedParts.length > 0"
          :comparison-running="comparisonRunning"
        />
        <WorkflowTabs v-model="activeTab" :tabs="TABS" />
      </header>

      <div v-show="activeTab === 'job'" class="tab">
        <label class="file">
          Open G-code file (.nc)
          <input type="file" accept=".nc,.gcode,.ngc,.tap,.txt" :disabled="loading" @change="onFileChosen" />
        </label>
        <p v-if="loading" class="status">Reading and parsing the file.</p>
        <p v-if="error" class="error">{{ error }}</p>
        <JobSummary
          v-if="loaded"
          v-model:rapids-visible="rapidsVisible"
          :loaded="loaded"
          :stock-box="stock?.source === 'header' ? stockBox : null"
          :hidden-toolpaths="hiddenToolpaths"
          @toggle-toolpath="toggleToolpath"
          @set-all-toolpaths="setAllToolpaths"
        />
        <p v-else-if="!loading" class="status">Open a .nc file to view its toolpaths.</p>
      </div>

      <div v-show="activeTab === 'tools'" class="tab">
        <p v-if="toolEditProblem" class="error">{{ toolEditProblem }}</p>
        <ToolTable v-if="loaded" :tools="tools" @update="onToolsEdited" @reset="resetTool" />
        <p v-else class="status">Open a .nc file on the Job tab to see its tools.</p>
      </div>

      <div v-show="activeTab === 'parts'" class="tab">
        <section v-if="loaded">
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
          <PartPanel
            v-for="p in placedParts"
            :key="p.id"
            :part="p.loaded.part"
            :placement="p.placement"
            :placed-bounds="p.bounds"
            :auto-orient-blocked="simStatus === 'ready' ? null : 'Available once the simulation has finished.'"
            :orient="orientState(p.id)"
            @update:placement="onPlacement(p.id, $event)"
            @auto-orient="autoOrient(p.id)"
            @remove="removePart(p.id)"
          />
        </section>
        <p v-else class="status">Open a .nc file on the Job tab before adding STEP parts.</p>
      </div>

      <div v-show="activeTab === 'check'" class="tab">
        <template v-if="loaded">
          <ComparisonPanel
            v-if="placedParts.length > 0"
            :tolerances="tolerances"
            :sources="toleranceSources"
            :cell-size="cellSize"
            :deviation="deviation"
            :shown-move="shownIndex"
            :timing="comparisonTiming"
            :deflection="deflection"
            :running="comparisonRunning"
            :error="comparisonError"
            :outlines-visible="outlinesVisible"
            :missing-visible="missingVisible"
            @tolerance="setTolerance"
            @update:outlines-visible="outlinesVisible = $event"
            @update:missing-visible="missingVisible = $event"
          />
          <p v-else class="status">Add a STEP part on the Parts tab to compare it with the simulation.</p>
          <FindingsPanel
            v-if="simStatus === 'ready'"
            :findings="findings"
            :selected="selectedFinding"
            :compared="placedParts.length > 0"
            :comparison-running="comparisonRunning"
            :toolpaths="toolpathStarts"
            @select="selectFinding"
          />
          <p v-else class="status">Findings appear once the simulation has finished.</p>
        </template>
        <p v-else class="status">Open a .nc file on the Job tab first.</p>
      </div>

      <div v-show="activeTab === 'info'" class="tab">
        <template v-if="loaded">
          <TimePanel :loaded="loaded" />
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
        </template>
        <p v-else class="status">Open a .nc file on the Job tab first.</p>
      </div>
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
          :outlines-visible="outlinesVisible"
          :missing-visible="missingVisible"
        />
      </div>
      <PlaybackControls
        ref="playback"
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
  margin: 0;
}
header {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.tab {
  display: flex;
  flex-direction: column;
  gap: 14px;
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
