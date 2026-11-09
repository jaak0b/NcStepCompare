import { describe, expect, it } from 'vitest'
import { parseGcode } from '../src/engine/gcodeParser'
import { MaterialSimulation, planCheckpoints } from '../src/engine/simulation'
import { cutterProfile, type CutterProfile, type CutterShape } from '../src/engine/toolShape'
import { buildToolTable, toolProblems, withToolValue } from '../src/engine/toolTable'

const profile = (shape: CutterShape): CutterProfile => {
  const p = cutterProfile(shape)
  if (typeof p === 'string') throw new Error(p)
  return p
}

// M3 x 0.5 single-tooth thread mill, ISO 68-1 basic profile for P 0.5: H = 0.4330127,
// tooth depth 5/8 H = 0.2706329, tip flat P/8 = 0.0625, flanks at 30 degrees from the radial
// direction. Cutting diameter 2.42, so the neck diameter is 2.42 - 2 x 0.2706329 = 1.8787342.
// The tooth base spans 3/4 P = 0.375 from the tip, so its centre is 0.1875 above the tip.
const threadMill: CutterShape = {
  kind: 'thread mill',
  diameter: 2.42,
  cornerRadius: 0,
  tipAngle: 0,
  pitch: 0.5,
  profileAngle: 60,
  teeth: 1,
  toothTipFlat: 0.0625,
  neckDiameter: 1.8787342,
  toothOffset: 0.1875,
}
const preDrill: CutterShape = { kind: 'flat end mill', diameter: 2.5, cornerRadius: 0, tipAngle: 0 }

// Stock 10 x 10 x 10 mm, top Z 0, cells 0.05 mm. The hole centre (5.025, 5.025) is a cell centre.
// T1 cuts the 2.5 mm pre-drilled hole to Z -6. T2 enters at the centre, moves out to the orbit
// radius 0.29 (major diameter 2 x (0.29 + 1.21) = 3.0) at X 5.315, cuts, and returns to the centre.
const stock = { min: { x: 0, y: 0, z: -10 }, max: { x: 10, y: 10, z: 0 } }
const PRE_DRILL = 'T1 M6\nG0 X5.025 Y5.025 Z5\nG1 Z-6 F100\nG0 Z5\n'

function simulate(threadMoves: string, checkpointInterval = 0) {
  const job = parseGcode(PRE_DRILL + 'T2 M6\nG0 X5.025 Y5.025 Z5\n' + threadMoves + 'G1 X5.025 Y5.025\nG0 Z5\n')
  const tools = new Map([
    [1, profile(preDrill)],
    [2, profile(threadMill)],
  ])
  const checkpoints = checkpointInterval > 0 ? planCheckpoints(job.moves, checkpointInterval) : []
  const sim = new MaterialSimulation(stock, 0.05, job.moves, tools, checkpoints)
  sim.advanceTo(job.moves.count)
  return sim
}

// Column (i, j) has its centre at (0.025 + 0.05 i, 0.025 + 0.05 j); row j = 100 is Y 5.025.
const column = (x: number) => 100 * 200 + Math.round((x - 0.025) / 0.05)
const gaps = (sim: MaterialSimulation, x: number) => [...sim.grid.dexels.gapView(column(x))]

