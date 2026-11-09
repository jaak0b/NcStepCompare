import { describe, expect, it } from 'vitest'
import { cellClasses } from '../src/engine/comparisonView'
import { toleranceLimits } from '../src/engine/deviation'
import type { Finding, FindingKind } from '../src/engine/findings/finding'
import { spoilboardFindings, toolChangeFindings } from '../src/engine/findings/jobFindings'
import { moveFindings, type FindingTool } from '../src/engine/findings/moveFindings'
import { stockFindings } from '../src/engine/findings/stockFindings'
import { parseGcode } from '../src/engine/gcodeParser'
import { MODEL_THROUGH } from '../src/engine/modelGrid'
import { MaterialSimulation } from '../src/engine/simulation'
import { cutterProfile, type CutterProfile, type CutterShapeKind } from '../src/engine/toolShape'

// Stock 20 x 10 x 5 mm, top at Z 0, grid cell 0.05 mm (cell centres at odd multiples of 0.025).
const stock = { min: { x: 0, y: 0, z: -5 }, max: { x: 20, y: 10, z: 0 } }

type Tool = FindingTool & { cornerRadius: number; tipAngle: number }

// Engagement limits default to those of the 3.175 mm tool (50 % and 1x its diameter), written out.
function tool(number: number, kind: CutterShapeKind, diameter: number, fluteLength = 12, widthOfCutLimit = 1.5875, depthOfCutLimit = 3.175): Tool {
  return {
    number,
    name: '',
    kind,
    diameter,
    cornerRadius: 0,
    tipAngle: 118,
    fluteLength,
    widthOfCutLimit,
    depthOfCutLimit,
    sources: {
      kind: 'header',
      diameter: 'header',
      cornerRadius: 'header',
      tipAngle: 'header',
      fluteLength: 'header',
      shoulderLength: 'header',
      widthOfCutLimit: 'assumed',
      depthOfCutLimit: 'assumed',
      pitch: 'missing',
      profileAngle: 'assumed',
      teeth: 'assumed',
      toothTipFlat: 'assumed',
      neckDiameter: 'assumed',
      toothOffset: 'assumed',
    },
  }
}

function run(gcode: string, tools: Tool[]) {
  const job = parseGcode(gcode)
  const profiles = new Map<number, CutterProfile>(tools.map((t) => [t.number, cutterProfile(t) as CutterProfile]))
  const sim = new MaterialSimulation(stock, 0.05, job.moves, profiles, [])
  sim.advanceTo(job.moves.count)
  return { job, sim, findings: moveFindings(job.moves, sim, tools) }
}

const ofKind = (findings: Finding[], kind: FindingKind) => findings.filter((f) => f.kind === kind)
const row = (f: Finding, label: string) => f.rows.find((r) => r.label === label)?.value

const flat3175 = tool(1, 'flat end mill', 3.175)

describe('rapid through material', () => {
  // Slot at Z -1 along Y 5 from X 5 to X 15; the rapid back along the slot cuts nothing, the rapid
  // sideways to Y 8 at Z -1 runs into uncut stock.
  const gcode = 'T1 M6\nS10000 M3\nG0 X5 Y5 Z5\nG1 Z-1 F100\nG1 X15\nG0 X5\nG0 Y8'

  it('reports only the rapid that runs into uncut stock, with its line and depth', () => {
    const { findings } = run(gcode, [flat3175])

    const rapids = ofKind(findings, 'rapid')
    expect(rapids.map((f) => row(f, 'Line'))).toEqual(['7'])
    expect(row(rapids[0], 'Deepest cut')).toBe('1.000 mm')
  })
})

