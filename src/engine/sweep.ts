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
// Only cells in the move's XY bounding box grown by the tool radius are visited.
import type { HeightGrid } from './heightGrid'
import { ProfileForm, type CutterProfile } from './toolShape'

const GOLDEN_SECTION_ITERATIONS = 40
const INV_PHI = (Math.sqrt(5) - 1) / 2

export interface MoveRemoval {
  /** Material volume removed by the move, in mm^3, counted only inside the stock. */
  removedVolume: number
  /** Largest thickness of stock material removed in one cell by this move, in mm. */
  maxCutDepth: number
  /** Changed cell range, inclusive; minI > maxI when nothing changed. */
  minI: number
  maxI: number
  minJ: number
  maxJ: number
}

function profileAt(p: CutterProfile, r: number): number {
  switch (p.form) {
    case ProfileForm.Flat:
      return 0
    case ProfileForm.Ball: {
      const s = p.radius * p.radius - r * r
      return p.radius - (s > 0 ? Math.sqrt(s) : 0)
    }
    case ProfileForm.BullNose: {
      const u = r - (p.radius - p.cornerRadius)
      if (u <= 0) return 0
      const s = p.cornerRadius * p.cornerRadius - u * u
      return p.cornerRadius - (s > 0 ? Math.sqrt(s) : 0)
    }
    default:
      return r * p.coneSlope
  }
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
): MoveRemoval {
  out.removedVolume = 0
  out.maxCutDepth = 0
  out.minI = grid.nx
  out.maxI = -1
  out.minJ = grid.ny
  out.maxJ = -1

  const R = tool.radius
  const cs = grid.cellSize
  const i0 = Math.max(0, Math.floor((Math.min(x0, x1) - R - grid.originX) / cs))
  const i1 = Math.min(grid.nx - 1, Math.floor((Math.max(x0, x1) + R - grid.originX) / cs))
  const j0 = Math.max(0, Math.floor((Math.min(y0, y1) - R - grid.originY) / cs))
  const j1 = Math.min(grid.ny - 1, Math.floor((Math.max(y0, y1) + R - grid.originY) / cs))
  if (i0 > i1 || j0 > j1) return out

  const dx = x1 - x0
  const dy = y1 - y0
  const dz = z1 - z0
  const a = dx * dx + dy * dy
  const R2 = R * R
  const flatBottom = tool.form === ProfileForm.Flat
  const horizontal = dz === 0
  const bottom = grid.bottom
  const h = grid.heights
  const nx = grid.nx
  let volumeHeight = 0

  for (let j = j0; j <= j1; j++) {
    const cy = grid.originY + (j + 0.5) * cs
    const wy = cy - y0
    const row = j * nx
    for (let i = i0; i <= i1; i++) {
      const cx = grid.originX + (i + 0.5) * cs
      const wx = cx - x0
      const w2 = wx * wx + wy * wy
      let zmin: number

      if (a === 0) {
        // Vertical move: the tool axis stays put.
        if (w2 > R2) continue
        zmin = (dz < 0 ? z1 : z0) + profileAt(tool, Math.sqrt(w2))
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
          zmin = z0 + profileAt(tool, Math.sqrt(ex * ex + ey * ey))
        } else if (flatBottom) {
          zmin = z0 + (dz < 0 ? tb : ta) * dz
        } else {
          // Golden-section search for the minimum of the convex f on [ta, tb].
          let lo = ta
          let hi = tb
          let m1 = hi - INV_PHI * (hi - lo)
          let m2 = lo + INV_PHI * (hi - lo)
          let f1 = z0 + m1 * dz + profileAt(tool, Math.hypot(wx - m1 * dx, wy - m1 * dy))
          let f2 = z0 + m2 * dz + profileAt(tool, Math.hypot(wx - m2 * dx, wy - m2 * dy))
          for (let k = 0; k < GOLDEN_SECTION_ITERATIONS; k++) {
            if (f1 <= f2) {
              hi = m2
              m2 = m1
              f2 = f1
              m1 = hi - INV_PHI * (hi - lo)
              f1 = z0 + m1 * dz + profileAt(tool, Math.hypot(wx - m1 * dx, wy - m1 * dy))
            } else {
              lo = m1
              m1 = m2
              f1 = f2
              m2 = lo + INV_PHI * (hi - lo)
              f2 = z0 + m2 * dz + profileAt(tool, Math.hypot(wx - m2 * dx, wy - m2 * dy))
            }
          }
          zmin = f1 < f2 ? f1 : f2
          // The interval ends are candidates too (a convex f can be monotone on the interval).
          const fa = z0 + ta * dz + profileAt(tool, Math.hypot(wx - ta * dx, wy - ta * dy))
          const fb = z0 + tb * dz + profileAt(tool, Math.hypot(wx - tb * dx, wy - tb * dy))
          if (fa < zmin) zmin = fa
          if (fb < zmin) zmin = fb
        }
      }

      const old = h[row + i]
      if (zmin < old) {
        h[row + i] = zmin
        // Removed stock material is the part of [new, old] above the stock bottom.
        const removed = (old > bottom ? old : bottom) - (zmin > bottom ? zmin : bottom)
        if (removed > 0) {
          volumeHeight += removed
          if (removed > out.maxCutDepth) out.maxCutDepth = removed
        }
        if (i < out.minI) out.minI = i
        if (i > out.maxI) out.maxI = i
        if (j < out.minJ) out.minJ = j
        if (j > out.maxJ) out.maxJ = j
      }
    }
  }
  out.removedVolume = volumeHeight * cs * cs
  return out
}

export function emptyMoveRemoval(): MoveRemoval {
  return { removedVolume: 0, maxCutDepth: 0, minI: 0, maxI: -1, minJ: 0, maxJ: -1 }
}
