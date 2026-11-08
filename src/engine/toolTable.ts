// Tool table for the simulation: one entry per tool number, prefilled from the Makera header and
// editable by the user. Each value records where it came from.
import type { ToolDefinition, ToolKind } from './makeraHeader'
import { cutterProfile, type CutterShape, type CutterShapeKind } from './toolShape'

/** 'saved': a user entry from an earlier session, applied again (still a user entry). */
export type ValueSource = 'header' | 'user' | 'saved' | 'assumed' | 'missing'

export type ToolField =
  | 'kind'
  | 'diameter'
  | 'cornerRadius'
  | 'tipAngle'
  | 'fluteLength'
  | 'shoulderLength'
  | 'widthOfCutLimit'
  | 'depthOfCutLimit'

export interface ToolSetup extends CutterShape {
  number: number
  name: string
  fluteLength: number
  shoulderLength: number
  /** Largest width of cut (radial engagement) one move may take, mm. */
  widthOfCutLimit: number
  /** Largest depth of cut (axial engagement) one move may take, mm. */
  depthOfCutLimit: number
  /** Header-only values, shown for reference; null when the tool is not in the header. */
  shankDiameter: number | null
  studioType: string | null
  sources: Record<ToolField, ValueSource>
}

/** Assumed included tip angles when the header gives none: common catalogue values. */
export const DEFAULT_DRILL_TIP_ANGLE = 118
export const DEFAULT_V_BIT_TIP_ANGLE = 90

/** Assumed engagement limits as a fraction of the tool diameter: width of cut 50 %, depth of cut 1x. */
export const DEFAULT_WIDTH_OF_CUT_FRACTION = 0.5
export const DEFAULT_DEPTH_OF_CUT_FRACTION = 1

/** The entry with every engagement limit that is still a default set from the current diameter. */
function withDefaultLimits(t: ToolSetup): ToolSetup {
  const next: ToolSetup = { ...t, sources: { ...t.sources } }
  if (next.sources.widthOfCutLimit === 'assumed') next.widthOfCutLimit = t.diameter * DEFAULT_WIDTH_OF_CUT_FRACTION
  if (next.sources.depthOfCutLimit === 'assumed') next.depthOfCutLimit = t.diameter * DEFAULT_DEPTH_OF_CUT_FRACTION
  return next
}

const SHAPE_BY_HEADER_KIND: Record<ToolKind, CutterShapeKind | null> = {
  'flat end mill': 'flat end mill',
  'ball end': 'ball end',
  drill: 'drill',
  'V-bit': 'V-bit',
  'thread mill': 'thread mill',
  unknown: null,
}

function fromHeader(t: ToolDefinition): ToolSetup {
  return withDefaultLimits(fromHeaderValues(t))
}

function fromHeaderValues(t: ToolDefinition): ToolSetup {
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
    widthOfCutLimit: NaN,
    depthOfCutLimit: NaN,
    shankDiameter: t.shankDiameter,
    studioType: t.studioType,
    sources: {
      kind: kind ? 'header' : 'assumed',
      diameter: 'header',
      cornerRadius: 'header',
      tipAngle: tipSource,
      fluteLength: 'header',
      shoulderLength: 'header',
      widthOfCutLimit: 'assumed',
      depthOfCutLimit: 'assumed',
    },
  }
}

function blank(number: number): ToolSetup {
  return withDefaultLimits({
    number,
    name: '',
    kind: 'flat end mill',
    diameter: NaN,
    cornerRadius: 0,
    tipAngle: 0,
    fluteLength: NaN,
    shoulderLength: NaN,
    widthOfCutLimit: NaN,
    depthOfCutLimit: NaN,
    shankDiameter: null,
    studioType: null,
    sources: {
      kind: 'assumed',
      diameter: 'missing',
      cornerRadius: 'assumed',
      tipAngle: 'assumed',
      fluteLength: 'missing',
      shoulderLength: 'missing',
      widthOfCutLimit: 'assumed',
      depthOfCutLimit: 'assumed',
    },
  })
}

