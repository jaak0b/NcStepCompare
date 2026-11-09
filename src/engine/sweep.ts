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
// Cutter-workpiece engagement is measured on the height grid (the discrete, Z-map method):
//  - Depth of cut (axial): the largest thickness of stock removed in one cell.
//  - Width of cut (radial), by the engagement angle method: on the grid as it was before the move,
//    the contact arc is the part of the leading half of the cutter (facing the feed direction) that
//    meets stock material. It is found at tool positions along the move no more than one tool radius
//    apart, so the leading halves cover the whole move. On each ray of the leading half the outermost
//    point where material stands above the cutter profile is the contact point (a flat end mill
//    touches with its rim). The width of cut is the extent of the contact points across the feed
//    direction, the largest over the positions. For a cut on one side of the cutter this is
//    R (1 - cos phi) with phi the engagement angle; a full slot gives the diameter. Not defined for a
//    move without XY travel.
//  - Contact height: the largest height of stock material above the tool tip that the cutter
//    touches, taking the tip at the point of the move where the cell is cut lowest. A classic
//    cutter is modelled as reaching up indefinitely, so material above the flute length is still
//    removed and shows up here.
//
// Cutters with bounded bands (a thread mill with its teeth) remove material on the dexel stock.
// Per column and band the tool occupies [z(t) + a(d(t)), z(t) + b(d(t))] while d(t) <= the band's
// radius; over the connected t range of the move this sweeps the single interval
// [min_t (z + a(d(t))), max_t (z + b(d(t)))], which is subtracted from the column. Band boundaries
// are straight lines in (r, h), so the extremes are found in closed form: on each line element
// z(t) + s d(t) has at most one stationary point (one quadratic), so the extreme lies at that
// point, at a t where d(t) crosses an element end, at the closest approach, or at the ends of the
// t range. Z is exact to float32; XY is sampled at the column centres. A column that already holds
// gaps is cut through the dexel stock by classic cutters too, so the gaps stay consistent.
import type { DexelGaps } from './dexelStock'
import type { HeightGrid } from './heightGrid'
import { boundaryHeight, ProfileForm, profileHeight, type CutterProfile, type ProfilePoint } from './toolShape'

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
  /** First pass through the move: record the last cut per cell and measure the width of cut. */
  record: { lastCut: Int32Array; moveIndex: number } | null = null,
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
  const dex = (grid as HeightGrid & { dexels?: DexelGaps }).dexels ?? null
  const bandTool = !tool.classic
  if (bandTool && dex === null) throw new Error('A cutter with a tooth profile needs the dexel stock.')
  const anyGaps = dex !== null && dex.gapColumnCount > 0
  if (record && len > 0 && !bandTool) out.widthOfCut = contactArcWidth(grid, x0, y0, z0, dx, dy, dz, len, tool)
  const lastCut = record ? record.lastCut : null
  const moveIndex = record ? record.moveIndex : 0

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
      if (bandTool) {
        const removed = bandCut(dex!, row + i, wx, wy, w2, z0, dx, dy, dz, a, tool, h[row + i], bottom)
        if (removed < 0) continue
        if (removed > 0) {
          volume += removed * (i === lastI ? grid.lastColumnWidth : cs) * cellH
          if (removed > out.maxCutDepth) out.maxCutDepth = removed
          const contact = dex!.lastHighestRemoved - bandTipZ
          if (contact > out.contactHeight) out.contactHeight = contact
        }
        if (lastCut) lastCut[row + i] = moveIndex
        if (i < out.minI) out.minI = i
        if (i > out.maxI) out.maxI = i
        if (j < out.minJ) out.minJ = j
        if (j > out.maxJ) out.maxJ = j
        continue
      }
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
        let removed: number
        if (anyGaps && dex!.gapCount(row + i) > 0) {
          removed = dex!.subtract(row + i, z, Infinity)
        } else {
          h[row + i] = z
          // Removed stock material is the part of [new, old] above the stock bottom.
          removed = (old > bottom ? old : bottom) - (z > bottom ? z : bottom)
        }
        if (removed > 0) {
          volume += removed * (i === lastI ? grid.lastColumnWidth : cs) * cellH
          if (removed > out.maxCutDepth) out.maxCutDepth = removed
          // removed > 0 means the cell held stock material up to `old`.
          if (old - tipZ > out.contactHeight) out.contactHeight = old - tipZ
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
  return out
}

