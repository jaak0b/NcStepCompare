// Deviation of the machined stock from the STEP model, per cell of the simulation grid.
//
// Sign convention: deviation = machined height - model height (vertical, in mm).
//  - Below zero: cut deeper than the model.
//  - Above zero: material left above the model.
// Cells outside every part outline have no deviation. A through-hole cell (inside the outline, no
// material in the model) should be cut down to the bottom of the part it belongs to: its deviation
// is the material left above that bottom, and a cut below it is not a gouge of the part.
//
// Gouge and leftover are decided by distance, not by the vertical deviation alone. At a vertical
// wall a lateral offset far smaller than the tolerance changes a cell's height by the whole wall
// height, so a vertical test would flag every wall. The tolerance is therefore a zone around the
// model surface: every point within the tolerance of the surface along X, Y and Z, which is the
// Minkowski sum of the surface with a cube of half-size tol (distance in the L-infinity norm). On
// the height field this is flat grey-scale erosion and dilation with a square window:
//   gouge limit(c)    = min over cells q with |di|, |dj| <= n of model(q) - tol
//   leftover limit(c) = max over the same window of model(q) + tol,   n = floor(tol / cellSize)
// where cells without material count as -infinity for the gouge limit, and a through-hole cell
// counts as its part's bottom for the leftover limit. A cell is a gouge when the machined height is
// below its gouge limit, and leftover when above its leftover limit.
//
// A square window is separable, so each limit is a sliding minimum or maximum along rows and then
// columns (monotonic deque, Lemire's streaming min/max): the cost per cell does not depend on the
// tolerance.
//
// Both the simulation and the model are sampled at cell centres with closed sets, so they agree on
// identical geometry. The inputs themselves differ by micrometres at walls (mesh chord error, the CAM
// chord tolerance, the G-code's rounding), so with a tolerance below the cell size the window holds
// only the cell itself and such walls can show as one-cell lines of gouge or leftover.
import type { GridGeometry } from './heightGrid'
import { MODEL_THROUGH, rasterizePart, type ModelGrid, type PartModelGrid } from './modelGrid'
import {
  placePositions,
  QUARTER_TURNS,
  UP_AXES,
  type PartPlacement,
  type QuarterTurns,
  type UpAxis,
} from './partPlacement'
import type { TriangleMesh } from './stepModel'

/** Assumed defaults, editable in the UI. */
export const DEFAULT_GOUGE_TOLERANCE_MM = 0.05
export const DEFAULT_LEFTOVER_TOLERANCE_MM = 0.1

export interface Tolerances {
  gouge: number
  leftover: number
}

/**
 * Vertical deviation of one cell in mm, or null outside every part outline. `throughFloor` is the
 * bottom Z the cell must be cut down to when it lies in a through-hole.
 */
export function cellDeviation(machined: number, model: number, throughFloor: number): number | null {
  if (Number.isNaN(model)) return null
  if (model === MODEL_THROUGH) return Math.max(0, machined - throughFloor)
  return machined - model
}

/** Cell rectangle, inclusive. */
export interface CellBounds {
  i0: number
  j0: number
  i1: number
  j1: number
}

/** Smallest cell rectangle holding every cell inside a part outline, or null when there is none. */
export function footprintBounds(g: GridGeometry, model: ModelGrid): CellBounds | null {
  let i0 = g.nx
  let j0 = g.ny
  let i1 = -1
  let j1 = -1
  for (let j = 0; j < g.ny; j++) {
    for (let i = 0; i < g.nx; i++) {
      if (Number.isNaN(model.top[j * g.nx + i])) continue
      if (i < i0) i0 = i
      if (i > i1) i1 = i
      if (j < j0) j0 = j
      if (j > j1) j1 = j
    }
  }
  return i1 < 0 ? null : { i0, j0, i1, j1 }
}

export interface ToleranceLimits {
  /** Per cell: machined heights below this are gouges. NaN outside the parts. */
  gougeBelow: Float32Array
  /** Per cell: machined heights above this are leftover. NaN outside the parts. */
  leftoverAbove: Float32Array
}

/**
 * Sliding minimum (or maximum) over the window [k - n, k + n] along one line of `len` values starting
 * at `start` with step `stride`, written to `dst`. Monotonic deque: each value enters and leaves once.
 */
function slidingExtreme(
  src: Float32Array,
  dst: Float32Array,
  start: number,
  stride: number,
  len: number,
  n: number,
  takeMin: boolean,
  deque: Int32Array,
): void {
  let head = 0
  let tail = 0
  let next = 0
  for (let k = 0; k < len; k++) {
    const last = Math.min(len - 1, k + n)
    while (next <= last) {
      const v = src[start + next * stride]
      while (tail > head) {
        const w = src[start + deque[tail - 1] * stride]
        if (takeMin ? w >= v : w <= v) tail--
        else break
      }
      deque[tail++] = next++
    }
    while (deque[head] < k - n) head++
    dst[start + k * stride] = src[start + deque[head] * stride]
  }
}