describe('engagement', () => {
  // Stock spans X 0 to 20; the tool (radius 1.5875) at X -3 and X 23 is clear of it. A full-width slot
  // along Y 5 (line 5), a step to Y 5.5 outside the stock (line 6), then a pass back with 0.5 mm of
  // stepover (line 7).
  const gcode = 'T1 M6\nS10000 M3\nG0 X-3 Y5 Z5\nG1 Z-1 F100\nG1 X23\nG1 Y5.5\nG1 X-3'

  it('measures the full-width slot at the tool diameter and the pass at its 0.5 mm stepover', () => {
    const { sim } = run(gcode, [flat3175])

    // Within one cell (0.05 mm) of the true width: the material edge is resolved to the cell.
    expect(sim.widthOfCut[1]).toBeGreaterThanOrEqual(3.125)
    expect(sim.widthOfCut[1]).toBeLessThanOrEqual(3.175)
    expect(sim.widthOfCut[3]).toBeGreaterThanOrEqual(0.45)
    expect(sim.widthOfCut[3]).toBeLessThanOrEqual(0.55)
    expect(sim.maxCutDepth[3]).toBeCloseTo(1, 6)
  })

  // A 2 mm end mill circles a boss centred at (10, 5): first at path radius 3 (boss radius 2), then
  // at path radius 2.5, 0.5 mm deeper into the boss. Hand calculation for the second circle: the
  // leading half meets the boss where R^2 + d^2 - 2 d R sin(a) < rb^2 with R 1, d 2.5, rb 2, so
  // sin(a) > 0.65, and the width of cut across the feed direction is R (1 - 0.65) = 0.35 mm.
  it('measures 0.35 mm width of cut on an arc 0.5 mm into a round boss', () => {
    const arcGcode = 'T1 M6\nS10000 M3\nG0 X13 Y5 Z5\nG1 Z-1 F100\nG2 X13 Y5 I-3 J0\nG1 X12.5\nG2 X12.5 Y5 I-2.5 J0'
    const { job, sim } = run(arcGcode, [tool(1, 'flat end mill', 2)])
    const secondCircle = Array.from(job.moves.line).flatMap((line, i) => (line === 7 ? [i] : []))
    const halfWay = secondCircle[secondCircle.length >> 1]

    // Within one cell (0.05 mm).
    expect(sim.widthOfCut[halfWay]).toBeGreaterThanOrEqual(0.3)
    expect(sim.widthOfCut[halfWay]).toBeLessThanOrEqual(0.4)
  })

  it('reports the slot above the 1.5875 mm width limit and not the stepover pass', () => {
    const { findings } = run(gcode, [flat3175])

    const e = ofKind(findings, 'engagement')
    expect(e.map((f) => [row(f, 'Moves over the limit'), row(f, 'Line')])).toEqual([['1', '5']])
  })

  it('reports a depth of cut above the limit', () => {
    // 4 mm deep pass with a 3.175 mm tool whose depth limit is 3.175 mm.
    const { findings } = run('T1 M6\nS10000 M3\nG0 X-3 Y5 Z5\nG1 Z-4 F100\nG1 X23', [flat3175])

    const e = ofKind(findings, 'engagement')
    expect(e.map((f) => row(f, 'Line'))).toEqual(['5'])
    expect(row(e[0], 'Largest depth of cut')).toBe('4.000 mm')
  })

  it('does not check a thread mill', () => {
    const { findings } = run('T1 M6\nS10000 M3\nG0 X-3 Y5 Z5\nG1 Z-4 F100\nG1 X23', [tool(1, 'thread mill', 3.175)])

    expect(ofKind(findings, 'engagement')).toEqual([])
  })
})

describe('findings per toolpath', () => {
  // Two rapids in a row through uncut stock with the same tool, in toolpaths 1 and 2.
  const gcode = [
    ';@MKR|TOOLPATH_START|toolpath_number=1',
    'T1 M6',
    'S10000 M3',
    'G0 X-3 Y2 Z-1',
    'G0 X23',
    ';@MKR|TOOLPATH_START|toolpath_number=2',
    'G0 X-3 Y8',
  ].join('\n')

  it('does not merge moves of different toolpaths into one finding', () => {
    const { findings } = run(gcode, [flat3175])

    expect(ofKind(findings, 'rapid').map((f) => [f.toolpath, row(f, 'Line')])).toEqual([
      [1, '5'],
      [2, '7'],
    ])
  })
})

