// Deviation of the dexel stock from the model as Z intervals per column, so undercuts (thread
// grooves, T-slots) are compared, not only the top heights.
//
// Expected solid E per column: the material intervals of the parts' model dexels (without them,
// everything below the model top), together with everything below the part bottom inside a part
// outline, below the through-hole's part bottom in a through-hole, and below the stock bottom
// outside every outline (the classification comes from
// the model grid, the same one the height comparison uses). The tolerance zone is the one of
// deviation.ts in three dimensions (ISO 1101 profile zone, a ball of radius tol):
//   gouge    = (E eroded by the ball of the gouge tolerance) minus S, inside the stock
//   leftover = S minus (E dilated by the ball of the leftover tolerance)
// with S the stock material. The ball's slice at the horizontal distance r is a Z segment of half
// height sqrt(tol^2 - r^2), so erosion is the intersection over the cells of the disc of each
// column's intervals shrunk by that cap, and dilation the union of them grown by it. The disc clips
// at the grid edge as in deviation.ts. Where every column of the disc is one half-line (everything
// below a height), this is exactly the height comparison's gouge and leftover limits, so those
// columns take the limits of deviation.ts directly: one rule, computed once.
import { discCells, type DiscCell, type ToleranceLimits } from './deviation'
import type { DexelStock } from './dexelStock'
import type { GridGeometry } from './heightGrid'
import type { PartModelDexels } from './modelDexels'
import { MODEL_THROUGH, type ModelGrid } from './modelGrid'

/** Sorted, disjoint closed intervals per grid column: column c holds z[offsets[c] .. offsets[c + 1]) as pairs. */
export interface IntervalSets {
  offsets: Int32Array
  z: Float32Array
}

type Spans = number[]

const column = (s: IntervalSets, c: number): Spans => Array.from(s.z.subarray(s.offsets[c], s.offsets[c + 1]))

/** Union of sorted interval sets; touching intervals merge. */
function union(a: Spans, b: Spans): Spans {
  const all: [number, number][] = []
  for (let k = 0; k < a.length; k += 2) all.push([a[k], a[k + 1]])
  for (let k = 0; k < b.length; k += 2) all.push([b[k], b[k + 1]])
  all.sort((p, q) => p[0] - q[0])
  const out: Spans = []
  for (const [lo, hi] of all) {
    if (out.length > 0 && lo <= out[out.length - 1]) out[out.length - 1] = Math.max(out[out.length - 1], hi)
    else out.push(lo, hi)
  }
  return out
}

function intersect(a: Spans, b: Spans): Spans {
  const out: Spans = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    const lo = Math.max(a[i], b[j])
    const hi = Math.min(a[i + 1], b[j + 1])
    if (lo <= hi) out.push(lo, hi)
    if (a[i + 1] < b[j + 1]) i += 2
    else j += 2
  }
  return out
}

/** a minus b (the boundary of b stays with a, so touching sets subtract to nothing extra). */
function subtract(a: Spans, b: Spans): Spans {
  const out: Spans = []
  for (let k = 0; k < a.length; k += 2) {
    let lo = a[k]
    const hi = a[k + 1]
    for (let m = 0; m < b.length && lo < hi; m += 2) {
      if (b[m + 1] <= lo) continue
      if (b[m] >= hi) break
      if (b[m] > lo) out.push(lo, b[m])
      lo = Math.max(lo, b[m + 1])
    }
    if (lo < hi) out.push(lo, hi)
  }
  return out
}

/** Each interval shrunk (t > 0) or grown (t < 0) by |t| at both ends; infinite ends stay. */
function offset(a: Spans, t: number): Spans {
  const out: Spans = []
  for (let k = 0; k < a.length; k += 2) {
    const lo = a[k] + t
    const hi = a[k + 1] - t
    if (lo > hi) continue
    if (out.length > 0 && lo <= out[out.length - 1]) out[out.length - 1] = Math.max(out[out.length - 1], hi)
    else out.push(lo, hi)
  }
  return out
}

/** Expected solid E per grid column (see the header). */
export function expectedSolid(g: GridGeometry, model: ModelGrid, parts: PartModelDexels[], stockBottom: number): IntervalSets {
  const extra = new Map<number, Spans>()
  for (const p of parts) {
    for (let j = 0; j < p.h; j++) {
      for (let i = 0; i < p.w; i++) {
        const k = j * p.w + i
        if (p.offsets[k + 1] === p.offsets[k]) continue
        const c = (p.j0 + j) * g.nx + p.i0 + i
        const own = Array.from(p.z.subarray(p.offsets[k], p.offsets[k + 1]))
        extra.set(c, union(extra.get(c) ?? [], own))
      }
    }
  }
  const out = new SetsBuilder(g.nx * g.ny)
  for (let c = 0; c < g.nx * g.ny; c++) {
    const top = model.top[c]
    const floor = Number.isNaN(top) ? stockBottom : top === MODEL_THROUGH ? model.throughFloor[c] : model.partBottom[c]
    const own = extra.get(c)
    if (own) out.pushAll(union([-Infinity, floor], own))
    // A solid cell without model dexels (none given, or none on this centre): the height model's
    // own statement, material up to its top.
    else out.push(-Infinity, Number.isNaN(top) || top === MODEL_THROUGH ? floor : top)
    out.end(c)
  }
  return out.result()
}

/**
 * Column sets of the expected solid. Most columns are one half-line (-Infinity, f]: those keep only f
 * in `half`. Other columns (NaN in `half`) keep their spans.
 */
