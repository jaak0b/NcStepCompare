import type { OrientationCandidate } from '../engine/autoOrient'
import type { MissingMaterial } from '../engine/comparisonView'
import type { DeviationSummary, Tolerances } from '../engine/deviation'
import type { Finding } from '../engine/findings/finding'
import type { FindingMoves, FindingTool } from '../engine/findings/moveFindings'
import type { ToolChange } from '../engine/gcodeParser'
import type { PartPlacement } from '../engine/partPlacement'
import type { GapRecord } from '../engine/dexelStock'
import type { CellRect } from '../engine/simulation'
import type { TriangleMesh } from '../engine/stepModel'
import type { Box3D } from '../engine/stock'
import type { CutterShape } from '../engine/toolShape'

/** A tool table entry as the worker needs it: the cutter shape and the values the checks use. */
export type WorkerTool = FindingTool & CutterShape

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
  /** Undercut gaps of the columns in `rect` that hold any; the others in `rect` have none. */
  gaps: GapRecord
  /** Time the worker spent on this frame (seek and copy), measured. */
  workerMs: number
  /** Deviation of the shown stock from the placed parts, or null with no parts placed. */
  deviation: DeviationSummary | null
}

/** Placed parts compared with the stock, answering the compare request with the same id. */
export interface ComparisonResult {
  type: 'comparison'
  requestId: number
  /**
   * Per cell, interleaved: the height below which the stock is a gouge, and the height above which
   * it is leftover; -Infinity where no gouge is possible (everywhere outside the part outlines). Null when
   * the request had no parts: the comparison is cleared.
   */
  limits: Float32Array | null
  /** Deviation at the stock state shown when the comparison was made. */
  deviation: DeviationSummary | null
  /** Gouges, threads and leftover on the final stock; empty without parts. */
  findings: Finding[]
  /** Per cell: bottom face class and thread bit (see comparisonView); null without parts. */
  classes: Uint8Array | null
  /** Material the model needs but the G-code cut away, on the final stock; null without parts. */
  missing: MissingMaterial | null
  rasterizeMs: number
  limitsMs: number
}

export type SimulationRequest =
  | {
      type: 'init'
      stock: Box3D
      cellSize: number
      moves: FindingMoves
      tools: WorkerTool[]
      toolChanges: ToolChange[]
    }
  | { type: 'seek'; moveIndex: number }
  | {
      type: 'compare'
      requestId: number
      /** Parts placed in work coordinates; empty clears the comparison. */
      parts: { positions: Float32Array; indices: Uint32Array }[]
      tolerances: Tolerances
    }
  | {
      type: 'autoOrient'
      requestId: number
      mesh: TriangleMesh
      at: Pick<PartPlacement, 'centerX' | 'centerY' | 'bottomZ'>
    }

export interface SimulationReady {
  type: 'ready'
  simMs: number
  grid: GridInfo
  /** The whole grid after the last move. */
  heights: Float32Array
  /** Undercut gaps of every column that holds any, after the last move. */
  gaps: GapRecord
  moveIndex: number
  checkpointCount: number
  checkpointBytes: number
  removedVolume: Float32Array
  maxCutDepth: Float32Array
  unsimulatedMoveCount: number
  /** Tools whose shape is not valid, with the reason; their moves are not simulated. */
  toolProblems: { number: number; problem: string }[]
  /** Findings from the moves and the G-code (not from the comparison). */
  findings: Finding[]
}

export type SimulationResponse =
  | { type: 'progress'; done: number; total: number }
  | SimulationReady
  | { type: 'frame'; frame: SimulationFrame }
  | ComparisonResult
  | { type: 'orientations'; requestId: number; candidates: OrientationCandidate[]; ms: number }
  | { type: 'error'; message: string; during: 'simulation' }
  | { type: 'error'; message: string; during: 'comparison' | 'autoOrient'; requestId: number }