/** Square-window minimum or maximum of a w x h array, separably: rows, then columns. */
function squareFilter(a: Float32Array, w: number, h: number, n: number, takeMin: boolean): Float32Array {
  const rows = new Float32Array(a.length)
  const out = new Float32Array(a.length)
  const deque = new Int32Array(Math.max(w, h))
  for (let j = 0; j < h; j++) slidingExtreme(a, rows, j * w, 1, w, n, takeMin, deque)
  for (let i = 0; i < w; i++) slidingExtreme(rows, out, i, w, h, n, takeMin, deque)
  return out
}

/** Window half-size in cells for a tolerance; the 1e-9 only absorbs rounding when tol is a multiple. */
const windowCells = (cellSize: number, tol: number) => Math.floor(tol / cellSize + 1e-9)

/** Gouge and leftover limits per cell for the model grid and tolerances. */
export function toleranceLimits(
  g: GridGeometry,
  model: ModelGrid,
  tol: Tolerances,
  bounds: CellBounds | null = footprintBounds(g, model),
): ToleranceLimits {
  const { nx, ny } = g
  const gougeBelow = new Float32Array(nx * ny).fill(Number.NaN)
  const leftoverAbove = new Float32Array(nx * ny).fill(Number.NaN)
  if (!bounds) return { gougeBelow, leftoverAbove }
  const ng = windowCells(g.cellSize, tol.gouge)
  const nl = windowCells(g.cellSize, tol.leftover)
  // Work rectangle: the footprint plus every cell a window of a footprint cell reaches.
  const m = Math.max(ng, nl)
  const ri0 = Math.max(0, bounds.i0 - m)
  const rj0 = Math.max(0, bounds.j0 - m)
  const w = Math.min(nx - 1, bounds.i1 + m) - ri0 + 1
  const h = Math.min(ny - 1, bounds.j1 + m) - rj0 + 1
  const gougeBase = new Float32Array(w * h)
  const leftoverBase = new Float32Array(w * h)
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const c = (rj0 + j) * nx + ri0 + i
      const top = model.top[c]
      const solid = !Number.isNaN(top) && top !== MODEL_THROUGH
      gougeBase[j * w + i] = solid ? top : -Infinity
      leftoverBase[j * w + i] = solid ? top : top === MODEL_THROUGH ? model.throughFloor[c] : -Infinity
    }
  }
  const lowest = squareFilter(gougeBase, w, h, ng, true)
  const highest = squareFilter(leftoverBase, w, h, nl, false)
  for (let j = bounds.j0; j <= bounds.j1; j++) {
    for (let i = bounds.i0; i <= bounds.i1; i++) {
      const c = j * nx + i
      if (Number.isNaN(model.top[c])) continue
      const k = (j - rj0) * w + (i - ri0)
      gougeBelow[c] = lowest[k] - tol.gouge
      leftoverAbove[c] = highest[k] + tol.leftover
    }
  }
  return { gougeBelow, leftoverAbove }
}

/**
 * True when a tolerance is below the cell size. The zone window then holds only the cell itself, so
 * a wall that is within tolerance but passes close to a cell centre shows as a one-cell line.
 */
export function toleranceBelowCellSize(cellSize: number, tol: Tolerances): boolean {
  return tol.gouge < cellSize - 1e-9 || tol.leftover < cellSize - 1e-9
}

export interface DeviationSummary {
  /** Cells inside the part outlines, holes included. */
  footprintCells: number
  /** Cells cut below the gouge tolerance zone. */
  gougeCells: number
  /** Cells with material above the leftover tolerance zone. */
  leftoverCells: number
  /** Largest vertical depth below the model among gouge cells, mm (0 when none). */
  maxGougeDepth: number
  /** Largest vertical height above the model among leftover cells, mm (0 when none). */
  maxLeftover: number
}

/** Changed cells, inclusive; empty when minI > maxI (the simulation's dirty rectangle). */
export interface ChangedCells {
  minI: number
  maxI: number
  minJ: number
  maxJ: number
}

/**
 * Deviation summary of a changing machined grid, kept up to date from the changed cells only. Per
 * footprint cell it stores the current gouge depth and leftover height (0 when within tolerance), so
 * an update adjusts the counts by difference. A maximum is rescanned (over these stored values, not
 * the grid) only when the cell that held it decreased.
 */
export class DeviationTracker {
  private readonly w: number
  private readonly h: number
  private readonly gougeDepth: Float32Array
  private readonly leftoverHeight: Float32Array
  private footprint = 0
  private gougeCells = 0
  private leftoverCells = 0
  private maxGouge = 0
  private maxLeftover = 0

