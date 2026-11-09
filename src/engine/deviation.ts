// Deviation of the machined stock from the STEP model, per cell of the simulation grid.
//
// Sign convention: deviation = machined height - model height (vertical, in mm).
//  - Below zero: cut deeper than the model.
//  - Above zero: material left above the model.
// Outside every part outline the expected surface is the stock bottom: material left there (the
// cut-out frame, tabs, a sliver next to a wall) is leftover, and a cut there is never a gouge (its
// depth below the stock is a matter of the spoilboard, not of the part). A through-hole cell (inside
// the outline, no material in the model) should be cut down to the bottom of the part it belongs to:
// its deviation is the material left above that bottom, and a cut below it is not a gouge of the part.
//
// Gouge and leftover are decided by distance, not by the vertical deviation alone. At a vertical
// wall a lateral offset far smaller than the tolerance changes a cell's height by the whole wall
// height, so a vertical test would flag every wall. The tolerance is therefore a zone around the
// model surface: every point within the tolerance of the surface, measured as Euclidean distance in
// X, Y and Z (the ISO 1101 profile zone, bounded by the envelope of spheres of radius tol), which is
// the Minkowski sum of the surface with a ball of radius tol. On the height field this is grey-scale
// erosion and dilation with the ball as a non-flat structuring element (Serra; Sternberg): a column
// at the horizontal distance r <= tol contributes the height of the ball's cap there,
// sqrt(tol^2 - r^2):
//   gouge limit(c)    = min over cells q with |q - c| <= tol of model(q) - sqrt(tol^2 - |q - c|^2)
//   leftover limit(c) = max over the same cells of model(q) + sqrt(tol^2 - |q - c|^2)
// with |q - c| the distance between the cell centres, where cells without material count as
// -infinity for the gouge limit, and for the leftover limit a through-hole cell counts as its part's
// bottom and a cell outside the outlines as the stock bottom.
// So cells outside the outline have the same tolerance zone as those inside: a wall within tolerance
// of the model wall is within tolerance on both sides. A cell is a gouge when the machined height is
// below its gouge limit, and leftover when above its leftover limit.
//
// The ball is not separable, so each limit is a loop over the cells of the disc. Most cells lie in
// flat regions, where every cell of the disc holds the same value and the limit is that value plus or
// minus tol; the square window around the disc (separable: a sliding minimum and maximum along rows
// and then columns, monotonic deque, Lemire's streaming min/max) finds these, so the disc loop runs
// only near walls and steps.
//
// Both the simulation and the model are sampled at cell centres with closed sets, so they agree on
// identical geometry. The inputs themselves differ by micrometres at walls (mesh chord error, the CAM
// chord tolerance, the G-code's rounding), so with a tolerance below the cell size the window holds
// only the cell itself and such walls can show as one-cell lines of gouge or leftover.
import type { GridGeometry } from './heightGrid'
import { MODEL_THROUGH, type ModelGrid } from './modelGrid'

/** Assumed defaults, editable in the UI. */
export const DEFAULT_GOUGE_TOLERANCE_MM = 0.05
export const DEFAULT_LEFTOVER_TOLERANCE_MM = 0.1

export interface Tolerances {
  gouge: number
  leftover: number
}

/**
 * Vertical deviation of one cell in mm. `throughFloor` is the bottom Z the cell must be cut down to
 * when it lies in a through-hole; outside every part outline that is `stockBottom`. Below either
 * bottom the deviation is 0: such a cut is not a gouge of the part.
 */
export function cellDeviation(machined: number, model: number, throughFloor: number, stockBottom: number): number {
  if (Number.isNaN(model)) return Math.max(0, machined - stockBottom)
  if (model === MODEL_THROUGH) return Math.max(0, machined - throughFloor)
  return machined - model
}

export interface ToleranceLimits {
  /** Per cell: machined heights below this are gouges (-Infinity where none is possible). */
  gougeBelow: Float32Array
  /** Per cell: machined heights above this are leftover. */
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

/** Cell offset (di, dj) inside the disc of radius tol, with the height of the ball's cap there. */
export interface DiscCell {
  di: number
  dj: number
  cap: number
}

/** The cells whose centres lie within tol of a cell centre (Euclidean), with their cap heights. */
export function discCells(cellSize: number, tol: number): DiscCell[] {
  const n = windowCells(cellSize, tol)
  const out: DiscCell[] = []
  for (let dj = -n; dj <= n; dj++) {
    for (let di = -n; di <= n; di++) {
      const r2 = (di * di + dj * dj) * cellSize * cellSize
      if (r2 <= tol * tol * (1 + 1e-9)) out.push({ di, dj, cap: Math.sqrt(Math.max(0, tol * tol - r2)) })
    }
  }
  return out
}

/**
 * Grey-scale erosion (min of value - cap) or dilation (max of value + cap) of a w x h array with
 * the ball of radius tol (see the header). The disc clips at the grid edge.
 */
function ballFilter(a: Float32Array, w: number, h: number, cellSize: number, tol: number, erode: boolean): Float32Array {
  const n = windowCells(cellSize, tol)
  const lo = squareFilter(a, w, h, n, true)
  const hi = squareFilter(a, w, h, n, false)
  const disc = discCells(cellSize, tol)
  const out = new Float32Array(a.length)
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const c = j * w + i
      if (lo[c] === hi[c]) {
        out[c] = erode ? lo[c] - tol : hi[c] + tol
        continue
      }
      let best = erode ? Infinity : -Infinity
      for (const d of disc) {
        const qi = i + d.di
        const qj = j + d.dj
        if (qi < 0 || qj < 0 || qi >= w || qj >= h) continue
        const v = a[qj * w + qi]
        if (erode) best = Math.min(best, v - d.cap)
        else best = Math.max(best, v + d.cap)
      }
      out[c] = best
    }
  }
  return out
}

