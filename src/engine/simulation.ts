// Runs the move list through the height grid, with checkpoints so playback can step backwards.
//
// Checkpoints are incremental: each stores the grid inside the rectangle of cells changed since the
// previous checkpoint (cells outside it did not change in that span). Applying the chain from the
// first checkpoint up to the nearest one at or before the target rebuilds the grid exactly; the
// simulation then runs forward to the target.
import { createHeightGrid, type HeightGrid } from './heightGrid'
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

export class MaterialSimulation {
  readonly grid: HeightGrid
  /** Per move: stock volume removed (mm^3), filled on the first pass through each move. */
  readonly removedVolume: Float32Array
  /** Per move: largest thickness of stock removed in one cell (mm). */
  readonly maxCutDepth: Float32Array
  /** Moves not simulated because their tool has no valid shape (or no tool was loaded). */
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

  constructor(
    stock: Box3D,
    cellSize: number,
    private readonly moves: SimulationMoves,
    private readonly tools: Map<number, CutterProfile>,
    checkpointMoves: number[],
  ) {
    this.grid = createHeightGrid(stock, cellSize)
    this.dirtyMinI = this.grid.nx
    this.dirtyMinJ = this.grid.ny
    this.removedVolume = new Float32Array(moves.count)
    this.maxCutDepth = new Float32Array(moves.count)
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
      if (!profile) {
        if (i >= this.statsUpTo) this.unsimulatedMoves[i] = 1
      } else if (Math.min(m.start[k + 2], m.end[k + 2]) < g.top) {
        sweepMove(g, m.start[k], m.start[k + 1], m.start[k + 2], m.end[k], m.end[k + 1], m.end[k + 2], profile, r)
        if (i >= this.statsUpTo) {
          this.removedVolume[i] = r.removedVolume
          this.maxCutDepth[i] = r.maxCutDepth
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

  /** Memory held by checkpoints, in bytes. */
  checkpointBytes(): number {
    return this.checkpoints.reduce((sum, c) => sum + c.data.byteLength, 0)
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
    g.heights.fill(g.top)
    this.current = 0
    for (const c of this.checkpoints) {
      if (c.moveIndex > target) break
      const w = c.maxI - c.minI + 1
      const hgt = c.maxJ - c.minJ + 1
      for (let j = 0; j < hgt; j++) {
        g.heights.set(c.data.subarray(j * w, (j + 1) * w), (c.minJ + j) * g.nx + c.minI)
      }
      this.current = c.moveIndex
    }
    this.resetDirty()
  }
}
