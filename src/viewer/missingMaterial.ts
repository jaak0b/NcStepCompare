// The material the model needs but the G-code cut away, drawn as a see-through solid: per listed cell
// a column from the machined height up to the model surface, as its top face plus a side face toward
// every neighbour that is not listed (the outer walls of the region). The column's bottom lies on
// the machined surface, which the stock already draws. Gouge cells are red, thread cells purple.
import * as THREE from 'three'
import type { MissingMaterial } from '../engine/comparisonView'
import type { GridInfo } from '../workers/simulationMessages'
import { DEVIATION_COLORS } from './stockSurface'

const OPACITY = 0.45

export function missingMaterialMesh(grid: GridInfo, m: MissingMaterial): THREE.Mesh | null {
  const n = m.cells.length
  if (n === 0) return null
  const listed = new Map<number, number>()
  for (let k = 0; k < n; k++) listed.set(m.cells[k], k)
  const positions: number[] = []
  const colors: number[] = []
  const gouge = new THREE.Color(DEVIATION_COLORS.gouge)
  const thread = new THREE.Color(DEVIATION_COLORS.thread)
  const cs = grid.cellSize
  const quad = (a: number[], b: number[], c: number[], d: number[], col: THREE.Color) => {
    for (const p of [a, b, c, a, c, d]) {
      positions.push(p[0], p[1], p[2])
      colors.push(col.r, col.g, col.b)
    }
  }
  for (let k = 0; k < n; k++) {
    const c = m.cells[k]
    const i = c % grid.nx
    const j = (c - i) / grid.nx
    const x0 = grid.originX + i * cs
    const y0 = grid.originY + j * cs
    const x1 = x0 + cs
    const y1 = y0 + cs
    const lo = m.bottom[k]
    const hi = m.top[k]
    const col = m.thread[k] ? thread : gouge
    quad([x0, y0, hi], [x1, y0, hi], [x1, y1, hi], [x0, y1, hi], col)
    const side = (ni: number, nj: number, a: number[], b: number[]) => {
      if (ni >= 0 && nj >= 0 && ni < grid.nx && nj < grid.ny && listed.has(nj * grid.nx + ni)) return
      quad([a[0], a[1], lo], [b[0], b[1], lo], [b[0], b[1], hi], [a[0], a[1], hi], col)
    }
    side(i, j - 1, [x0, y0], [x1, y0])
    side(i + 1, j, [x1, y0], [x1, y1])
    side(i, j + 1, [x1, y1], [x0, y1])
    side(i - 1, j, [x0, y1], [x0, y0])
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  const material = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: OPACITY,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
  return new THREE.Mesh(geometry, material)
}
