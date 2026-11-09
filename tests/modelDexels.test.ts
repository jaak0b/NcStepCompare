import { describe, expect, it } from 'vitest'
import { rasterizePartDexels, type PartModelDexels } from '../src/engine/modelDexels'

// Grid 5 x 5 mm, cells 1/16 mm, origin 0: cell (i, j) has its centre at ((i + 0.5) / 16, (j + 0.5) / 16).
// Binary fractions, so mesh corners (float32) lie exactly on cell centres.
const grid = { nx: 80, ny: 80, cellSize: 0.0625, originX: 0, originY: 0 }

/** Closed box mesh: 8 corners, 12 triangles; the top and bottom are split along the (x0, y0)-(x1, y1) diagonal. */
function box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, base = 0) {
  const positions = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ].flat()
  const quads = [
    [0, 3, 2, 1], [4, 5, 6, 7], // bottom, top
    [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7], // sides
  ]
  const indices = quads.flatMap(([a, b, c, d]) => [a, b, c, a, c, d]).map((v) => v + base)
  return { positions, indices }
}

function mesh(...parts: ReturnType<typeof box>[]) {
  return { positions: new Float32Array(parts.flatMap((p) => p.positions)), indices: new Uint32Array(parts.flatMap((p) => p.indices)) }
}

const intervals = (d: PartModelDexels, i: number, j: number) => {
  const c = (j - d.j0) * d.w + (i - d.i0)
  return [...d.z.subarray(d.offsets[c], d.offsets[c + 1])]
}

describe('model dexels', () => {
  // Two boxes over the same square (X and Y 1.03125 to 2.03125: centres of cells 16 and 32), Z 0
  // to 2 and Z 5 to 7: a model with an undercut gap from Z 2 to 5.
  const two = mesh(box(1.03125, 2.03125, 1.03125, 2.03125, 0, 2), box(1.03125, 2.03125, 1.03125, 2.03125, 5, 7, 8))

  it('stores both material intervals of a column under an overhang', () => {
    const d = rasterizePartDexels(grid, two.positions, two.indices)

    expect(intervals(d, 20, 20)).toEqual([0, 2, 5, 7])
    expect(d.oddColumns).toBe(0)
  })

  it('counts a centre on the shared diagonal of two triangles once', () => {
    const d = rasterizePartDexels(grid, two.positions, two.indices)

    expect(intervals(d, 24, 24)).toEqual([0, 2, 5, 7]) // centre 1.53125, 1.53125 on the diagonal
  })

  // Top-left rule: the left edge X 1.03125 and the top edge Y 2.03125 own their centres; the right
  // edge X 2.03125 and the bottom edge Y 1.03125 do not.
  it('gives centres on the box outline to the left and top edges only', () => {
    const d = rasterizePartDexels(grid, two.positions, two.indices)

    expect(intervals(d, 16, 24)).toEqual([0, 2, 5, 7])
    expect(intervals(d, 24, 32)).toEqual([0, 2, 5, 7])
    expect(intervals(d, 32, 24)).toEqual([])
    expect(intervals(d, 24, 16)).toEqual([])
  })

  // A top face alone is not closed: its 16 x 16 owned centres (columns 16 to 31, rows 17 to 32)
  // each have one crossing.
  it('reports the columns of an open mesh instead of guessing', () => {
    const top = box(1.03125, 2.03125, 1.03125, 2.03125, 0, 2)
    const open = { positions: new Float32Array(top.positions), indices: new Uint32Array(top.indices.slice(6, 12)) }

    const d = rasterizePartDexels(grid, open.positions, open.indices)

    expect(d.oddColumns).toBe(256)
    expect(d.z.length).toBe(0)
  })
})