describe('thread mill tooth profile on the dexel stock', () => {
  // A circle at constant Z: at the column on the +X side the tooth passes closest at distance
  // 1.4 - 0.29 = 1.11 from its axis. There the tooth spans 0.1875 - (1.11 - 0.9393671) x tan 30
  // = 0.0889851 either side of its centre, which is at the tip Z -3 + 0.1875 = -2.8125.
  it('cuts the ISO 68-1 flank width at 1.11 mm from the tool axis, under material that stays', () => {
    const sim = simulate('G1 Z-3 F100\nG1 X5.315\nG3 X5.315 Y5.025 I-0.29 J0\n')

    const g = gaps(sim, 6.425)

    expect(g).toHaveLength(2)
    expect(g[0]).toBeCloseTo(-2.9014851, 5)
    expect(g[1]).toBeCloseTo(-2.7235149, 5)
    expect(sim.grid.heights[column(6.425)]).toBe(0)
  })

  // Five passes at tip Z -5, -4.5, -4, -3.5, -3 on the +X side: one groove per pass, so the
  // grooves repeat every pitch, 0.5 mm.
  it('cuts a helical groove every pitch, and none beyond the major radius 1.5 mm', () => {
    const helix = 'G1 Z-5 F100\nG1 X5.315\n' + 'G91\nG3 X0 Y0 I-0.29 J0 Z0.5\nG3 X0 Y0 I-0.29 J0 Z0.5\nG3 X0 Y0 I-0.29 J0 Z0.5\nG3 X0 Y0 I-0.29 J0 Z0.5\nG90\n'
    const sim = simulate(helix)

    const g = gaps(sim, 6.475) // 1.45 from the hole centre
    const lowerEnds = [g[2], g[4], g[6]]

    expect(g).toHaveLength(10)
    expect(lowerEnds[1] - lowerEnds[0]).toBeCloseTo(0.5, 5)
    expect(lowerEnds[2] - lowerEnds[1]).toBeCloseTo(0.5, 5)
    expect(gaps(sim, 6.575)).toEqual([]) // 1.55 from the hole centre
    expect(sim.grid.heights[column(6.475)]).toBe(0)
  })
})

describe('thread grooves in playback', () => {
  // Checkpoints every 20 moves inside the helix; seeking back restores from them.
  it('removes the grooves when seeking back to the start and restores them at the end', () => {
    const helix = 'G1 Z-5 F100\nG1 X5.315\n' + 'G91\nG3 X0 Y0 I-0.29 J0 Z0.5\nG3 X0 Y0 I-0.29 J0 Z0.5\nG3 X0 Y0 I-0.29 J0 Z0.5\nG3 X0 Y0 I-0.29 J0 Z0.5\nG90\n'
    const sim = simulate(helix, 20)
    const end = sim.current

    sim.seek(0)
    const atStart = gaps(sim, 6.475)
    sim.seek(end)
    const atEnd = gaps(sim, 6.475)

    expect(atStart).toEqual([])
    expect(atEnd).toHaveLength(10)
    expect(atEnd[4] - atEnd[2]).toBeCloseTo(0.5, 5)
  })
})

describe('thread mill entry in the tool table', () => {
  // T6 of the backplate fixture header: 2.42 mm cutting diameter.
  const header = ';@MKR|TOOL|number=6|id=152111243809|name=3.175*M3*9mm Thread|type=Thread|handlediameter=3.175|sticklength=0|shoulderlength=9|flutelength=10|diameter=2.42|tipdiameter=0|cornerradius=0|angle=0|halfAngle=0\nT6 M6\n'

  it('stays a cylinder with a tool problem until the pitch is entered', () => {
    const [t6] = buildToolTable(parseGcode(header).header.tools, [6])

    expect(t6.sources.pitch).toBe('missing')
    expect(toolProblems(t6)).toContain('Enter the thread pitch. Until then this thread mill is simulated as a cylinder of its cutting diameter, without thread grooves.')
    expect(cutterProfile(t6)).toMatchObject({ classic: true })
  })

  // ISO 68-1 for P 0.5 on a 2.42 mm cutter (see the profile above).
  it('prefills the ISO 68-1 tooth from the pitch, marked assumed', () => {
    const [t6] = buildToolTable(parseGcode(header).header.tools, [6])

    const t = withToolValue(t6, 'pitch', 0.5)

    expect(t.toothTipFlat).toBeCloseTo(0.0625, 9)
    expect(t.neckDiameter).toBeCloseTo(1.8787342, 6)
    expect(t.toothOffset).toBeCloseTo(0.1875, 9)
    expect(t.profileAngle).toBe(60)
    expect(t.teeth).toBe(1)
    expect(t.sources.neckDiameter).toBe('assumed')
    expect(toolProblems(t)).toEqual([])
  })
})
