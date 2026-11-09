// Findings on the final machined stock against the placed parts: gouges, threads and leftover.
//
// Gouge and leftover cells are those the comparison flags (outside the tolerance zone, see
// deviation). Each 8-connected cluster of them is one finding (connected-component labelling).
//
// Thread: a hole cut wider than the model by a thread mill. A gouge cluster is a thread when every
// one of its cells was last cut by a move of a thread-mill tool and the cluster is a ring around a
// hole of the model: it encloses cells that are not part of it, and in every one of them the model
// surface within the gouge tolerance (the cell's gouge limit) lies below that under the ring. That
// holds in a through-hole (no material, no limit), on a blind hole's floor, and on the rim cells
// within tolerance of either; it fails for a solid island. Thread data is not in the STEP export, so
// the G-code decides.
//
// With the interval deviation (dexel stock against model dexels, see intervalDeviation), a column
// is a gouge or leftover cell when it holds a gouge or leftover interval anywhere along Z, so thread
// grooves below the hole rim count as well. The clusters are then the components of these columns
// in XY. A thread finding also gets its measured pitch (the median spacing of the groove intervals
// in the column with the most of them, at least three) and major diameter (twice the largest distance of a cluster
// cell centre from the cluster centre).
import { cellDeviation, type ToleranceLimits } from '../deviation'
import type { IntervalDeviation, IntervalSets } from '../intervalDeviation'
import type { HeightGrid } from '../heightGrid'
import type { ModelGrid } from '../modelGrid'
import { enclosedCells, labelComponents, type CellBounds } from './clusters'
import { mm, position, type Finding, type FindingRow } from './finding'

export interface StockFindingInput {
  grid: Pick<HeightGrid, 'nx' | 'ny' | 'cellSize' | 'originX' | 'originY' | 'bottom'>
  /** Machined heights after the last move. */
  heights: Float32Array
  model: ModelGrid
  limits: ToleranceLimits
  /** Per cell: the last move that lowered it, or -1. */
  lastCut: Int32Array
  /** Per move: tool number and source line. */
  moveTool: Int32Array
  moveLine: Int32Array
  /** Tool numbers that are thread mills. */
  threadMills: Set<number>
  /** Deviation as Z intervals per column; when given it decides gouge and leftover cells. */
  deviation?: IntervalDeviation
}

const has = (s: IntervalSets, c: number) => s.offsets[c + 1] > s.offsets[c]

/** Longest interval of column c, 0 without one. */
function longest(s: IntervalSets, c: number): number {
  let best = 0
  for (let k = s.offsets[c]; k < s.offsets[c + 1]; k += 2) best = Math.max(best, s.z[k + 1] - s.z[k])
  return best
}

interface Cluster extends CellBounds {
  cells: number
  /** Cell with the largest deviation, and that deviation. */
  peakCell: number
  peak: number
  minZ: number
  maxZ: number
  /** True while every cell was last cut by a thread mill. */
  allThreadMill: boolean
  /** Lowest gouge limit among the cluster's cells. */
  minGougeLimit: number
}

function clusters(
  input: StockFindingInput,
  flags: Uint8Array,
  amount: (c: number) => number,
  intervals: IntervalSets | null,
): { list: Cluster[]; labels: Int32Array } {
  const { nx, ny } = input.grid
  const { labels, count } = labelComponents(flags, nx, ny)
  const list: Cluster[] = Array.from({ length: count }, () => ({
    i0: nx,
    i1: -1,
    j0: ny,
    j1: -1,
    cells: 0,
    peakCell: -1,
    peak: -Infinity,
    minZ: Infinity,
    maxZ: -Infinity,
    allThreadMill: true,
    minGougeLimit: Infinity,
  }))
  for (let c = 0; c < labels.length; c++) {
    const l = labels[c]
    if (l < 0) continue
    const k = list[l]
    const i = c % nx
    const j = (c - i) / nx
    if (i < k.i0) k.i0 = i
    if (i > k.i1) k.i1 = i
    if (j < k.j0) k.j0 = j
    if (j > k.j1) k.j1 = j
    k.cells++
    const a = amount(c)
    if (a > k.peak) {
      k.peak = a
      k.peakCell = c
    }
    const z = input.heights[c]
    if (z < k.minZ) k.minZ = z
    if (z > k.maxZ) k.maxZ = z
    if (intervals && has(intervals, c)) {
      k.minZ = Math.min(k.minZ, intervals.z[intervals.offsets[c]])
      k.maxZ = Math.max(k.maxZ, intervals.z[intervals.offsets[c + 1] - 1])
    }
    if (input.limits.gougeBelow[c] < k.minGougeLimit) k.minGougeLimit = input.limits.gougeBelow[c]
    const m = input.lastCut[c]
    if (m < 0 || !input.threadMills.has(input.moveTool[m])) k.allThreadMill = false
  }
  return { list, labels }
}