/** Gouge and leftover limits per cell of the whole grid for the model grid and tolerances. */
export function toleranceLimits(g: GridGeometry, model: ModelGrid, tol: Tolerances, stockBottom: number): ToleranceLimits {
  const n = g.nx * g.ny
  const gougeBase = new Float32Array(n)
  const leftoverBase = new Float32Array(n)
  for (let c = 0; c < n; c++) {
    const top = model.top[c]
    const solid = !Number.isNaN(top) && top !== MODEL_THROUGH
    gougeBase[c] = solid ? top : -Infinity
    leftoverBase[c] = solid ? top : top === MODEL_THROUGH ? model.throughFloor[c] : stockBottom
  }
  return {
    gougeBelow: ballFilter(gougeBase, g.nx, g.ny, g.cellSize, tol.gouge, true),
    leftoverAbove: ballFilter(leftoverBase, g.nx, g.ny, g.cellSize, tol.leftover, false),
  }
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
  /** Cells with material above the leftover tolerance zone, inside and outside the part outlines. */
  leftoverCells: number
  /** Largest vertical depth below the model among gouge cells, mm (0 when none). */
  maxGougeDepth: number
  /**
   * Largest vertical height among leftover cells above the model, or outside the part outlines above
   * the stock bottom, mm (0 when none).
   */
  maxLeftover: number
}

/** Changed cells, inclusive; empty when minI > maxI (the simulation's dirty rectangle). */
export interface ChangedCells {
  minI: number
  maxI: number
  minJ: number
  maxJ: number
}

/** The undercut gaps of the machined stock, per column (see DexelGaps). */
export interface ColumnGaps {
  gapCount(c: number): number
  gapView(c: number): Float32Array
}

/**
 * Gouge of one column against its gouge limit, as the longest Z range where the model needs
 * material (below `gougeBelow`) and the stock has none: above the machined height `h`, or inside one
 * of the column's gaps, within the stock from `bottom` to `top`. 0 when there is none. This is the
 * interval comparison (intervalDeviation) for an expected solid that is one half-line per column,
 * which the comparison uses as long as the model dexels are not used.
 */
export function columnGouge(h: number, gaps: Float32Array | null, gougeBelow: number, bottom: number, top: number): number {
  const limit = Math.min(gougeBelow, top)
  let best = limit - Math.max(h, bottom)
  if (gaps) {
    for (let k = 0; k < gaps.length; k += 2) {
      const len = Math.min(gaps[k + 1], limit) - Math.max(gaps[k], bottom)
      if (len > best) best = len
    }
  }
  return best > 0 ? best : 0
}

/**
 * Deviation summary of a changing machined grid, kept up to date from the changed cells only. Per
 * cell it stores the current gouge depth and leftover height (0 when within tolerance), so an update
 * adjusts the counts by difference. A maximum is rescanned (over these stored values, not the grid)
 * only when the cell that held it decreased.
 *
 * A cell is a gouge when its column holds a gouge anywhere along Z (columnGouge), thread grooves
 * below the top included, and leftover when its top lies above the leftover limit (the top is the
 * highest material of the column, so no gap adds leftover). These are the cells the findings
 * cluster, so the counts here and the findings agree. The gouge depth is the larger of the
 * vertical depth below the model and the longest gouge range of the column, as in the findings.
 */
export class DeviationTracker {
  private readonly ny: number
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
    private readonly stockBottom: number,
    machined: Float32Array,
    private readonly stockTop: number,
    private readonly gaps: ColumnGaps | null = null,
  ) {
    this.ny = machined.length / nx
    this.gougeDepth = new Float32Array(machined.length)
    this.leftoverHeight = new Float32Array(machined.length)
    for (const top of model.top) if (!Number.isNaN(top)) this.footprint++
    this.update(machined, { minI: 0, maxI: nx - 1, minJ: 0, maxJ: this.ny - 1 })
  }

  update(machined: Float32Array, changed: ChangedCells): void {
    const i0 = Math.max(changed.minI, 0)
    const i1 = Math.min(changed.maxI, this.nx - 1)
    const j0 = Math.max(changed.minJ, 0)
    const j1 = Math.min(changed.maxJ, this.ny - 1)
    let rescanGouge = false
    let rescanLeftover = false
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const c = j * this.nx + i
        const d = cellDeviation(machined[c], this.model.top[c], this.model.throughFloor[c], this.stockBottom)
        const g = this.gaps && this.gaps.gapCount(c) > 0 ? this.gaps.gapView(c) : null
        const range = columnGouge(machined[c], g, this.limits.gougeBelow[c], this.stockBottom, this.stockTop)
        const gouge = range > 0 ? Math.max(-d, range) : 0
        const left = machined[c] > this.limits.leftoverAbove[c] ? d : 0
        const oldGouge = this.gougeDepth[c]
        const oldLeft = this.leftoverHeight[c]
        this.gougeCells += (gouge > 0 ? 1 : 0) - (oldGouge > 0 ? 1 : 0)
        this.leftoverCells += (left > 0 ? 1 : 0) - (oldLeft > 0 ? 1 : 0)
        this.gougeDepth[c] = gouge
        this.leftoverHeight[c] = left
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