describe('plunge', () => {
  it('reports an end mill fed straight down 2 mm at the 300 mm/min cutting feed', () => {
    const { findings } = run('T1 M6\nS10000 M3\nG0 X10 Y5 Z5\nG1 Z-2 F300\nG1 X12', [flat3175])

    const p = ofKind(findings, 'plunge')
    expect(p.map((f) => row(f, 'Line'))).toEqual(['4'])
    expect(row(p[0], 'Plunges at the cutting feed')).toBe('1')
    expect(row(p[0], 'Deepest plunge into stock')).toBe('2.000 mm')
  })

  it('does not report a plunge at a 100 mm/min plunge feed below the 300 mm/min cutting feed', () => {
    const { findings } = run('T1 M6\nS10000 M3\nG0 X10 Y5 Z5\nG1 Z-2 F100\nG1 X12 F300', [flat3175])

    expect(ofKind(findings, 'plunge')).toEqual([])
  })

  it('does not report a drill', () => {
    const { findings } = run('T1 M6\nS10000 M3\nG0 X10 Y5 Z5\nG1 Z-2 F300\nG1 X12', [tool(1, 'drill', 3.175)])

    expect(ofKind(findings, 'plunge')).toEqual([])
  })
})

describe('feed and spindle', () => {
  it('reports a cut with the spindle off', () => {
    const { findings } = run('T1 M6\nG0 X-3 Y5 Z5\nG1 Z-1 F100\nG1 X23', [flat3175])

    expect(ofKind(findings, 'spindleOff').map((f) => row(f, 'Line'))).toEqual(['4'])
  })

  it('reports a cut with no feed programmed', () => {
    const { findings } = run('T1 M6\nS10000 M3\nG0 X-3 Y5 Z-1\nG1 X23', [flat3175])

    expect(ofKind(findings, 'zeroFeed').map((f) => row(f, 'Line'))).toEqual(['4'])
  })
})

describe('non-cutting contact', () => {
  // A pass 4 mm deep: stock touches the cutter 4 mm above the tip.
  const gcode = 'T1 M6\nS10000 M3\nG0 X-3 Y5 Z5\nG1 Z-4 F100\nG1 X23'

  it('reports stock above a 3 mm flute length', () => {
    const { findings } = run(gcode, [tool(1, 'flat end mill', 3.175, 3)])

    const c = ofKind(findings, 'contact')
    expect(c.map((f) => row(f, 'Line'))).toEqual(['5'])
    expect(row(c[0], 'Highest stock in contact above the tool tip')).toBe('4.000 mm')
  })

  it('does not report a 12 mm flute length', () => {
    const { findings } = run(gcode, [tool(1, 'flat end mill', 3.175, 12)])

    expect(ofKind(findings, 'contact')).toEqual([])
  })
})

describe('spoilboard and tool changes', () => {
  const gcode = 'T1 M6\nS10000 M3\nG0 X10 Y5 Z5\nG1 Z-5.3 F100\nG0 Z5\nT2 M6\nG0 X15 Y5\nG1 Z-6 F100'

  it('reports the lowest tool tip below the 5 mm stock per toolpath', () => {
    const { job } = run(gcode, [flat3175, tool(2, 'drill', 2.5)])

    const s = spoilboardFindings(job.moves, -5)
    expect(s.map((f) => row(f, 'Depth below the stock bottom'))).toEqual(['1.000 mm'])
    expect(row(s[0], 'Line')).toBe('8')
  })

  it('lists each tool change with its line', () => {
    const { job } = run(gcode, [flat3175, tool(2, 'drill', 2.5)])

    const t = toolChangeFindings(job.moves, job.toolChanges, [])
    expect(t.map((f) => [row(f, 'Tool'), row(f, 'Line')])).toEqual([
      ['T1', '1'],
      ['T2', '6'],
    ])
  })
})

