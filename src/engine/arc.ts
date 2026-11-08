// Arc geometry for G2/G3 in the XY plane (G17).
//
// Flattening method: chord-tolerance segmentation. A chord spanning angle t on a circle of radius r
// deviates from the arc by the sagitta s = r (1 - cos(t / 2)). Solving for t with s equal to the
// chord tolerance gives the largest allowed step t = 2 acos(1 - tol / r); the sweep is then split
// into n = ceil(sweep / t) equal steps, so no point of the polyline is further than tol from the
// true arc. Z is interpolated linearly with the angle (helix).

const TWO_PI = Math.PI * 2

/** Default maximum distance between the flattened polyline and the true arc, in mm. */
export const DEFAULT_CHORD_TOLERANCE_MM = 0.01

/**
 * Start and end positions closer than this (mm) count as the same point, which makes a centre-format
 * arc a full circle. It only absorbs floating point noise from unit conversion and incremental sums.
 */
const SAME_POINT_EPSILON_MM = 1e-6

export interface ArcCentre {
  cx: number
  cy: number
}

/**
 * Centre of an R-format arc (standard RS274 rule): a positive R selects the arc of at most 180
 * degrees, a negative R the arc of more than 180 degrees. Returns null when the chord is longer
 * than the diameter or the end point equals the start point (R format cannot describe a full circle).
 */
export function arcCentreFromRadius(
  sx: number,
  sy: number,
  ex: number,
  ey: number,
  r: number,
  clockwise: boolean,
): ArcCentre | null {
  const dx = ex - sx
  const dy = ey - sy
  const d = Math.hypot(dx, dy)
  const radius = Math.abs(r)
  if (d < SAME_POINT_EPSILON_MM || radius === 0) return null
  const h2 = radius * radius - (d * d) / 4
  if (h2 < 0) {
    // Allow the chord to equal the diameter up to rounding in the file.
    if (d / 2 - radius > SAME_POINT_EPSILON_MM) return null
  }
  const h = Math.sqrt(Math.max(0, h2))
  const mx = (sx + ex) / 2
  const my = (sy + ey) / 2
  // Unit normal to the chord, pointing left of the travel direction start -> end.
  const nx = -dy / d
  const ny = dx / d
  // For a counter-clockwise arc of at most 180 degrees the centre lies left of the chord.
  let side = clockwise ? -1 : 1
  if (r < 0) side = -side
  return { cx: mx + side * h * nx, cy: my + side * h * ny }
}

/** Swept angle in radians, always in (0, 2 pi]. Equal start and end give a full circle. */
export function arcSweep(
  sx: number,
  sy: number,
  ex: number,
  ey: number,
  cx: number,
  cy: number,
  clockwise: boolean,
): number {
  if (Math.hypot(ex - sx, ey - sy) < SAME_POINT_EPSILON_MM) return TWO_PI
  const a0 = Math.atan2(sy - cy, sx - cx)
  const a1 = Math.atan2(ey - cy, ex - cx)
  let sweep = clockwise ? a0 - a1 : a1 - a0
  while (sweep <= 0) sweep += TWO_PI
  while (sweep > TWO_PI) sweep -= TWO_PI
  return sweep
}

/**
 * Flattens an arc into points, calling `emit` for each polyline vertex after the start, ending
 * exactly at the programmed end point. When the end radius differs slightly from the start radius
 * (rounding in the file), the radius is blended linearly along the sweep.
 */
export function flattenArc(
  sx: number,
  sy: number,
  sz: number,
  ex: number,
  ey: number,
  ez: number,
  cx: number,
  cy: number,
  clockwise: boolean,
  chordTolerance: number,
  emit: (x: number, y: number, z: number) => void,
): void {
  const r0 = Math.hypot(sx - cx, sy - cy)
  const r1 = Math.hypot(ex - cx, ey - cy)
  const sweep = arcSweep(sx, sy, ex, ey, cx, cy, clockwise)
  const rMax = Math.max(r0, r1)
  const maxStep = chordTolerance < rMax ? 2 * Math.acos(1 - chordTolerance / rMax) : Math.PI
  const n = Math.max(1, Math.ceil(sweep / maxStep))
  const a0 = Math.atan2(sy - cy, sx - cx)
  const dir = clockwise ? -1 : 1
  for (let i = 1; i < n; i++) {
    const t = i / n
    const a = a0 + dir * sweep * t
    const r = r0 + (r1 - r0) * t
    emit(cx + r * Math.cos(a), cy + r * Math.sin(a), sz + (ez - sz) * t)
  }
  emit(ex, ey, ez)
}

/**
 * Centre-format radius check, following the rule Grbl uses: start and end radius may differ by up
 * to 0.005 mm, or by up to 0.1 % of the radius when that is larger, but never by more than 0.5 mm.
 */
export function arcRadiusMismatch(
  sx: number,
  sy: number,
  ex: number,
  ey: number,
  cx: number,
  cy: number,
): number | null {
  const r0 = Math.hypot(sx - cx, sy - cy)
  const r1 = Math.hypot(ex - cx, ey - cy)
  const delta = Math.abs(r1 - r0)
  if (delta > 0.005 && (delta > 0.5 || delta > 0.001 * r1)) return delta
  return null
}
