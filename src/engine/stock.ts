import type { StockDefinition, WorkOriginDefinition } from './makeraHeader'

export interface Box3D {
  min: { x: number; y: number; z: number }
  max: { x: number; y: number; z: number }
}

/**
 * Stock box in work coordinates (the coordinates the G-code is written in).
 *
 * Makera Studio gives the work origin as an offset from the stock centre: for 150 x 100 x 10 stock
 * with a top front-left origin it writes x=-75, y=-50, z=5. A stock corner at centre-relative
 * position c therefore sits at c - offset in work coordinates.
 *
 * Only cuboid stock has a box; any other shape returns null.
 */
export function stockBoxInWorkCoordinates(
  stock: StockDefinition,
  origin: WorkOriginDefinition,
): Box3D | null {
  if (stock.shape !== 'cuboid') return null
  const o = origin.offsetFromStockCentre
  const hx = stock.lengthX / 2
  const hy = stock.widthY / 2
  const hz = stock.heightZ / 2
  return {
    min: { x: -hx - o.x, y: -hy - o.y, z: -hz - o.z },
    max: { x: hx - o.x, y: hy - o.y, z: hz - o.z },
  }
}
