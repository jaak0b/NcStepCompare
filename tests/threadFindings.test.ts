import { describe, expect, it } from 'vitest'
import { toleranceLimits } from '../src/engine/deviation'
import { analyseStock } from '../src/engine/findings/stockFindings'
import { parseGcode } from '../src/engine/gcodeParser'
import { expectedSolid, intervalDeviation } from '../src/engine/intervalDeviation'
import { MaterialSimulation } from '../src/engine/simulation'
import { cutterProfile, type CutterProfile, type CutterShape } from '../src/engine/toolShape'

const profile = (shape: CutterShape) => cutterProfile(shape) as CutterProfile
// ISO 68-1 M3 x 0.5 single-tooth thread mill (values as in threadMill.test.ts).
const threadMill: CutterShape = {
  kind: 'thread mill', diameter: 2.42, cornerRadius: 0, tipAngle: 0,
  pitch: 0.5, profileAngle: 60, teeth: 1, toothTipFlat: 0.0625, neckDiameter: 1.8787342, toothOffset: 0.1875,
}
const stock = { min: { x: 0, y: 0, z: -10 }, max: { x: 10, y: 10, z: 0 } }

// A 2.5 mm hole 6 mm deep at (5.025, 5.025), drilled with a 2.5 mm flat end mill, then threaded
// with four helix turns from tip Z -5 up to -3. The model has the same hole without the thread.
describe('thread findings on the dexel stock', () => {
  const gcode =
    'T1 M6\nG0 X5.025 Y5.025 Z5\nG1 Z-6 F100\nG0 Z5\n' +
    'T2 M6\nG0 X5.025 Y5.025 Z5\nG1 Z-5 F100\nG1 X5.315\nG91\n' +
    'G3 X0 Y0 I-0.29 J0 Z0.5\n'.repeat(4) +
    'G90\nG1 X5.025 Y5.025\nG0 Z5\n'
  const job = parseGcode(gcode)
  const sim = new MaterialSimulation(stock, 0.05, job.moves, new Map([[1, profile({ kind: 'flat end mill', diameter: 2.5, cornerRadius: 0, tipAngle: 0 })], [2, profile(threadMill)]]), [])
  sim.advanceTo(job.moves.count)
  const g = sim.grid
  const top = new Float32Array(g.nx * g.ny).fill(0)
  for (let j = 0; j < g.ny; j++) {
    for (let i = 0; i < g.nx; i++) {
      if (Math.hypot(0.025 + 0.05 * i - 5.025, 0.025 + 0.05 * j - 5.025) <= 1.25) top[j * g.nx + i] = -6
    }
  }
  const model = { top, throughFloor: new Float32Array(g.nx * g.ny).fill(NaN), partBottom: new Float32Array(g.nx * g.ny).fill(-10) }
  const tol = { gouge: 0.05, leftover: 0.1 }
  const input = {
    grid: g,
    heights: g.heights,
    model,
    limits: toleranceLimits(g, model, tol, g.bottom),
    lastCut: sim.lastCut,
    moveTool: job.moves.tool,
    moveLine: job.moves.line,
    threadMills: new Set([2]),
  }

  it('reports the grooved ring as one thread with its pitch, and no gouge', () => {
    const { findings } = analyseStock({ ...input, deviation: intervalDeviation(g, expectedSolid(g, model, [], g.bottom), tol) })

    expect(findings.filter((f) => f.kind === 'gouge')).toEqual([])
    const threads = findings.filter((f) => f.kind === 'thread')
    expect(threads).toHaveLength(1)
    expect(threads[0].rows.find((r) => r.label === 'Pitch')?.value).toBe('0.500 mm')
  })

  it('misses the grooves when only the top heights are compared', () => {
    const { findings } = analyseStock(input)

    expect(findings.filter((f) => f.kind === 'thread')).toEqual([])
  })
})
