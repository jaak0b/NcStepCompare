// Reader for the Makera Studio `;@MKR|` records. Studio writes them as comment lines:
//   ;@MKR|TYPE|key=value|key=value
// Studio's own field names are mapped to standard machinist terms here, at the parser boundary,
// so nothing outside this module sees names like `flutelength` or `handlediameter`.

export const MAKERA_RECORD_PREFIX = ';@MKR|'

export interface MakeraRecord {
  type: string
  fields: Record<string, string>
}

export type StockShape = 'box' | 'cylinder' | 'unknown'

export interface StockDefinition {
  shape: StockShape
  /** Studio's stock shape id as written, for example `cuboid`. */
  studioShape: string
  /** Size along X in mm (Studio `length`). */
  lengthX: number
  /** Size along Y in mm (Studio `width`). */
  widthY: number
  /** Size along Z in mm (Studio `height`). */
  heightZ: number
  /** Diameter in mm for cylindrical stock (Studio `diameter`). */
  diameter: number
}

export interface WorkOriginDefinition {
  /** Plain description of the preset, for example "Top, front left corner". */
  description: string
  /** Studio's preset name as written, for example `topFrontLeft`. */
  presetName: string
  /** Work origin position relative to the stock centre, in mm. */
  offsetFromStockCentre: { x: number; y: number; z: number }
}

export type ToolKind = 'flat end mill' | 'ball end' | 'drill' | 'V-bit' | 'thread mill' | 'unknown'

export interface ToolDefinition {
  number: number
  name: string
  kind: ToolKind
  /** Tool type exactly as Studio wrote it. */
  studioType: string
  /** Cutting diameter in mm. */
  diameter: number
  shankDiameter: number
  fluteLength: number
  shoulderLength: number
  tipDiameter: number
  cornerRadius: number
  /** Included tip angle in degrees (Studio `angle`), 0 when not given. */
  tipAngle: number
  /** All fields as Studio wrote them, including ones without a standard mapping. */
  studioFields: Record<string, string>
}

export interface ToolpathDefinition {
  number: number
  toolNumber: number
  name: string
}

export interface MakeraHeader {
  stock: StockDefinition | null
  workOrigin: WorkOriginDefinition | null
  tools: ToolDefinition[]
  toolpaths: ToolpathDefinition[]
  /** Studio's own job time estimate in seconds (`TIME seconds`). */
  studioTimeEstimateSeconds: number | null
  /** Unit declared by Studio (`UNIT value`), for example `mm`. */
  unit: string | null
  /** Records without a dedicated mapping, kept as written. */
  otherRecords: MakeraRecord[]
}

export function emptyMakeraHeader(): MakeraHeader {
  return {
    stock: null,
    workOrigin: null,
    tools: [],
    toolpaths: [],
    studioTimeEstimateSeconds: null,
    unit: null,
    otherRecords: [],
  }
}

/** Splits one `;@MKR|` line into its record type and fields. Returns null for any other line. */
export function parseMakeraRecord(line: string): MakeraRecord | null {
  if (!line.startsWith(MAKERA_RECORD_PREFIX)) return null
  const parts = line.slice(MAKERA_RECORD_PREFIX.length).trimEnd().split('|')
  const type = parts[0]
  if (!type) return null
  const fields: Record<string, string> = {}
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i]
    const eq = part.indexOf('=')
    if (eq < 0) fields[part] = ''
    else fields[part.slice(0, eq)] = part.slice(eq + 1)
  }
  return { type, fields }
}

const STOCK_SHAPE_BY_STUDIO_ID: Record<string, StockShape> = {
  cuboid: 'box',
  cylinder: 'cylinder',
}

/**
 * Turns a Studio origin preset such as `topFrontLeft` into "Top, front left corner". Studio names
 * them as a height (top, bottom, center) followed by a position on that face. Unrecognised names
 * are returned as written.
 */
