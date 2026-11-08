// Main-thread handle on the simulation worker. Starting a new run terminates the previous worker,
// which cancels a simulation still in progress.
import type { MoveList } from '../engine/moveList'
import type { Box3D } from '../engine/stock'
import type { CutterShape } from '../engine/toolShape'
import type { SimulationFrame, SimulationReady, SimulationRequest, SimulationResponse } from './simulationMessages'

export interface SimulationHandlers {
  onProgress(done: number, total: number): void
  onReady(result: SimulationReady): void
  onFrame(frame: SimulationFrame): void
  onError(message: string): void
}

/** Largest display grid side in cells; the simulation grid itself keeps its full resolution. */
export const DISPLAY_MAX_CELLS = 600

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
      else handlers.onError(r.message)
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
      displayMaxCells: DISPLAY_MAX_CELLS,
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

  stop(): void {
    this.worker?.terminate()
    this.worker = null
  }
}
