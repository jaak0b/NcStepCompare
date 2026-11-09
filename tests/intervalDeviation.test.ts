import { describe, expect, it } from 'vitest'
import { createDexelStock } from '../src/engine/dexelStock'
import { expectedSolid, intervalDeviation, type IntervalSets } from '../src/engine/intervalDeviation'

// A row of 5 cells, 1 mm each, stock Z -10 to 0. The part covers cells 1 to 3 with its top at Z -2
// and its bottom on the stock bottom; cell 2 of the model has an undercut from Z -6 to -4. Cells 0
// and 4 are outside the outline. Tolerances 0.5 mm on 1 mm cells: the XY window is the cell itself.
const box = { min: { x: 0, y: 0, z: -10 }, max: { x: 5, y: 1, z: 0 } }
const geometry = { nx: 5, ny: 1, cellSize: 1, originX: 0, originY: 0 }
const model = {
  top: new Float32Array([NaN, -2, -2, -2, NaN]),
  throughFloor: new Float32Array(5).fill(NaN),
  partBottom: new Float32Array([NaN, -10, -10, -10, NaN]),
}
const partDexels = {
  i0: 1, j0: 0, w: 3, h: 1,
  offsets: new Int32Array([0, 2, 6, 8]),
  z: new Float32Array([-10, -2, -10, -6, -4, -2, -10, -2]),
  oddColumns: 0,
}
const at = (s: IntervalSets, c: number) => [...s.z.subarray(s.offsets[c], s.offsets[c + 1])]

function compare(tol = 0.5) {
  const stock = createDexelStock(box, 1)
  stock.dexels.subtract(1, -3, Infinity) // cell 1 cut 1 mm below the model top
  stock.dexels.subtract(2, -2, Infinity) // cell 2 cut to the model top, its undercut not cut
  stock.dexels.subtract(3, -2, Infinity)
  stock.dexels.subtract(3, -8, -7) // a groove below the model surface in cell 3
  stock.dexels.subtract(4, -10.3, Infinity) // cut through outside the part
  const expected = expectedSolid(geometry, model, [partDexels], -10)
  return intervalDeviation(stock, expected, { gouge: tol, leftover: tol })
}

describe('deviation as Z intervals per column', () => {
  it('gives the height comparison result for a column with one interval', () => {
    const d = compare()

    expect(at(d.gouge, 1)).toEqual([-3, -2.5]) // below the gouge limit -2.5
    expect(at(d.leftover, 1)).toEqual([])
    expect(at(d.leftover, 0)).toEqual([-9.5, 0]) // outside: leftover above the stock bottom + 0.5
    expect(at(d.gouge, 0)).toEqual([])
    expect(at(d.gouge, 4)).toEqual([])
    expect(at(d.leftover, 4)).toEqual([])
  })

  it('finds material left in a model undercut and a groove cut below the model surface', () => {
    const d = compare()

    expect(at(d.leftover, 2)).toEqual([-5.5, -4.5]) // the undercut -6..-4, less 0.5 each side
    expect(at(d.gouge, 2)).toEqual([])
    expect(at(d.gouge, 3)).toEqual([-8, -7])
    expect(at(d.leftover, 3)).toEqual([])
  })

  // Tolerance 1 mm: the window takes one neighbour on each side. Cells 1 and 3 border the outside,
  // whose expected solid ends at the stock bottom, so nothing there is a gouge; cell 2's undercut
  // lies within 1 mm of the material of cells 1 and 3, so it is not leftover; cell 0 is leftover
  // only above Z -2 + 1 = -1, the part top next to it plus the tolerance.
  it('applies the tolerance window across neighbouring columns', () => {
    const d = compare(1)

    expect(at(d.gouge, 1)).toEqual([])
    expect(at(d.gouge, 3)).toEqual([])
    expect(at(d.leftover, 2)).toEqual([])
    expect(at(d.leftover, 0)).toEqual([-1, 0])
  })
})
