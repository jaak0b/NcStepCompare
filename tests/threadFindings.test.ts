import { describe, expect, it } from 'vitest'
import { DeviationTracker, toleranceLimits } from '../src/engine/deviation'
import { labelComponents } from '../src/engine/findings/clusters'
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
const threadedHole =
  'T1 M6\nG0 X5.025 Y5.025 Z5\nG1 Z-6 F100\nG0 Z5\n' +
  'T2 M6\nG0 X5.025 Y5.025 Z5\nG1 Z-5 F100\nG1 X5.315\nG91\n' +
  'G3 X0 Y0 I-0.29 J0 Z0.5\n'.repeat(4) +
  'G90\nG1 X5.025 Y5.025\nG0 Z5\n'

// The hole model: material with its top at Z 0, the 2.5 mm hole's floor at Z -6.
function holeModel(g: { nx: number; ny: number }) {
  const top = new Float32Array(g.nx * g.ny).fill(0)
  for (let j = 0; j < g.ny; j++) {
    for (let i = 0; i < g.nx; i++) {
      if (Math.hypot(0.025 + 0.05 * i - 5.025, 0.025 + 0.05 * j - 5.025) <= 1.25) top[j * g.nx + i] = -6
    }
  }
  return { top, throughFloor: new Float32Array(g.nx * g.ny).fill(NaN), partBottom: new Float32Array(g.nx * g.ny).fill(-10) }
}

describe('thread findings on the dexel stock', () => {
  const job = parseGcode(threadedHole)
  const sim = new MaterialSimulation(stock, 0.05, job.moves, new Map([[1, profile({ kind: 'flat end mill', diameter: 2.5, cornerRadius: 0, tipAngle: 0 })], [2, profile(threadMill)]]), [])
  sim.advanceTo(job.moves.count)
  const g = sim.grid
  const model = holeModel(g)
  const tol = { gouge: 0.05, leftover: 0.1 }
  const input = {
    grid: g,
    heights: g.heights,
    model,
    limits: toleranceLimits(g, model, tol, g.bottom),
    lastCut: sim.lastCut,
    moveTool: job.moves.tool,
    moveLine: job.moves.line,
    moveStart: job.moves.start,
    moveEnd: job.moves.end,
    threadMills: new Set([2]),
  }

  it('reports the grooved ring as one thread with its pitch, and no gouge', () => {
    const { findings } = analyseStock({ ...input, deviation: intervalDeviation(g, expectedSolid(g, model, [], g.bottom), tol, toleranceLimits(g, model, tol, g.bottom)) })

    expect(findings.filter((f) => f.kind === 'gouge')).toEqual([])
    const threads = findings.filter((f) => f.kind === 'thread')
    expect(threads).toHaveLength(1)
    expect(threads[0].rows.find((r) => r.label === 'Pitch')?.value).toBe('0.500 mm')
  })

  it('misses the grooves when only the top heights are compared', () => {
    const { findings } = analyseStock(input)

    expect(findings.filter((f) => f.kind === 'thread')).toEqual([])
  })

  it('counts the grooves below the rim as gouge cells, as the findings do', () => {
    const dev = intervalDeviation(g, expectedSolid(g, model, [], g.bottom), tol, toleranceLimits(g, model, tol, g.bottom))
    let columns = 0
    for (let c = 0; c < g.nx * g.ny; c++) if (dev.gouge.offsets[c + 1] > dev.gouge.offsets[c]) columns++

    const s = new DeviationTracker(g.nx, model, input.limits, g.bottom, g.heights, g.top, g.dexels).summary()

    expect(columns).toBeGreaterThan(0)
    expect(s.gougeCells).toBe(columns)
  })
})

// The same threaded hole, then a 1 mm end mill plunges 2 mm deep beside it (centre X 7.075), into
// the model's material: a gouge whose cells touch the thread ring.
describe('a gouge next to a thread-milled hole', () => {
  const gcode = threadedHole + 'T3 M6\nG0 X7.075 Y5.025 Z5\nG1 Z-2 F100\nG0 Z5\n'
  const job = parseGcode(gcode)
  const sim = new MaterialSimulation(
    stock,
    0.05,
    job.moves,
    new Map([
      [1, profile({ kind: 'flat end mill', diameter: 2.5, cornerRadius: 0, tipAngle: 0 })],
      [2, profile(threadMill)],
      [3, profile({ kind: 'flat end mill', diameter: 1, cornerRadius: 0, tipAngle: 0 })],
    ]),
    [],
  )
  sim.advanceTo(job.moves.count)
  const g = sim.grid
  const model = holeModel(g)
  const tol = { gouge: 0.05, leftover: 0.1 }
  const deviation = intervalDeviation(g, expectedSolid(g, model, [], g.bottom), tol, toleranceLimits(g, model, tol, g.bottom))

  it('reports one gouge and one thread, though their cells touch', () => {
    const flags = new Uint8Array(g.nx * g.ny)
    for (let c = 0; c < flags.length; c++) flags[c] = deviation.gouge.offsets[c + 1] > deviation.gouge.offsets[c] ? 1 : 0
    expect(labelComponents(flags, g.nx, g.ny).count).toBe(1)

    const { findings } = analyseStock({
      grid: g,
      heights: g.heights,
      model,
      limits: toleranceLimits(g, model, tol, g.bottom),
      lastCut: sim.lastCut,
      moveTool: job.moves.tool,
      moveLine: job.moves.line,
      moveStart: job.moves.start,
      moveEnd: job.moves.end,
      threadMills: new Set([2]),
      deviation,
    })

    expect(findings.filter((f) => f.kind === 'thread')).toHaveLength(1)
    const gouges = findings.filter((f) => f.kind === 'gouge')
    expect(gouges).toHaveLength(1)
    expect(gouges[0].rows.find((r) => r.label === 'Last cut by')?.value).toMatch(/^T3,/)
  })
})