/** Tool tip Z at the point of the move where the last `bandCut` reached lowest. */
let bandTipZ = 0

/**
 * Cuts one column with every band of the tool (see the header). Returns the thickness of material
 * removed, or -1 when the column did not change.
 */
function bandCut(
  dex: DexelGaps,
  c: number,
  wx: number,
  wy: number,
  w2: number,
  z0: number,
  dx: number,
  dy: number,
  dz: number,
  a: number,
  tool: CutterProfile,
  top: number,
  bottom: number,
): number {
  let total = -1
  let lowest = Infinity
  const b = wx * dx + wy * dy
  // Closest distance from the column to the tool axis over the move.
  let tc = a > 0 ? b / a : 0
  if (tc < 0) tc = 0
  else if (tc > 1) tc = 1
  const dMin = Math.sqrt(Math.max(0, (wx - tc * dx) * (wx - tc * dx) + (wy - tc * dy) * (wy - tc * dy)))
  const zMin = dz < 0 ? z0 + dz : z0
  const zMax = dz < 0 ? z0 : z0 + dz
  for (const band of tool.bands) {
    const rM = band.rMax
    if (dMin > rM) continue
    // a is non-decreasing and b non-increasing in d, so the band stays inside these bounds.
    const lowBound = zMin + boundaryHeight(band.lower!, dMin)
    const highBound = band.upper.length > 0 ? zMax + boundaryHeight(band.upper, dMin) : Infinity
    if (Math.fround(lowBound) >= top || Math.fround(highBound) <= bottom) continue
    if (dex.insideGap(c, lowBound, highBound)) continue
    let zLow: number
    let zHigh: number
    let tLow: number
    if (a === 0) {
      zLow = lowBound
      zHigh = highBound
      tLow = dz < 0 ? 1 : 0
    } else {
      const disc = b * b - a * (w2 - rM * rM)
      if (disc < 0) continue
      const sq = Math.sqrt(disc)
      const ta = Math.max(0, (b - sq) / a)
      const tb = Math.min(1, (b + sq) / a)
      if (ta > tb) continue
      zLow = boundaryExtreme(band.lower!, 1, z0, dz, a, b, w2, ta, tb)
      tLow = extremeT
      zHigh = band.upper.length > 0 ? boundaryExtreme(band.upper, -1, z0, dz, a, b, w2, ta, tb) : Infinity
    }
    const r = dex.subtract(c, zLow, zHigh)
    if (r < 0) continue
    total = total < 0 ? r : total + r
    if (zLow < lowest) {
      lowest = zLow
      bandTipZ = z0 + tLow * dz
    }
  }
  return total
}

/** t of the extreme found by the last `boundaryExtreme`. */
let extremeT = 0
let extremeBest = 0

/** Candidate t for `boundaryExtreme`: keeps the smallest sign * g(t) on [ta, tb]. */
function considerT(points: ProfilePoint[], sign: number, z0: number, dz: number, a: number, b: number, w2: number, ta: number, tb: number, t: number): void {
  if (!(t >= ta && t <= tb)) return
  const d = Math.sqrt(Math.max(0, a * t * t - 2 * b * t + w2))
  const v = sign * (z0 + dz * t + boundaryHeight(points, d))
  if (v < extremeBest) {
    extremeBest = v
    extremeT = t
  }
}

/**
 * Smallest (sign 1) or largest (sign -1) value of z0 + dz t + f(d(t)) over t in [ta, tb], where
 * d(t)^2 = a t^2 - 2 b t + w2 and f is the band boundary through `points`.
 */
