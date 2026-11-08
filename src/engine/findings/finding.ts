// Findings: what the checks report, in one shape for every check.
//
// Design: findings come from three inputs, each with its own module.
//  - stockFindings: the final machined stock against the placed parts (gouge, thread, leftover),
//    clustered by connected-component labelling. Needs the comparison.
//  - moveFindings: the per-move engagement the simulation measured (rapid through material,
//    non-cutting contact, engagement, plunge, feed and spindle). Needs the simulation only.
//  - jobFindings: the G-code alone (spoilboard depth, tool changes).
// Every value shown is a labelled row stating where the number comes from. Thresholds are the
// user's tolerances and the tool table's limits, never constants of their own.
import type { Box3D } from '../stock'
import type { ValueSource } from '../toolTable'

export type FindingSeverity = 'error' | 'warning' | 'info'

export type FindingKind =
  | 'gouge'
  | 'rapid'
  | 'contact'
  | 'spindleOff'
  | 'zeroFeed'
  | 'leftover'
  | 'engagement'
  | 'plunge'
  | 'thread'
  | 'spoilboard'
  | 'toolChange'

/** Group order in the list: errors, then warnings, then information. */
export const FINDING_KINDS: FindingKind[] = [
  'gouge',
  'rapid',
  'contact',
  'spindleOff',
  'zeroFeed',
  'leftover',
  'engagement',
  'plunge',
  'thread',
  'spoilboard',
  'toolChange',
]

export const FINDING_SEVERITY: Record<FindingKind, FindingSeverity> = {
  gouge: 'error',
  rapid: 'error',
  contact: 'error',
  spindleOff: 'error',
  zeroFeed: 'error',
  leftover: 'warning',
  engagement: 'warning',
  plunge: 'warning',
  thread: 'info',
  spoilboard: 'info',
  toolChange: 'info',
}

/** Where a number comes from: the simulation, the G-code, or a tool table value with its source. */
export type ValueBasis = 'measured' | 'calculated' | ValueSource

export interface FindingRow {
  label: string
  /** The value with its unit, as shown. */
  value: string
  basis: ValueBasis
}

export interface Finding {
  kind: FindingKind
  /** Point to look at, work coordinates. */
  at: { x: number; y: number; z: number }
  /** Region the camera frames. */
  box: Box3D
  /** Moves involved, inclusive indices; null for findings on the final stock. */
  moves: { first: number; last: number } | null
  /** Toolpath number, or null when the finding is not tied to one. */
  toolpath: number | null
  rows: FindingRow[]
  /** Order within the group, ascending. */
  rank: number
}

export const mm = (v: number, digits = 3) => `${v.toFixed(digits)} mm`

export const position = (p: { x: number; y: number; z: number }) =>
  `X ${p.x.toFixed(3)}, Y ${p.y.toFixed(3)}, Z ${p.z.toFixed(3)} mm`

/** Lines of a move run, "120" or "120 to 135". */
export const lineRange = (first: number, last: number) => (first === last ? `${first}` : `${first} to ${last}`)

/** Group order, then rank. */
export function sortFindings(findings: Finding[]): Finding[] {
  const order = (k: FindingKind) => FINDING_KINDS.indexOf(k)
  return [...findings].sort((a, b) => order(a.kind) - order(b.kind) || a.rank - b.rank)
}
