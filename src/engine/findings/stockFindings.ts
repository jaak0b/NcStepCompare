// Findings on the final machined stock against the placed parts: gouges, threads and leftover.
//
// Gouge and leftover cells are those the comparison flags (outside the tolerance zone, see
// deviation). Each 8-connected cluster of them is one finding (connected-component labelling).
//
// Thread: a hole cut wider than the model by a thread mill. A gouge cluster is a thread when every
// one of its cells was last cut by a move of a thread-mill tool and the cluster is a ring around a
// hole (it encloses cells that are not part of it). Thread data is not in the STEP export, so the
// G-code decides.
import { cellDeviation, type ToleranceLimits } from '../deviation'
import type { HeightGrid } from '../heightGrid'
import type { ModelGrid } from '../modelGrid'
import { enclosesHole, labelComponents, type CellBounds } from './clusters'
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
}

function clusters(input: StockFindingInput, flags: Uint8Array, amount: (c: number) => number): { list: Cluster[]; labels: Int32Array } {
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

export function stockFindings(input: StockFindingInput): Finding[] {
  const { nx, ny, bottom } = input.grid
  const n = nx * ny
  const { heights, model, limits } = input
  const deviation = (c: number) => cellDeviation(heights[c], model.top[c], model.throughFloor[c], bottom)
  const out: Finding[] = []

  const gougeFlags = new Uint8Array(n)
  for (let c = 0; c < n; c++) gougeFlags[c] = heights[c] < limits.gougeBelow[c] ? 1 : 0
  const gouges = clusters(input, gougeFlags, (c) => -deviation(c))
  gouges.list.forEach((k, label) => {
    const { box, rows } = common(input, k)
    const at = cellCentre(input, k.peakCell)
    const thread = k.allThreadMill && enclosesHole(gouges.labels, nx, label, k)
    if (thread) {
      out.push({
        kind: 'thread',
        at,
        box,
        moves: null,
        toolpath: null,
        rank: at.x * 1e6 + at.y,
        rows: [
          { label: 'Centre', value: position({ x: (box.min.x + box.max.x) / 2, y: (box.min.y + box.max.y) / 2, z: k.maxZ }), basis: 'measured' },
          ...rows,
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

  const leftoverFlags = new Uint8Array(n)
  for (let c = 0; c < n; c++) leftoverFlags[c] = heights[c] > limits.leftoverAbove[c] ? 1 : 0
  const leftover = clusters(input, leftoverFlags, deviation)
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
  return out
}