/** Header tools first, then a blank entry for every tool the program loads that the header lacks. */
export function buildToolTable(headerTools: ToolDefinition[], toolNumbersUsed: number[]): ToolSetup[] {
  const table = headerTools.map(fromHeader)
  for (const n of toolNumbersUsed) {
    if (n >= 0 && !table.some((t) => t.number === n)) table.push(blank(n))
  }
  return table.sort((a, b) => a.number - b.number)
}

/** Default included tip angle for a cutter type, or null when the type has no tip angle. */
export function defaultTipAngle(kind: CutterShapeKind): number | null {
  if (kind === 'drill') return DEFAULT_DRILL_TIP_ANGLE
  if (kind === 'V-bit') return DEFAULT_V_BIT_TIP_ANGLE
  return null
}

/** Changes the cutter type. A drill or V-bit gets its default tip angle unless the user set one. */
export function withToolKind(t: ToolSetup, kind: CutterShapeKind): ToolSetup {
  const next: ToolSetup = { ...t, kind, sources: { ...t.sources, kind: 'user' } }
  const angle = defaultTipAngle(kind)
  if (angle !== null && !((t.sources.tipAngle === 'user' || t.sources.tipAngle === 'saved') && t.tipAngle > 0)) {
    next.tipAngle = angle
    next.sources.tipAngle = 'assumed'
  }
  return next
}

/** Sets a numeric field from user input. An empty or unreadable entry leaves the value missing. */
export function withToolValue(t: ToolSetup, field: Exclude<ToolField, 'kind'>, value: number): ToolSetup {
  const ok = Number.isFinite(value)
  return withDefaultLimits({ ...t, [field]: ok ? value : NaN, sources: { ...t.sources, [field]: ok ? 'user' : 'missing' } })
}

/** Every reason the tool entry is not usable as entered; empty when it is fine. */
export function toolProblems(t: ToolSetup): string[] {
  const problems: string[] = []
  const shape = cutterProfile(t)
  if (typeof shape === 'string') problems.push(`${shape} Moves with this tool are not simulated.`)
  if (!(t.fluteLength > 0)) problems.push('Enter a flute length above 0 mm.')
  if (!(t.shoulderLength > 0)) problems.push('Enter a shoulder length above 0 mm.')
  if (!(t.widthOfCutLimit > 0)) problems.push('Enter a width of cut limit above 0 mm. Moves with this tool are not checked against it.')
  if (!(t.depthOfCutLimit > 0)) problems.push('Enter a depth of cut limit above 0 mm. Moves with this tool are not checked against it.')
  return problems
}

/** The user's own values of a tool entry: fields typed in this session or applied from a saved edit. */
export type ToolEdits = Partial<Pick<ToolSetup, ToolField>>

const EDITABLE_FIELDS: ToolField[] = [
  'kind',
  'diameter',
  'cornerRadius',
  'tipAngle',
  'fluteLength',
  'shoulderLength',
  'widthOfCutLimit',
  'depthOfCutLimit',
]

export function toolEdits(t: ToolSetup): ToolEdits {
  const out: Record<string, unknown> = {}
  for (const f of EDITABLE_FIELDS) {
    if (t.sources[f] === 'user' || t.sources[f] === 'saved') out[f] = t[f]
  }
  return out as ToolEdits
}

/** The entry with saved edits applied; those fields are marked 'saved'. */
export function withSavedEdits(t: ToolSetup, edits: ToolEdits): ToolSetup {
  const next: ToolSetup = { ...t, sources: { ...t.sources } }
  for (const f of EDITABLE_FIELDS) {
    const v = edits[f]
    if (v === undefined) continue
    ;(next as unknown as Record<string, unknown>)[f] = v
    next.sources[f] = 'saved'
  }
  return withDefaultLimits(next)
}

/**
 * Key under which a tool's edits are saved: the Makera Studio tool name when the file header names
 * the tool, otherwise the tool number (a file without a header gives no diameter to match on).
 */
export function toolEditKey(t: ToolSetup): string {
  return t.name !== '' ? `name:${t.name}` : `number:${t.number}`
}
