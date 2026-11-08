import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseGcode } from '../src/engine/gcodeParser'

const program = (...lines: string[]) => lines.join('\n')

describe('rotary axis refusal', () => {
  it('refuses the whole job on an A word on a G1 line, naming the line and the word', () => {
    const job = parseGcode(program('G21 G90', 'G0 X0 Y0 Z5', 'G1 Z-1 F100', 'G1 X10 A90', 'G1 Y10'))

    expect(job.refusal).toEqual({
      line: 4,
      text: 'G1 X10 A90',
      message:
        'This file uses a rotary axis (A word on line 4). NcStepCompare simulates 3-axis milling only, so the job is not loaded.',
    })
    expect(job.moves.count).toBe(0)
  })

  it('refuses a C word on a line that moves in the modal motion mode', () => {
    const job = parseGcode(program('G0 X0 Y0 Z5', 'G1 Z-1 F100', 'C45'))

    expect(job.refusal?.line).toBe(3)
    expect(job.refusal?.message).toContain('C word on line 3')
  })

  it('loads a job with a cylinder stock header and no rotary words', () => {
    const job = parseGcode(
      program(
        ';@MKR|STOCK|id=cylinder|length=100|width=50|height=50|diameter=50',
        'G0 X0 Y0 Z5',
        'G1 Z-1 F100',
        'G1 X10',
      ),
    )

    expect(job.refusal).toBeNull()
    expect(job.header.stock?.shape).toBe('cylinder')
    expect(job.moves.count).toBe(2)
  })

  it('loads the backplate fixture', () => {
    const source = readFileSync(new URL('../fixtures/Z1 Pro - Backplate CM_TOP_210320.nc', import.meta.url), 'utf8')
    const job = parseGcode(source)

    expect(job.refusal).toBeNull()
    expect(job.moves.count).toBeGreaterThan(100_000)
  })
})
