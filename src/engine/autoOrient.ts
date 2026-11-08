// Auto-orient: finds the orientation and XY position of a STEP part that best match the machined
// stock, keeping the entered bottom Z.
//
// 1. Coarse position per orientation (24 = 6 up axes x 4 quarter turns): template matching by the
//    masked sum of squared differences (SSD) between the machined cut-depth map D and the part's
//    expected cut-depth map E over the part footprint F:
//      SSD(s) = sum_F D(x+s)^2 - 2 sum E(x) D(x+s) + sum E^2
//    The two sums over shifts s are cross-correlations, computed with the 2D FFT (radix-2
//    Cooley-Tukey) on a coarse search grid. Every shift is searched, including ones where the part
//    sticks out of the stock: around the stock the map is padded with the full stock depth (no
//    material there).
// 2. Every orientation is scored at full resolution at its coarse position with the comparison's
//    own measure: the mean absolute deviation over the footprint.
// 3. The best three are refined by a pattern search over whole-cell shifts at full resolution on
//    the same measure (step halved from the coarse cell down to one cell).
import { cellDeviation } from './deviation'
import type { GridGeometry, HeightGrid } from './heightGrid'
import { rasterizePart, MODEL_THROUGH, type PartModelGrid } from './modelGrid'
import { meshBounds } from './stepModel'
import {
  placePositions,
  QUARTER_TURNS,
  UP_AXES,
  type PartPlacement,
  type QuarterTurns,
  type UpAxis,
} from './partPlacement'
import type { TriangleMesh } from './stepModel'

/** Cell size of the coarse search grid, mm. Only sets the search speed: the result is refined per cell. */
export const COARSE_SEARCH_CELL_MM = 1
/** Orientations refined at full resolution. */
const REFINED_ORIENTATIONS = 3

export interface OrientationCandidate {
  upAxis: UpAxis
  quarterTurns: QuarterTurns
  centerX: number
  centerY: number
  /** Mean absolute deviation over the candidate's footprint, mm (lower is better). */
  meanAbsDeviation: number
  footprintCells: number
}

type Grid = GridGeometry & Pick<HeightGrid, 'top' | 'bottom'>

/** In-place radix-2 FFT of n complex values with stride `step`, starting at `off`. */
function fft(re: Float64Array, im: Float64Array, off: number, step: number, n: number, inverse: boolean): void {
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const a = off + i * step
      const b = off + j * step
      let t = re[a]
      re[a] = re[b]
      re[b] = t
      t = im[a]
      im[a] = im[b]
      im[b] = t
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < len / 2; k++) {
        const a = off + (i + k) * step
        const b = off + (i + k + len / 2) * step
        const xr = re[b] * cr - im[b] * ci
        const xi = re[b] * ci + im[b] * cr
        re[b] = re[a] - xr
        im[b] = im[a] - xi
        re[a] += xr
        im[a] += xi
        const t = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = t
      }
    }
  }
}

function fft2(re: Float64Array, im: Float64Array, p: number, q: number, inverse: boolean): void {
  for (let r = 0; r < q; r++) fft(re, im, r * p, 1, p, inverse)
  for (let c = 0; c < p; c++) fft(re, im, c, p, q, inverse)
  if (inverse) {
    const s = 1 / (p * q)
    for (let k = 0; k < re.length; k++) {
      re[k] *= s
      im[k] *= s
    }
  }
}

const nextPow2 = (n: number) => 1 << Math.ceil(Math.log2(Math.max(1, n)))

/** Spectrum of a p x q real array given as w x h values placed at the origin. */
function spectrum(values: Float64Array, w: number, h: number, p: number, q: number) {
  const re = new Float64Array(p * q)
  const im = new Float64Array(p * q)
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) re[j * p + i] = values[j * w + i]
  fft2(re, im, p, q, false)
  return { re, im }
}

/**
 * Both correlations of the masked SSD in two FFTs: the expected depth E and the mask F go in as the
 * real and imaginary parts of one forward transform and are separated by Hermitian symmetry; both
 * correlations are real, so they come back as the real and imaginary parts of one inverse transform:
 *   cross(s) = sum_x E(x) D(x + s),   energy(s) = sum_x F(x) D(x + s)^2
 */
