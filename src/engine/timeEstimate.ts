// Feed-based machining time per toolpath and in total, calculated from the move list.
//
// Each cutting move takes its length divided by its programmed feed; each rapid takes its length
// divided by the rapid rate, which is not in the file and so is a user setting. Dwells (G4) add
// their time. Acceleration and deceleration are ignored, so real machines take somewhat longer on
// short moves.

import type { Dwell } from './gcodeParser'
import { MoveType, type MoveList } from './moveList'

/**
 * Assumed rapid rate in mm/min. The Makera Z1 rapid rate is not published in the file; 3000 mm/min
 * is the maximum travel speed Makera states for its Carvera machines.
 */
export const DEFAULT_RAPID_RATE_MM_PER_MIN = 3000

export interface TimeBreakdown {
  feedSeconds: number
  rapidSeconds: number
  dwellSeconds: number
  totalSeconds: number
  /** Length of cutting moves (feed moves and arcs) in mm. */
  feedLengthMm: number
  rapidLengthMm: number
  /** Length of cutting moves with a feed of 0: they get no time. */
  noFeedLengthMm: number
}

export interface ToolpathTime extends TimeBreakdown {
  /** Toolpath number from the move list, or NO_TOOLPATH. */
  toolpath: number
}

export interface TimeEstimate {
  rapidRateMmPerMin: number
  toolpaths: ToolpathTime[]
  total: TimeBreakdown
}

/** Why a rapid rate cannot be used, or null. */
export function rapidRateProblem(rapidRateMmPerMin: number): string | null {
  if (!Number.isFinite(rapidRateMmPerMin) || rapidRateMmPerMin <= 0) {
    return 'Enter a rapid rate above 0 mm/min, for example 3000.'
  }
  return null
}

const emptyBreakdown = (): TimeBreakdown => ({
  feedSeconds: 0,
  rapidSeconds: 0,
  dwellSeconds: 0,
  totalSeconds: 0,
  feedLengthMm: 0,
  rapidLengthMm: 0,
  noFeedLengthMm: 0,
})

export function estimateMachiningTime(
  moves: MoveList,
  dwells: readonly Dwell[],
  rapidRateMmPerMin: number,
): TimeEstimate {
  const problem = rapidRateProblem(rapidRateMmPerMin)
  if (problem) throw new RangeError(problem)

  const byToolpath = new Map<number, ToolpathTime>()
  const entry = (toolpath: number) => {
    let e = byToolpath.get(toolpath)
    if (!e) byToolpath.set(toolpath, (e = { toolpath, ...emptyBreakdown() }))
    return e
  }

  const { start, end } = moves
  for (let i = 0; i < moves.count; i++) {
    const j = i * 3
    const length = Math.hypot(end[j] - start[j], end[j + 1] - start[j + 1], end[j + 2] - start[j + 2])
    const e = entry(moves.toolpath[i])
    if (moves.type[i] === MoveType.Rapid) {
      e.rapidLengthMm += length
      e.rapidSeconds += (length / rapidRateMmPerMin) * 60
    } else {
      e.feedLengthMm += length
      const feed = moves.feed[i]
      if (feed > 0) e.feedSeconds += (length / feed) * 60
      else e.noFeedLengthMm += length
    }
  }
  for (const d of dwells) entry(d.toolpath).dwellSeconds += d.seconds

  const total = emptyBreakdown()
  const toolpaths = [...byToolpath.values()].sort((a, b) => a.toolpath - b.toolpath)
  for (const t of toolpaths) {
    t.totalSeconds = t.feedSeconds + t.rapidSeconds + t.dwellSeconds
    total.feedSeconds += t.feedSeconds
    total.rapidSeconds += t.rapidSeconds
    total.dwellSeconds += t.dwellSeconds
    total.totalSeconds += t.totalSeconds
    total.feedLengthMm += t.feedLengthMm
    total.rapidLengthMm += t.rapidLengthMm
    total.noFeedLengthMm += t.noFeedLengthMm
  }
  return { rapidRateMmPerMin, toolpaths, total }
}