function boundaryExtreme(
  points: ProfilePoint[],
  sign: number,
  z0: number,
  dz: number,
  a: number,
  b: number,
  w2: number,
  ta: number,
  tb: number,
): number {
  const tc = b / a
  const e2 = Math.max(0, w2 - (b * b) / a)
  extremeBest = Infinity
  extremeT = ta
  considerT(points, sign, z0, dz, a, b, w2, ta, tb, ta)
  considerT(points, sign, z0, dz, a, b, w2, ta, tb, tb)
  considerT(points, sign, z0, dz, a, b, w2, ta, tb, tc)
  for (let k = 0; k < points.length; k++) {
    const q = (points[k].r * points[k].r - e2) / a
    if (q >= 0) {
      const u = Math.sqrt(q)
      considerT(points, sign, z0, dz, a, b, w2, ta, tb, tc - u)
      considerT(points, sign, z0, dz, a, b, w2, ta, tb, tc + u)
    }
    if (k === 0) continue
    const s = (points[k].h - points[k - 1].h) / (points[k].r - points[k - 1].r)
    // Stationary point of dz t + s d(t): s a u = -dz d(t), u = t - tc.
    const den = a * (s * s * a - dz * dz)
    if (s !== 0 && den > 0) {
      const u = Math.sqrt((dz * dz * e2) / den)
      considerT(points, sign, z0, dz, a, b, w2, ta, tb, dz * s > 0 ? tc - u : tc + u)
    }
  }
  return sign * extremeBest
}

/**
 * Width of cut by the engagement angle method (see the header), from the grid before the move.
 * Returns 0 when the leading half meets no material.
 */
function contactArcWidth(
  grid: HeightGrid,
  x0: number,
  y0: number,
  z0: number,
  dx: number,
  dy: number,
  dz: number,
  len: number,
  tool: CutterProfile,
): number {
  const R = tool.radius
  const cs = grid.cellSize
  const fx = dx / len
  const fy = dy / len
  // Rays every cell width along the rim, across the leading half from -90 to +90 degrees.
  const rays = Math.max(2, Math.ceil((Math.PI * R) / cs))
  const positions = Math.max(1, Math.ceil(len / R))
  const rimOnly = tool.form === ProfileForm.Flat
  const h = grid.heights
  const bottom = grid.bottom
  const present = (x: number, y: number, z: number): boolean => {
    const i = Math.floor((x - grid.originX) / cs)
    const j = Math.floor((y - grid.originY) / cs)
    if (i < 0 || j < 0 || i >= grid.nx || j >= grid.ny) return false
    const v = h[j * grid.nx + i]
    // In the grid's float32 precision, so a cell already cut to this height counts as cut.
    return v > bottom && v > Math.fround(z)
  }
  let width = 0
  for (let k = 0; k <= positions; k++) {
    const t = k / positions
    const px = x0 + t * dx
    const py = y0 + t * dy
    const pz = z0 + t * dz
    let lo = Infinity
    let hi = -Infinity
    for (let m = 0; m <= rays; m++) {
      const alpha = -Math.PI / 2 + (Math.PI * m) / rays
      const ca = Math.cos(alpha)
      const sa = Math.sin(alpha)
      // Direction on the leading half: forward component ca, sideways (left of the feed) sa.
      const ux = ca * fx - sa * fy
      const uy = ca * fy + sa * fx
      let r = R
      let hit = -1
      while (r >= 0) {
        if (present(px + r * ux, py + r * uy, pz + profileHeight(tool, r))) {
          hit = r
          break
        }
        if (rimOnly) break
        r -= cs
      }
      if (hit < 0) continue
      const lat = hit * sa
      if (lat < lo) lo = lat
      if (lat > hi) hi = lat
    }
    if (hi >= lo && hi - lo > width) width = hi - lo
  }
  return width
}

export function emptyMoveRemoval(): MoveRemoval {
  return { removedVolume: 0, maxCutDepth: 0, widthOfCut: NaN, contactHeight: 0, minI: 0, maxI: -1, minJ: 0, maxJ: -1 }
}
