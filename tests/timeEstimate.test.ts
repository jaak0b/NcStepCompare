import { describe, expect, it } from 'vitest'
import { parseGcode } from '../src/engine/gcodeParser'
import { estimateMachiningTime, type TimeSettings } from '../src/engine/timeEstimate'

const program = (...lines: string[]) => lines.join('\n')
const settings: TimeSettings = { rapidRateMmPerMin: 3000, dwellPUnit: 'seconds' }

describe('machining time estimate', () => {
  // Hand calculation: 30 mm at 600 mm/min = 3 s; 50 mm (3-4-5 triangle) at 1200 mm/min = 2.5 s;
  // dwell 1.5 s inside toolpath 1; rapid 30 mm at 3000 mm/min = 0.6 s. Total 7.6 s.
  const job = parseGcode(
    program(
      'G21 G90',
      'G0 X0 Y0 Z0',
      ';@MKR|TOOLPATH_START|toolpath_number=1',
      'G1 X30 F600',
      'G1 X60 Y40 F1200',
      'G4 P1.5',
      ';@MKR|TOOLPATH_START|toolpath_number=2',
      'G0 Z30',
    ),
  )

  it('times feed moves at their F, rapids at the rapid rate, and adds dwells, per toolpath', () => {
    const estimate = estimateMachiningTime(job.moves, job.dwells, settings)
    const [tp1, tp2] = estimate.toolpaths

    expect(estimate.toolpaths.map((t) => t.toolpath)).toEqual([1, 2])
    expect(tp1.feedSeconds).toBeCloseTo(5.5, 9)
    expect(tp1.dwellSeconds).toBe(1.5)
    expect(tp1.rapidSeconds).toBe(0)
    expect(tp1.totalSeconds).toBeCloseTo(7.0, 9)
    expect(tp1.feedLengthMm).toBeCloseTo(80, 9)
    expect(tp2.rapidSeconds).toBeCloseTo(0.6, 9)
    expect(tp2.rapidLengthMm).toBeCloseTo(30, 9)
    expect(estimate.total.totalSeconds).toBeCloseTo(7.6, 9)
  })

  it('reads a P dwell as milliseconds when that unit is chosen', () => {
    const estimate = estimateMachiningTime(job.moves, job.dwells, { ...settings, dwellPUnit: 'milliseconds' })

    expect(estimate.toolpaths[0].dwellSeconds).toBeCloseTo(0.0015, 12)
  })

  it('converts G20 feeds so inch and mm programs of the same path take the same time', () => {
    const inch = parseGcode(program('G20 G90', 'G0 X0 Y0 Z0', 'G1 X1 F10'))
    // 25.4 mm at 254 mm/min = 6 s.
    expect(estimateMachiningTime(inch.moves, inch.dwells, settings).total.feedSeconds).toBeCloseTo(6, 9)
  })

  it('gives no time to a cutting move without a feed and reports its length', () => {
    const noFeed = parseGcode(program('G0 X0 Y0 Z0', 'G1 X12'))
    const t = estimateMachiningTime(noFeed.moves, noFeed.dwells, settings).total

    expect(t.feedSeconds).toBe(0)
    expect(t.noFeedLengthMm).toBe(12)
  })
})

describe('dwell parsing', () => {
  it('reads G4 X as dwell seconds, not as a move, even in G1 mode', () => {
    const job = parseGcode(program('G0 X0 Y0 Z0', 'G1 X5 F100', 'G4 X1.5'))

    expect(job.moves.count).toBe(1)
    expect(job.dwells).toEqual([{ line: 3, word: 'X', value: 1.5, toolpath: 0 }])
    expect(estimateMachiningTime(job.moves, job.dwells, { ...settings, dwellPUnit: 'milliseconds' }).total.dwellSeconds).toBe(1.5)
  })

  it('reads G4 S as dwell seconds, not as a spindle speed', () => {
    const job = parseGcode(program('S12000 M3', 'G0 X0 Y0 Z0', 'G4 S2', 'G0 X1'))

    expect(job.dwells).toEqual([{ line: 3, word: 'S', value: 2, toolpath: 0 }])
    expect(job.moves.spindleSpeed[0]).toBe(12000)
  })

  it('warns about a G4 without a time and records no dwell', () => {
    const job = parseGcode(program('G4'))

    expect(job.dwells).toEqual([])
    expect(job.warnings.map((w) => w.line)).toEqual([1])
  })

  it('counts motion lines that cannot be stored', () => {
    const job = parseGcode(program('G0 X0 Y0 Z5', 'G1 X1 F100', 'G28', 'G0 X1 Y1 Z1', 'G0 X2'))

    // Line 1 starts from an unknown position, line 3 homes to an unknown position, line 4 starts there.
    expect(job.moves.count).toBe(2)
    expect(job.unstoredMotionLines).toBe(3)
  })
})
