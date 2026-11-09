// Deviation of the dexel stock from the model as Z intervals per column, so undercuts (thread
// grooves, T-slots) are compared, not only the top heights.
//
// Expected solid E per column: the material intervals of the parts' model dexels, together with
// everything below the part bottom inside a part outline, below the through-hole's part bottom in
// a through-hole, and below the stock bottom outside every outline (the classification comes from
// the model grid, the same one the height comparison uses). The tolerance zone is the one of
// deviation.ts in three dimensions (ISO 1101 zone in the L-infinity norm, a cube of half-size tol):
//   gouge    = (E eroded by the cube of the gouge tolerance) minus S, inside the stock
//   leftover = S minus (E dilated by the cube of the leftover tolerance)
// with S the stock material. A cube is the product of the XY square and a Z segment, so erosion is
// the intersection of the interval sets over the square window (separable: along rows, then along
// columns), then each interval shrunk by tol in Z; dilation is the union, then grown by tol. The
// window clips at the grid edge as in deviation.ts. For a column with one interval this gives the
// height comparison's limits exactly: gouge below (window minimum of the model top) - tol, leftover
// above (window maximum of the base) + tol.
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

function build(count: number, get: (c: number) => Spans): IntervalSets {
  const offsets = new Int32Array(count + 1)
  const parts: Spans[] = new Array(count)
  let total = 0
  for (let c = 0; c < count; c++) {
    parts[c] = get(c)
    offsets[c] = total
    total += parts[c].length
  }
  offsets[count] = total
  const z = new Float32Array(total)
  for (let c = 0; c < count; c++) z.set(parts[c], offsets[c])
  return { offsets, z }
}

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
  return build(g.nx * g.ny, (c) => {
    const top = model.top[c]
    const floor = Number.isNaN(top) ? stockBottom : top === MODEL_THROUGH ? model.throughFloor[c] : model.partBottom[c]
    const base: Spans = [-Infinity, floor]
    const own = extra.get(c)
    return own ? union(base, own) : base
  })
}

/** Intersection (erode) or union (dilate) over the square window of half-size n cells, separably. */
function windowCombine(g: GridGeometry, s: IntervalSets, n: number, erode: boolean): IntervalSets {
  const combine = erode ? intersect : union
  const pass = (src: IntervalSets, alongX: boolean) =>
    build(g.nx * g.ny, (c) => {
      const j = Math.floor(c / g.nx)
      const i = c - j * g.nx
      let acc = column(src, c)
      for (let d = -n; d <= n; d++) {
        if (d === 0) continue
        const qi = alongX ? i + d : i
        const qj = alongX ? j : j + d
        if (qi < 0 || qj < 0 || qi >= g.nx || qj >= g.ny) continue
        acc = combine(acc, column(src, qj * g.nx + qi))
      }
      return acc
    })
  return n === 0 ? s : pass(pass(s, true), false)
}

/** Window half-size in cells for a tolerance, as in deviation.ts. */
const windowCells = (cellSize: number, tol: number) => Math.floor(tol / cellSize + 1e-9)

export interface IntervalDeviation {
  /** Per column: Z ranges where the model needs material inside its gouge tolerance and the stock has none. */
  gouge: IntervalSets
  /** Per column: Z ranges of stock material outside the model's leftover tolerance zone. */
  leftover: IntervalSets
}

/** Gouge and leftover intervals of the stock against the expected solid. */
export function intervalDeviation(stock: DexelStock, expected: IntervalSets, tol: { gouge: number; leftover: number }): IntervalDeviation {
  const eroded = windowCombine(stock, expected, windowCells(stock.cellSize, tol.gouge), true)
  const dilated = windowCombine(stock, expected, windowCells(stock.cellSize, tol.leftover), false)
  const count = stock.nx * stock.ny
  const material = (c: number): Spans => {
    const h = stock.heights[c]
    if (!(h > stock.bottom)) return []
    return subtract([stock.bottom, h], Array.from(stock.dexels.gapView(c)))
  }
  const stockBox: Spans = [stock.bottom, stock.top]
  return {
    gouge: build(count, (c) => subtract(intersect(offset(column(eroded, c), tol.gouge), stockBox), material(c))),
    leftover: build(count, (c) => subtract(material(c), offset(column(dilated, c), -tol.leftover))),
  }
}
