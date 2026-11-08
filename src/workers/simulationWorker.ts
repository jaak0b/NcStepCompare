// Runs the material removal simulation off the main thread, then answers seek requests for playback.
import { downsampleMin } from '../engine/heightGrid'
import { MaterialSimulation, planCheckpoints } from '../engine/simulation'
import { cutterProfile, type CutterProfile } from '../engine/toolShape'
import type { SimulationFrame, SimulationRequest, SimulationResponse } from './simulationMessages'

let sim: MaterialSimulation | null = null
let displayFactor = 1
let pendingSeek: number | null = null
let seekScheduled = false

function post(message: SimulationResponse, transfer: ArrayBuffer[] = []) {
  self.postMessage(message, { transfer })
}

function frame(s: MaterialSimulation): SimulationFrame {
  const d = downsampleMin(s.grid, displayFactor)
  return {
    moveIndex: s.current,
    nx: d.nx,
    ny: d.ny,
    cellSize: d.cellSize,
    originX: s.grid.originX,
    originY: s.grid.originY,
    heights: d.heights,
  }
}

function fail(err: unknown) {
  post({ type: 'error', message: err instanceof Error ? err.message : String(err) })
}

function init(req: Extract<SimulationRequest, { type: 'init' }>) {
  const t0 = performance.now()
  const tools = new Map<number, CutterProfile>()
  for (const t of req.tools) {
    const p = cutterProfile(t.shape)
    if (typeof p !== 'string') tools.set(t.number, p)
  }
  const s = new MaterialSimulation(req.stock, req.cellSize, req.moves, tools, planCheckpoints(req.moves))
  displayFactor = Math.max(1, Math.ceil(Math.max(s.grid.nx, s.grid.ny) / req.displayMaxCells))
  const total = req.moves.count
  s.advanceTo(total, (done) => post({ type: 'progress', done, total }), 5000)
  sim = s
  let unsimulated = 0
  for (const v of s.unsimulatedMoves) unsimulated += v
  const f = frame(s)
  const removedVolume = s.removedVolume.slice()
  const maxCutDepth = s.maxCutDepth.slice()
  post(
    {
      type: 'ready',
      simMs: performance.now() - t0,
      gridNx: s.grid.nx,
      gridNy: s.grid.ny,
      cellSize: s.grid.cellSize,
      checkpointCount: s.checkpointCount,
      checkpointBytes: s.checkpointBytes(),
      removedVolume,
      maxCutDepth,
      unsimulatedMoveCount: unsimulated,
      frame: f,
    },
    [f.heights.buffer as ArrayBuffer, removedVolume.buffer as ArrayBuffer, maxCutDepth.buffer as ArrayBuffer],
  )
}

function runSeek() {
  seekScheduled = false
  if (!sim || pendingSeek === null) return
  const target = pendingSeek
  pendingSeek = null
  try {
    sim.seek(target)
    const f = frame(sim)
    post({ type: 'frame', frame: f }, [f.heights.buffer as ArrayBuffer])
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
