// Runs the material removal simulation off the main thread, then answers seek requests for playback
// with only the part of the grid that changed. It also owns the comparison with the placed STEP
// parts, because that needs the height grid: the model grid, the tolerance limits, the deviation
// summary of each shown frame, and the auto-orient ranking against the final stock.
import { DeviationTracker, footprintBounds, rankOrientations, toleranceLimits } from '../engine/deviation'
import { mergePartGrids, rasterizePart } from '../engine/modelGrid'
import { MaterialSimulation, planCheckpoints } from '../engine/simulation'
import { cutterProfile, type CutterProfile } from '../engine/toolShape'
import type { SimulationRequest, SimulationResponse } from './simulationMessages'

let sim: MaterialSimulation | null = null
/** Grid after the last move, for auto-orient. */
let finalHeights: Float32Array | null = null
/** Deviation of the shown stock from the placed parts, updated from each frame's changed cells. */
let comparison: DeviationTracker | null = null
let pendingSeek: number | null = null
let seekScheduled = false
/** Only the latest compare request matters: a newer one replaces one not yet started. */
let pendingCompare: Extract<SimulationRequest, { type: 'compare' }> | null = null
let compareScheduled = false

function post(message: SimulationResponse, transfer: ArrayBuffer[] = []) {
  self.postMessage(message, { transfer })
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err))

function fail(err: unknown) {
  post({ type: 'error', message: messageOf(err), during: 'simulation' })
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
  pendingCompare = null
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
    comparison?.update(sim.grid.heights, rect)
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
        frame: {
          moveIndex: sim.current,
          rect,
          data,
          workerMs: performance.now() - t0,
          deviation: comparison?.summary() ?? null,
        },
      },
      [data.buffer as ArrayBuffer],
    )
  } catch (err) {
    fail(err)
  }
}

function runCompare() {
  compareScheduled = false
  const req = pendingCompare
  pendingCompare = null
  if (!req) return
  try {
    if (!sim) throw new Error('The comparison needs a finished simulation.')
    const g = sim.grid
    if (req.parts.length === 0) {
      comparison = null
      post({ type: 'comparison', requestId: req.requestId, limits: null, deviation: null, rasterizeMs: 0, limitsMs: 0 })
      return
    }
    const t0 = performance.now()
    const model = mergePartGrids(
      g,
      req.parts.map((p) => rasterizePart(g, p.positions, p.indices)),
    )
    const t1 = performance.now()
    const bounds = footprintBounds(g, model)
    const limits = toleranceLimits(g, model, req.tolerances, bounds)
    const t2 = performance.now()
    comparison = new DeviationTracker(g.nx, model, limits, bounds, g.heights)
    const interleaved = new Float32Array(g.nx * g.ny * 2)
    for (let c = 0; c < g.nx * g.ny; c++) {
      interleaved[c * 2] = limits.gougeBelow[c]
      interleaved[c * 2 + 1] = limits.leftoverAbove[c]
    }
    post(
      {
        type: 'comparison',
        requestId: req.requestId,
        limits: interleaved,
        deviation: comparison.summary(),
        rasterizeMs: t1 - t0,
        limitsMs: t2 - t1,
      },
      [interleaved.buffer as ArrayBuffer],
    )
  } catch (err) {
    post({ type: 'error', message: messageOf(err), during: 'comparison', requestId: req.requestId })
  }
}

function autoOrient(req: Extract<SimulationRequest, { type: 'autoOrient' }>) {
  try {
    if (!sim || !finalHeights) throw new Error('Auto-orient needs a finished simulation.')
    const t0 = performance.now()
    const candidates = rankOrientations(sim.grid, finalHeights, req.mesh, req.at)
    post({ type: 'orientations', requestId: req.requestId, candidates, ms: performance.now() - t0 })
  } catch (err) {
    post({ type: 'error', message: messageOf(err), during: 'autoOrient', requestId: req.requestId })
  }
}

self.onmessage = (event: MessageEvent<SimulationRequest>) => {
  const req = event.data
  if (req.type === 'init') {
    try {
      init(req)
    } catch (err) {
      fail(err)
    }
    return
  }
  if (req.type === 'autoOrient') {
    autoOrient(req)
    return
  }
  if (req.type === 'compare') {
    pendingCompare = req
    if (!compareScheduled) {
      compareScheduled = true
      setTimeout(runCompare, 0)
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
