// Deviation of the machined stock from the STEP model, per cell of the simulation grid.
//
// Sign convention: deviation = machined height - model height (vertical, in mm).
//  - Below zero: cut deeper than the model.
//  - Above zero: material left above the model.
// Cells outside every part outline have no deviation. A through-hole cell (inside the outline, no
// material in the model) should be cut down to the stock bottom: its deviation is the material left
// above the stock bottom, and a cut below the stock bottom is not a gouge of the part.
//
// Gouge and leftover are decided by distance, not by the vertical deviation alone. At a vertical
// wall a lateral offset far smaller than the tolerance changes a cell's height by the whole wall
// height, so a vertical test would flag every wall. Instead the tolerance is a zone around the model
// surface: the Minkowski sum of the surface with a ball of the tolerance radius (the profile
// tolerance zone of ISO 1101). On the height field this is grey-scale erosion (gouge side) and
// dilation (leftover side) of the model heights with a ball structuring element:
//   gouge limit(c)    = min over cells q within tol in XY of model(q) - sqrt(tol^2 - r^2)
//   leftover limit(c) = max over cells q within tol in XY of model(q) + sqrt(tol^2 - r^2)
// where cells without material count as -infinity for the gouge limit and as the stock bottom for
// the leftover limit. A cell is a gouge when the machined height is below its gouge limit, and
// leftover when above its leftover limit. The zone is sampled at cell centres, so a tolerance below
// the cell size reduces to the vertical test at the cell itself.
import type { GridGeometry } from './heightGrid'
import { MODEL_THROUGH, rasterizePart, type PartModelGrid } from './modelGrid'
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

