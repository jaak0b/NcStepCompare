// Findings from the per-move engagement the simulation measured, in program order, so each check
// sees the material present at that moment (not only the final stock).
//
//  - Rapid through material: a G0 move that removes stock material.
//  - Non-cutting contact: stock material touches the cutter higher above the tip than its flute
//    length.
//  - Engagement: width of cut or depth of cut of a feed move with XY travel above the tool's limit.
//    Thread mills and drills are not checked. One finding per toolpath summarises its moves over the
//    limit and points at the worst one (largest ratio of measured value to limit).
//  - Plunge: an end mill (flat end mill or ball end) feeding straight down, without XY travel, into
//    stock material at the toolpath's cutting feed or faster. Drills, V-bits and thread mills are not
//    end mills and are not checked. The cutting feed of a toolpath is the feed programmed on most of
//    its horizontal feed moves with XY travel (the mode by move count; the higher feed on a tie). A
//    plunge at a lower feed is a planned plunge and not a finding. One finding per toolpath, pointing
//    at the deepest plunge.
//  - Feed and spindle: a feed move that removes stock material with the spindle off, or with a
//    programmed feed of 0 (F0, or no F word yet).
// For the other checks, consecutive moves of the same tool and toolpath with the same finding are
// merged into one finding.
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
const NOT_ENGAGEMENT_CHECKED = new Set<FindingTool['kind']>(['thread mill', 'drill'])

/** Cutting feed per toolpath: the mode of the feeds of its horizontal feed moves with XY travel. */
export function cuttingFeeds(moves: FindingMoves): Map<number, number> {
  const counts = new Map<number, Map<number, number>>()
  for (let i = 0; i < moves.count; i++) {
    const k = i * 3
    const xy = moves.start[k] !== moves.end[k] || moves.start[k + 1] !== moves.end[k + 1]
    if (moves.type[i] === MoveType.Rapid || !xy || moves.start[k + 2] !== moves.end[k + 2]) continue
    let c = counts.get(moves.toolpath[i])
    if (!c) counts.set(moves.toolpath[i], (c = new Map()))
    c.set(moves.feed[i], (c.get(moves.feed[i]) ?? 0) + 1)
  }
  const out = new Map<number, number>()
  for (const [tp, c] of counts) {
    let best = -1
    let bestCount = 0
    for (const [feed, n] of c) {
      if (n > bestCount || (n === bestCount && feed > best)) {
        best = feed
        bestCount = n
      }
    }
    out.set(tp, best)
  }
  return out
}

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
    if (open && open.last === i - 1 && moves.tool[i] === moves.tool[open.last] && moves.toolpath[i] === moves.toolpath[open.last]) {
      open.last = i
    }
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

  const make = (kind: FindingKind, r: Run, rows: FindingRow[], lead: FindingRow[] = []): Finding => {
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
        ...lead,
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

  // Engagement: per toolpath (and tool), the moves over a limit and the worst of them.
  const engagement = new Map<string, { count: number; worst: number; ratio: number; width: number; depth: number }>()
  const widthOf = (i: number) => (Number.isNaN(m.widthOfCut[i]) ? 0 : m.widthOfCut[i])
  for (let i = 0; i < moves.count; i++) {
    const t = toolOf.get(moves.tool[i])
    if (!t || NOT_ENGAGEMENT_CHECKED.has(t.kind) || !feedMove(i) || !cutsStock(i) || !hasXYTravel(i)) continue
    const ratio = Math.max(widthOf(i) / t.widthOfCutLimit, m.maxCutDepth[i] / t.depthOfCutLimit)
    if (!(ratio > 1)) continue
    const key = `${moves.toolpath[i]}|${t.number}`
    const e = engagement.get(key)
    if (!e) {
      engagement.set(key, { count: 1, worst: i, ratio, width: widthOf(i), depth: m.maxCutDepth[i] })
      continue
    }
    e.count++
    if (ratio > e.ratio) {
      e.ratio = ratio
      e.worst = i
    }
    if (widthOf(i) > e.width) e.width = widthOf(i)
    if (m.maxCutDepth[i] > e.depth) e.depth = m.maxCutDepth[i]
  }
  for (const e of engagement.values()) {
    const t = toolOf.get(moves.tool[e.worst])!
    out.push(
      make(
        'engagement',
        { first: e.worst, last: e.worst },
        [
          { label: 'Width of cut of the worst move', value: mm(widthOf(e.worst), 2), basis: 'measured' },
          { label: 'Depth of cut of the worst move', value: mm(m.maxCutDepth[e.worst]), basis: 'measured' },
        ],
        [
          { label: 'Moves over the limit', value: String(e.count), basis: 'measured' },
          { label: 'Largest width of cut', value: mm(e.width, 2), basis: 'measured' },
          { label: 'Width of cut limit', value: mm(t.widthOfCutLimit, 2), basis: t.sources.widthOfCutLimit },
          { label: 'Largest depth of cut', value: mm(e.depth), basis: 'measured' },
          { label: 'Depth of cut limit', value: mm(t.depthOfCutLimit), basis: t.sources.depthOfCutLimit },
        ],
      ),
    )
  }

  // Plunges at the cutting feed, per toolpath (and tool), pointing at the deepest.
  const cuttingFeed = cuttingFeeds(moves)
  const plunges = new Map<string, { count: number; deepest: number }>()
  for (let i = 0; i < moves.count; i++) {
    const t = toolOf.get(moves.tool[i])
    const k = i * 3
    if (!t || !END_MILLS.has(t.kind) || !feedMove(i) || !cutsStock(i) || hasXYTravel(i)) continue
    if (!(moves.end[k + 2] < moves.start[k + 2])) continue
    const cf = cuttingFeed.get(moves.toolpath[i])
    if (cf === undefined || !(moves.feed[i] >= cf)) continue
    const key = `${moves.toolpath[i]}|${t.number}`
    const p = plunges.get(key)
    if (!p) plunges.set(key, { count: 1, deepest: i })
    else {
      p.count++
      if (m.maxCutDepth[i] > m.maxCutDepth[p.deepest]) p.deepest = i
    }
  }
  for (const p of plunges.values()) {
    const i = p.deepest
    out.push(
      make(
        'plunge',
        { first: i, last: i },
        [
          { label: 'Plunge feed', value: `${moves.feed[i]} mm/min`, basis: 'calculated' },
          { label: 'Cutting feed of the toolpath', value: `${cuttingFeed.get(moves.toolpath[i])} mm/min`, basis: 'calculated' },
        ],
        [
          { label: 'Plunges at the cutting feed', value: String(p.count), basis: 'measured' },
          { label: 'Deepest plunge into stock', value: mm(m.maxCutDepth[i]), basis: 'measured' },
        ],
      ),
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
