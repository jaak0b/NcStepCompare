// Runs the material removal simulation off the main thread, then answers seek requests for playback
// with only the part of the grid that changed.
import { MaterialSimulation, planCheckpoints } from '../engine/simulation'
import { cutterProfile, type CutterProfile } from '../engine/toolShape'
import type { SimulationRequest, SimulationResponse } from './simulationMessages'

let sim: MaterialSimulation | null = null
let pendingSeek: number | null = null
let seekScheduled = false

function post(message: SimulationResponse, transfer: ArrayBuffer[] = []) {
  self.postMessage(message, { transfer })
}

function fail(err: unknown) {
  post({ type: 'error', message: err instanceof Error ? err.message : String(err) })
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
      { type: 'frame', frame: { moveIndex: sim.current, rect, data, workerMs: performance.now() - t0 } },
      [data.buffer as ArrayBuffer],
    )
  } catch (err) {
    fail(err)
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
  // Only the latest seek matters: requests that arrive while one is running replace each other.
  pendingSeek = req.moveIndex
  if (!seekScheduled) {
    seekScheduled = true
    setTimeout(runSeek, 0)
  }
}