function cellCentre(input: StockFindingInput, c: number) {
  const { nx, cellSize, originX, originY } = input.grid
  const i = c % nx
  const j = (c - i) / nx
  return { x: originX + (i + 0.5) * cellSize, y: originY + (j + 0.5) * cellSize, z: input.heights[c] }
}

function common(input: StockFindingInput, k: Cluster): { box: Finding['box']; rows: FindingRow[] } {
  const { cellSize, originX, originY } = input.grid
  const box = {
    min: { x: originX + k.i0 * cellSize, y: originY + k.j0 * cellSize, z: k.minZ },
    max: { x: originX + (k.i1 + 1) * cellSize, y: originY + (k.j1 + 1) * cellSize, z: k.maxZ },
  }
  const rows: FindingRow[] = [
    { label: 'Area', value: `${(k.cells * cellSize * cellSize).toFixed(3)} mm²`, basis: 'measured' },
    {
      label: 'Size in X and Y',
      value: `${((k.i1 - k.i0 + 1) * cellSize).toFixed(2)} x ${((k.j1 - k.j0 + 1) * cellSize).toFixed(2)} mm`,
      basis: 'measured',
    },
  ]
  return { box, rows }
}

function lastCutRow(input: StockFindingInput, c: number): FindingRow[] {
  const m = input.lastCut[c]
  if (m < 0) return []
  return [{ label: 'Last cut by', value: `T${input.moveTool[m]}, line ${input.moveLine[m]}`, basis: 'measured' }]
}

/** True when the cluster encloses cells and every one of them is a hole in the model. */
function enclosesModelHole(input: StockFindingInput, labels: Int32Array, label: number, k: Cluster): boolean {
  const inside = enclosedCells(labels, input.grid.nx, label, k)
  if (inside.length === 0) return false
  return inside.every((c) => input.limits.gougeBelow[c] < k.minGougeLimit)
}

/** Measured pitch and major diameter of a thread cluster from its groove intervals. */
function threadRows(input: StockFindingInput, labels: Int32Array, label: number, gouge: IntervalSets, centre: { x: number; y: number }): FindingRow[] {
  const { nx, cellSize, originX, originY } = input.grid
  let most = -1
  let mostCount = 0
  let radius = 0
  for (let c = 0; c < labels.length; c++) {
    if (labels[c] !== label) continue
    const count = (gouge.offsets[c + 1] - gouge.offsets[c]) / 2
    if (count > mostCount) {
      mostCount = count
      most = c
    }
    const i = c % nx
    const j = (c - i) / nx
    radius = Math.max(radius, Math.hypot(originX + (i + 0.5) * cellSize - centre.x, originY + (j + 0.5) * cellSize - centre.y))
  }
  const rows: FindingRow[] = [{ label: 'Major diameter (cell centres)', value: mm(2 * radius), basis: 'measured' }]
  if (mostCount >= 3) {
    // Median spacing of the groove lower ends: the first and last turns are cut by a partial helix.
    const spacings: number[] = []
    for (let k = gouge.offsets[most] + 2; k < gouge.offsets[most + 1]; k += 2) spacings.push(gouge.z[k] - gouge.z[k - 2])
    spacings.sort((x, y) => x - y)
    const m = spacings.length
    const median = m % 2 === 1 ? spacings[(m - 1) / 2] : (spacings[m / 2 - 1] + spacings[m / 2]) / 2
    rows.unshift({ label: 'Pitch', value: mm(median), basis: 'measured' })
    rows.push({ label: 'Grooves in one column', value: String(mostCount), basis: 'measured' })
  }
  return rows
}

