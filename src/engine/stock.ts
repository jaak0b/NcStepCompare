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
 * Only box-shaped stock has a box; any other shape returns null.
 */
export function stockBoxInWorkCoordinates(
  stock: StockDefinition,
  origin: WorkOriginDefinition,
): Box3D | null {
  if (stock.shape !== 'box') return null
  const o = origin.offsetFromStockCentre
  const hx = stock.lengthX / 2
  const hy = stock.widthY / 2
  const hz = stock.heightZ / 2
  return {
    min: { x: -hx - o.x, y: -hy - o.y, z: -hz - o.z },
    max: { x: hx - o.x, y: hy - o.y, z: hz - o.z },
  }
}

export interface SimulationStock {
  box: Box3D
  /** 'header': from the Makera STOCK and ORIGIN records; 'assumed': from the toolpath extent. */
  source: 'header' | 'assumed'
}

/**
 * Stock for the simulation. Without a usable header the stock is assumed to be the XY extent of
 * the toolpath, from its lowest point up to Z 0, so the user can still see the cuts.
 */
export function simulationStock(
  stock: StockDefinition | null,
  origin: WorkOriginDefinition | null,
  toolpathExtent: Box3D | null,
): SimulationStock | null {
  const fromHeader = stock && origin ? stockBoxInWorkCoordinates(stock, origin) : null
  if (fromHeader) return { box: fromHeader, source: 'header' }
  if (!toolpathExtent || toolpathExtent.min.z >= 0) return null
  return {
    box: {
      min: { x: toolpathExtent.min.x, y: toolpathExtent.min.y, z: toolpathExtent.min.z },
      max: { x: toolpathExtent.max.x, y: toolpathExtent.max.y, z: 0 },
    },
    source: 'assumed',
  }
}
