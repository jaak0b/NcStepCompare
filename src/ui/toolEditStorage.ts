// The user's tool table edits, saved in the browser (localStorage) so they come back for the next
// job that uses the same tool. Nothing else is stored.
import { CUTTER_SHAPE_KINDS, type CutterShapeKind } from '../engine/toolShape'
import type { ToolEdits } from '../engine/toolTable'

const STORAGE_KEY = 'ncstepcompare.toolEdits.v1'
const NUMBER_FIELDS = ['diameter', 'cornerRadius', 'tipAngle', 'fluteLength', 'shoulderLength'] as const
type NumberField = (typeof NUMBER_FIELDS)[number]

export type SavedToolEdits = Record<string, ToolEdits>

/** A valid saved entry, or null. */
function validEdits(raw: unknown): ToolEdits | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const out: ToolEdits = {}
  for (const [field, value] of Object.entries(raw as Record<string, unknown>)) {
    if (field === 'kind') {
      if (!CUTTER_SHAPE_KINDS.includes(value as CutterShapeKind)) return null
      out.kind = value as CutterShapeKind
    } else if ((NUMBER_FIELDS as readonly string[]).includes(field)) {
      // JSON writes a missing value (NaN) as null.
      if (value !== null && (typeof value !== 'number' || !Number.isFinite(value))) return null
      out[field as NumberField] = value === null ? NaN : (value as number)
    } else {
      return null
    }
  }
  return Object.keys(out).length > 0 ? out : null
}

/** Saved edits, plus a message when some or all could not be read. */
export function loadToolEdits(): { edits: SavedToolEdits; problem: string | null } {
  let text: string | null
  try {
    text = localStorage.getItem(STORAGE_KEY)
  } catch (err) {
    return { edits: {}, problem: `Saved tool edits are not available: the browser refused access (${String(err)}).` }
  }
  if (text === null) return { edits: {}, problem: null }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    return { edits: {}, problem: `Saved tool edits could not be read and are ignored: ${String(err)}` }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { edits: {}, problem: 'Saved tool edits are not in the expected form and are ignored.' }
  }
  const edits: SavedToolEdits = {}
  const dropped: string[] = []
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const e = validEdits(value)
    if (e) edits[key] = e
    else dropped.push(key.replace(/^(name|number):/, ''))
  }
  return {
    edits,
    problem: dropped.length > 0 ? `Saved edits for ${dropped.join(', ')} were not valid and are ignored.` : null,
  }
}

/** Writes all saved edits. Returns a message when the browser refused, otherwise null. */
export function storeToolEdits(edits: SavedToolEdits): string | null {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(edits))
    return null
  } catch (err) {
    return `Tool edits were not saved in the browser: ${String(err)}`
  }
}
