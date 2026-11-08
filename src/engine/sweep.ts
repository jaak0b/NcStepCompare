// Material removal for one straight move on the height grid.
//
// Method: exact swept-envelope evaluation per cell. For a cell centre c and a tool tip moving along
// p(t) = p0 + t (p1 - p0), t in [0, 1], the lowest point of the cutter over c is
//   f(t) = z(t) + profile(|c - p(t)|_xy),  on the t interval where |c - p(t)|_xy <= tool radius.
// The cell's new height is min(old height, min over t of f). |c - p(t)| is convex in t and every
// cutter profile is convex and non-decreasing in r, so f is convex on that interval:
//  - horizontal move: the minimum is at the closest point of the segment (closed form);
//  - flat-bottomed cutter: f is linear in t, the minimum is at an interval end (closed form);
//  - otherwise (ramps and plunges of ball, bull nose and cone profiles): golden-section search,
//    which converges to the minimum of a convex function; 40 iterations narrow t to 1e-8 of the move.
//    Before searching, the exact lower bound (lowest Z on the interval plus the profile at the
//    closest distance) skips cells that are already deeper.
// Only the swept band is visited: per cell row, the X interval where the row crosses the capsule
// of points within the tool radius of the segment (two end discs and the two offset edges).
//
// Cutter-workpiece engagement is measured on the same cells (the discrete, Z-map method): every cell
// whose stock material the move removes is in contact with the cutter.
//  - Depth of cut (axial): the largest thickness of stock removed in one cell.
//  - Width of cut (radial): the extent of the removed cells across the feed direction in XY, from
//    the cell centres plus one cell width (the cell resolution), at most the tool diameter. Not
//    defined for a move without XY travel.
//  - Contact height: the largest height of stock material above the tool tip that the cutter
//    touches, taking the tip at the point of the move where the cell is cut lowest. The cutter is
//    modelled as reaching up indefinitely, so material above the flute length is still removed and
//    shows up here.
import type { HeightGrid } from './heightGrid'
import { ProfileForm, profileHeight, type CutterProfile } from './toolShape'

const GOLDEN_SECTION_ITERATIONS = 40
const INV_PHI = (Math.sqrt(5) - 1) / 2

export interface MoveRemoval {
  /** Material volume removed by the move, in mm^3, counted only inside the stock. */
  removedVolume: number
  /** Largest thickness of stock material removed in one cell by this move, in mm. */
  maxCutDepth: number
  /** Width of cut across the feed direction, mm; NaN without XY travel or without removal. */
  widthOfCut: number
  /** Largest height of stock material above the tool tip in contact with the cutter, mm (0 when none). */
  contactHeight: number
  /** Changed cell range, inclusive; minI > maxI when nothing changed. */
  minI: number
  maxI: number
  minJ: number
  maxJ: number
}

