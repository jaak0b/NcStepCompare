import { describe, expect, it } from 'vitest'
import { autoOrient } from '../src/engine/autoOrient'
import { mergePartGrids, rasterizePart } from '../src/engine/modelGrid'
import { placePositions } from '../src/engine/partPlacement'

/** A 4 x 3 mm plate, top Z -0.5, bottom Z -2, with a 1 x 1 mm hole near one corner (0.5..1.5). */
function plate(): { positions: Float32Array; indices: Uint32Array } {
  const ring = [
    [0, 0],
    [4, 0],
    [4, 3],
    [0, 3],
    [0.5, 0.5],
    [1.5, 0.5],
    [1.5, 1.5],
    [0.5, 1.5],
  ]
  const positions: number[] = []
  for (const [x, y] of ring) positions.push(x, y, -0.5)
  for (const [x, y] of ring) positions.push(x, y, -2)
  const indices: number[] = []
  for (const [a, b, c, d] of [
    [0, 1, 5, 4],
    [1, 2, 6, 5],
    [2, 3, 7, 6],
    [3, 0, 4, 7],
  ]) {
    indices.push(a, b, c, a, c, d, a + 8, c + 8, b + 8, a + 8, d + 8, c + 8)
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) }
}

describe('auto-orient position search', () => {
  it('finds the orientation and centre the part was cut at, starting 1 mm away', () => {
    // Stock 10 x 8 mm, Z 0 to -2, 0.1 mm cells. The machined result: the plate at centre (6.0, 4.0),
    // Z up, unrotated; everything else (and the hole) cut through to Z -2.2.
    const grid = { nx: 100, ny: 80, cellSize: 0.1, originX: 0, originY: 0, top: 0, bottom: -2 }
    const mesh = plate()
    const truth = { upAxis: '+Z', quarterTurns: 0, centerX: 6, centerY: 4, bottomZ: -2 } as const
    const model = mergePartGrids(grid, [rasterizePart(grid, placePositions(mesh, truth), mesh.indices)])
    const machined = model.top.map((v) => (Number.isFinite(v) ? v : -2.2))

    const best = autoOrient(grid, machined, mesh, { centerX: 5, centerY: 4, bottomZ: -2 })[0]

    expect([best.upAxis, best.quarterTurns]).toEqual(['+Z', 0])
    expect(best.centerX).toBeCloseTo(6, 6)
    expect(best.centerY).toBeCloseTo(4, 6)
  })
})
