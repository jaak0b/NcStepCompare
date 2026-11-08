import type { CellRect, SimulationMoves } from '../engine/simulation'
import type { Box3D } from '../engine/stock'
import type { CutterShape } from '../engine/toolShape'

/** Size and placement of the simulation grid, in work coordinates. */
export interface GridInfo {
  nx: number
  ny: number
  cellSize: number
  originX: number
  originY: number
  /** The stock box; the grid's last cells may overhang its X and Y edges. */
  stock: Box3D
}

/** Changed part of the grid: heights of the cells in `rect`, row by row. */
export interface SimulationFrame {
  /** The grid shows the state after moves [0, moveIndex). */
  moveIndex: number
  rect: CellRect
  data: Float32Array
  /** Time the worker spent on this frame (seek and copy), measured. */
  workerMs: number
}

export type SimulationRequest =
  | {
      type: 'init'
      stock: Box3D
      cellSize: number
      moves: SimulationMoves
      tools: { number: number; shape: CutterShape }[]
    }
  | { type: 'seek'; moveIndex: number }

export interface SimulationReady {
  type: 'ready'
  simMs: number
  grid: GridInfo
  /** The whole grid after the last move. */
  heights: Float32Array
  moveIndex: number
  checkpointCount: number
  checkpointBytes: number
  removedVolume: Float32Array
  maxCutDepth: Float32Array
  unsimulatedMoveCount: number
  /** Tools whose shape is not valid, with the reason; their moves are not simulated. */
  toolProblems: { number: number; problem: string }[]
}

export type SimulationResponse =
  | { type: 'progress'; done: number; total: number }
  | SimulationReady
  | { type: 'frame'; frame: SimulationFrame }
  | { type: 'error'; message: string }
