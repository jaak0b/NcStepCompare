import { describe, expect, it } from 'vitest'
import { parseGcode, type ParsedJob } from '../src/engine/gcodeParser'
import { summarizeJob } from '../src/engine/jobSummary'
import { MoveType, SpindleState } from '../src/engine/moveList'

const program = (...lines: string[]) => lines.join('\n')
const startOf = (job: ParsedJob, i: number) => Array.from(job.moves.start.slice(i * 3, i * 3 + 3))
const endOf = (job: ParsedJob, i: number) => Array.from(job.moves.end.slice(i * 3, i * 3 + 3))

describe('G-code parser: modal state', () => {
  it('keeps motion mode, feed and spindle modal across lines', () => {
    const job = parseGcode(program('G21 G90', 'G0 X0 Y0 Z5', 'G1 Z-1 F100', 'X10', 'S8000 M3', 'Y5 F200'))

    expect(job.moves.count).toBe(3)
    expect(startOf(job, 0)).toEqual([0, 0, 5])
    expect(endOf(job, 1)).toEqual([10, 0, -1])
    expect(job.moves.type[1]).toBe(MoveType.Feed)
    expect(job.moves.feed[1]).toBe(100)
    expect(job.moves.spindle[1]).toBe(SpindleState.Off)
    expect(endOf(job, 2)).toEqual([10, 5, -1])
    expect(job.moves.feed[2]).toBe(200)
    expect(job.moves.spindle[2]).toBe(SpindleState.Clockwise)
    expect(job.moves.spindleSpeed[2]).toBe(8000)
    expect(job.moves.line[2]).toBe(6)
  })

  it('skips a rapid from an unknown position but warns about a feed move from one', () => {
    const job = parseGcode(program('G0 X10 Y10', 'G1 Z-1 F100', 'G0 X0 Y0 Z5', 'G0 X1'))

    expect(job.moves.count).toBe(2)
    expect(startOf(job, 0)).toEqual([10, 10, -1])
    expect(job.warnings.map((w) => w.line)).toEqual([2])
  })

  it('adds incremental G91 moves to the current position', () => {
    const job = parseGcode(program('G0 X1 Y2 Z3', 'G91', 'G1 X1 Y-1 Z-0.5 F50', 'X2'))

    expect(endOf(job, 0)).toEqual([2, 1, 2.5])
    expect(endOf(job, 1)).toEqual([4, 1, 2.5])
  })

  it('converts G20 inch coordinates and feed to mm', () => {
    const job = parseGcode(program('G20 G90', 'G0 X0 Y0 Z0', 'G1 X1 Y2 F10'))

    expect(endOf(job, 0)[0]).toBeCloseTo(25.4, 12)
    expect(endOf(job, 0)[1]).toBeCloseTo(50.8, 12)
    expect(job.moves.feed[0]).toBeCloseTo(254, 4)
  })
})

// Flattened arc vertices lie on the circle, but an extreme of the circle that falls between two
// vertices is only reached to within the 0.01 mm default chord tolerance.
describe('G-code parser: arcs', () => {
  it('flattens a G3 quarter arc counter-clockwise, ending exactly on the end point', () => {
    const job = parseGcode(program('G0 X10 Y0 Z0', 'G3 X0 Y10 I-10 J0 F100'))
    const b = summarizeJob(job).bounds!

    expect(job.moves.count).toBeGreaterThan(1)
    expect(job.moves.type[0]).toBe(MoveType.Arc)
    expect(endOf(job, job.moves.count - 1)).toEqual([0, 10, 0])
    expect(b.min.x).toBeGreaterThanOrEqual(0)
    expect(b.min.y).toBeGreaterThanOrEqual(0)
  })

  it('takes the long way round for G2 between the same points', () => {
    const job = parseGcode(program('G0 X10 Y0 Z0', 'G2 X0 Y10 I-10 J0 F100'))
    const b = summarizeJob(job).bounds!

    expect(b.min.x).toBeLessThan(-9.99)
    expect(b.min.y).toBeLessThan(-9.99)
    expect(b.max.y).toBe(10)
  })

  it('draws a full circle when the end point equals the start point', () => {
    const job = parseGcode(program('G0 X10 Y0 Z0', 'G2 X10 Y0 I-10 J0 F100'))
    const s = summarizeJob(job)

    expect(s.arcMoveCount).toBe(1)
    expect(s.bounds!.min.x).toBeLessThan(-9.99)
    expect(s.bounds!.min.y).toBeLessThan(-9.99)
    expect(s.bounds!.max.y).toBeGreaterThan(9.99)
    expect(endOf(job, job.moves.count - 1)).toEqual([10, 0, 0])
  })

  it('places an R-format G2 half circle above the chord', () => {
    const job = parseGcode(program('G0 X0 Y0 Z0', 'G2 X10 Y0 R5 F100'))
    const b = summarizeJob(job).bounds!

    expect(b.max.y).toBeGreaterThan(4.99)
    expect(b.max.y).toBeLessThanOrEqual(5)
    expect(b.min.y).toBeGreaterThanOrEqual(0)
  })

  it('lowers Z along a helical arc to the programmed end depth', () => {
    const job = parseGcode(program('G0 X10 Y0 Z0', 'G3 X-10 Y0 Z-2 I-10 J0 F100'))

    expect(endOf(job, job.moves.count - 1)).toEqual([-10, 0, -2])
    expect(endOf(job, 0)[2]).toBeLessThan(0)
    expect(endOf(job, 0)[2]).toBeGreaterThan(-2)
  })
})

