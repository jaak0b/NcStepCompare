import { describe, expect, it } from 'vitest'
import { createDexelStock } from '../src/engine/dexelStock'

// Stock 1 x 1 x 10 mm, top Z 0, bottom Z -10, one 1 mm cell: column 0. Values are exact in float32.
const box = { min: { x: 0, y: 0, z: -10 }, max: { x: 1, y: 1, z: 0 } }
const gapsOf = (s: ReturnType<typeof createDexelStock>, c = 0) => [...s.dexels.gapView(c)]

describe('dexel stock interval subtraction', () => {
  it('cuts a gap below the top and reports the removed thickness', () => {
    const s = createDexelStock(box, 1)

    const removed = s.dexels.subtract(0, -4, -2)

    expect(removed).toBe(2)
    expect(s.heights[0]).toBe(0)
    expect(gapsOf(s)).toEqual([-4, -2])
  })

  it('merges a gap that touches another exactly, and keeps a separate one apart', () => {
    const s = createDexelStock(box, 1)
    s.dexels.subtract(0, -4, -2)
    s.dexels.subtract(0, -8, -6)

    s.dexels.subtract(0, -2, -1)

    expect(gapsOf(s)).toEqual([-8, -6, -4, -1])
  })

  it('removes only the material between gaps when a cut spans them', () => {
    const s = createDexelStock(box, 1)
    s.dexels.subtract(0, -4, -2)
    s.dexels.subtract(0, -8, -6)

    const removed = s.dexels.subtract(0, -7, -3)

    expect(removed).toBe(2) // material -6..-4
    expect(gapsOf(s)).toEqual([-8, -2])
  })

  it('lowers the top to the cut and joins a gap the cut reaches', () => {
    const s = createDexelStock(box, 1)
    s.dexels.subtract(0, -4, -2)

    const removed = s.dexels.subtract(0, -3, Infinity)

    expect(removed).toBe(2) // material -2..0
    expect(s.heights[0]).toBe(-4)
    expect(gapsOf(s)).toEqual([])
  })

  it('reports no change for a cut inside air', () => {
    const s = createDexelStock(box, 1)
    s.dexels.subtract(0, -4, -2)

    expect(s.dexels.subtract(0, -3.5, -2.5)).toBe(-1)
    expect(s.dexels.subtract(0, 1, 2)).toBe(-1)
  })

  it('keeps the real depth of a cut into the spoilboard', () => {
    const s = createDexelStock(box, 1)

    const removed = s.dexels.subtract(0, -10.5, Infinity)

    expect(removed).toBe(10)
    expect(s.heights[0]).toBe(-10.5)
  })
})

describe('dexel stock pool and checkpoints', () => {
  it('holds 300 gaps in one column after the pool grows', () => {
    const s = createDexelStock(box, 1)
    // Gaps 1/64 mm wide every 1/32 mm from Z -9.5: binary fractions, exact in float32.
    for (let k = 0; k < 300; k++) s.dexels.subtract(0, -9.5 + k / 32, -9.5 + k / 32 + 1 / 64)

    expect(s.dexels.gapCount(0)).toBe(300)
    expect(gapsOf(s).slice(0, 2)).toEqual([-9.5, -9.484375])
    expect(gapsOf(s).slice(598)).toEqual([-0.15625, -0.140625])
  })

  it('restores the gaps of a recorded rectangle after they changed', () => {
    // 300 x 2 cells: columns across three tiles of 128.
    const s = createDexelStock({ min: { x: 0, y: 0, z: -10 }, max: { x: 300, y: 2, z: 0 } }, 1)
    s.dexels.subtract(5, -4, -2)
    s.dexels.subtract(299 + 300, -7, -6)
    const rec = s.dexels.record(0, 299, 0, 1)
    s.dexels.subtract(5, -9, -1)
    s.dexels.subtract(200, -5, -3)

    s.dexels.clearRect(0, 299, 0, 1)
    s.dexels.apply(rec)

    expect(gapsOf(s, 5)).toEqual([-4, -2])
    expect(gapsOf(s, 599)).toEqual([-7, -6])
    expect(gapsOf(s, 200)).toEqual([])
    expect(s.dexels.gapColumnCount).toBe(2)
  })
})
