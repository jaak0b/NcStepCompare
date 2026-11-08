import { describe, expect, it } from 'vitest'
import { cellDeviation, footprintBounds, summarizeDeviation, toleranceLimits } from '../src/engine/deviation'
import { mergePartGrids, rasterizePart } from '../src/engine/modelGrid'
import { placePositions } from '../src/engine/partPlacement'

/**
 * A 1 x 1 mm plate with a 0.2 x 0.2 mm through-hole at (0.4..0.6, 0.4..0.6). The top face slopes:
 * z = -1 + 0.5 x. The bottom face is flat at z = -2. One outer wall is included (it is vertical).
 */
function plateWithHole(): { positions: Float32Array; indices: Uint32Array } {
  const ring = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
    [0.4, 0.4],
    [0.6, 0.4],
    [0.6, 0.6],
    [0.4, 0.6],
  ]
  const positions: number[] = []
  for (const [x, y] of ring) positions.push(x, y, -1 + 0.5 * x) // 0..7: top
  for (const [x, y] of ring) positions.push(x, y, -2) // 8..15: bottom
  const band = [
    [0, 1, 5, 4],
    [1, 2, 6, 5],
    [2, 3, 7, 6],
    [3, 0, 4, 7],
  ]
  const indices: number[] = []
  for (const [a, b, c, d] of band) {
    indices.push(a, b, c, a, c, d)
    indices.push(a + 8, c + 8, b + 8, a + 8, d + 8, c + 8)
  }
  // Front wall along y = 0.
  indices.push(0, 8, 9, 0, 9, 1)
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) }
}

// 12 x 12 cells of 0.1 mm starting at -0.1: cell centres at -0.05, 0.05, ..., 1.05.
const grid = { nx: 12, ny: 12, cellSize: 0.1, originX: -0.1, originY: -0.1 }
const at = (i: number, j: number) => j * grid.nx + i

describe('model grid rasterisation', () => {
  const mesh = plateWithHole()
  const model = mergePartGrids(grid, [rasterizePart(grid, mesh.positions, mesh.indices)])

  it('takes the top face height at each cell centre, not the bottom face', () => {
    expect(model[at(1, 1)]).toBeCloseTo(-0.975, 5) // centre (0.05, 0.05)
    expect(model[at(10, 3)]).toBeCloseTo(-0.525, 5) // centre (0.95, 0.25)
    expect(model[at(4, 5)]).toBeCloseTo(-0.825, 5) // centre (0.35, 0.55), next to the hole
  })

  it('marks the cells inside the hole as cut through', () => {
    expect(model[at(5, 5)]).toBe(-Infinity)
    expect(model[at(6, 6)]).toBe(-Infinity)
  })

  it('leaves cells outside the plate outline without a model height', () => {
    expect(model[at(0, 0)]).toBeNaN()
    expect(model[at(11, 6)]).toBeNaN()
    expect(model[at(6, 11)]).toBeNaN()
  })
})

describe('deviation', () => {
  it('is negative where the stock is cut below the model and positive where material is left', () => {
    expect(cellDeviation(-1.2, -1, -10)).toBeCloseTo(-0.2, 12)
    expect(cellDeviation(-0.9, -1, -10)).toBeCloseTo(0.1, 12)
  })

  it('counts only material above the stock bottom in a through-hole, and nothing outside the parts', () => {
    expect(cellDeviation(-10.3, -Infinity, -10)).toBe(0)
    expect(cellDeviation(-9, -Infinity, -10)).toBe(1)
    expect(cellDeviation(-5, NaN, -10)).toBeNull()
  })

  // A wall between a top at Z -1 (cells 0..2) and a floor at Z -3 (cells 3..5), 0.05 mm cells.
  const row = { nx: 6, ny: 1, cellSize: 0.05, originX: 0, originY: 0 }
  const model = Float32Array.from([-1, -1, -1, -3, -3, -3])
  const tolerances = { gouge: 0.05, leftover: 0.1 }

  it('accepts a wall cut one cell (0.05 mm, the gouge tolerance) too far as within tolerance', () => {
    const machined = Float32Array.from([-1, -1, -3, -3, -3, -3])
    const limits = toleranceLimits(row, model, -10, tolerances)

    const s = summarizeDeviation(row.nx, machined, model, limits, -10, footprintBounds(row, model))

    expect(s.gougeCells).toBe(0)
  })

  it('reports a gouge where the wall is cut two cells (0.10 mm) too far', () => {
    const machined = Float32Array.from([-1, -3, -3, -3, -3, -3])
    const limits = toleranceLimits(row, model, -10, tolerances)

    const s = summarizeDeviation(row.nx, machined, model, limits, -10, footprintBounds(row, model))

    expect(s.gougeCells).toBe(1)
    expect(s.maxGougeDepth).toBe(2)
  })
})

describe('part placement', () => {
  it('turns model +Y up, rotates 90 degrees about Z and moves the box centre and bottom into place', () => {
    const mesh = { positions: Float32Array.from([1, 2, 3, 0, 0, 0]), indices: new Uint32Array(0) }

    const placed = placePositions(mesh, { upAxis: '+Y', quarterTurns: 1, centerX: 10, centerY: 20, bottomZ: 5 })

    // (1, 2, 3) -> +Y up -> (1, -3, 2) -> 90 deg -> (3, 1, 2); the box x 0..3, y 0..1, z 0..2 then
    // moves by (8.5, 19.5, 5).
    expect([...placed]).toEqual([11.5, 20.5, 7, 8.5, 19.5, 5])
  })
})
