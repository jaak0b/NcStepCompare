// Main-thread handle on the simulation worker. Starting a new run terminates the previous worker,
// which cancels a simulation still in progress.
import type { OrientationCandidate, Tolerances } from '../engine/deviation'
import type { PartPlacement } from '../engine/partPlacement'
import type { MoveList } from '../engine/moveList'
import type { TriangleMesh } from '../engine/stepModel'
import type { Box3D } from '../engine/stock'
import type { CutterShape } from '../engine/toolShape'
import type {
  ComparisonResult,
  SimulationFrame,
  SimulationReady,
  SimulationRequest,
  SimulationResponse,
} from './simulationMessages'

export interface SimulationHandlers {
  onProgress(done: number, total: number): void
  onReady(result: SimulationReady): void
  onFrame(frame: SimulationFrame): void
  onComparison(result: ComparisonResult): void
  onOrientations(requestId: number, candidates: OrientationCandidate[], ms: number): void
  /** A failed simulation; the stock is gone. */
  onError(message: string): void
  /** A failed comparison or auto-orient; the simulation is still usable. */
  onComparisonError(message: string, during: 'comparison' | 'autoOrient', requestId: number): void
}

export class SimulationClient {
  private worker: Worker | null = null

  start(
    moves: MoveList,
    stock: Box3D,
    cellSize: number,
    tools: { number: number; shape: CutterShape }[],
    handlers: SimulationHandlers,
  ): void {
    this.stop()
    const worker = new Worker(new URL('./simulationWorker.ts', import.meta.url), { type: 'module' })
    this.worker = worker
    worker.onmessage = (event: MessageEvent<SimulationResponse>) => {
      if (worker !== this.worker) return
      const r = event.data
      if (r.type === 'progress') handlers.onProgress(r.done, r.total)
      else if (r.type === 'ready') handlers.onReady(r)
      else if (r.type === 'frame') handlers.onFrame(r.frame)
      else if (r.type === 'comparison') handlers.onComparison(r)
      else if (r.type === 'orientations') handlers.onOrientations(r.requestId, r.candidates, r.ms)
      else if (r.during === 'simulation') handlers.onError(r.message)
      else handlers.onComparisonError(r.message, r.during, r.requestId)
    }
    worker.onmessageerror = () => {
      if (worker === this.worker) handlers.onError('A message from the simulation worker could not be read.')
    }
    worker.onerror = (event) => {
      if (worker === this.worker) handlers.onError(event.message || 'The simulation worker stopped unexpectedly.')
    }
    // Copies, so the main thread keeps its move list for drawing.
    const request: SimulationRequest = {
      type: 'init',
      stock,
      cellSize,
      tools,
      moves: {
        count: moves.count,
        start: moves.start.slice(),
        end: moves.end.slice(),
        tool: moves.tool.slice(),
        toolpath: moves.toolpath.slice(),
      },
    }
    worker.postMessage(request, [
      request.moves.start.buffer,
      request.moves.end.buffer,
      request.moves.tool.buffer,
      request.moves.toolpath.buffer,
    ] as ArrayBuffer[])
  }

  seek(moveIndex: number): void {
    this.worker?.postMessage({ type: 'seek', moveIndex } satisfies SimulationRequest)
  }

  /**
   * Compares the stock with parts already placed in work coordinates; no parts clears the
   * comparison. Sends copies. The result carries the same request id.
   */
  compare(
    requestId: number,
    parts: { positions: Float32Array; indices: Uint32Array }[],
    tolerances: Tolerances,
  ): void {
    if (!this.worker) return
    const copies = parts.map((p) => ({ positions: p.positions.slice(), indices: p.indices.slice() }))
    this.worker.postMessage(
      { type: 'compare', requestId, parts: copies, tolerances: { ...tolerances } } satisfies SimulationRequest,
      copies.flatMap((p) => [p.positions.buffer, p.indices.buffer]) as ArrayBuffer[],
    )
  }

  autoOrient(requestId: number, mesh: TriangleMesh, at: Pick<PartPlacement, 'centerX' | 'centerY' | 'bottomZ'>): void {
    this.worker?.postMessage({
      type: 'autoOrient',
      requestId,
      mesh: { positions: mesh.positions, indices: mesh.indices },
      at: { centerX: at.centerX, centerY: at.centerY, bottomZ: at.bottomZ },
    } satisfies SimulationRequest)
  }

  stop(): void {
    this.worker?.terminate()
    this.worker = null
  }
}