interface Columns {
  half: Float32Array
  spans: Map<number, Spans>
}

function toColumns(s: IntervalSets): Columns {
  const count = s.offsets.length - 1
  const half = new Float32Array(count)
  const spans = new Map<number, Spans>()
  for (let c = 0; c < count; c++) {
    const o = s.offsets[c]
    if (s.offsets[c + 1] - o === 2 && s.z[o] === -Infinity) half[c] = s.z[o + 1]
    else {
      half[c] = NaN
      spans.set(c, column(s, c))
    }
  }
  return { half, spans }
}

const spansOf = (s: Columns, c: number): Spans => (Number.isNaN(s.half[c]) ? s.spans.get(c)! : [-Infinity, s.half[c]])

/** Per cell 1 where the disc around it holds a column that is not one half-line. */
function generalColumns(g: GridGeometry, s: Columns, disc: DiscCell[]): Uint8Array {
  const out = new Uint8Array(g.nx * g.ny)
  for (const c of s.spans.keys()) {
    const i = c % g.nx
    const j = (c - i) / g.nx
    for (const d of disc) {
      const qi = i + d.di
      const qj = j + d.dj
      if (qi >= 0 && qj >= 0 && qi < g.nx && qj < g.ny) out[qj * g.nx + qi] = 1
    }
  }
  return out
}

/** Erosion (intersection of the columns shrunk by their caps) or dilation (union grown) at cell c. */
function ballCombine(g: GridGeometry, s: Columns, c: number, disc: DiscCell[], erode: boolean): Spans {
  const i = c % g.nx
  const j = (c - i) / g.nx
  let acc: Spans | null = null
  for (const d of disc) {
    const qi = i + d.di
    const qj = j + d.dj
    if (qi < 0 || qj < 0 || qi >= g.nx || qj >= g.ny) continue
    const own = offset(spansOf(s, qj * g.nx + qi), erode ? d.cap : -d.cap)
    acc = acc === null ? own : erode ? intersect(acc, own) : union(acc, own)
  }
  return acc ?? []
}

export interface IntervalDeviation {
  /** Per column: Z ranges where the model needs material inside its gouge tolerance and the stock has none. */
  gouge: IntervalSets
  /** Per column: Z ranges of stock material outside the model's leftover tolerance zone. */
  leftover: IntervalSets
}

/** Builds interval sets column by column, in order. */
class SetsBuilder {
  readonly offsets: Int32Array
  private z = new Float32Array(1024)
  private used = 0
  constructor(count: number) {
    this.offsets = new Int32Array(count + 1)
  }
  push(lo: number, hi: number): void {
    if (this.used + 2 > this.z.length) {
      const next = new Float32Array(this.z.length * 2)
      next.set(this.z)
      this.z = next
    }
    this.z[this.used++] = lo
    this.z[this.used++] = hi
  }
  pushAll(s: Spans): void {
    for (let k = 0; k < s.length; k += 2) this.push(s[k], s[k + 1])
  }
  /** Closes column c (call for every column in order). */
  end(c: number): void {
    this.offsets[c + 1] = this.used
  }
  result(): IntervalSets {
    return { offsets: this.offsets, z: this.z.slice(0, this.used) }
  }
}

/**
 * Gouge and leftover intervals of the stock against the expected solid, with `limits` the height
 * comparison's limits of the same model and tolerances (see the header).
 */
export function intervalDeviation(
  stock: DexelStock,
  expected: IntervalSets,
  tol: { gouge: number; leftover: number },
  limits: ToleranceLimits,
): IntervalDeviation {
  const e = toColumns(expected)
  const gougeDisc = discCells(stock.cellSize, tol.gouge)
  const leftoverDisc = discCells(stock.cellSize, tol.leftover)
  const gougeGeneral = generalColumns(stock, e, gougeDisc)
  const leftoverGeneral = generalColumns(stock, e, leftoverDisc)
  const count = stock.nx * stock.ny
  const { bottom, top } = stock
  const stockBox: Spans = [bottom, top]
  const gouge = new SetsBuilder(count)
  const leftover = new SetsBuilder(count)
  for (let c = 0; c < count; c++) {
    const h = stock.heights[c]
    const gaps = stock.dexels.gapCount(c) > 0
    const material: Spans | null = gaps ? (h > bottom ? subtract([bottom, h], Array.from(stock.dexels.gapView(c))) : []) : null
    if (material === null && !gougeGeneral[c]) {
      // One half-line against a column without gaps: the height comparison's rule.
      const lo = h > bottom ? h : bottom
      const hi = Math.min(limits.gougeBelow[c], top)
      if (hi > lo) gouge.push(lo, hi)
    } else {
      const eroded = gougeGeneral[c] ? ballCombine(stock, e, c, gougeDisc, true) : [-Infinity, limits.gougeBelow[c]]
      gouge.pushAll(subtract(intersect(eroded, stockBox), material ?? (h > bottom ? [bottom, h] : [])))
    }
    gouge.end(c)
    if (material === null && !leftoverGeneral[c]) {
      const lo = Math.max(bottom, limits.leftoverAbove[c])
      if (h > lo) leftover.push(lo, h)
    } else {
      const dilated = leftoverGeneral[c] ? ballCombine(stock, e, c, leftoverDisc, false) : [-Infinity, limits.leftoverAbove[c]]
      leftover.pushAll(subtract(material ?? (h > bottom ? [bottom, h] : []), dilated))
    }
    leftover.end(c)
  }
  return { gouge: gouge.result(), leftover: leftover.result() }
}
