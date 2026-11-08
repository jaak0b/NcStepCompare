import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseGcode } from '../src/engine/gcodeParser'
import { summarizeJob } from '../src/engine/jobSummary'
import { stockBoxInWorkCoordinates } from '../src/engine/stock'

// Facts stated for the backplate fixture in CLAUDE.md.
describe('backplate fixture', () => {
  const source = readFileSync(new URL('../fixtures/Z1 Pro - Backplate CM_TOP_210320.nc', import.meta.url), 'utf8')
  const job = parseGcode(source)
  const summary = summarizeJob(job)

  it('has the documented header', () => {
    const h = job.header
    const t1 = h.tools.find((t) => t.number === 1)!

    expect(stockBoxInWorkCoordinates(h.stock!, h.workOrigin!)).toEqual({
      min: { x: 0, y: 0, z: -10 },
      max: { x: 150, y: 100, z: 0 },
    })
    expect(h.workOrigin!.presetName).toBe('topFrontLeft')
    expect(h.studioTimeEstimateSeconds).toBe(9892.54)
    expect(h.tools.map((t) => t.number)).toEqual([1, 2, 3, 6])
    expect(t1.diameter).toBe(3.175)
    expect(t1.fluteLength).toBe(12)
  })

  it('loads tools 1, 2, 3 and 6 and has no arcs', () => {
    expect([...new Set(job.moves.tool)].sort((a, b) => a - b)).toEqual([1, 2, 3, 6])
    expect(summary.arcMoveCount).toBe(0)
  })

  it('moves between clearance Z 15 and drilling depth Z -11.0, inside the stock in XY', () => {
    const b = summary.bounds!

    expect(b.max.z).toBe(15)
    expect(b.min.z).toBe(-11)
    expect(b.min.x).toBeGreaterThanOrEqual(0)
    expect(b.max.x).toBeLessThanOrEqual(150)
    expect(b.min.y).toBeGreaterThanOrEqual(0)
    expect(b.max.y).toBeLessThanOrEqual(100)
  })
})
