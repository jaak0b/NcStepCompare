import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { autoOrient } from '../src/engine/autoOrient'
import { DeviationTracker, toleranceLimits } from '../src/engine/deviation'
import { spoilboardFindings } from '../src/engine/findings/jobFindings'
import { stockFindings } from '../src/engine/findings/stockFindings'
import { parseGcode } from '../src/engine/gcodeParser'
import { mergePartGrids, rasterizePart } from '../src/engine/modelGrid'
import { placePositions, type PartPlacement } from '../src/engine/partPlacement'
import { MaterialSimulation } from '../src/engine/simulation'
import { stockBoxInWorkCoordinates } from '../src/engine/stock'
import { readStepPart, type OcctModule } from '../src/engine/stepModel'
import { cutterProfile, type CutterProfile } from '../src/engine/toolShape'
import { buildToolTable } from '../src/engine/toolTable'

/** Bounding box sizes (mm) of the 8-connected clusters of flagged cells. */
function clusterSizes(nx: number, ny: number, cellSize: number, flagged: Uint8Array): { w: number; h: number }[] {
  const seen = new Uint8Array(nx * ny)
  const sizes: { w: number; h: number }[] = []
  for (let start = 0; start < nx * ny; start++) {
    if (!flagged[start] || seen[start]) continue
    seen[start] = 1
    const stack = [start]
    let i0 = nx
    let i1 = -1
    let j0 = ny
    let j1 = -1
    while (stack.length > 0) {
      const c = stack.pop()!
      const i = c % nx
      const j = (c - i) / nx
      i0 = Math.min(i0, i)
      i1 = Math.max(i1, i)
      j0 = Math.min(j0, j)
      j1 = Math.max(j1, j)
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const qi = i + di
          const qj = j + dj
          const q = qj * nx + qi
          if (qi < 0 || qj < 0 || qi >= nx || qj >= ny || !flagged[q] || seen[q]) continue
          seen[q] = 1
          stack.push(q)
        }
      }
    }
    sizes.push({ w: (i1 - i0 + 1) * cellSize, h: (j1 - j0 + 1) * cellSize })
  }
  return sizes
}