function correlatePair(
  depth: { re: Float64Array; im: Float64Array },
  depthSq: { re: Float64Array; im: Float64Array },
  expected: Float64Array,
  mask: Float64Array,
  w: number,
  h: number,
  p: number,
  q: number,
): { cross: Float64Array; energy: Float64Array } {
  const tr = new Float64Array(p * q)
  const ti = new Float64Array(p * q)
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      tr[j * p + i] = expected[j * w + i]
      ti[j * p + i] = mask[j * w + i]
    }
  }
  fft2(tr, ti, p, q, false)
  const zr = new Float64Array(p * q)
  const zi = new Float64Array(p * q)
  for (let ky = 0; ky < q; ky++) {
    const my = (q - ky) % q
    for (let kx = 0; kx < p; kx++) {
      const k = ky * p + kx
      const m = my * p + ((p - kx) % p)
      // Spectra of E and F from T(k) and T(-k).
      const er = (tr[k] + tr[m]) / 2
      const ei = (ti[k] - ti[m]) / 2
      const fr = (ti[k] + ti[m]) / 2
      const fi = -(tr[k] - tr[m]) / 2
      // A = D * conj(E), S = D^2 * conj(F), Z = A + i S.
      const ar = depth.re[k] * er + depth.im[k] * ei
      const ai = depth.im[k] * er - depth.re[k] * ei
      const sr = depthSq.re[k] * fr + depthSq.im[k] * fi
      const si = depthSq.im[k] * fr - depthSq.re[k] * fi
      zr[k] = ar - si
      zi[k] = ai + sr
    }
  }
  fft2(zr, zi, p, q, true)
  return { cross: zr, energy: zi }
}

/**
 * Mean |deviation| of a part model grid shifted by whole cells against the machined grid, over every
 * `stride`-th cell in X and Y (1: every cell). Cells beyond the stock have no material: they count as
 * cut down to the stock bottom.
 */
function shiftedScore(g: Grid, machined: Float32Array, p: PartModelGrid, dx: number, dy: number, stride = 1) {
  let n = 0
  let sum = 0
  for (let j = 0; j < p.h; j += stride) {
    for (let i = 0; i < p.w; i += stride) {
      const top = p.top[j * p.w + i]
      if (Number.isNaN(top)) continue
      const gi = p.i0 + i + dx
      const gj = p.j0 + j + dy
      const inside = gi >= 0 && gj >= 0 && gi < g.nx && gj < g.ny
      const d = cellDeviation(inside ? machined[gj * g.nx + gi] : g.bottom, top, p.bottomZ, g.bottom)
      n++
      sum += Math.abs(d)
    }
  }
  return { footprintCells: n, meanAbsDeviation: n > 0 ? sum / n : Infinity }
}

/** Best whole-cell shift (on the coarse grid) of the part's expected cut depth against the machined one. */
function coarseShift(
  coarse: GridGeometry,
  depth: { re: Float64Array; im: Float64Array },
  depthSq: { re: Float64Array; im: Float64Array },
  p: number,
  q: number,
  part: PartModelGrid,
  stockTop: number,
): { dx: number; dy: number } {
  const { w, h } = part
  const expected = new Float64Array(w * h)
  const mask = new Float64Array(w * h)
  for (let k = 0; k < w * h; k++) {
    const top = part.top[k]
    if (Number.isNaN(top)) continue
    mask[k] = 1
    expected[k] = stockTop - (top === MODEL_THROUGH ? part.bottomZ : top)
  }
  const { cross, energy } = correlatePair(depth, depthSq, expected, mask, w, h, p, q)
  // Template origin at padded-grid cell (sx, sy); the padding is wide enough for any position.
  let best = Infinity
  let bx = part.i0
  let by = part.j0
  for (let sy = 0; sy + h <= coarse.ny; sy++) {
    for (let sx = 0; sx + w <= coarse.nx; sx++) {
      const k = sy * p + sx
      const ssd = energy[k] - 2 * cross[k]
      if (ssd < best) {
        best = ssd
        bx = sx
        by = sy
      }
    }
  }
  return { dx: bx - part.i0, dy: by - part.j0 }
}

/**
 * Pattern search over whole-cell shifts. Steps of 4 cells or more compare every 4th cell, a step of 2
 * every 2nd; the last step of one cell uses every cell, so the result is exact at full resolution.
 */
