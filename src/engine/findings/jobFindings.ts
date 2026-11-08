// Findings from the G-code alone: how deep each toolpath reaches into the spoilboard, and the
// tool changes.
//
// Spoilboard: the lowest tool tip Z of the toolpath's moves (straight segments, so the lowest point
// is a segment end). Below the stock bottom the tool cuts into the spoilboard the stock sits on.
import type { ToolChange } from '../gcodeParser'
import { mm, position, type Finding } from './finding'
import type { FindingMoves, FindingTool } from './moveFindings'

/** Half size of the region the camera frames around a finding at a single point, mm (view only). */
const POINT_VIEW_HALF_SIZE_MM = 5
const h = POINT_VIEW_HALF_SIZE_MM

/** Moves whose tool tip goes below the stock bottom, one finding per toolpath at its lowest point. */
export function spoilboardFindings(moves: FindingMoves, stockBottom: number): Finding[] {
  const lowest = new Map<number, { z: number; move: number; atEnd: boolean }>()
  for (let i = 0; i < moves.count; i++) {
    const tp = moves.toolpath[i]
    for (const atEnd of [false, true]) {
      const z = (atEnd ? moves.end : moves.start)[i * 3 + 2]
      const best = lowest.get(tp)
      if (z < stockBottom && (!best || z < best.z)) lowest.set(tp, { z, move: i, atEnd })
    }
  }
  const out: Finding[] = []
  for (const [toolpath, low] of lowest) {
    const arr = low.atEnd ? moves.end : moves.start
    const k = low.move * 3
    const at = { x: arr[k], y: arr[k + 1], z: low.z }
    out.push({
      kind: 'spoilboard',
      at,
      box: { min: { x: at.x - h, y: at.y - h, z: low.z }, max: { x: at.x + h, y: at.y + h, z: stockBottom } },
      moves: { first: low.move, last: low.move },
      toolpath,
      rank: toolpath,
      rows: [
        { label: 'Depth below the stock bottom', value: mm(stockBottom - low.z), basis: 'calculated' },
        { label: 'Lowest tool tip', value: position(at), basis: 'calculated' },
        { label: 'Line', value: String(moves.line[low.move]), basis: 'calculated' },
      ],
    })
  }
  return out
}

/** One finding per M6, placed at the start of the first move after it (if any). */
export function toolChangeFindings(moves: FindingMoves, changes: ToolChange[], tools: FindingTool[]): Finding[] {
  const out: Finding[] = []
  changes.forEach((c, n) => {
    // First move after the change: moves are in line order, so a binary search finds it.
    let lo = 0
    let hi = moves.count
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (moves.line[mid] > c.line) hi = mid
      else lo = mid + 1
    }
    const move = lo < moves.count ? lo : null
    const k = (move ?? 0) * 3
    const at = move === null ? { x: 0, y: 0, z: 0 } : { x: moves.start[k], y: moves.start[k + 1], z: moves.start[k + 2] }
    const t = tools.find((x) => x.number === c.tool)
    out.push({
      kind: 'toolChange',
      at,
      box: { min: { x: at.x - h, y: at.y - h, z: at.z - h }, max: { x: at.x + h, y: at.y + h, z: at.z + h } },
      moves: move === null ? null : { first: move, last: move },
      toolpath: c.toolpath,
      rank: n,
      rows: [
        { label: 'Tool', value: t ? `T${t.number} ${t.name}`.trim() : `T${c.tool}`, basis: 'calculated' },
        { label: 'Line', value: String(c.line), basis: 'calculated' },
      ],
    })
  })
  return out
}