export function describeWorkOriginPreset(presetName: string): string {
  const words = presetName.split(/(?=[A-Z])/).map((w) => w.toLowerCase())
  const heights = ['top', 'bottom', 'center']
  const positions = ['front', 'back', 'left', 'right', 'center']
  if (words.length === 0 || !heights.includes(words[0]) || !words.slice(1).every((w) => positions.includes(w))) {
    return presetName
  }
  const spell = (w: string) => (w === 'center' ? 'centre' : w)
  const height = spell(words[0])
  const rest = words.slice(1).map(spell)
  const heightLabel = height.charAt(0).toUpperCase() + height.slice(1)
  if (rest.length === 0) return heightLabel
  if (rest.length === 1 && rest[0] === 'centre') return `${heightLabel}, centre`
  const corner = rest.length === 2 && !rest.includes('centre')
  return `${heightLabel}, ${rest.join(' ')}${corner ? ' corner' : ' edge'}`
}

const TOOL_KIND_BY_STUDIO_TYPE: Record<string, ToolKind> = {
  'flat end': 'flat end mill',
  'ball end': 'ball end',
  drill: 'drill',
  'v-bit': 'V-bit',
  vbit: 'V-bit',
  thread: 'thread mill',
}

/**
 * Applies one record to the header. Returns a problem description when a known record type has a
 * field that is missing or not a number, otherwise null. Record types this reader does not map are
 * kept in `otherRecords`.
 */
export function applyMakeraRecord(header: MakeraHeader, record: MakeraRecord): string | null {
  const f = record.fields
  const problems: string[] = []
  const num = (key: string): number => {
    const raw = f[key]
    const value = raw === undefined || raw.trim() === '' ? NaN : Number(raw)
    if (!Number.isFinite(value)) problems.push(`${key}=${raw ?? '(missing)'}`)
    return value
  }
  const optionalNum = (key: string): number => {
    if (f[key] === undefined || f[key].trim() === '') return 0
    return num(key)
  }

  switch (record.type) {
    case 'STOCK':
      header.stock = {
        shape: STOCK_SHAPE_BY_STUDIO_ID[(f.id ?? '').trim().toLowerCase()] ?? 'unknown',
        studioShape: f.id ?? '',
        lengthX: optionalNum('length'),
        widthY: optionalNum('width'),
        heightZ: num('height'),
        diameter: optionalNum('diameter'),
      }
      break
    case 'ORIGIN':
      header.workOrigin = {
        description: describeWorkOriginPreset(f.type_name ?? ''),
        presetName: f.type_name ?? '',
        offsetFromStockCentre: { x: num('x'), y: num('y'), z: num('z') },
      }
      break
    case 'TOOL': {
      const studioType = f.type ?? ''
      header.tools.push({
        number: num('number'),
        name: f.name ?? '',
        kind: TOOL_KIND_BY_STUDIO_TYPE[studioType.trim().toLowerCase()] ?? 'unknown',
        studioType,
        diameter: num('diameter'),
        shankDiameter: optionalNum('handlediameter'),
        fluteLength: optionalNum('flutelength'),
        shoulderLength: optionalNum('shoulderlength'),
        tipDiameter: optionalNum('tipdiameter'),
        cornerRadius: optionalNum('cornerradius'),
        tipAngle: optionalNum('angle'),
        studioFields: { ...f },
      })
      break
    }
    case 'TIME':
      header.studioTimeEstimateSeconds = num('seconds')
      break
    case 'TOOLPATH':
      header.toolpaths.push({
        number: num('number'),
        toolNumber: num('tool_number'),
        name: f.name ?? '',
      })
      break
    case 'UNIT':
      header.unit = f.value ?? null
      break
    case 'TOOLPATH_START':
      // Positional marker in the program body; the G-code parser consumes it.
      break
    default:
      header.otherRecords.push(record)
  }
  return problems.length > 0 ? `${record.type} record has invalid values: ${problems.join(', ')}` : null
}
