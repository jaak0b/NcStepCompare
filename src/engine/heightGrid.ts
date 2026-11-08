// Height grid over the stock in XY: one material-top height per cell, in work coordinates.
// Heights are not clamped at the stock bottom, so a cut into the spoilboard keeps its real depth.
import type { Box3D } from './stock'

/** Default cell size in mm. */
export const DEFAULT_CELL_SIZE_MM = 0.05

export interface HeightGrid {
  /** Cell counts along X and Y. Cell (i, j) is at heights[j * nx + i]. */
  nx: number
  ny: number
  cellSize: number
  /** Work coordinates of the grid's lower-left corner (cell 0, 0 edge). */
  originX: number
  originY: number
  /** Stock top and bottom Z. */
  top: number
  bottom: number
  heights: Float32Array
}

export function createHeightGrid(stock: Box3D, cellSize = DEFAULT_CELL_SIZE_MM): HeightGrid {
  if (!(cellSize > 0) || !Number.isFinite(cellSize)) {
    throw new RangeError(`Cell size must be a number above 0 mm, got ${cellSize}.`)
  }
  const nx = Math.max(1, Math.ceil((stock.max.x - stock.min.x) / cellSize - 1e-9))
  const ny = Math.max(1, Math.ceil((stock.max.y - stock.min.y) / cellSize - 1e-9))
  const heights = new Float32Array(nx * ny)
  heights.fill(stock.max.z)
  return {
    nx,
    ny,
    cellSize,
    originX: stock.min.x,
    originY: stock.min.y,
    top: stock.max.z,
    bottom: stock.min.z,
    heights,
  }
}

/** Height at the cell containing (x, y), or null outside the grid. */
export function heightAt(grid: HeightGrid, x: number, y: number): number | null {
  const i = Math.floor((x - grid.originX) / grid.cellSize)
  const j = Math.floor((y - grid.originY) / grid.cellSize)
  if (i < 0 || j < 0 || i >= grid.nx || j >= grid.ny) return null
  return grid.heights[j * grid.nx + i]
}

export interface DownsampledHeights {
  nx: number
  ny: number
  /** Size of one display cell in mm. */
  cellSize: number
  heights: Float32Array
}

/**
 * Display copy of the grid: each block of factor x factor cells becomes one value, the lowest
 * height in the block, so a slot narrower than a block still shows at its full depth.
 */
export function downsampleMin(grid: HeightGrid, factor: number): DownsampledHeights {
  const f = Math.max(1, Math.floor(factor))
  const nx = Math.ceil(grid.nx / f)
  const ny = Math.ceil(grid.ny / f)
  const out = new Float32Array(nx * ny).fill(Infinity)
  const h = grid.heights
  for (let j = 0; j < grid.ny; j++) {
    const row = j * grid.nx
    const orow = Math.floor(j / f) * nx
    for (let i = 0; i < grid.nx; i++) {
      const v = h[row + i]
      const o = orow + Math.floor(i / f)
      if (v < out[o]) out[o] = v
    }
  }
  return { nx, ny, cellSize: grid.cellSize * f, heights: out }
}
