// Model dexels: the placed STEP part as material intervals along Z per grid column, so undercuts
// in the model (threads, T-slots, dovetails) compare with the dexel stock column for column.
//
// Method: scanline triangle scan conversion collecting every crossing. The vertical line through
// each cell centre crosses the closed surface an even number of times; the crossing Zs, sorted and
// paired (even-odd rule), are the material intervals. Each triangle not seen edge-on from above is
// tested against the cell centres in its XY bounds with edge functions. A centre exactly on an edge
// belongs to the triangle only on its top or left edges (the top-left fill rule of rasterisers), so
// a centre on an edge shared by two triangles of one surface is counted once, never twice or not at
// all. Triangles facing down are tested with their vertices swapped, so every triangle is tested
// counter-clockwise in XY. Vertical faces project to zero area and add no crossings; the faces
// above and below them supply the interval ends.
//
// A column with an odd number of crossings means the mesh is not closed there (a gap or a
// duplicated face). It is reported, never patched: the column's crossings are dropped and the
// count of such columns is returned.
//
// Storage is compressed rows: per column of the part's cell rectangle an offset into one Float32
// array of interval ends, built in two passes (count, then fill).
import type { GridGeometry } from './heightGrid'

export interface PartModelDexels {
  i0: number
  j0: number
  w: number
  h: number
  /** Per column of the rectangle (row by row) the start of its ends in `z`; length w * h + 1. */
  offsets: Int32Array
  /** Interval ends, sorted per column: (lo, hi) pairs of material. */
  z: Float32Array
  /** Columns whose crossing count was odd (mesh not closed there); their crossings are dropped. */
  oddColumns: number
}

/** Calls visit(columnIndex, z) for every crossing of a cell-centre line with a triangle. */
function scanCrossings(
  g: GridGeometry,
  positions: Float32Array,
  indices: Uint32Array,
  i0: number,
  j0: number,
  i1: number,
  j1: number,
  w: number,
  visit: (c: number, z: number) => void,
): void {
  const cs = g.cellSize
  for (let t = 0; t < indices.length; t += 3) {
    let a = indices[t] * 3
    let b = indices[t + 1] * 3
    const c3 = indices[t + 2] * 3
    let ax = positions[a]
    let ay = positions[a + 1]
    let bx = positions[b]
    let by = positions[b + 1]
    const cx = positions[c3]
    const cy = positions[c3 + 1]
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
    if (area === 0) continue
    if (area < 0) {
      // Test clockwise triangles with two vertices swapped, so all are counter-clockwise.
      ;[a, b] = [b, a]
      ;[ax, bx] = [bx, ax]
      ;[ay, by] = [by, ay]
    }
    const az = positions[a + 2]
    const bz = positions[b + 2]
    const cz = positions[c3 + 2]
    const A = Math.abs(area)
    const ia = Math.max(i0, Math.ceil((Math.min(ax, bx, cx) - g.originX) / cs - 0.5))
    const ib = Math.min(i1, Math.floor((Math.max(ax, bx, cx) - g.originX) / cs - 0.5))
    const ja = Math.max(j0, Math.ceil((Math.min(ay, by, cy) - g.originY) / cs - 0.5))
    const jb = Math.min(j1, Math.floor((Math.max(ay, by, cy) - g.originY) / cs - 0.5))
    // Top-left rule for counter-clockwise triangles with Y up: an edge going down (dy < 0), or
    // horizontal and going left (dy = 0, dx < 0), owns the centres lying on it.
    const own0 = by - ay < 0 || (by === ay && bx - ax < 0)
    const own1 = cy - by < 0 || (cy === by && cx - bx < 0)
    const own2 = ay - cy < 0 || (ay === cy && ax - cx < 0)
    for (let j = ja; j <= jb; j++) {
      const py = g.originY + (j + 0.5) * cs
      for (let i = ia; i <= ib; i++) {
        const px = g.originX + (i + 0.5) * cs
        // Edge functions: twice the signed area of (edge start, edge end, p).
        const e0 = (bx - ax) * (py - ay) - (by - ay) * (px - ax)
        const e1 = (cx - bx) * (py - by) - (cy - by) * (px - bx)
        const e2 = (ax - cx) * (py - cy) - (ay - cy) * (px - cx)
        if (e0 < 0 || e1 < 0 || e2 < 0) continue
        if ((e0 === 0 && !own0) || (e1 === 0 && !own1) || (e2 === 0 && !own2)) continue
        // Barycentric weights: e1 belongs to vertex a, e2 to b, e0 to c.
        const z = (e1 * az + e2 * bz + e0 * cz) / A
        visit((j - j0) * w + (i - i0), z)
      }
    }
  }
}

/** Material intervals per column of one placed part (work coordinates). */
export function rasterizePartDexels(g: GridGeometry, positions: Float32Array, indices: Uint32Array): PartModelDexels {
  const cs = g.cellSize
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let k = 0; k < positions.length; k += 3) {
    if (positions[k] < minX) minX = positions[k]
    if (positions[k] > maxX) maxX = positions[k]
    if (positions[k + 1] < minY) minY = positions[k + 1]
    if (positions[k + 1] > maxY) maxY = positions[k + 1]
  }
  const i0 = Math.max(0, Math.floor((minX - g.originX) / cs))
  const j0 = Math.max(0, Math.floor((minY - g.originY) / cs))
  const i1 = Math.min(g.nx - 1, Math.floor((maxX - g.originX) / cs))
  const j1 = Math.min(g.ny - 1, Math.floor((maxY - g.originY) / cs))
  const w = Math.max(0, i1 - i0 + 1)
  const h = Math.max(0, j1 - j0 + 1)
  const counts = new Int32Array(w * h)
  if (w > 0 && h > 0) scanCrossings(g, positions, indices, i0, j0, i1, j1, w, (c) => counts[c]++)
  const offsets = new Int32Array(w * h + 1)
  for (let c = 0; c < w * h; c++) offsets[c + 1] = offsets[c] + counts[c]
  const raw = new Float64Array(offsets[w * h])
  const fill = offsets.slice(0, w * h)
  if (w > 0 && h > 0) scanCrossings(g, positions, indices, i0, j0, i1, j1, w, (c, z) => (raw[fill[c]++] = z))
  // Sort each column, drop odd columns, and compact.
  let oddColumns = 0
  const out = new Float32Array(raw.length)
  const compact = new Int32Array(w * h + 1)
  let write = 0
  for (let c = 0; c < w * h; c++) {
    compact[c] = write
    const n = offsets[c + 1] - offsets[c]
    if (n % 2 === 1) {
      oddColumns++
      continue
    }
    const col = raw.subarray(offsets[c], offsets[c + 1]).sort()
    for (let k = 0; k < n; k++) out[write++] = col[k]
  }
  compact[w * h] = write
  return { i0, j0, w, h, offsets: compact, z: out.slice(0, write), oddColumns }
}