describe('gouge and thread', () => {
  // Model: solid to the stock top everywhere except a through-hole of radius 1.0 at (10.025, 5.025).
  // A 2 mm end mill plunges through it. Tool 2 (1 mm) then circles at radius 0.71, cutting the hole
  // out to radius 1.21. Cell centres lie on a 0.05 mm lattice through the hole centre, so the widest
  // cut cells are 24 cells either side: 49 cells, 2.45 mm across.
  const cx = 10.025
  const cy = 5.025
  const gcode = [
    'T1 M6',
    'S10000 M3',
    'G0 X10.025 Y5.025 Z5',
    'G1 Z-5.3 F100',
    'G0 Z5',
    'T2 M6',
    'G0 X10.735 Y5.025',
    'G1 Z-5.3 F100',
    'G2 X10.735 Y5.025 I-0.71 J0',
    'G0 Z5',
  ].join('\n')

  function compare(secondTool: CutterShapeKind, program = gcode) {
    const tools = [tool(1, 'flat end mill', 2), tool(2, secondTool, 1)]
    const { job, sim } = run(program, tools)
    const g = sim.grid
    const top = new Float32Array(g.nx * g.ny)
    const throughFloor = new Float32Array(g.nx * g.ny).fill(NaN)
    const partBottom = new Float32Array(g.nx * g.ny).fill(-5)
    for (let j = 0; j < g.ny; j++) {
      for (let i = 0; i < g.nx; i++) {
        const dx = g.originX + (i + 0.5) * g.cellSize - cx
        const dy = g.originY + (j + 0.5) * g.cellSize - cy
        const hole = dx * dx + dy * dy <= 1
        top[j * g.nx + i] = hole ? MODEL_THROUGH : 0
        if (hole) throughFloor[j * g.nx + i] = -5
      }
    }
    const model = { top, throughFloor, partBottom }
    return stockFindings({
      grid: g,
      heights: g.heights,
      model,
      limits: toleranceLimits(g, model, { gouge: 0.05, leftover: 0.1 }, g.bottom),
      lastCut: sim.lastCut,
      moveTool: job.moves.tool,
      moveLine: job.moves.line,
      threadMills: new Set(tools.filter((t) => t.kind === 'thread mill').map((t) => t.number)),
    })
  }

  it('reports a ring cut by a thread mill around the hole as a thread, not a gouge', () => {
    const findings = compare('thread mill')

    expect(ofKind(findings, 'gouge')).toEqual([])
    const threads = ofKind(findings, 'thread')
    expect(threads).toHaveLength(1)
    expect(row(threads[0], 'Size in X and Y')).toBe('2.45 x 2.45 mm')
  })

  it('reports a thread mill slot in solid material, not around a hole, as a gouge', () => {
    const findings = compare('thread mill', 'T2 M6\nS10000 M3\nG0 X3 Y2 Z5\nG1 Z-1 F100\nG1 X6')

    expect(ofKind(findings, 'thread')).toEqual([])
    expect(ofKind(findings, 'gouge')).toHaveLength(1)
  })

  it('reports a thread mill ring around an uncut island of solid model as a gouge', () => {
    // Tool 2 (1 mm) circles at radius 1.5 around (4.025, 5.025), away from the model's hole: it cuts a
    // ring from radius 1.0 to 2.0 and leaves the island inside, where the model has material at the
    // stock top.
    const findings = compare('thread mill', 'T2 M6\nS10000 M3\nG0 X5.525 Y5.025 Z5\nG1 Z-1 F100\nG2 X5.525 Y5.025 I-1.5 J0')

    expect(ofKind(findings, 'thread')).toEqual([])
    expect(ofKind(findings, 'gouge')).toHaveLength(1)
  })

  it('reports the same ring cut by an end mill as a gouge 5.3 mm deep', () => {
    const findings = compare('flat end mill')

    expect(ofKind(findings, 'thread')).toEqual([])
    const gouges = ofKind(findings, 'gouge')
    expect(gouges).toHaveLength(1)
    expect(row(gouges[0], 'Deepest below the model')).toBe('5.300 mm')
  })
})

describe('bottom face class', () => {
  // Four cells: outside the parts, under a part whose bottom is on the stock bottom (Z -5), under a
  // part 0.05 mm up (within the 0.1 mm leftover tolerance), under a part 1 mm up; the last is a thread.
  it('marks parts on the stock bottom, raised parts and thread cells', () => {
    const model = {
      top: Float32Array.from([NaN, 0, 0, 0]),
      throughFloor: new Float32Array(4).fill(NaN),
      partBottom: Float32Array.from([NaN, -5, -4.95, -4]),
    }

    const classes = cellClasses(model, Uint8Array.from([0, 0, 0, 1]), -5, 0.1)

    expect(Array.from(classes)).toEqual([0, 1, 1, 6])
  })
})