/** Vertical deviation of one cell in mm, or null outside every part outline. */
export function cellDeviation(machined: number, model: number, stockBottom: number): number | null {
  if (Number.isNaN(model)) return null
  if (model === MODEL_THROUGH) return Math.max(0, machined - stockBottom)
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
export function footprintBounds(g: GridGeometry, model: Float32Array): CellBounds | null {
  let i0 = g.nx
  let j0 = g.ny
  let i1 = -1
  let j1 = -1
  for (let j = 0; j < g.ny; j++) {
    for (let i = 0; i < g.nx; i++) {
      if (Number.isNaN(model[j * g.nx + i])) continue
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

/** Cells within `radius` of a cell centre in XY, with the ball's height sqrt(radius^2 - r^2) there. */
interface Ball {
  di: Int32Array
  dj: Int32Array
  dz: Float64Array
}

function ball(cellSize: number, radius: number): Ball {
  const reach = Math.floor(radius / cellSize + 1e-9)
  const di: number[] = []
  const dj: number[] = []
  const dz: number[] = []
  for (let j = -reach; j <= reach; j++) {
    for (let i = -reach; i <= reach; i++) {
      const r = cellSize * Math.sqrt(i * i + j * j)
      // The 1e-9 only absorbs floating-point rounding when r equals the radius.
      if (r > radius + 1e-9) continue
      di.push(i)
      dj.push(j)
      dz.push(Math.sqrt(Math.max(0, radius * radius - r * r)))
    }
  }
  return { di: Int32Array.from(di), dj: Int32Array.from(dj), dz: Float64Array.from(dz) }
}

/** Gouge and leftover limits per cell for the model grid and tolerances. */
export function toleranceLimits(
  g: GridGeometry,
  model: Float32Array,
  stockBottom: number,
  tol: Tolerances,
  bounds: CellBounds | null = footprintBounds(g, model),
): ToleranceLimits {
  const { nx, ny } = g
  const gougeBelow = new Float32Array(nx * ny).fill(Number.NaN)
  const leftoverAbove = new Float32Array(nx * ny).fill(Number.NaN)
  if (!bounds) return { gougeBelow, leftoverAbove }
  const gb = ball(g.cellSize, tol.gouge)
  const lb = ball(g.cellSize, tol.leftover)
  // Material top per cell: no material (through-hole or outside) is -infinity for the gouge limit
  // and the stock bottom for the leftover limit.
  const solid = (m: number) => !Number.isNaN(m) && m !== MODEL_THROUGH
  for (let j = bounds.j0; j <= bounds.j1; j++) {
    for (let i = bounds.i0; i <= bounds.i1; i++) {
      const c = j * nx + i
      if (Number.isNaN(model[c])) continue
      let lo = Infinity
      for (let k = 0; k < gb.di.length; k++) {
        const qi = i + gb.di[k]
        const qj = j + gb.dj[k]
        if (qi < 0 || qj < 0 || qi >= nx || qj >= ny) continue
        const m = model[qj * nx + qi]
        if (!solid(m)) {
          lo = -Infinity
          break
        }
        const v = m - gb.dz[k]
        if (v < lo) lo = v
      }
      let hi = -Infinity
      for (let k = 0; k < lb.di.length; k++) {
        const qi = i + lb.di[k]
        const qj = j + lb.dj[k]
        if (qi < 0 || qj < 0 || qi >= nx || qj >= ny) continue
        const m = model[qj * nx + qi]
        const v = (solid(m) ? m : stockBottom) + lb.dz[k]
        if (v > hi) hi = v
      }
      gougeBelow[c] = lo
      leftoverAbove[c] = hi
    }
  }
  return { gougeBelow, leftoverAbove }
}

/**
 * True when a tolerance is below the cell size. The zone then holds only the cell itself, so a wall
 * that is off by less than one cell can still show as a gouge or leftover along its length.
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

/** Summary over the cells of `bounds`. */
export function summarizeDeviation(
  nx: number,
  machined: Float32Array,
  model: Float32Array,
  limits: ToleranceLimits,
  stockBottom: number,
  bounds: CellBounds | null,
): DeviationSummary {
  const s: DeviationSummary = { footprintCells: 0, gougeCells: 0, leftoverCells: 0, maxGougeDepth: 0, maxLeftover: 0 }
  if (!bounds) return s
  for (let j = bounds.j0; j <= bounds.j1; j++) {
    for (let i = bounds.i0; i <= bounds.i1; i++) {
      const c = j * nx + i
      const d = cellDeviation(machined[c], model[c], stockBottom)
      if (d === null) continue
      s.footprintCells++
      if (machined[c] < limits.gougeBelow[c]) {
        s.gougeCells++
        if (-d > s.maxGougeDepth) s.maxGougeDepth = -d
      }
      if (machined[c] > limits.leftoverAbove[c]) {
        s.leftoverCells++
        if (d > s.maxLeftover) s.maxLeftover = d
      }
    }
  }
  return s
}

/** Mean |deviation| of one part's model grid against the machined grid, and its footprint size. */
function partScore(g: GridGeometry, machined: Float32Array, stockBottom: number, p: PartModelGrid) {
  let n = 0
  let sum = 0
  for (let j = 0; j < p.h; j++) {
    for (let i = 0; i < p.w; i++) {
      const d = cellDeviation(machined[(p.j0 + j) * g.nx + p.i0 + i], p.top[j * p.w + i], stockBottom)
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
  stockBottom: number,
  mesh: TriangleMesh,
  at: Pick<PartPlacement, 'centerX' | 'centerY' | 'bottomZ'>,
): OrientationCandidate[] {
  const out: OrientationCandidate[] = []
  for (const upAxis of UP_AXES) {
    for (const quarterTurns of QUARTER_TURNS) {
      const positions = placePositions(mesh, { ...at, upAxis, quarterTurns })
      const s = partScore(g, machined, stockBottom, rasterizePart(g, positions, mesh.indices))
      out.push({ upAxis, quarterTurns, ...s })
    }
  }
  return out.sort((a, b) => a.meanAbsDeviation - b.meanAbsDeviation)
}