export function sweepMove(
  grid: HeightGrid,
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
  tool: CutterProfile,
  out: MoveRemoval,
  lastCut: Int32Array | null = null,
  moveIndex = 0,
): MoveRemoval {
  out.removedVolume = 0
  out.maxCutDepth = 0
  out.widthOfCut = NaN
  out.contactHeight = 0
  out.minI = grid.nx
  out.maxI = -1
  out.minJ = grid.ny
  out.maxJ = -1

  const R = tool.radius
  const cs = grid.cellSize
  const nx = grid.nx
  const ox = grid.originX
  const i0 = Math.max(0, Math.floor((Math.min(x0, x1) - R - ox) / cs))
  const i1 = Math.min(nx - 1, Math.floor((Math.max(x0, x1) + R - ox) / cs))
  const j0 = Math.max(0, Math.floor((Math.min(y0, y1) - R - grid.originY) / cs))
  const j1 = Math.min(grid.ny - 1, Math.floor((Math.max(y0, y1) + R - grid.originY) / cs))
  if (i0 > i1 || j0 > j1) return out

  const dx = x1 - x0
  const dy = y1 - y0
  const dz = z1 - z0
  const a = dx * dx + dy * dy
  const R2 = R * R
  const len = Math.sqrt(a)
  // Unit normal of the segment in XY, for the capsule's offset edges.
  const nxu = len > 0 ? -dy / len : 0
  const nyu = len > 0 ? dx / len : 0
  const flatBottom = tool.form === ProfileForm.Flat
  const horizontal = dz === 0
  const bottom = grid.bottom
  const h = grid.heights
  const lastI = nx - 1
  const lastJ = grid.ny - 1
  let volume = 0
  let minLat = Infinity
  let maxLat = -Infinity

  for (let j = j0; j <= j1; j++) {
    const cy = grid.originY + (j + 0.5) * cs
    const wy = cy - y0

    // X extent of the capsule on this row.
    let lo = Infinity
    let hi = -Infinity
    const r0 = R2 - wy * wy
    if (r0 >= 0) {
      const s = Math.sqrt(r0)
      if (x0 - s < lo) lo = x0 - s
      if (x0 + s > hi) hi = x0 + s
    }
    const wy1 = cy - y1
    const r1 = R2 - wy1 * wy1
    if (r1 >= 0) {
      const s = Math.sqrt(r1)
      if (x1 - s < lo) lo = x1 - s
      if (x1 + s > hi) hi = x1 + s
    }
    if (dy !== 0) {
      for (let side = -1; side <= 1; side += 2) {
        const t = (wy - side * R * nyu) / dy
        if (t >= 0 && t <= 1) {
          const x = x0 + t * dx + side * R * nxu
          if (x < lo) lo = x
          if (x > hi) hi = x
        }
      }
    }
    if (lo > hi) continue
    const ia = Math.max(i0, Math.ceil((lo - ox) / cs - 0.5 - 1e-9))
    const ib = Math.min(i1, Math.floor((hi - ox) / cs - 0.5 + 1e-9))

    const row = j * nx
    const cellH = j === lastJ ? grid.lastRowHeight : cs
    for (let i = ia; i <= ib; i++) {
      const cx = ox + (i + 0.5) * cs
      const wx = cx - x0
      const w2 = wx * wx + wy * wy
      const old = h[row + i]
      let zmin: number
      // Tool tip Z at the point of the move where this cell is cut lowest.
      let tipZ: number

      if (a === 0) {
        // Vertical move: the tool axis stays put.
        if (w2 > R2) continue
        tipZ = dz < 0 ? z1 : z0
        zmin = tipZ + profileHeight(tool, Math.sqrt(w2))
      } else {
        const b = wx * dx + wy * dy
        const disc = b * b - a * (w2 - R2)
        if (disc < 0) continue
        const sq = Math.sqrt(disc)
        let ta = (b - sq) / a
        let tb = (b + sq) / a
        if (ta < 0) ta = 0
        if (tb > 1) tb = 1
        if (ta > tb) continue
        if (horizontal) {
          let t = b / a
          if (t < 0) t = 0
          else if (t > 1) t = 1
          const ex = wx - t * dx
          const ey = wy - t * dy
          tipZ = z0
          zmin = z0 + profileHeight(tool, Math.sqrt(ex * ex + ey * ey))
        } else if (flatBottom) {
          zmin = z0 + (dz < 0 ? tb : ta) * dz
          tipZ = zmin
        } else {
          let tc = b / a
          if (tc < ta) tc = ta
          else if (tc > tb) tc = tb
          const lowerBound = z0 + (dz < 0 ? tb : ta) * dz + profileHeight(tool, Math.hypot(wx - tc * dx, wy - tc * dy))
          if (Math.fround(lowerBound) >= old) continue
          // Golden-section search for the minimum of the convex f on [ta, tb].
          let lo2 = ta
          let hi2 = tb
          let m1 = hi2 - INV_PHI * (hi2 - lo2)
          let m2 = lo2 + INV_PHI * (hi2 - lo2)
          let f1 = z0 + m1 * dz + profileHeight(tool, Math.hypot(wx - m1 * dx, wy - m1 * dy))
          let f2 = z0 + m2 * dz + profileHeight(tool, Math.hypot(wx - m2 * dx, wy - m2 * dy))
          for (let k = 0; k < GOLDEN_SECTION_ITERATIONS; k++) {
            if (f1 <= f2) {
              hi2 = m2
              m2 = m1
              f2 = f1
              m1 = hi2 - INV_PHI * (hi2 - lo2)
              f1 = z0 + m1 * dz + profileHeight(tool, Math.hypot(wx - m1 * dx, wy - m1 * dy))
            } else {
              lo2 = m1
              m1 = m2
              f1 = f2
              m2 = lo2 + INV_PHI * (hi2 - lo2)
              f2 = z0 + m2 * dz + profileHeight(tool, Math.hypot(wx - m2 * dx, wy - m2 * dy))
            }
          }
          let tBest = f1 < f2 ? m1 : m2
          zmin = f1 < f2 ? f1 : f2
          // The interval ends are candidates too (a convex f can be monotone on the interval).
          const fa = z0 + ta * dz + profileHeight(tool, Math.hypot(wx - ta * dx, wy - ta * dy))
          const fb = z0 + tb * dz + profileHeight(tool, Math.hypot(wx - tb * dx, wy - tb * dy))
          if (fa < zmin) {
            zmin = fa
            tBest = ta
          }
          if (fb < zmin) {
            zmin = fb
            tBest = tb
          }
          tipZ = z0 + tBest * dz
        }
      }

      // Compare in the grid's float32 precision, so a repeated pass at the same depth removes nothing.
      const z = Math.fround(zmin)
      if (z < old) {
        h[row + i] = z
        // Removed stock material is the part of [new, old] above the stock bottom.
        const removed = (old > bottom ? old : bottom) - (z > bottom ? z : bottom)
        if (removed > 0) {
          volume += removed * (i === lastI ? grid.lastColumnWidth : cs) * cellH
          if (removed > out.maxCutDepth) out.maxCutDepth = removed
          // removed > 0 means the cell held stock material up to `old`.
          if (old - tipZ > out.contactHeight) out.contactHeight = old - tipZ
          if (len > 0) {
            const lat = wx * nxu + wy * nyu
            if (lat < minLat) minLat = lat
            if (lat > maxLat) maxLat = lat
          }
        }
        if (lastCut) lastCut[row + i] = moveIndex
        if (i < out.minI) out.minI = i
        if (i > out.maxI) out.maxI = i
        if (j < out.minJ) out.minJ = j
        if (j > out.maxJ) out.maxJ = j
      }
    }
  }
  out.removedVolume = volume
  if (maxLat >= minLat) out.widthOfCut = Math.min(maxLat - minLat + cs, 2 * R)
  return out
}

export function emptyMoveRemoval(): MoveRemoval {
  return { removedVolume: 0, maxCutDepth: 0, widthOfCut: NaN, contactHeight: 0, minI: 0, maxI: -1, minJ: 0, maxJ: -1 }
}
