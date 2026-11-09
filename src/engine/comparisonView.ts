// Per-cell data the 3D view needs from the comparison, beyond the gouge and leftover limits.
//
// Cell class (one byte per cell):
//  - bits 0 and 1, the class of the stock's bottom face under the cell. Under part material: on the
//    stock bottom when the part's bottom is no more than the leftover tolerance above the stock
//    bottom, raised when it is higher (material is left under the part). Outside every part and in a
//    part's through-holes, where the model has no material: the bottom face takes the class of the
//    cell's own column, leftover when its top lies above the leftover limit (material left in a hole
//    that was not cut through shows from below as well), which the view decides from the shown
//    height. A bottom face is never a gouge in 3-axis milling: the tool cannot reach it.
//  - bit 2: the cell belongs to a thread finding.
//
// Surface colours: every drawn point of the stock (top surface, walls, side walls, undercut faces)
// is classified by its own position against the tolerance zone, with the same limits that decide the
// gouge and leftover cells (deviation.ts). A surface point is where stock material meets air. It is a
// gouge when the air at its height lies below the gouge limit of the air's column (the model needs
// material there), purple when that column belongs to a thread finding; otherwise leftover when the
// material at its height lies above the leftover limit of the material's column; otherwise within
// tolerance. On a top face material and air are the same column, so the colour is exactly the cell's
// class. On a wall the material is the higher column and the air the lower one, so a wall cut too
// far into the model is a gouge over its full height, and a wall standing farther out than the
// leftover tolerance is leftover over its full height, down to the tolerance above the floor it must
// reach. Of the up to 2 x 2 columns around a point, the point's own cell decides when it has
// material (or air) at the point's height, else the nearest of the others that has.
//
// Missing material: the material the model needs but the G-code cut away, in every cell below the
// gouge limit (gouges and threads): from the machined height up to the model surface. Such a cell
// always lies on model material (a cell next to a hole or outside the parts has no gouge limit).
import type { ColumnGaps, ToleranceLimits } from './deviation'
import { MODEL_THROUGH, type ModelGrid } from './modelGrid'

export const BottomClass = { Outside: 0, OnStockBottom: 1, Raised: 2 } as const
export const BOTTOM_CLASS_MASK = 3
export const THREAD_BIT = 4

export function cellClasses(model: ModelGrid, threadMask: Uint8Array, stockBottom: number, leftoverTolerance: number): Uint8Array {
  const out = new Uint8Array(model.top.length)
  for (let c = 0; c < out.length; c++) {
    const pb = model.partBottom[c]
    let v: number = BottomClass.Outside
    if (!Number.isNaN(pb) && model.top[c] !== MODEL_THROUGH) v = pb - stockBottom <= leftoverTolerance ? BottomClass.OnStockBottom : BottomClass.Raised
    if (threadMask[c]) v |= THREAD_BIT
    out[c] = v
  }
  return out
}

export interface MissingMaterial {
  /** Grid index of each cell with missing material. */
  cells: Int32Array
  /** Machined height (bottom of the missing material) and model surface (top) per listed cell. */
  bottom: Float32Array
  top: Float32Array
  /** 1 where the cell belongs to a thread finding. */
  thread: Uint8Array
}

export function missingMaterial(heights: Float32Array, model: ModelGrid, limits: ToleranceLimits, threadMask: Uint8Array): MissingMaterial {
  let n = 0
  for (let c = 0; c < heights.length; c++) if (heights[c] < limits.gougeBelow[c]) n++
  const out: MissingMaterial = {
    cells: new Int32Array(n),
    bottom: new Float32Array(n),
    top: new Float32Array(n),
    thread: new Uint8Array(n),
  }
  let k = 0
  for (let c = 0; c < heights.length; c++) {
    if (!(heights[c] < limits.gougeBelow[c])) continue
    out.cells[k] = c
    out.bottom[k] = heights[c]
    out.top[k] = model.top[c]
    out.thread[k] = threadMask[c]
    k++
  }
  return out
}

export const SurfaceClass = { Within: 0, Gouge: 1, Thread: 2, Leftover: 3 } as const
export type SurfaceClassValue = (typeof SurfaceClass)[keyof typeof SurfaceClass]