// Facts stated for the backplate fixture in CLAUDE.md: placed at centre X 38.5, Y 50.0 with its bottom
// on the stock bottom (Z -10), the 7 mm thickness along the model Y axis; no gouges except the 11 M3
// holes, which are 2.53 mm in the model and thread-milled to about 3.0 mm.
describe('backplate fixture against its STEP model', async () => {
  const require = createRequire(import.meta.url)
  const occt: OcctModule = await require('occt-import-js')()
  // Tessellated at 0.005 mm, a tenth of the 0.05 mm gouge tolerance (the app's rule).
  const part = readStepPart(occt, readFileSync(new URL('../fixtures/V2 Backplate 6.11 v93.step', import.meta.url)), 'backplate.step', 0.005)
  const job = parseGcode(readFileSync(new URL('../fixtures/Z1 Pro - Backplate CM_TOP_210320.nc', import.meta.url), 'utf8'))
  const tools = new Map<number, CutterProfile>()
  const toolTable = buildToolTable(job.header.tools, [])
  for (const t of toolTable) tools.set(t.number, cutterProfile(t) as CutterProfile)
  // The default cell size, so the 0.05 mm gouge tolerance zone reaches the neighbouring cells.
  const sim = new MaterialSimulation(stockBoxInWorkCoordinates(job.header.stock!, job.header.workOrigin!)!, 0.05, job.moves, tools, [])
  sim.advanceTo(job.moves.count)
  const placement: PartPlacement = { upAxis: '-Y', quarterTurns: 2, centerX: 38.5, centerY: 50, bottomZ: -10 }

  it('reads the model in mm with the documented outline', () => {
    expect(part.fileUnit).toBe('millimetre')
    expect(part.bounds.max.x - part.bounds.min.x).toBeCloseTo(51.73, 2)
    expect(part.bounds.max.y - part.bounds.min.y).toBeCloseTo(7, 4)
  })

  it('auto-orient from the default placement (stock centre 75, 50) finds the cut part at 38.5, 50.0', () => {
    const best = autoOrient(sim.grid, sim.grid.heights, part.mesh, { centerX: 75, centerY: 50, bottomZ: -10 })[0]

    expect([best.upAxis, best.quarterTurns]).toEqual(['-Y', 2])
    // Within one cell (0.05 mm).
    expect(Math.abs(best.centerX - 38.5)).toBeLessThanOrEqual(0.05)
    expect(Math.abs(best.centerY - 50)).toBeLessThanOrEqual(0.05)
  })

  it('places the part top at Z -3.0', () => {
    const positions = placePositions(part.mesh, placement)
    let top = -Infinity
    for (let k = 2; k < positions.length; k += 3) top = Math.max(top, positions[k])

    expect(top).toBeCloseTo(-3, 4)
  })

  it('has gouges only at the 11 thread-milled M3 holes, each about 3.0 mm across', () => {
    const g = sim.grid
    const model = mergePartGrids(g, [rasterizePart(g, placePositions(part.mesh, placement), part.mesh.indices)])
    const limits = toleranceLimits(g, model, { gouge: 0.05, leftover: 0.1 }, g.bottom)
    const gouge = new Uint8Array(g.nx * g.ny)
    for (let c = 0; c < gouge.length; c++) gouge[c] = g.heights[c] < limits.gougeBelow[c] ? 1 : 0

    const clusters = clusterSizes(g.nx, g.ny, g.cellSize, gouge)
    const summary = new DeviationTracker(g.nx, model, limits, g.bottom, g.heights).summary()

    expect(summary.gougeCells).toBeGreaterThan(0)
    expect(clusters).toHaveLength(11)
    // Within one cell (0.05 mm) of 3.0 mm in X and Y.
    for (const c of clusters) {
      expect(c.w).toBeGreaterThanOrEqual(2.95)
      expect(c.w).toBeLessThanOrEqual(3.05)
      expect(c.h).toBeGreaterThanOrEqual(2.95)
      expect(c.h).toBeLessThanOrEqual(3.05)
    }
  })

  it('reports no gouge and the 11 M3 holes as threads, 3.00 mm across', () => {
    const g = sim.grid
    const model = mergePartGrids(g, [rasterizePart(g, placePositions(part.mesh, placement), part.mesh.indices)])
    const findings = stockFindings({
      grid: g,
      heights: g.heights,
      model,
      limits: toleranceLimits(g, model, { gouge: 0.05, leftover: 0.1 }, g.bottom),
      lastCut: sim.lastCut,
      moveTool: job.moves.tool,
      moveLine: job.moves.line,
      threadMills: new Set(toolTable.filter((t) => t.kind === 'thread mill').map((t) => t.number)),
    })

    expect(findings.filter((f) => f.kind === 'gouge')).toEqual([])
    const sizes = findings.filter((f) => f.kind === 'thread').map((f) => f.rows.find((r) => r.label === 'Size in X and Y')?.value)
    expect(sizes).toEqual(Array(11).fill('3.00 x 3.00 mm'))
  })

  // Through-cuts end at Z -10.3 and drilling at Z -11.0, with the stock bottom at Z -10.
  it('reaches 0.3 mm into the spoilboard with the through-cuts and 1.0 mm with the drill', () => {
    const depths = spoilboardFindings(job.moves, -10).map((f) => [f.toolpath, f.rows[0].value])

    expect(depths).toEqual([
      [3, '0.300 mm'],
      [4, '1.000 mm'],
      [6, '0.300 mm'],
      [7, '0.300 mm'],
      [8, '0.300 mm'],
      [9, '0.300 mm'],
      [12, '0.300 mm'],
    ])
  })
}, 300000)
