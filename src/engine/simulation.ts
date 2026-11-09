// Runs the move list through the height grid, with checkpoints so playback can step backwards.
//
// Checkpoints are incremental: each stores the grid inside the rectangle of cells changed since the
// previous checkpoint (cells outside it did not change in that span). Applying the chain from the
// first checkpoint up to the nearest one at or before the target rebuilds the grid exactly; the
// simulation then runs forward to the target. The rectangle also records the gaps of the dexel
// columns inside it, so undercuts come back with the heights.
import { createDexelStock, type DexelStock, type GapRecord } from './dexelStock'
import type { MoveList } from './moveList'
import type { Box3D } from './stock'
import { emptyMoveRemoval, sweepMove } from './sweep'
import type { CutterProfile } from './toolShape'

export type SimulationMoves = Pick<MoveList, 'count' | 'start' | 'end' | 'tool' | 'toolpath'>

/** Default spacing of checkpoints in moves, in addition to one at every toolpath start. */
export const DEFAULT_CHECKPOINT_INTERVAL = 20000

interface Checkpoint {
  moveIndex: number
  minI: number
  maxI: number
  minJ: number
  maxJ: number
  data: Float32Array
  gaps: GapRecord
}

/** Move indices at which to store a checkpoint: every toolpath start and every `interval` moves. */
export function planCheckpoints(moves: SimulationMoves, interval = DEFAULT_CHECKPOINT_INTERVAL): number[] {
  const set = new Set<number>()
  for (let i = 1; i < moves.count; i++) {
    if (moves.toolpath[i] !== moves.toolpath[i - 1] || i % interval === 0) set.add(i)
  }
  set.add(moves.count)
  return [...set].sort((a, b) => a - b)
}

/** Inclusive cell range; empty when minI > maxI. */
export interface CellRect {
  minI: number
  maxI: number
  minJ: number
  maxJ: number
}

function emptyRect(): CellRect {
  return { minI: Number.MAX_SAFE_INTEGER, maxI: -1, minJ: Number.MAX_SAFE_INTEGER, maxJ: -1 }
}

function extend(r: CellRect, o: CellRect): void {
  if (o.minI > o.maxI || o.minJ > o.maxJ) return
  if (o.minI < r.minI) r.minI = o.minI
  if (o.maxI > r.maxI) r.maxI = o.maxI
  if (o.minJ < r.minJ) r.minJ = o.minJ
  if (o.maxJ > r.maxJ) r.maxJ = o.maxJ
}

export class MaterialSimulation {
  readonly grid: DexelStock
  /** Per move: stock volume removed (mm^3), filled on the first pass through each move. */
  readonly removedVolume: Float32Array
  /** Per move: largest thickness of stock removed in one cell (mm), the depth of cut. */
  readonly maxCutDepth: Float32Array
  /** Per move: width of cut across the feed direction (mm), NaN when not defined (see sweep). */
  readonly widthOfCut: Float32Array
  /** Per move: largest height of stock material above the tool tip touching the cutter (mm). */
  readonly contactHeight: Float32Array
  /** Per cell: index of the last move that lowered it, -1 for never; from the first pass in order. */
  readonly lastCut: Int32Array
  /**
   * 1 for moves that reach below the stock top but were not simulated because their tool has no
   * valid shape (or no tool was loaded).
   */
  readonly unsimulatedMoves: Int32Array
  /** Number of moves applied to the grid; the grid shows the state after moves [0, current). */
  current = 0

  private readonly checkpoints: Checkpoint[] = []
  private readonly checkpointAt: Set<number>
  private statsUpTo = 0
  /** Cells changed since the last checkpoint (or since the start). */
  private dirtyMinI: number
  private dirtyMaxI = -1
  private dirtyMinJ: number
  private dirtyMaxJ = -1
  private readonly removal = emptyMoveRemoval()
  /** Every cell ever changed lies in this rectangle; all others are still at the stock top. */
  private readonly everDirty = emptyRect()
  /** Cells that may have changed since the display last took a copy. */
  private displayDirty = emptyRect()

  constructor(
    stock: Box3D,
    cellSize: number,
    private readonly moves: SimulationMoves,
    private readonly tools: Map<number, CutterProfile>,
    checkpointMoves: number[],
  ) {
    this.grid = createDexelStock(stock, cellSize)
    this.dirtyMinI = this.grid.nx
    this.dirtyMinJ = this.grid.ny
    this.removedVolume = new Float32Array(moves.count)
    this.maxCutDepth = new Float32Array(moves.count)
    this.widthOfCut = new Float32Array(moves.count).fill(NaN)
    this.contactHeight = new Float32Array(moves.count)
    this.lastCut = new Int32Array(this.grid.nx * this.grid.ny).fill(-1)
    this.unsimulatedMoves = new Int32Array(moves.count)
    this.checkpointAt = new Set(checkpointMoves)
  }

