import { describe, expect, it } from 'vitest'
import { parseGcode } from '../src/engine/gcodeParser'
import { heightAt } from '../src/engine/heightGrid'
import { MaterialSimulation } from '../src/engine/simulation'
import { cutterProfile, profileHeight, type CutterProfile, type CutterShape } from '../src/engine/toolShape'

const profile = (shape: CutterShape): CutterProfile => {
  const p = cutterProfile(shape)
  if (typeof p === 'string') throw new Error(p)
  return p
}

describe('cutter profile height above the tip', () => {
  it.each([
    ['flat end mill', { kind: 'flat end mill', diameter: 3.175, cornerRadius: 0, tipAngle: 0 }, 1.5, 0],
    ['ball end D2 at r 0.6', { kind: 'ball end', diameter: 2, cornerRadius: 0, tipAngle: 0 }, 0.6, 0.2],
    ['ball end D2 at the rim', { kind: 'ball end', diameter: 2, cornerRadius: 0, tipAngle: 0 }, 1, 1],
    ['bull nose D6 rc1 on the flat', { kind: 'flat end mill', diameter: 6, cornerRadius: 1, tipAngle: 0 }, 2, 0],
    ['bull nose D6 rc1 in the corner', { kind: 'flat end mill', diameter: 6, cornerRadius: 1, tipAngle: 0 }, 2.6, 0.2],
    ['90 degree V-bit', { kind: 'V-bit', diameter: 6, cornerRadius: 0, tipAngle: 90 }, 1, 1],
    ['118 degree drill', { kind: 'drill', diameter: 2.5, cornerRadius: 0, tipAngle: 118 }, 1.25, 0.75108],
    ['thread mill', { kind: 'thread mill', diameter: 2.42, cornerRadius: 0, tipAngle: 0 }, 1.2, 0],
  ] as [string, CutterShape, number, number][])('%s', (_name, shape, r, expected) => {
    expect(profileHeight(profile(shape), r)).toBeCloseTo(expected, 5)
  })
})

// Stock 20 x 10 x 5 mm, top at Z 0, grid cell 0.05 mm. Cell centres sit at odd multiples of 0.025,
// so paths along Y 5.025 put the tool axis exactly over a row of cell centres.
const stock = { min: { x: 0, y: 0, z: -5 }, max: { x: 20, y: 10, z: 0 } }

function simulate(gcode: string, shape: CutterShape) {
  const job = parseGcode(gcode)
  const sim = new MaterialSimulation(stock, 0.05, job.moves, new Map([[1, profile(shape)]]), [])
  sim.advanceTo(job.moves.count)
  return sim
}

describe('material removal on the height grid', () => {
  it('cuts a 3.175 mm flat end mill slot 1 mm deep and 3.175 mm wide', () => {
    const sim = simulate('T1 M6\nG0 X5 Y5 Z5\nG1 Z-1 F100\nG1 X15', { kind: 'flat end mill', diameter: 3.175, cornerRadius: 0, tipAngle: 0 })

    expect(heightAt(sim.grid, 10, 5)).toBeCloseTo(-1, 6)
    expect(heightAt(sim.grid, 10, 6.5)).toBeCloseTo(-1, 6) // cell centre 6.525: 1.525 mm off the axis
    expect(heightAt(sim.grid, 10, 6.65)).toBe(0) // cell centre 6.675: 1.675 mm off the axis
    expect(heightAt(sim.grid, 16.5, 5)).toBeCloseTo(-1, 6) // inside the end radius
    expect(heightAt(sim.grid, 16.65, 5)).toBe(0)
  })

  // The slot move sweeps a 10 x 3.175 rectangle plus two half discs; the plunge before it already
  // removed one full disc, so the move itself removes 10 x 3.175 x 1 = 31.75 mm^3. The grid resolves
  // the outline (about 30 mm long) to half a cell, so +/- 0.75 mm^3.
  it('reports the volume the slot move removed', () => {
    const sim = simulate('T1 M6\nG0 X5 Y5 Z5\nG1 Z-1 F100\nG1 X15', { kind: 'flat end mill', diameter: 3.175, cornerRadius: 0, tipAngle: 0 })

    expect(sim.removedVolume[1]).toBeGreaterThan(31.75 - 0.75)
    expect(sim.removedVolume[1]).toBeLessThan(31.75 + 0.75)
    expect(sim.maxCutDepth[1]).toBeCloseTo(1, 6)
  })

  // Groove floor at offset d from the axis: -1 + 2 - sqrt(4 - d^2).
  it('cuts the round cross-section of a 4 mm ball end groove', () => {
    const sim = simulate('T1 M6\nG0 X5 Y5.025 Z5\nG1 Z-1 F100\nG1 X15', { kind: 'ball end', diameter: 4, cornerRadius: 0, tipAngle: 0 })

    expect(heightAt(sim.grid, 10, 5.03)).toBeCloseTo(-1, 6)
    expect(heightAt(sim.grid, 10, 6.03)).toBeCloseTo(-0.73205, 5) // d = 1.0
    expect(heightAt(sim.grid, 10, 6.73)).toBeCloseTo(-0.053565, 5) // d = 1.7
    expect(heightAt(sim.grid, 10, 6.78)).toBe(0) // d = 1.75, above the stock top
  })

  it('cuts a 90 degree V-bit line 2 mm wide at 1 mm depth', () => {
    const sim = simulate('T1 M6\nG0 X5 Y5.025 Z5\nG1 Z-1 F100\nG1 X15', { kind: 'V-bit', diameter: 6, cornerRadius: 0, tipAngle: 90 })

    expect(heightAt(sim.grid, 10, 5.53)).toBeCloseTo(-0.5, 6) // d = 0.5
    expect(heightAt(sim.grid, 10, 5.98)).toBeCloseTo(-0.05, 5) // d = 0.95
    expect(heightAt(sim.grid, 10, 6.08)).toBe(0) // d = 1.05
  })

  // Ramp 10 mm long dropping 1 mm, axis Z -0.5 at X 10.025. The lowest ball point over that cell
  // is at axis offset u = 0.19901 (u / sqrt(4 - u^2) = 0.1), height -0.50998.
  it('cuts the lowest point of a 4 mm ball end along a ramp', () => {
    const sim = simulate('T1 M6\nG0 X5.025 Y5.025 Z5\nG1 Z0 F100\nG1 X15.025 Z-1', { kind: 'ball end', diameter: 4, cornerRadius: 0, tipAngle: 0 })

    expect(heightAt(sim.grid, 10.03, 5.03)).toBeCloseTo(-0.50998, 4)
  })

  it('restores the earlier state when seeking backwards', () => {
    const job = parseGcode('T1 M6\nG0 X5 Y5 Z5\nG1 Z-1 F100\nG1 X15\nG1 Z-2')
    const sim = new MaterialSimulation(stock, 0.05, job.moves, new Map([[1, profile({ kind: 'flat end mill', diameter: 3.175, cornerRadius: 0, tipAngle: 0 })]]), [1])
    sim.advanceTo(job.moves.count)

    sim.seek(2)

    expect(heightAt(sim.grid, 15, 5)).toBeCloseTo(-1, 6)
    expect(heightAt(sim.grid, 10, 5)).toBeCloseTo(-1, 6)
  })
})
