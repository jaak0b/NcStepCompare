import type { ParsedJob } from './gcodeParser'
import { MoveType, NO_TOOLPATH, type MoveList } from './moveList'
import type { Box3D } from './stock'

export interface ToolpathSummary {
  /** Toolpath number from the file, or NO_TOOLPATH for moves outside any toolpath marker. */
  number: number
  name: string
  /** Tool number the header assigns, or null when the header has no entry. */
  headerToolNumber: number | null
  /** Tool numbers actually loaded (M6) during this toolpath's moves. */
  toolsUsed: number[]
  /** Programmed moves: an arc counts once, however many segments it was flattened into. */
  moveCount: number
  rapidCount: number
  cuttingCount: number
}

export interface JobSummary {
  toolpaths: ToolpathSummary[]
  /** Bounds of all stored move end points, or null when there are no moves. */
  bounds: Box3D | null
  arcMoveCount: number
}

export function summarizeJob(job: ParsedJob): JobSummary {
  const m: MoveList = job.moves
  const byNumber = new Map<number, ToolpathSummary>()
  for (const tp of job.header.toolpaths) {
    byNumber.set(tp.number, {
      number: tp.number,
      name: tp.name,
      headerToolNumber: tp.toolNumber,
      toolsUsed: [],
      moveCount: 0,
      rapidCount: 0,
      cuttingCount: 0,
    })
  }

  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  let arcMoveCount = 0
  const tools = new Map<number, Set<number>>()

  for (let i = 0; i < m.count; i++) {
    const type = m.type[i]
    // A flattened arc is a run of Arc segments with the same source line.
    const continuesArc = type === MoveType.Arc && i > 0 && m.type[i - 1] === MoveType.Arc && m.line[i - 1] === m.line[i]
    if (!continuesArc) {
      const number = m.toolpath[i]
      let s = byNumber.get(number)
      if (!s) {
        s = {
          number,
          name: number === NO_TOOLPATH ? '' : `Toolpath ${number}`,
          headerToolNumber: null,
          toolsUsed: [],
          moveCount: 0,
          rapidCount: 0,
          cuttingCount: 0,
        }
        byNumber.set(number, s)
      }
      s.moveCount++
      if (type === MoveType.Rapid) s.rapidCount++
      else s.cuttingCount++
      if (type === MoveType.Arc) arcMoveCount++
      let set = tools.get(number)
      if (!set) tools.set(number, (set = new Set()))
      set.add(m.tool[i])
    }
    for (const arr of [m.start, m.end]) {
      const x = arr[i * 3], y = arr[i * 3 + 1], z = arr[i * 3 + 2]
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      if (z < minZ) minZ = z
      if (z > maxZ) maxZ = z
    }
  }

  const toolpaths = [...byNumber.values()].sort((a, b) => a.number - b.number)
  for (const tp of toolpaths) tp.toolsUsed = [...(tools.get(tp.number) ?? [])].sort((a, b) => a - b)

  return {
    toolpaths,
    bounds: m.count > 0 ? { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } } : null,
    arcMoveCount,
  }
}
