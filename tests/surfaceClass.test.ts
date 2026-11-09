import { describe, expect, it } from 'vitest'
import { DeviationTracker, toleranceLimits } from '../src/engine/deviation'
import { bottomFaceClass, cellClasses, SurfaceClass, surfaceClassAt } from '../src/engine/comparisonView'
import { analyseStock } from '../src/engine/findings/stockFindings'
import { MODEL_OUTSIDE, MODEL_THROUGH, type ModelGrid } from '../src/engine/modelGrid'

// One row of 0.05 mm cells, stock Z -10 to 0, default tolerances: the leftover window reaches
// floor(0.1 / 0.05) = 2 cells, the gouge window 1 cell. Cell k spans X 0.05 k to 0.05 (k + 1).
const tol = { gouge: 0.05, leftover: 0.1 }
const N = 30
const grid = { nx: N, ny: 1, cellSize: 0.05, originX: 0, originY: 0, top: 0, bottom: -10 }
const xIn = (k: number) => 0.05 * k + 0.01 // inside cell k, near its lower X edge
const xEnd = (k: number) => 0.05 * (k + 1) - 0.01 // inside cell k, near its upper X edge

/** Cells 0..9 part material with its top at Z 0 and bottom at Z -10; cells 10.. `rest`. */
function model(rest: number): ModelGrid {
  const top = new Float32Array(N).fill(rest)
  top.fill(0, 0, 10)
  return { top, throughFloor: new Float32Array(N).fill(rest === MODEL_THROUGH ? -10 : NaN), partBottom: new Float32Array(N).fill(-10) }
}

function classify(m: ModelGrid, machined: number[]) {
  const heights = Float32Array.from(machined)
  const limits = toleranceLimits(grid, m, tol, grid.bottom)
  const classes = cellClasses(m, new Uint8Array(N), grid.bottom, tol.leftover)
  return {
    at: (x: number, z: number) => surfaceClassAt(grid, heights, null, limits, classes, x, 0.025, z),
    summary: new DeviationTracker(N, m, limits, grid.bottom, heights, grid.top).summary(),
    findings: analyseStock({
      grid,
      heights,
      model: m,
      limits,
      lastCut: new Int32Array(N).fill(-1),
      moveTool: new Int32Array(0),
      moveLine: new Int32Array(0),
      moveStart: new Float64Array(0),
      moveEnd: new Float64Array(0),
      threadMills: new Set(),
    }).findings,
  }
}

const row = (...runs: [number, number][]) => runs.flatMap(([count, z]) => Array(count).fill(z))

