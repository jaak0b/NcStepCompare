import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { footprintBounds, rankOrientations, summarizeDeviation, toleranceLimits } from '../src/engine/deviation'
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
  const part = readStepPart(occt, readFileSync(new URL('../fixtures/V2 Backplate 6.11 v93.step', import.meta.url)), 'backplate.step')
  const job = parseGcode(readFileSync(new URL('../fixtures/Z1 Pro - Backplate CM_TOP_210320.nc', import.meta.url), 'utf8'))
  const tools = new Map<number, CutterProfile>()
  for (const t of buildToolTable(job.header.tools, [])) tools.set(t.number, cutterProfile(t) as CutterProfile)
  // The default cell size, so the 0.05 mm gouge tolerance zone reaches the neighbouring cells.
  const sim = new MaterialSimulation(stockBoxInWorkCoordinates(job.header.stock!, job.header.workOrigin!)!, 0.05, job.moves, tools, [])
  sim.advanceTo(job.moves.count)
  const placement: PartPlacement = { upAxis: '-Y', quarterTurns: 2, centerX: 38.5, centerY: 50, bottomZ: -10 }

  it('reads the model in mm with the documented outline', () => {
    expect(part.fileUnit).toBe('millimetre')
    expect(part.bounds.max.x - part.bounds.min.x).toBeCloseTo(51.73, 2)
    expect(part.bounds.max.y - part.bounds.min.y).toBeCloseTo(7, 4)
  })

  it('auto-orient picks the thickness along model Y, turned so the part matches the cut', () => {
    const ranked = rankOrientations(sim.grid, sim.grid.heights, -10, part.mesh, placement)

    expect([ranked[0].upAxis, ranked[0].quarterTurns]).toEqual(['-Y', 2])
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
    const bounds = footprintBounds(g, model)
    const limits = toleranceLimits(g, model, g.bottom, { gouge: 0.05, leftover: 0.1 }, bounds)
    const gouge = new Uint8Array(g.nx * g.ny)
    for (let c = 0; c < gouge.length; c++) gouge[c] = g.heights[c] < limits.gougeBelow[c] ? 1 : 0

    const clusters = clusterSizes(g.nx, g.ny, g.cellSize, gouge)
    const summary = summarizeDeviation(g.nx, g.heights, model, limits, g.bottom, bounds)

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
}, 300000)
