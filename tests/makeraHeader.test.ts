import { describe, expect, it } from 'vitest'
import { parseGcode } from '../src/engine/gcodeParser'
import { stockBoxInWorkCoordinates } from '../src/engine/stock'

// Literal header lines as documented for the fixture, plus one record type the reader does not know.
const header = [
  ';@MKR|STOCK|id=cuboid|length=150|width=100|height=10|diameter=50',
  ';@MKR|ORIGIN|id=0|type_name=topFrontLeft|x=-75|y=-50|z=5',
  ';@MKR|TOOL|number=1|...|type=Flat End|handlediameter=3.175|shoulderlength=12|flutelength=12|diameter=3.175|tipdiameter=3.175|cornerradius=0|angle=0|halfAngle=0',
  ';@MKR|TIME|seconds=9892.54',
  ';@MKR|TOOLPATH|number=1|tool_number=1|name=[T1]3D Relief - Facing',
  ';@MKR|SOMETHING_NEW|a=1',
].join('\n')

describe('Makera header reader', () => {
  it('maps Studio tool fields to standard terms', () => {
    const tool = parseGcode(header).header.tools[0]

    expect(tool.number).toBe(1)
    expect(tool.kind).toBe('flat end mill')
    expect(tool.diameter).toBe(3.175)
    expect(tool.shankDiameter).toBe(3.175)
    expect(tool.fluteLength).toBe(12)
    expect(tool.shoulderLength).toBe(12)
  })

  it('reads stock, work origin, Studio time and toolpaths, and keeps unknown records', () => {
    const job = parseGcode(header)
    const h = job.header

    expect(h.stock).toMatchObject({ shape: 'box', lengthX: 150, widthY: 100, heightZ: 10 })
    expect(h.workOrigin?.description).toBe('Top, front left corner')
    expect(h.studioTimeEstimateSeconds).toBe(9892.54)
    expect(h.toolpaths).toEqual([{ number: 1, toolNumber: 1, name: '[T1]3D Relief - Facing' }])
    expect(h.otherRecords.map((r) => r.type)).toEqual(['SOMETHING_NEW'])
    expect(job.warnings).toEqual([])
  })

  it('places top front-left origin stock at X 0..150, Y 0..100, Z -10..0', () => {
    const h = parseGcode(header).header

    expect(stockBoxInWorkCoordinates(h.stock!, h.workOrigin!)).toEqual({
      min: { x: 0, y: 0, z: -10 },
      max: { x: 150, y: 100, z: 0 },
    })
  })
})