describe('surface colours by position against the model', () => {
  it('colours a leftover ledge inside a through-hole leftover over its full height, wall included', () => {
    // Hole from X 0.5. Cells 10..19: a ledge at Z -5 (0.5 mm wide); cells 20..: cut through.
    const r = classify(model(MODEL_THROUGH), row([10, 0], [10, -5], [10, -10.3]))

    // Ledge top: within tolerance up to 0.1 mm from the hole wall (cells 10, 11), leftover beyond.
    expect([r.at(xIn(11) + 0.02, -5), r.at(xIn(12) + 0.02, -5), r.at(xIn(19), -5)]).toEqual([SurfaceClass.Within, SurfaceClass.Leftover, SurfaceClass.Leftover])
    // Ledge wall at X 1.0, on both sides of the cell edge: it bounds leftover material, so it is
    // leftover over its full height.
    for (const x of [xEnd(19), xIn(20)]) expect([-5, -7, -9.95].map((z) => r.at(x, z))).toEqual(Array(3).fill(SurfaceClass.Leftover))
    // The hole wall itself (X 0.5, Z 0 to -5) lies on the model wall.
    expect([r.at(xEnd(9), -2), r.at(xIn(10), -2)]).toEqual([SurfaceClass.Within, SurfaceClass.Within])
  })

  it('reports a sliver standing 0.15 mm or more inside a through-hole outline as leftover', () => {
    // Cells 13..18 (X 0.65 to 0.95) uncut, every other hole cell cut through: 0.15 mm from the wall.
    const r = classify(model(MODEL_THROUGH), row([10, 0], [3, -10.3], [6, 0], [11, -10.3]))

    expect(r.summary.leftoverCells).toBe(6)
    expect(r.findings.filter((f) => f.kind === 'leftover')).toHaveLength(1)
    expect([r.at(xIn(13), 0), r.at(xEnd(18), 0)]).toEqual([SurfaceClass.Leftover, SurfaceClass.Leftover])
    // Both walls of the sliver, full height.
    for (const x of [xEnd(12), xIn(13), xEnd(18), xIn(19)]) expect(r.at(x, -6)).toBe(SurfaceClass.Leftover)
  })

  it('colours a part wall cut 0.3 mm wide of the outline leftover, top strip and wall', () => {
    // Outside the part from X 0.5; the machined wall stands at X 0.8 (cells 10..15 uncut).
    const r = classify(model(MODEL_OUTSIDE), row([16, 0], [14, -10.3]))

    // Top strip: the first 0.1 mm from the model wall is within tolerance, the rest leftover.
    expect([10, 11, 12, 15].map((k) => r.at(xIn(k) + 0.02, 0))).toEqual([SurfaceClass.Within, SurfaceClass.Within, SurfaceClass.Leftover, SurfaceClass.Leftover])
    for (const x of [xEnd(15), xIn(16)]) expect([0, -5, -9.95].map((z) => r.at(x, z))).toEqual(Array(3).fill(SurfaceClass.Leftover))
  })

  it('colours a part wall cut 0.05 mm wide of the outline within tolerance', () => {
    const r = classify(model(MODEL_OUTSIDE), row([11, 0], [19, -10.3]))

    expect(r.summary.leftoverCells).toBe(0)
    for (const x of [xIn(10) + 0.02, xEnd(10), xIn(11)]) expect([0, -5, -9.95].map((z) => r.at(x, z))).toEqual(Array(3).fill(SurfaceClass.Within))
  })

  it('colours a leftover column one cell wide over its whole square, though its top is drawn as a slope', () => {
    // Part top at Z -3. Cell 11 stands at Z -2.95, 0.1 mm from the part wall, its neighbours cut
    // through: 0.112 mm from the model's top edge, so leftover, with its leftover limit at Z -3.
    // Between cell centres its top is drawn sloping down to Z -6.625 at the cell's edges.
    const m = model(MODEL_THROUGH)
    m.top.fill(-3, 0, 10)
    const r = classify(m, row([10, -3], [1, -10.3], [1, -2.95], [18, -10.3]))
    const slope = (x: number) => -2.95 - (Math.abs(x - 0.575) / 0.05) * 7.35

    expect(r.summary.leftoverCells).toBe(1)
    for (const x of [0.551, 0.56, 0.575, 0.59, 0.599]) expect(r.at(x, slope(x))).toBe(SurfaceClass.Leftover)
    // The rest of the slope, in the squares of the cut-through cells, is the column's wall.
    for (const x of [0.545, 0.53, 0.605, 0.62]) expect(r.at(x, slope(x))).toBe(SurfaceClass.Leftover)
  })

  it('colours a leftover ring around a drilled opening leftover on its top, inner wall and bottom face', () => {
    // Through-hole from X 0.5: cells 10..19 hold a drill cone ring 0.95 mm high, cells 20.. are the
    // opening the drill tip made.
    const r = classify(model(MODEL_THROUGH), row([10, 0], [10, -9.05], [10, -10.3]))
    const m = model(MODEL_THROUGH)
    const limits = toleranceLimits(grid, m, tol, grid.bottom)
    const classes = cellClasses(m, new Uint8Array(N), grid.bottom, tol.leftover)

    expect(r.at(xIn(15), -9.05)).toBe(SurfaceClass.Leftover)
    for (const x of [xEnd(19), xIn(20)]) expect([-9.1, -9.5, -9.99].map((z) => r.at(x, z))).toEqual(Array(3).fill(SurfaceClass.Leftover))
    expect(bottomFaceClass(classes[15], -9.05, limits.leftoverAbove[15])).toBe(SurfaceClass.Leftover)
  })

  it('colours the bottom face leftover inside a through-hole left with a cone, within under the part', () => {
    // Through-hole from X 0.5, not drilled through: a stepped cone of material is left on the stock
    // bottom, 0.95 mm high (cells 10..19) and 0.5 mm high (cells 20..29).
    const m = model(MODEL_THROUGH)
    const heights = Float32Array.from(row([10, 0], [10, -9.05], [10, -9.5]))
    const limits = toleranceLimits(grid, m, tol, grid.bottom)
    const classes = cellClasses(m, new Uint8Array(N), grid.bottom, tol.leftover)
    const bottom = (k: number) => bottomFaceClass(classes[k], heights[k], limits.leftoverAbove[k])

    expect([bottom(15), bottom(25)]).toEqual([SurfaceClass.Leftover, SurfaceClass.Leftover])
    expect(bottom(5)).toBe(SurfaceClass.Within)
  })

  it('colours a wall cut 0.3 mm into the part a gouge over its full height', () => {
    // Part cells 0..9; the machined wall stands at X 0.2 (cells 4..9 cut through).
    const r = classify(model(MODEL_OUTSIDE), row([4, 0], [26, -10.3]))

    for (const x of [xEnd(3), xIn(4)]) expect([-0.1, -5, -9.9].map((z) => r.at(x, z))).toEqual(Array(3).fill(SurfaceClass.Gouge))
    // The top next to it is untouched and within tolerance.
    expect(r.at(xIn(2), 0)).toBe(SurfaceClass.Within)
  })
})

