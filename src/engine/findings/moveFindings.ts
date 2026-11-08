// Findings from the per-move engagement the simulation measured, in program order, so each check
// sees the material present at that moment (not only the final stock).
//
//  - Rapid through material: a G0 move that removes stock material.
//  - Non-cutting contact: stock material touches the cutter higher above the tip than its flute
//    length.
//  - Engagement: width of cut or depth of cut of a feed move with XY travel above the tool's limit.
//  - Plunge: an end mill (flat end mill or ball end) feeding straight down, without XY travel, into
//    stock material. Drills, V-bits and thread mills are not end mills and are not checked.
//  - Feed and spindle: a feed move that removes stock material with the spindle off, or with a
//    programmed feed of 0 (F0, or no F word yet).
// Consecutive moves of the same tool with the same finding are merged into one finding.
import { MoveType, SpindleState, type MoveList } from '../moveList'
import type { ToolSetup } from '../toolTable'
import { lineRange, mm, position, type Finding, type FindingKind, type FindingRow } from './finding'

export type FindingMoves = Pick<MoveList, 'count' | 'start' | 'end' | 'type' | 'feed' | 'spindle' | 'tool' | 'toolpath' | 'line'>

/** The tool table values the checks use. */
export type FindingTool = Pick<
  ToolSetup,
  'number' | 'name' | 'kind' | 'diameter' | 'fluteLength' | 'widthOfCutLimit' | 'depthOfCutLimit' | 'sources'
>

/** Per-move values from the simulation (see MaterialSimulation). */
export interface MoveMeasurements {
  removedVolume: Float32Array
  maxCutDepth: Float32Array
  widthOfCut: Float32Array
  contactHeight: Float32Array
}

const END_MILLS = new Set<FindingTool['kind']>(['flat end mill', 'ball end'])

interface Run {
  first: number
  last: number
}

/** Runs of consecutive flagged moves with the same tool. */
function runs(moves: FindingMoves, flagged: (i: number) => boolean): Run[] {
  const out: Run[] = []
  let open: Run | null = null
  for (let i = 0; i < moves.count; i++) {
    if (!flagged(i)) {
      open = null
      continue
    }
    if (open && moves.tool[i] === moves.tool[open.last] && open.last === i - 1) open.last = i
    else out.push((open = { first: i, last: i }))
  }
  return out
}

function maxOver(a: Float32Array, r: Run, skipNaN = false): number {
  let m = -Infinity
  for (let i = r.first; i <= r.last; i++) if (!(skipNaN && Number.isNaN(a[i])) && a[i] > m) m = a[i]
  return m
}

function sumOver(a: Float32Array, r: Run): number {
  let s = 0
  for (let i = r.first; i <= r.last; i++) s += a[i]
  return s
}