  constructor(
    private readonly nx: number,
    private readonly model: ModelGrid,
    private readonly limits: ToleranceLimits,
    private readonly bounds: CellBounds | null,
    machined: Float32Array,
  ) {
    this.w = bounds ? bounds.i1 - bounds.i0 + 1 : 0
    this.h = bounds ? bounds.j1 - bounds.j0 + 1 : 0
    this.gougeDepth = new Float32Array(this.w * this.h)
    this.leftoverHeight = new Float32Array(this.w * this.h)
    if (!bounds) return
    for (let j = bounds.j0; j <= bounds.j1; j++) {
      for (let i = bounds.i0; i <= bounds.i1; i++) if (!Number.isNaN(model.top[j * nx + i])) this.footprint++
    }
    this.update(machined, { minI: bounds.i0, maxI: bounds.i1, minJ: bounds.j0, maxJ: bounds.j1 })
  }

  update(machined: Float32Array, changed: ChangedCells): void {
    const b = this.bounds
    if (!b) return
    const i0 = Math.max(changed.minI, b.i0)
    const i1 = Math.min(changed.maxI, b.i1)
    const j0 = Math.max(changed.minJ, b.j0)
    const j1 = Math.min(changed.maxJ, b.j1)
    let rescanGouge = false
    let rescanLeftover = false
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const c = j * this.nx + i
        const d = cellDeviation(machined[c], this.model.top[c], this.model.throughFloor[c])
        if (d === null) continue
        const k = (j - b.j0) * this.w + (i - b.i0)
        const gouge = machined[c] < this.limits.gougeBelow[c] ? -d : 0
        const left = machined[c] > this.limits.leftoverAbove[c] ? d : 0
        const oldGouge = this.gougeDepth[k]
        const oldLeft = this.leftoverHeight[k]
        this.gougeCells += (gouge > 0 ? 1 : 0) - (oldGouge > 0 ? 1 : 0)
        this.leftoverCells += (left > 0 ? 1 : 0) - (oldLeft > 0 ? 1 : 0)
        this.gougeDepth[k] = gouge
        this.leftoverHeight[k] = left
        if (gouge > this.maxGouge) this.maxGouge = gouge
        else if (oldGouge === this.maxGouge && gouge < oldGouge) rescanGouge = true
        if (left > this.maxLeftover) this.maxLeftover = left
        else if (oldLeft === this.maxLeftover && left < oldLeft) rescanLeftover = true
      }
    }
    if (rescanGouge) this.maxGouge = this.gougeDepth.reduce((a, v) => (v > a ? v : a), 0)
    if (rescanLeftover) this.maxLeftover = this.leftoverHeight.reduce((a, v) => (v > a ? v : a), 0)
  }

  summary(): DeviationSummary {
    return {
      footprintCells: this.footprint,
      gougeCells: this.gougeCells,
      leftoverCells: this.leftoverCells,
      maxGougeDepth: this.maxGouge,
      maxLeftover: this.maxLeftover,
    }
  }
}

/** Mean |deviation| of one part's model grid against the machined grid, and its footprint size. */
function partScore(g: GridGeometry, machined: Float32Array, p: PartModelGrid) {
  let n = 0
  let sum = 0
  for (let j = 0; j < p.h; j++) {
    for (let i = 0; i < p.w; i++) {
      const d = cellDeviation(machined[(p.j0 + j) * g.nx + p.i0 + i], p.top[j * p.w + i], p.bottomZ)
      if (d === null) continue
      n++
      sum += Math.abs(d)
    }
  }
  return { footprintCells: n, meanAbsDeviation: n > 0 ? sum / n : Infinity }
}

export interface OrientationCandidate {
  upAxis: UpAxis
  quarterTurns: QuarterTurns
  /** Mean absolute deviation over the candidate's footprint, mm (lower is better). */
  meanAbsDeviation: number
  footprintCells: number
}

/**
 * Tries the 6 up axes x 4 quarter turns with the given centre and bottom Z, and ranks them by the
 * mean absolute deviation between the machined grid and the model over the part footprint.
 */
export function rankOrientations(
  g: GridGeometry,
  machined: Float32Array,
  mesh: TriangleMesh,
  at: Pick<PartPlacement, 'centerX' | 'centerY' | 'bottomZ'>,
): OrientationCandidate[] {
  const out: OrientationCandidate[] = []
  for (const upAxis of UP_AXES) {
    for (const quarterTurns of QUARTER_TURNS) {
      const positions = placePositions(mesh, { ...at, upAxis, quarterTurns })
      const s = partScore(g, machined, rasterizePart(g, positions, mesh.indices))
      out.push({ upAxis, quarterTurns, ...s })
    }
  }
  return out.sort((a, b) => a.meanAbsDeviation - b.meanAbsDeviation)
}