// The zone is a ball: material whose true distance to the model is above the leftover tolerance is
// leftover. Model cells are sampled at their centres, which all lie in the model, so a sampled
// distance is never below the true one: a cell farther than the tolerance from the true model wall
// is always leftover (cells closer than that may still be leftover by up to half a cell diagonal).
describe('sphere zone on round and 45 degree walls', () => {
  const cs = 0.05
  const n = 60 // 3 x 3 mm
  const sq = { nx: n, ny: n, cellSize: cs, originX: 0, originY: 0, top: 0, bottom: -10 }
  const centre = (k: number) => (k + 0.5) * cs

  function run(isModel: (x: number, y: number) => boolean, isMaterial: (x: number, y: number) => boolean) {
    const top = new Float32Array(n * n)
    const heights = new Float32Array(n * n)
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const c = j * n + i
        top[c] = isModel(centre(i), centre(j)) ? 0 : MODEL_THROUGH
        heights[c] = isMaterial(centre(i), centre(j)) ? 0 : -10.3
      }
    }
    const m: ModelGrid = { top, throughFloor: new Float32Array(n * n).fill(-10), partBottom: new Float32Array(n * n).fill(-10) }
    const limits = toleranceLimits(sq, m, tol, sq.bottom)
    return { heights, limits, leftover: (c: number) => heights[c] > limits.leftoverAbove[c], m }
  }

  it('reports the spike two cuts leave inside a round hole as leftover wherever it stands beyond the tolerance', () => {
    // Model: a through-hole of radius 1 at (1.5, 1.5). Two cuts of radius 0.5 at X 1.05 and 1.95
    // leave a spike above and below their overlap.
    const r = (x: number, y: number) => Math.hypot(x - 1.5, y - 1.5)
    const cut = (x: number, y: number) => Math.hypot(x - 1.05, y - 1.5) <= 0.5 || Math.hypot(x - 1.95, y - 1.5) <= 0.5
    const s = run((x, y) => r(x, y) >= 1, (x, y) => r(x, y) >= 1 || !cut(x, y))

    let beyond = 0
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const c = j * n + i
        if (s.heights[c] <= -10 || r(centre(i), centre(j)) >= 1) continue
        if (1 - r(centre(i), centre(j)) > tol.leftover) {
          beyond++
          expect(s.leftover(c)).toBe(true)
        }
      }
    }
    expect(beyond).toBeGreaterThan(50)
  })

  // The wall x + y = 2 at 45 degrees; the machined wall stands `offset` farther out, perpendicular.
  function wall45(offset: number) {
    const d = (x: number, y: number) => (x + y - 2) / Math.SQRT2
    return { d, s: run((x, y) => d(x, y) <= 0, (x, y) => d(x, y) <= offset) }
  }

  it('keeps a 45 degree wall 0.05 mm out within tolerance', () => {
    const { s } = wall45(0.05)

    let leftover = 0
    for (let c = 0; c < n * n; c++) if (s.leftover(c)) leftover++
    expect(leftover).toBe(0)
  })

  it('reports a 45 degree wall 0.3 mm out as leftover beyond the tolerance, its wall face included', () => {
    const { d, s } = wall45(0.3)

    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const dist = d(centre(i), centre(j))
        if (dist > tol.leftover && dist <= 0.3) expect(s.leftover(j * n + i)).toBe(true)
      }
    }
    // A point of the machined wall face at mid height.
    const classes = cellClasses(s.m, new Uint8Array(n * n), sq.bottom, tol.leftover)
    const x = 1 + 0.3 * Math.SQRT1_2
    expect(surfaceClassAt(sq, s.heights, null, s.limits, classes, x + 0.012, 1 + 0.3 * Math.SQRT1_2 - 0.003, -5)).toBe(SurfaceClass.Leftover)
  })
})