describe('G-code parser: tools and toolpaths', () => {
  it('changes the tool only on M6 and tags moves with the current toolpath', () => {
    const job = parseGcode(program(
      ';@MKR|TOOLPATH_START|toolpath_number=2',
      'T3 M6',
      'G0 X0 Y0 Z5',
      'G0 X1',
      ';@MKR|TOOLPATH_START|toolpath_number=3',
      'T5',
      'G0 X2',
      'M6',
      'G0 X3',
    ))

    expect(Array.from(job.moves.tool)).toEqual([3, 3, 5])
    expect(Array.from(job.moves.toolpath)).toEqual([2, 3, 3])
    expect(Array.from(job.moves.line)).toEqual([4, 7, 9])
  })
})

describe('G-code parser: warnings', () => {
  it('reports bad lines with line number and text and keeps parsing the job', () => {
    const job = parseGcode(program(
      'G0 X0 Y0 Z0',
      'G1 X5 Q7 F100',
      'G1 X',
      'G2 X1 Y1',
      '(unclosed comment',
      'G1 X6',
    ))

    expect(job.warnings.map((w) => w.line)).toEqual([2, 3, 4, 5])
    expect(job.warnings[1].text).toBe('G1 X')
    expect(job.moves.count).toBe(2)
    expect(endOf(job, 1)).toEqual([6, 1, 0])
  })
})

describe('G-code parser: review fixes', () => {
  it('does not draw moves in an unsupported motion mode until G0 to G3 returns', () => {
    const job = parseGcode(program('G0 X0 Y0 Z5', 'G0 X1', 'G81 X10 Y10 Z-5 R1 F100', 'X20', 'G0 X0 Y0 Z5', 'G0 X2'))

    expect(job.moves.count).toBe(2)
    expect(Array.from(job.moves.line)).toEqual([2, 6])
    expect(job.warnings.map((w) => w.line)).toEqual([3, 4])
  })

  it('treats every axis as unknown after a bare G28', () => {
    const job = parseGcode(program('G0 X1 Y2 Z3', 'G28', 'G1 X5 F100'))

    expect(job.moves.count).toBe(0)
    expect(job.warnings.map((w) => w.line)).toEqual([2, 3])
  })

  it.each([
    ['G53 G0 Z0'],
    ['G91 G28 Z0'],
  ])('keeps X and Y known after %s, which names only Z', (homingLine) => {
    const job = parseGcode(program('G0 X1 Y2 Z3', homingLine, 'G90 G0 Z5', 'G1 X4 F100'))

    expect(job.moves.count).toBe(1)
    expect(startOf(job, 0)).toEqual([1, 2, 5])
  })

  it('skips a line with a number in exponent notation instead of moving', () => {
    const job = parseGcode(program('G0 X0 Y0 Z0', 'G1 X1e3 F100'))

    expect(job.moves.count).toBe(0)
    expect(job.warnings.map((w) => w.line)).toEqual([2])
    expect(job.warnings[0].text).toBe('G1 X1e3 F100')
  })

  it.each([[0], [-0.01], [NaN]])('rejects chord tolerance %s', (tolerance) => {
    expect(() => parseGcode('G0 X0 Y0 Z0', { chordToleranceMm: tolerance })).toThrow(RangeError)
  })

  it('reads I/J as offsets from the start point under G91, not added twice', () => {
    const job = parseGcode(program('G0 X10 Y0 Z0', 'G91 G3 X-10 Y10 I-10 J0 F100'))
    const b = summarizeJob(job).bounds!

    expect(endOf(job, job.moves.count - 1)).toEqual([0, 10, 0])
    expect(b.min.x).toBeGreaterThanOrEqual(0)
    expect(b.max.x).toBe(10)
  })

  // Centre of R-10 between (0,0) and (10,0) is (5, 8.660); the 300 degree G2 arc peaks at Y 18.660.
  it('takes the arc over 180 degrees for a negative R', () => {
    const job = parseGcode(program('G0 X0 Y0 Z0', 'G2 X10 Y0 R-10 F100'))
    const b = summarizeJob(job).bounds!

    expect(b.max.y).toBeGreaterThan(18.65)
    expect(b.max.y).toBeLessThanOrEqual(18.661)
    expect(b.min.y).toBeGreaterThanOrEqual(0)
  })
})