  /** Applies moves until `current === target`. Calls onProgress every `progressEvery` moves. */
  advanceTo(target: number, onProgress?: (done: number) => void, progressEvery = 5000): void {
    const end = Math.min(target, this.moves.count)
    const m = this.moves
    const g = this.grid
    const r = this.removal
    while (this.current < end) {
      const i = this.current
      const profile = this.tools.get(m.tool[i])
      const k = i * 3
      if (Math.min(m.start[k + 2], m.end[k + 2]) >= g.top) {
        // Entirely above the stock: removes nothing, whatever the tool.
      } else if (!profile) {
        if (i >= this.statsUpTo) this.unsimulatedMoves[i] = 1
      } else {
        const firstPass = i >= this.statsUpTo
        sweepMove(g, m.start[k], m.start[k + 1], m.start[k + 2], m.end[k], m.end[k + 1], m.end[k + 2], profile, r, firstPass ? { lastCut: this.lastCut, moveIndex: i } : null)
        extend(this.everDirty, r)
        extend(this.displayDirty, r)
        if (firstPass) {
          this.removedVolume[i] = r.removedVolume
          this.maxCutDepth[i] = r.maxCutDepth
          this.widthOfCut[i] = r.widthOfCut
          this.contactHeight[i] = r.contactHeight
        }
        if (r.minI < this.dirtyMinI) this.dirtyMinI = r.minI
        if (r.maxI > this.dirtyMaxI) this.dirtyMaxI = r.maxI
        if (r.minJ < this.dirtyMinJ) this.dirtyMinJ = r.minJ
        if (r.maxJ > this.dirtyMaxJ) this.dirtyMaxJ = r.maxJ
      }
      this.current++
      if (this.current > this.statsUpTo) this.statsUpTo = this.current
      if (this.checkpointAt.has(this.current)) this.storeCheckpoint()
      if (onProgress && this.current % progressEvery === 0) onProgress(this.current)
    }
  }

  /** Brings the grid to the state after moves [0, target), forwards or backwards. */
  seek(target: number): void {
    const t = Math.max(0, Math.min(target, this.moves.count))
    // Going back, or forward past a stored checkpoint: rebuild from checkpoints, then run forward.
    const jumpAhead = this.checkpoints.some((c) => c.moveIndex > this.current && c.moveIndex <= t)
    if (t < this.current || jumpAhead) this.restore(t)
    this.advanceTo(t)
  }

  /** Rectangle of cells that may have changed since the last call, then starts a new one. */
  takeDisplayDirty(): CellRect {
    const r = this.displayDirty
    this.displayDirty = emptyRect()
    if (r.maxI >= 0) {
      r.maxI = Math.min(r.maxI, this.grid.nx - 1)
      r.maxJ = Math.min(r.maxJ, this.grid.ny - 1)
    }
    return r
  }

  /** Memory held by checkpoints, in bytes. */
  checkpointBytes(): number {
    return this.checkpoints.reduce((sum, c) => sum + c.data.byteLength + c.gaps.columns.byteLength + c.gaps.counts.byteLength + c.gaps.pairs.byteLength, 0)
  }

  get checkpointCount(): number {
    return this.checkpoints.length
  }

  private storeCheckpoint(): void {
    // Checkpoints are written once, in order, on the first pass; replays only reuse them.
    const last = this.checkpoints[this.checkpoints.length - 1]
    if (last && last.moveIndex >= this.current) {
      this.resetDirty()
      return
    }
    const { nx, heights } = this.grid
    const w = this.dirtyMaxI - this.dirtyMinI + 1
    const hgt = this.dirtyMaxJ - this.dirtyMinJ + 1
    const data = new Float32Array(Math.max(0, w) * Math.max(0, hgt))
    for (let j = 0; j < hgt; j++) {
      const src = (this.dirtyMinJ + j) * nx + this.dirtyMinI
      data.set(heights.subarray(src, src + w), j * w)
    }
    this.checkpoints.push({
      moveIndex: this.current,
      minI: this.dirtyMinI,
      maxI: this.dirtyMaxI,
      minJ: this.dirtyMinJ,
      maxJ: this.dirtyMaxJ,
      data,
      gaps: this.grid.dexels.record(this.dirtyMinI, this.dirtyMaxI, this.dirtyMinJ, this.dirtyMaxJ),
    })
    this.resetDirty()
  }

  private resetDirty(): void {
    this.dirtyMinI = this.grid.nx
    this.dirtyMaxI = -1
    this.dirtyMinJ = this.grid.ny
    this.dirtyMaxJ = -1
  }

  private restore(target: number): void {
    const g = this.grid
    // Only cells inside everDirty can differ from the stock top.
    const e = this.everDirty
    for (let j = e.minJ; j <= e.maxJ; j++) g.heights.fill(g.top, j * g.nx + e.minI, j * g.nx + e.maxI + 1)
    g.dexels.clear()
    extend(this.displayDirty, e)
    this.current = 0
    for (const c of this.checkpoints) {
      if (c.moveIndex > target) break
      const w = c.maxI - c.minI + 1
      const hgt = c.maxJ - c.minJ + 1
      for (let j = 0; j < hgt; j++) {
        g.heights.set(c.data.subarray(j * w, (j + 1) * w), (c.minJ + j) * g.nx + c.minI)
      }
      if (w > 0 && hgt > 0) g.dexels.clearRect(c.minI, c.maxI, c.minJ, c.maxJ)
      g.dexels.apply(c.gaps)
      this.current = c.moveIndex
    }
    this.resetDirty()
  }
}