function refine(g: Grid, machined: Float32Array, part: PartModelGrid, startStep: number) {
  let dx = 0
  let dy = 0
  let best = shiftedScore(g, machined, part, 0, 0)
  for (let step = Math.max(1, startStep); step >= 1; step = Math.floor(step / 2)) {
    const stride = step >= 4 ? 4 : step
    best = shiftedScore(g, machined, part, dx, dy, stride)
    for (let moved = true; moved; ) {
      moved = false
      for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const s = shiftedScore(g, machined, part, dx + ox * step, dy + oy * step, stride)
        if (s.meanAbsDeviation < best.meanAbsDeviation) {
          best = s
          dx += ox * step
          dy += oy * step
          moved = true
        }
      }
    }
  }
  return { dx, dy, score: best }
}

/**
 * Ranks the 24 orientations, each at its best XY position, with the bottom Z of `at`. `at` gives the
 * starting centre; the search covers every position that keeps the part inside the stock.
 */
export function autoOrient(
  g: Grid,
  machined: Float32Array,
  mesh: TriangleMesh,
  at: Pick<PartPlacement, 'centerX' | 'centerY' | 'bottomZ'>,
): OrientationCandidate[] {
  const factor = Math.max(1, Math.round(COARSE_SEARCH_CELL_MM / g.cellSize))
  const cc = g.cellSize * factor
  // Padding around the stock, in coarse cells: room for the part at any position overlapping it.
  const b = meshBounds(mesh.positions)
  const pad = Math.ceil(Math.max(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z) / cc) + 2
  const sx0 = Math.ceil(g.nx / factor)
  const sy0 = Math.ceil(g.ny / factor)
  const coarse: GridGeometry = {
    nx: sx0 + 2 * pad,
    ny: sy0 + 2 * pad,
    cellSize: cc,
    originX: g.originX - pad * cc,
    originY: g.originY - pad * cc,
  }
  // Machined cut depth below the stock top, averaged per coarse cell; cuts below the stock count as
  // the full stock height, and so does everything around the stock.
  const p = nextPow2(coarse.nx)
  const q = nextPow2(coarse.ny)
  const full = g.top - g.bottom
  const cut = new Float64Array(coarse.nx * coarse.ny).fill(full)
  const sum = new Float64Array(sx0 * sy0)
  const count = new Float64Array(sx0 * sy0)
  for (let j = 0; j < g.ny; j++) {
    for (let i = 0; i < g.nx; i++) {
      const c = Math.floor(j / factor) * sx0 + Math.floor(i / factor)
      sum[c] += Math.min(full, Math.max(0, g.top - machined[j * g.nx + i]))
      count[c]++
    }
  }
  for (let j = 0; j < sy0; j++) {
    for (let i = 0; i < sx0; i++) cut[(j + pad) * coarse.nx + i + pad] = sum[j * sx0 + i] / count[j * sx0 + i]
  }
  const depth = spectrum(cut, coarse.nx, coarse.ny, p, q)
  const depthSq = spectrum(cut.map((v) => v * v), coarse.nx, coarse.ny, p, q)

  const candidates: (OrientationCandidate & { part: PartModelGrid })[] = []
  for (const upAxis of UP_AXES) {
    for (const quarterTurns of QUARTER_TURNS) {
      const start = { ...at, upAxis, quarterTurns }
      const shift = coarseShift(coarse, depth, depthSq, p, q, rasterizePart(coarse, placePositions(mesh, start), mesh.indices), g.top)
      const placement = {
        ...start,
        centerX: at.centerX + shift.dx * coarse.cellSize,
        centerY: at.centerY + shift.dy * coarse.cellSize,
      }
      const part = rasterizePart(g, placePositions(mesh, placement), mesh.indices)
      const s = shiftedScore(g, machined, part, 0, 0)
      candidates.push({ upAxis, quarterTurns, centerX: placement.centerX, centerY: placement.centerY, ...s, part })
    }
  }
  candidates.sort((a, b) => a.meanAbsDeviation - b.meanAbsDeviation)
  for (const c of candidates.slice(0, REFINED_ORIENTATIONS)) {
    const r = refine(g, machined, c.part, factor)
    c.centerX += r.dx * g.cellSize
    c.centerY += r.dy * g.cellSize
    c.meanAbsDeviation = r.score.meanAbsDeviation
    c.footprintCells = r.score.footprintCells
  }
  return candidates
    .map(({ part: _part, ...c }) => c)
    .sort((a, b) => a.meanAbsDeviation - b.meanAbsDeviation)
}