/** Gouge, thread and leftover findings on the final stock. */
export function stockFindings(input: StockFindingInput): Finding[] {
  return analyseStock(input).findings
}

/** The findings, and per cell 1 where the cell belongs to a thread finding. */
export function analyseStock(input: StockFindingInput): { findings: Finding[]; threadMask: Uint8Array } {
  const { nx, ny, bottom } = input.grid
  const n = nx * ny
  const { heights, model, limits } = input
  const deviation = (c: number) => cellDeviation(heights[c], model.top[c], model.throughFloor[c], bottom)
  const out: Finding[] = []
  const threadMask = new Uint8Array(nx * ny)
  const threadLabels = new Set<number>()

  const dev = input.deviation ?? null
  const gougeFlags = new Uint8Array(n)
  for (let c = 0; c < n; c++) gougeFlags[c] = (dev ? has(dev.gouge, c) : heights[c] < limits.gougeBelow[c]) ? 1 : 0
  const gougeAmount = dev ? (c: number) => Math.max(-deviation(c), longest(dev.gouge, c)) : (c: number) => -deviation(c)
  const gouges = clusters(input, gougeFlags, gougeAmount, dev ? dev.gouge : null)
  gouges.list.forEach((k, label) => {
    const { box, rows } = common(input, k)
    const at = cellCentre(input, k.peakCell)
    const thread = k.allThreadMill && enclosesModelHole(input, gouges.labels, label, k)
    if (thread) {
      threadLabels.add(label)
      const centre = { x: (box.min.x + box.max.x) / 2, y: (box.min.y + box.max.y) / 2 }
      out.push({
        kind: 'thread',
        at,
        box,
        moves: null,
        toolpath: null,
        rank: at.x * 1e6 + at.y,
        rows: [
          { label: 'Centre', value: position({ ...centre, z: k.maxZ }), basis: 'measured' },
          ...rows,
          ...(dev ? threadRows(input, gouges.labels, label, dev.gouge, centre) : []),
          ...lastCutRow(input, k.peakCell),
        ],
      })
      return
    }
    out.push({
      kind: 'gouge',
      at,
      box,
      moves: null,
      toolpath: null,
      rank: -k.peak,
      rows: [
        { label: 'Deepest below the model', value: mm(k.peak), basis: 'measured' },
        { label: 'Deepest point', value: position(at), basis: 'measured' },
        ...rows,
        ...lastCutRow(input, k.peakCell),
      ],
    })
  })

  for (let c = 0; c < n; c++) if (threadLabels.has(gouges.labels[c])) threadMask[c] = 1

  const leftoverFlags = new Uint8Array(n)
  for (let c = 0; c < n; c++) leftoverFlags[c] = (dev ? has(dev.leftover, c) : heights[c] > limits.leftoverAbove[c]) ? 1 : 0
  const leftoverAmount = dev ? (c: number) => Math.max(deviation(c), longest(dev.leftover, c)) : deviation
  const leftover = clusters(input, leftoverFlags, leftoverAmount, dev ? dev.leftover : null)
  for (const k of leftover.list) {
    const { box, rows } = common(input, k)
    const at = cellCentre(input, k.peakCell)
    out.push({
      kind: 'leftover',
      at,
      box,
      moves: null,
      toolpath: null,
      rank: -k.peak,
      rows: [
        { label: 'Highest above the model or the stock bottom', value: mm(k.peak), basis: 'measured' },
        { label: 'Highest point', value: position(at), basis: 'measured' },
        ...rows,
      ],
    })
  }
  return { findings: out, threadMask }
}
