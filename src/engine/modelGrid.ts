// Model top height grid: the STEP part's upper surface sampled at the simulation grid's cell
// centres, so machined and model heights compare cell for cell.
//
// Method: scanline triangle scan conversion with a max z-buffer (the upper envelope). For every
// triangle not seen edge-on from above, each cell row whose centre line crosses the triangle gets the
// X span of that crossing, and every cell centre in the span takes the triangle's plane height if it
// is higher than what the cell holds. Spans are closed (edges and vertices count), so cell centres on
// a shared edge are never lost between two triangles. Vertical faces project to zero area and add
// nothing; the faces next to them supply the heights.
//
// Cells no triangle covers are either outside the part or inside one of its through-holes. A 4-way
// flood fill (connected-component labelling) from the border of the part's cell rectangle marks the
// outside; uncovered cells it cannot reach are enclosed by the part outline, so they are through-holes.
import type { GridGeometry } from './heightGrid'

/** Model grid value for a cell outside every part outline. */
export const MODEL_OUTSIDE = Number.NaN
/** Model grid value for a cell inside a part outline with no material: should be cut through. */
export const MODEL_THROUGH = Number.NEGATIVE_INFINITY

/** Model heights for one part over its own cell rectangle (one cell margin around the part). */
export interface PartModelGrid {
  i0: number
  j0: number
  w: number
  h: number
  /** Model top Z, MODEL_THROUGH or MODEL_OUTSIDE per cell, row by row. */
  top: Float32Array
}

/** Rasterises one placed part (work coordinates) into model heights on the grid's cells. */
export function rasterizePart(g: GridGeometry, positions: Float32Array, indices: Uint32Array): PartModelGrid {
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
  // One extra cell on each side so the rectangle border lies outside the part.
  const i0 = Math.max(0, Math.floor((minX - g.originX) / cs) - 1)
  const j0 = Math.max(0, Math.floor((minY - g.originY) / cs) - 1)
  const i1 = Math.min(g.nx - 1, Math.floor((maxX - g.originX) / cs) + 1)
  const j1 = Math.min(g.ny - 1, Math.floor((maxY - g.originY) / cs) + 1)
  const w = Math.max(0, i1 - i0 + 1)
  const h = Math.max(0, j1 - j0 + 1)
  const top = new Float32Array(w * h).fill(MODEL_THROUGH)
  if (w === 0 || h === 0) return { i0, j0, w, h, top }

  const xs = [0, 0, 0]
  const ys = [0, 0, 0]
  const zs = [0, 0, 0]
  for (let t = 0; t < indices.length; t += 3) {
    for (let v = 0; v < 3; v++) {
      const k = indices[t + v] * 3
      xs[v] = positions[k]
      ys[v] = positions[k + 1]
      zs[v] = positions[k + 2]
    }
    const e1x = xs[1] - xs[0]
    const e1y = ys[1] - ys[0]
    const e1z = zs[1] - zs[0]
    const e2x = xs[2] - xs[0]
    const e2y = ys[2] - ys[0]
    const e2z = zs[2] - zs[0]
    // Plane normal; nz is twice the projected area.
    const nxp = e1y * e2z - e1z * e2y
    const nyp = e1z * e2x - e1x * e2z
    const nzp = e1x * e2y - e1y * e2x
    const scale = Math.abs(e1x) + Math.abs(e1y) + Math.abs(e2x) + Math.abs(e2y)
    // Edge-on from above (a vertical face): no area to sample.
    if (Math.abs(nzp) <= 1e-12 * scale * scale) continue
    const dzdx = -nxp / nzp
    const dzdy = -nyp / nzp

    const tyMin = Math.min(ys[0], ys[1], ys[2])
    const tyMax = Math.max(ys[0], ys[1], ys[2])
    const ja = Math.max(j0, Math.ceil((tyMin - g.originY) / cs - 0.5 - 1e-9))
    const jb = Math.min(j1, Math.floor((tyMax - g.originY) / cs - 0.5 + 1e-9))
    for (let j = ja; j <= jb; j++) {
      const cy = g.originY + (j + 0.5) * cs
      let lo = Infinity
      let hi = -Infinity
      for (let e = 0; e < 3; e++) {
        const ax = xs[e]
        const ay = ys[e]
        const bx = xs[(e + 1) % 3]
        const by = ys[(e + 1) % 3]
        if (ay === by) {
          if (Math.abs(cy - ay) <= 1e-9) {
            lo = Math.min(lo, ax, bx)
            hi = Math.max(hi, ax, bx)
          }
          continue
        }
        if (cy < Math.min(ay, by) - 1e-9 || cy > Math.max(ay, by) + 1e-9) continue
        const s = Math.min(1, Math.max(0, (cy - ay) / (by - ay)))
        const x = ax + s * (bx - ax)
        if (x < lo) lo = x
        if (x > hi) hi = x
      }
      if (lo > hi) continue
      const ia = Math.max(i0, Math.ceil((lo - g.originX) / cs - 0.5 - 1e-9))
      const ib = Math.min(i1, Math.floor((hi - g.originX) / cs - 0.5 + 1e-9))
      const row = (j - j0) * w - i0
      const zRow = zs[0] + dzdy * (cy - ys[0])
      for (let i = ia; i <= ib; i++) {
        const cx = g.originX + (i + 0.5) * cs
        const z = zRow + dzdx * (cx - xs[0])
        if (z > top[row + i]) top[row + i] = z
      }
    }
  }

  markOutside(top, w, h)
  return { i0, j0, w, h, top }
}

/** Flood fill of uncovered cells from the rectangle border: those become MODEL_OUTSIDE. */
function markOutside(top: Float32Array, w: number, h: number): void {
  const stack: number[] = []
  const visit = (c: number) => {
    if (top[c] === MODEL_THROUGH) {
      top[c] = MODEL_OUTSIDE
      stack.push(c)
    }
  }
  for (let i = 0; i < w; i++) {
    visit(i)
    visit((h - 1) * w + i)
  }
  for (let j = 0; j < h; j++) {
    visit(j * w)
    visit(j * w + w - 1)
  }
  while (stack.length > 0) {
    const c = stack.pop()!
    const i = c % w
    if (i > 0) visit(c - 1)
    if (i < w - 1) visit(c + 1)
    if (c >= w) visit(c - w)
    if (c < (h - 1) * w) visit(c + w)
  }
}

/**
 * Model grid over the whole simulation grid from several parts. Where parts overlap, the higher
 * material wins; a through-hole of one part stays open only where no other part has material.
 */
export function mergePartGrids(g: GridGeometry, parts: PartModelGrid[]): Float32Array {
  const model = new Float32Array(g.nx * g.ny).fill(MODEL_OUTSIDE)
  for (const p of parts) {
    for (let j = 0; j < p.h; j++) {
      for (let i = 0; i < p.w; i++) {
        const v = p.top[j * p.w + i]
        if (Number.isNaN(v)) continue
        const c = (p.j0 + j) * g.nx + p.i0 + i
        const old = model[c]
        if (Number.isNaN(old) || v > old) model[c] = v
      }
    }
  }
  return model
}
