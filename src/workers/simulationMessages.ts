import type { SimulationMoves } from '../engine/simulation'
import type { Box3D } from '../engine/stock'
import type { CutterShape } from '../engine/toolShape'

export interface SimulationFrame {
  /** The grid shows the state after moves [0, moveIndex). */
  moveIndex: number
  nx: number
  ny: number
  /** Display cell size in mm (the simulation grid may be finer). */
  cellSize: number
  originX: number
  originY: number
  heights: Float32Array
}

export type SimulationRequest =
  | {
      type: 'init'
      stock: Box3D
      cellSize: number
      moves: SimulationMoves
      tools: { number: number; shape: CutterShape }[]
      /** Largest display grid side, in cells. */
      displayMaxCells: number
    }
  | { type: 'seek'; moveIndex: number }

export interface SimulationReady {
  type: 'ready'
  simMs: number
  gridNx: number
  gridNy: number
  cellSize: number
  checkpointCount: number
  checkpointBytes: number
  removedVolume: Float32Array
  maxCutDepth: Float32Array
  unsimulatedMoveCount: number
  frame: SimulationFrame
}

export type SimulationResponse =
  | { type: 'progress'; done: number; total: number }
  | SimulationReady
  | { type: 'frame'; frame: SimulationFrame }
  | { type: 'error'; message: string }
