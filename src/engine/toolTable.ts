// Tool table for the simulation: one entry per tool number, prefilled from the Makera header and
// editable by the user. Each value records where it came from.
import type { ToolDefinition, ToolKind } from './makeraHeader'
import type { CutterShape, CutterShapeKind } from './toolShape'

export type ValueSource = 'header' | 'user' | 'assumed' | 'missing'

export type ToolField = 'kind' | 'diameter' | 'cornerRadius' | 'tipAngle' | 'fluteLength' | 'shoulderLength'

export interface ToolSetup extends CutterShape {
  number: number
  name: string
  fluteLength: number
  shoulderLength: number
  sources: Record<ToolField, ValueSource>
}

/** Assumed included tip angles when the header gives none: common catalogue values. */
export const DEFAULT_DRILL_TIP_ANGLE = 118
export const DEFAULT_V_BIT_TIP_ANGLE = 90

const SHAPE_BY_HEADER_KIND: Record<ToolKind, CutterShapeKind | null> = {
  'flat end mill': 'flat end mill',
  'ball end': 'ball end',
  drill: 'drill',
  'V-bit': 'V-bit',
  'thread mill': 'thread mill',
  unknown: null,
}

function fromHeader(t: ToolDefinition): ToolSetup {
  const kind = SHAPE_BY_HEADER_KIND[t.kind]
  const shapeKind = kind ?? 'flat end mill'
  let tipAngle = t.tipAngle
  // The header's drill tip angle is not reliable, so it stays a starting value the user confirms.
  let tipSource: ValueSource = shapeKind === 'drill' ? 'assumed' : 'header'
  if ((shapeKind === 'drill' || shapeKind === 'V-bit') && !(tipAngle > 0)) {
    tipAngle = shapeKind === 'drill' ? DEFAULT_DRILL_TIP_ANGLE : DEFAULT_V_BIT_TIP_ANGLE
    tipSource = 'assumed'
  }
  return {
    number: t.number,
    name: t.name,
    kind: shapeKind,
    diameter: t.diameter,
    cornerRadius: t.cornerRadius,
    tipAngle,
    fluteLength: t.fluteLength,
    shoulderLength: t.shoulderLength,
    sources: {
      kind: kind ? 'header' : 'assumed',
      diameter: 'header',
      cornerRadius: 'header',
      tipAngle: tipSource,
      fluteLength: 'header',
      shoulderLength: 'header',
    },
  }
}

function blank(number: number): ToolSetup {
  return {
    number,
    name: '',
    kind: 'flat end mill',
    diameter: 0,
    cornerRadius: 0,
    tipAngle: 0,
    fluteLength: 0,
    shoulderLength: 0,
    sources: {
      kind: 'assumed',
      diameter: 'missing',
      cornerRadius: 'assumed',
      tipAngle: 'assumed',
      fluteLength: 'missing',
      shoulderLength: 'missing',
    },
  }
}

/** Header tools first, then a blank entry for every tool the program loads that the header lacks. */
export function buildToolTable(headerTools: ToolDefinition[], toolNumbersUsed: number[]): ToolSetup[] {
  const table = headerTools.map(fromHeader)
  for (const n of toolNumbersUsed) {
    if (n >= 0 && !table.some((t) => t.number === n)) table.push(blank(n))
  }
  return table.sort((a, b) => a.number - b.number)
}