export function moveFindings(moves: FindingMoves, m: MoveMeasurements, tools: FindingTool[]): Finding[] {
  const toolOf = new Map(tools.map((t) => [t.number, t]))
  const out: Finding[] = []
  const cutsStock = (i: number) => m.removedVolume[i] > 0
  const feedMove = (i: number) => moves.type[i] !== MoveType.Rapid
  const hasXYTravel = (i: number) =>
    moves.start[i * 3] !== moves.end[i * 3] || moves.start[i * 3 + 1] !== moves.end[i * 3 + 1]

  const make = (kind: FindingKind, r: Run, rows: FindingRow[]): Finding => {
    const t = toolOf.get(moves.tool[r.first])
    const radius = t && t.diameter > 0 ? t.diameter / 2 : 0
    const box = {
      min: { x: Infinity, y: Infinity, z: Infinity },
      max: { x: -Infinity, y: -Infinity, z: -Infinity },
    }
    for (let i = r.first; i <= r.last; i++) {
      for (const arr of [moves.start, moves.end]) {
        box.min.x = Math.min(box.min.x, arr[i * 3] - radius)
        box.min.y = Math.min(box.min.y, arr[i * 3 + 1] - radius)
        box.min.z = Math.min(box.min.z, arr[i * 3 + 2])
        box.max.x = Math.max(box.max.x, arr[i * 3] + radius)
        box.max.y = Math.max(box.max.y, arr[i * 3 + 1] + radius)
        box.max.z = Math.max(box.max.z, arr[i * 3 + 2])
      }
    }
    const k = r.last * 3
    const at = { x: moves.end[k], y: moves.end[k + 1], z: moves.end[k + 2] }
    const count = r.last - r.first + 1
    return {
      kind,
      at,
      box,
      moves: { first: r.first, last: r.last },
      toolpath: moves.toolpath[r.first],
      rank: r.first,
      rows: [
        { label: count === 1 ? 'Line' : 'Lines', value: lineRange(moves.line[r.first], moves.line[r.last]), basis: 'calculated' },
        ...(count > 1 ? [{ label: 'Moves', value: String(count), basis: 'calculated' as const }] : []),
        { label: 'Tool', value: t ? `T${t.number} ${t.name}`.trim() : `T${moves.tool[r.first]}`, basis: 'calculated' },
        ...rows,
        { label: 'End of the last move', value: position(at), basis: 'calculated' },
      ],
    }
  }

  for (const r of runs(moves, (i) => !feedMove(i) && cutsStock(i))) {
    out.push(
      make('rapid', r, [
        { label: 'Stock removed by the rapids', value: `${sumOver(m.removedVolume, r).toFixed(3)} mm³`, basis: 'measured' },
        { label: 'Deepest cut', value: mm(maxOver(m.maxCutDepth, r)), basis: 'measured' },
      ]),
    )
  }

  const tooHigh = (i: number) => {
    const t = toolOf.get(moves.tool[i])
    return !!t && t.fluteLength > 0 && m.contactHeight[i] > t.fluteLength
  }
  for (const r of runs(moves, tooHigh)) {
    const t = toolOf.get(moves.tool[r.first])!
    out.push(
      make('contact', r, [
        { label: 'Highest stock in contact above the tool tip', value: mm(maxOver(m.contactHeight, r)), basis: 'measured' },
        { label: 'Flute length', value: mm(t.fluteLength), basis: t.sources.fluteLength },
      ]),
    )
  }

  const overLimit = (i: number) => {
    const t = toolOf.get(moves.tool[i])
    if (!t || !feedMove(i) || !cutsStock(i) || !hasXYTravel(i)) return false
    return m.widthOfCut[i] > t.widthOfCutLimit || m.maxCutDepth[i] > t.depthOfCutLimit
  }
  for (const r of runs(moves, overLimit)) {
    const t = toolOf.get(moves.tool[r.first])!
    out.push(
      make('engagement', r, [
        { label: 'Largest width of cut', value: mm(maxOver(m.widthOfCut, r, true), 2), basis: 'measured' },
        { label: 'Width of cut limit', value: mm(t.widthOfCutLimit, 2), basis: t.sources.widthOfCutLimit },
        { label: 'Largest depth of cut', value: mm(maxOver(m.maxCutDepth, r)), basis: 'measured' },
        { label: 'Depth of cut limit', value: mm(t.depthOfCutLimit), basis: t.sources.depthOfCutLimit },
      ]),
    )
  }

  const plunge = (i: number) => {
    const t = toolOf.get(moves.tool[i])
    const k = i * 3
    return !!t && END_MILLS.has(t.kind) && feedMove(i) && cutsStock(i) && !hasXYTravel(i) && moves.end[k + 2] < moves.start[k + 2]
  }
  for (const r of runs(moves, plunge)) {
    out.push(
      make('plunge', r, [
        { label: 'Depth plunged into stock', value: mm(maxOver(m.maxCutDepth, r)), basis: 'measured' },
        { label: 'Feed', value: `${moves.feed[r.first]} mm/min`, basis: 'calculated' },
      ]),
    )
  }

  for (const r of runs(moves, (i) => feedMove(i) && cutsStock(i) && moves.spindle[i] === SpindleState.Off)) {
    out.push(
      make('spindleOff', r, [
        { label: 'Stock removed with the spindle off', value: `${sumOver(m.removedVolume, r).toFixed(3)} mm³`, basis: 'measured' },
      ]),
    )
  }

  for (const r of runs(moves, (i) => feedMove(i) && cutsStock(i) && moves.feed[i] === 0)) {
    out.push(
      make('zeroFeed', r, [
        { label: 'Programmed feed', value: '0 mm/min (F0, or no F word before this move)', basis: 'calculated' },
        { label: 'Stock removed', value: `${sumOver(m.removedVolume, r).toFixed(3)} mm³`, basis: 'measured' },
      ]),
    )
  }
  return out
}