/**
 * Class of a surface point at height z (see the header): `airGougeBelow` and `airThread` belong to
 * the column holding the air at z, `materialLeftoverAbove` to the column holding the material.
 */
export function pointClass(z: number, airGougeBelow: number, airThread: boolean, materialLeftoverAbove: number): SurfaceClassValue {
  if (z < airGougeBelow) return airThread ? SurfaceClass.Thread : SurfaceClass.Gouge
  return z > materialLeftoverAbove ? SurfaceClass.Leftover : SurfaceClass.Within
}

/**
 * Allowance for float32 rounding of a height interpolated across a face (about 1e-5 mm at 100 mm),
 * when deciding whether a column holds material or air at that height. Far below any tolerance.
 */
export const HEIGHT_ROUNDING_MM = 1e-4

export interface SurfaceGrid {
  nx: number
  ny: number
  cellSize: number
  originX: number
  originY: number
}

/**
 * Class of the surface point (x, y, z) of the drawn stock: the rule the stock surface shader applies
 * per fragment (stockSurface.ts mirrors it in GLSL).
 */
export function surfaceClassAt(
  g: SurfaceGrid,
  heights: Float32Array,
  gaps: ColumnGaps | null,
  limits: ToleranceLimits,
  classes: Uint8Array,
  x: number,
  y: number,
  z: number,
): SurfaceClassValue {
  const fx = (x - g.originX) / g.cellSize
  const fy = (y - g.originY) / g.cellSize
  const clampI = (i: number) => Math.min(Math.max(i, 0), g.nx - 1)
  const clampJ = (j: number) => Math.min(Math.max(j, 0), g.ny - 1)
  const inGap = (c: number) => {
    if (!gaps || gaps.gapCount(c) === 0) return false
    const v = gaps.gapView(c)
    for (let k = 0; k < v.length; k += 2) if (z > v[k] && z < v[k + 1]) return true
    return false
  }
  const hasMaterial = (c: number) => heights[c] >= z - HEIGHT_ROUNDING_MM && !inGap(c)
  const hasAir = (c: number) => heights[c] <= z + HEIGHT_ROUNDING_MM || inGap(c)
  const own = clampJ(Math.floor(fy)) * g.nx + clampI(Math.floor(fx))
  let material = hasMaterial(own) ? own : -1
  let air = hasAir(own) ? own : -1
  let bestMaterial = Infinity
  let bestAir = Infinity
  let highest = own
  const bi = Math.floor(fx - 0.5)
  const bj = Math.floor(fy - 0.5)
  for (let k = 0; k < 4; k++) {
    const i = clampI(bi + (k & 1))
    const j = clampJ(bj + (k >> 1))
    const c = j * g.nx + i
    const d = (i + 0.5 - fx) ** 2 + (j + 0.5 - fy) ** 2
    if (heights[c] > heights[highest]) highest = c
    if (material !== own && hasMaterial(c) && d < bestMaterial) {
      bestMaterial = d
      material = c
    }
    if (air !== own && hasAir(c) && d < bestAir) {
      bestAir = d
      air = c
    }
  }
  if (material < 0) material = highest
  // No column with air at z: the air lies outside the stock (its side walls), never a gouge.
  const gougeBelow = air < 0 ? -Infinity : limits.gougeBelow[air]
  const thread = air >= 0 && (classes[air] & THREAD_BIT) !== 0
  return pointClass(z, gougeBelow, thread, limits.leftoverAbove[material])
}

/**
 * Class of the stock's bottom face under a cell with class byte `cls`, machined height `h` and
 * leftover limit `leftoverAbove` (see the header; the stock surface shader mirrors it).
 */
export function bottomFaceClass(cls: number, h: number, leftoverAbove: number): SurfaceClassValue {
  const b = cls & BOTTOM_CLASS_MASK
  if (b === BottomClass.OnStockBottom) return SurfaceClass.Within
  if (b === BottomClass.Raised) return SurfaceClass.Leftover
  return h > leftoverAbove ? SurfaceClass.Leftover : SurfaceClass.Within
}
