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
  /**
   * Width of the last cell column and height of the last cell row inside the stock, in mm. When the
   * cell size does not divide the stock size, the last cell overhangs the stock edge and only this
   * part of it holds material.
   */
  lastColumnWidth: number
  lastRowHeight: number
  heights: Float32Array
}

/**
 * Grid size limits. The grid takes 4 bytes per cell in the simulation and again as the display
 * texture, and checkpoints grow with it: 16 million cells is 64 MB each. Most GPUs accept textures up
 * to 8192 texels per side, which bounds the cells along X and along Y.
 */
export const MAX_GRID_CELLS = 16_000_000
export const MAX_GRID_SIDE = 8192

/** Cell counts along X and Y for a stock and cell size: the last cell may overhang the stock edge. */
export function gridDimensions(stock: Box3D, cellSize: number): { nx: number; ny: number } {
  return {
    nx: Math.max(1, Math.ceil((stock.max.x - stock.min.x) / cellSize - 1e-9)),
    ny: Math.max(1, Math.ceil((stock.max.y - stock.min.y) / cellSize - 1e-9)),
  }
}

/** Why a cell size cannot be used for this stock, or null when it can. */
export function cellSizeProblem(stock: Box3D, cellSize: number): string | null {
  if (!(cellSize > 0) || !Number.isFinite(cellSize)) return 'Enter a cell size above 0 mm, for example 0.05.'
  const { nx, ny } = gridDimensions(stock, cellSize)
  if (nx * ny > MAX_GRID_CELLS || nx > MAX_GRID_SIDE || ny > MAX_GRID_SIDE) {
    return `Use a larger cell size: ${cellSize} mm gives ${nx.toLocaleString('en-US')} x ${ny.toLocaleString('en-US')} cells. The limit is ${MAX_GRID_CELLS.toLocaleString('en-US')} cells and ${MAX_GRID_SIDE} cells per side, so the grid and its display fit in memory.`
  }
  return null
}

export function createHeightGrid(stock: Box3D, cellSize = DEFAULT_CELL_SIZE_MM): HeightGrid {
  const problem = cellSizeProblem(stock, cellSize)
  if (problem) throw new RangeError(problem)
  const { nx, ny } = gridDimensions(stock, cellSize)
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
    lastColumnWidth: Math.min(cellSize, stock.max.x - (stock.min.x + (nx - 1) * cellSize)),
    lastRowHeight: Math.min(cellSize, stock.max.y - (stock.min.y + (ny - 1) * cellSize)),
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
