// Per-cell data the 3D view needs from the comparison, beyond the gouge and leftover limits.
//
// Cell class (one byte per cell):
//  - bits 0 and 1, the class of the stock's bottom face under the cell. Under a part: on the stock
//    bottom when the part's bottom is no more than the leftover tolerance above the stock bottom,
//    raised when it is higher (material is left under the part). Outside every part: the bottom face
//    takes the class of the cell's top, which the view decides from the shown height. A bottom face
//    is never a gouge in 3-axis milling: the tool cannot reach it.
//  - bit 2: the cell belongs to a thread finding.
//  - bits 3 and 4: the column holds a gouge or a leftover interval anywhere along Z (interval
//    deviation); the undercut faces take their colour from these.
//
// Missing material: the material the model needs but the G-code cut away, in every cell below the
// gouge limit (gouges and threads): from the machined height up to the model surface. Such a cell
// always lies on model material (a cell next to a hole or outside the parts has no gouge limit).
import type { ToleranceLimits } from './deviation'
import type { IntervalDeviation } from './intervalDeviation'
import type { ModelGrid } from './modelGrid'

export const BottomClass = { Outside: 0, OnStockBottom: 1, Raised: 2 } as const
export const BOTTOM_CLASS_MASK = 3
export const THREAD_BIT = 4
export const GOUGE_INTERVAL_BIT = 8
export const LEFTOVER_INTERVAL_BIT = 16

export function cellClasses(
  model: ModelGrid,
  threadMask: Uint8Array,
  stockBottom: number,
  leftoverTolerance: number,
  deviation: IntervalDeviation | null = null,
): Uint8Array {
  const out = new Uint8Array(model.top.length)
  for (let c = 0; c < out.length; c++) {
    const pb = model.partBottom[c]
    let v: number = BottomClass.Outside
    if (!Number.isNaN(pb)) v = pb - stockBottom <= leftoverTolerance ? BottomClass.OnStockBottom : BottomClass.Raised
    if (threadMask[c]) v |= THREAD_BIT
    if (deviation && deviation.gouge.offsets[c + 1] > deviation.gouge.offsets[c]) v |= GOUGE_INTERVAL_BIT
    if (deviation && deviation.leftover.offsets[c + 1] > deviation.leftover.offsets[c]) v |= LEFTOVER_INTERVAL_BIT
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
