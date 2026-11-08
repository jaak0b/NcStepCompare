// Runs the material removal simulation off the main thread, then answers seek requests for playback
// with only the part of the grid that changed. It also owns the comparison with the placed STEP
// parts, because that needs the height grid: the model grid, the tolerance limits, the deviation
// summary of each shown frame, and the auto-orient ranking against the final stock.
import {
  footprintBounds,
  rankOrientations,
  summarizeDeviation,
  toleranceLimits,
  type CellBounds,
  type DeviationSummary,
  type ToleranceLimits,
} from '../engine/deviation'
import { mergePartGrids, rasterizePart } from '../engine/modelGrid'
import { MaterialSimulation, planCheckpoints } from '../engine/simulation'
import { cutterProfile, type CutterProfile } from '../engine/toolShape'
import type { SimulationRequest, SimulationResponse } from './simulationMessages'

let sim: MaterialSimulation | null = null
/** Grid after the last move, for auto-orient. */
let finalHeights: Float32Array | null = null
let comparison: { model: Float32Array; limits: ToleranceLimits; bounds: CellBounds | null } | null = null
let pendingSeek: number | null = null
let seekScheduled = false

function post(message: SimulationResponse, transfer: ArrayBuffer[] = []) {
  self.postMessage(message, { transfer })
}

function fail(err: unknown, during: 'simulation' | 'comparison' | 'autoOrient' = 'simulation') {
  post({ type: 'error', message: err instanceof Error ? err.message : String(err), during })
}

function init(req: Extract<SimulationRequest, { type: 'init' }>) {
  const t0 = performance.now()
  const tools = new Map<number, CutterProfile>()
  const toolProblems: { number: number; problem: string }[] = []
  for (const t of req.tools) {
    const p = cutterProfile(t.shape)
    if (typeof p === 'string') toolProblems.push({ number: t.number, problem: p })
    else tools.set(t.number, p)
  }
  const s = new MaterialSimulation(req.stock, req.cellSize, req.moves, tools, planCheckpoints(req.moves))
  const total = req.moves.count
  s.advanceTo(total, (done) => post({ type: 'progress', done, total }), 5000)
  sim = s
  finalHeights = s.grid.heights.slice()
  comparison = null
  s.takeDisplayDirty()
  let unsimulated = 0
  for (const v of s.unsimulatedMoves) unsimulated += v
  const heights = s.grid.heights.slice()
  const removedVolume = s.removedVolume.slice()
  const maxCutDepth = s.maxCutDepth.slice()
  post(
    {
      type: 'ready',
      simMs: performance.now() - t0,
      grid: {
        nx: s.grid.nx,
        ny: s.grid.ny,
        cellSize: s.grid.cellSize,
        originX: s.grid.originX,
        originY: s.grid.originY,
        stock: req.stock,
      },
      heights,
      moveIndex: s.current,
      checkpointCount: s.checkpointCount,
      checkpointBytes: s.checkpointBytes(),
      removedVolume,
      maxCutDepth,
      unsimulatedMoveCount: unsimulated,
      toolProblems,
    },
    [heights.buffer as ArrayBuffer, removedVolume.buffer as ArrayBuffer, maxCutDepth.buffer as ArrayBuffer],
  )
}

function runSeek() {
  seekScheduled = false
  if (!sim || pendingSeek === null) return
  const target = pendingSeek
  pendingSeek = null
  try {
    const t0 = performance.now()
    sim.seek(target)
    const rect = sim.takeDisplayDirty()
    const w = Math.max(0, rect.maxI - rect.minI + 1)
    const h = Math.max(0, rect.maxJ - rect.minJ + 1)
    const data = new Float32Array(w * h)
    const { nx, heights } = sim.grid
    for (let j = 0; j < h; j++) {
      const src = (rect.minJ + j) * nx + rect.minI
      data.set(heights.subarray(src, src + w), j * w)
    }
    post(
      {
        type: 'frame',
        frame: { moveIndex: sim.current, rect, data, workerMs: performance.now() - t0, deviation: currentDeviation() },
      },
      [data.buffer as ArrayBuffer],
    )
  } catch (err) {
    fail(err)
  }
}

function currentDeviation(): DeviationSummary | null {
  if (!sim || !comparison) return null
  return summarizeDeviation(sim.grid.nx, sim.grid.heights, comparison.model, comparison.limits, sim.grid.bottom, comparison.bounds)
}

function compare(req: Extract<SimulationRequest, { type: 'compare' }>) {
  if (!sim) throw new Error('The comparison needs a finished simulation.')
  const g = sim.grid
  const t0 = performance.now()
  const model = mergePartGrids(
    g,
    req.parts.map((p) => rasterizePart(g, p.positions, p.indices)),
  )
  const t1 = performance.now()
  const bounds = footprintBounds(g, model)
  const limits = toleranceLimits(g, model, g.bottom, req.tolerances, bounds)
  const t2 = performance.now()
  comparison = { model, limits, bounds }
  const interleaved = new Float32Array(g.nx * g.ny * 2)
  for (let c = 0; c < g.nx * g.ny; c++) {
    interleaved[c * 2] = limits.gougeBelow[c]
    interleaved[c * 2 + 1] = limits.leftoverAbove[c]
  }
  post(
    {
      type: 'comparison',
      limits: interleaved,
      deviation: currentDeviation(),
      rasterizeMs: t1 - t0,
      limitsMs: t2 - t1,
    },
    [interleaved.buffer as ArrayBuffer],
  )
}

function autoOrient(req: Extract<SimulationRequest, { type: 'autoOrient' }>) {
  if (!sim || !finalHeights) throw new Error('Auto-orient needs a finished simulation.')
  const t0 = performance.now()
  const candidates = rankOrientations(sim.grid, finalHeights, sim.grid.bottom, req.mesh, req.at)
  post({ type: 'orientations', requestId: req.requestId, candidates, ms: performance.now() - t0 })
}

self.onmessage = (event: MessageEvent<SimulationRequest>) => {
  const req = event.data
  if (req.type !== 'seek') {
    try {
      if (req.type === 'init') init(req)
      else if (req.type === 'compare') compare(req)
      else autoOrient(req)
    } catch (err) {
      fail(err, req.type === 'init' ? 'simulation' : req.type === 'compare' ? 'comparison' : 'autoOrient')
    }
    return
  }
  // Only the latest seek matters: requests that arrive while one is running replace each other.
  pendingSeek = req.moveIndex
  if (!seekScheduled) {
    seekScheduled = true
    setTimeout(runSeek, 0)
  }
}
