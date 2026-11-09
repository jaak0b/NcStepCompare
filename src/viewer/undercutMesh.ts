// Undercuts of the machined stock, drawn as their exact boundary faces (van Hook 1986; Stautner and
// Müller): every gap of a dexel column gets a ceiling quad at its top Z (facing down) and a floor
// quad at its bottom Z (facing up) over the cell's square, and every cell side where a gap of one
// column meets material of the neighbour gets a vertical quad over exactly that Z range. No Z
// quantisation and no smoothing. The top surface (stockSurface) draws everything above the gaps.
//
// The faces are built per tile of 128 x 128 cells, one mesh per tile, and rebuilt only for tiles a
// change touches (a cell's side faces depend on its neighbours, so a change reaches one cell into
// the next tile). The mesh is never decimated.
//
// With a comparison, each column's faces take the deviation class of the column on the final stock
// (thread, gouge, leftover or within tolerance, the same classes and colours as the top surface);
// without one they are stock grey.
import * as THREE from 'three'
import { GOUGE_INTERVAL_BIT, LEFTOVER_INTERVAL_BIT, THREAD_BIT } from '../engine/comparisonView'
import { DEVIATION_COLORS } from './stockSurface'
import type { GapRecord } from '../engine/dexelStock'
import type { CellRect } from '../engine/simulation'
import type { GridInfo } from '../workers/simulationMessages'

const TILE = 128
const STOCK_COLOR = 0xb8bcc2

/** Gaps of every column that holds any, mirrored on the main thread from the worker's records. */
export class StockGaps {
  readonly columns = new Map<number, Float32Array>()

  constructor(private readonly nx: number) {}

  /** Replaces the gaps inside `rect` with the record's (which covers the same rectangle). */
  applyRect(rect: CellRect, rec: GapRecord): void {
    if (this.columns.size > 0 && rect.minI <= rect.maxI) {
      for (const c of [...this.columns.keys()]) {
        const j = Math.floor(c / this.nx)
        const i = c - j * this.nx
        if (i >= rect.minI && i <= rect.maxI && j >= rect.minJ && j <= rect.maxJ) this.columns.delete(c)
      }
    }
    let r = 0
    for (let k = 0; k < rec.columns.length; k++) {
      const n = rec.counts[k] * 2
      this.columns.set(rec.columns[k], rec.pairs.slice(r, r + n))
      r += n
    }
  }
}

const EMPTY = new Float32Array(0)

/** Z ranges of `gaps` (pairs) where the column with `top` and `otherGaps` holds material. */
function gapsAgainstMaterial(gaps: Float32Array, top: number, bottom: number, otherGaps: Float32Array, out: number[]): void {
  for (let k = 0; k < gaps.length; k += 2) {
    let lo = Math.max(gaps[k], bottom)
    const hi = Math.min(gaps[k + 1], top)
    if (!(hi > lo)) continue
    // Material of the other column inside [lo, hi]: [lo, hi] minus its gaps (sorted).
    for (let m = 0; m < otherGaps.length && lo < hi; m += 2) {
      const gl = otherGaps[m]
      const gh = otherGaps[m + 1]
      if (gh <= lo) continue
      if (gl >= hi) break
      if (gl > lo) out.push(lo, gl)
      lo = Math.max(lo, gh)
    }
    if (lo < hi) out.push(lo, hi)
  }
}

export class UndercutMesh {
  private readonly group = new THREE.Group()
  private readonly meshes = new Map<number, THREE.Mesh>()
  readonly material = new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true, side: THREE.DoubleSide })
  /** Class byte per cell from the comparison (see comparisonView), or null for plain stock. */
  private classes: Uint8Array | null = null
  private readonly palette = {
    stock: new THREE.Color(STOCK_COLOR),
    thread: new THREE.Color(DEVIATION_COLORS.thread),
    gouge: new THREE.Color(DEVIATION_COLORS.gouge),
    leftover: new THREE.Color(DEVIATION_COLORS.leftover),
    within: new THREE.Color(DEVIATION_COLORS.within),
  }
  private readonly tilesX: number
  private readonly tilesY: number

  constructor(
    private readonly parent: THREE.Object3D,
    private readonly grid: GridInfo,
    private readonly gaps: StockGaps,
    private readonly heights: Float32Array,
  ) {
    this.tilesX = Math.ceil(grid.nx / TILE)
    this.tilesY = Math.ceil(grid.ny / TILE)
    parent.add(this.group)
    this.rebuild({ minI: 0, maxI: grid.nx - 1, minJ: 0, maxJ: grid.ny - 1 })
  }

  /** True when the tile of the stock surface covering tile (tx, ty) of cells holds a gap face. */
  tileHasGaps(tx: number, ty: number): boolean {
    return tx < this.tilesX && ty < this.tilesY && this.meshes.has(ty * this.tilesX + tx)
  }

  /** Colours the faces by the comparison's cell classes (null: plain stock) and rebuilds every tile. */
  setClasses(classes: Uint8Array | null): void {
    this.classes = classes
    this.rebuild({ minI: 0, maxI: this.grid.nx - 1, minJ: 0, maxJ: this.grid.ny - 1 })
  }

  private colorOf(c: number): THREE.Color {
    const k = this.classes
    if (!k) return this.palette.stock
    const v = k[c]
    if (v & THREAD_BIT) return this.palette.thread
    if (v & GOUGE_INTERVAL_BIT) return this.palette.gouge
    if (v & LEFTOVER_INTERVAL_BIT) return this.palette.leftover
    return this.palette.within
  }

  /** Rebuilds the tiles that a change of the cells in `rect` touches. */
  rebuild(rect: CellRect): void {
    if (rect.minI > rect.maxI || rect.minJ > rect.maxJ) return
    const tx0 = Math.max(0, Math.floor((rect.minI - 1) / TILE))
    const tx1 = Math.min(this.tilesX - 1, Math.floor((rect.maxI + 1) / TILE))
    const ty0 = Math.max(0, Math.floor((rect.minJ - 1) / TILE))
    const ty1 = Math.min(this.tilesY - 1, Math.floor((rect.maxJ + 1) / TILE))
    const touched = new Set<number>()
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) touched.add(ty * this.tilesX + tx)
    // Group the gap columns by tile once, then build each touched tile.
    const byTile = new Map<number, number[]>()
    const nx = this.grid.nx
    for (const c of this.gaps.columns.keys()) {
      const j = Math.floor(c / nx)
      const i = c - j * nx
      const t = Math.floor(j / TILE) * this.tilesX + Math.floor(i / TILE)
      if (!touched.has(t)) continue
      let list = byTile.get(t)
      if (!list) byTile.set(t, (list = []))
      list.push(c)
    }
    for (const t of touched) {
      const old = this.meshes.get(t)
      if (old) {
        this.group.remove(old)
        old.geometry.dispose()
        this.meshes.delete(t)
      }
      const cols = byTile.get(t)
      if (!cols) continue
      const geometry = this.tileGeometry(cols)
      if (!geometry) continue
      const mesh = new THREE.Mesh(geometry, this.material)
      this.group.add(mesh)
      this.meshes.set(t, mesh)
    }
  }

  private tileGeometry(cols: number[]): THREE.BufferGeometry | null {
    const { nx, ny, cellSize: cs, originX, originY, stock } = this.grid
    const bottom = stock.min.z
    const pos: number[] = []
    const nor: number[] = []
    const col: number[] = []
    let color = this.palette.stock
    const quad = (
      ax: number, ay: number, az: number,
      bx: number, by: number, bz: number,
      cx: number, cy: number, cz: number,
      dx: number, dy: number, dz: number,
      n: [number, number, number],
    ) => {
      // Wind the triangles counter-clockwise seen from the side the normal points to.
      const gx = (by - ay) * (cz - az) - (bz - az) * (cy - ay)
      const gy = (bz - az) * (cx - ax) - (bx - ax) * (cz - az)
      const gz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
      if (gx * n[0] + gy * n[1] + gz * n[2] >= 0) pos.push(ax, ay, az, bx, by, bz, cx, cy, cz, ax, ay, az, cx, cy, cz, dx, dy, dz)
      else pos.push(ax, ay, az, cx, cy, cz, bx, by, bz, ax, ay, az, dx, dy, dz, cx, cy, cz)
      for (let k = 0; k < 6; k++) {
        nor.push(n[0], n[1], n[2])
        col.push(color.r, color.g, color.b)
      }
    }
    const xAt = (i: number) => Math.min(originX + i * cs, stock.max.x)
    const yAt = (j: number) => Math.min(originY + j * cs, stock.max.y)
    const seg: number[] = []
    for (const c of cols) {
      const g = this.gaps.columns.get(c)!
      const j = Math.floor(c / nx)
      const i = c - j * nx
      const top = this.heights[c]
      color = this.colorOf(c)
      const x0 = xAt(i)
      const x1 = xAt(i + 1)
      const y0 = yAt(j)
      const y1 = yAt(j + 1)
      for (let k = 0; k < g.length; k += 2) {
        const lo = g[k]
        const hi = g[k + 1]
        if (!(hi < top)) continue
        quad(x0, y0, hi, x1, y0, hi, x1, y1, hi, x0, y1, hi, [0, 0, -1])
        if (lo > bottom) quad(x0, y0, lo, x1, y0, lo, x1, y1, lo, x0, y1, lo, [0, 0, 1])
      }
      // Sides towards the four neighbours where this column's gaps meet the neighbour's material.
      // The opposite case (the neighbour's gap against this column's material) is drawn when the
      // neighbour is the gap column, so each face is built once.
      const sides: [number, number, number, number, number, number, [number, number, number]][] = [
        [i - 1, j, x0, y0, x0, y1, [1, 0, 0]],
        [i + 1, j, x1, y0, x1, y1, [-1, 0, 0]],
        [i, j - 1, x0, y0, x1, y0, [0, 1, 0]],
        [i, j + 1, x0, y1, x1, y1, [0, -1, 0]],
      ]
      for (const [ni, nj, ax, ay, bx, by, n] of sides) {
        if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue
        const nc = nj * nx + ni
        seg.length = 0
        gapsAgainstMaterial(g, top, bottom, this.gaps.columns.get(nc) ?? EMPTY, seg)
        // Only the parts below the neighbour's top: above it the top surface draws the wall.
        const nTop = this.heights[nc]
        for (let k = 0; k < seg.length; k += 2) {
          const lo = seg[k]
          const hi = Math.min(seg[k + 1], nTop)
          if (hi > lo) quad(ax, ay, lo, bx, by, lo, bx, by, hi, ax, ay, hi, n)
        }
      }
    }
    if (pos.length === 0) return null
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3))
    geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3))
    geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3))
    geometry.computeBoundingSphere()
    return geometry
  }

  dispose(): void {
    this.parent.remove(this.group)
    for (const m of this.meshes.values()) m.geometry.dispose()
    this.material.dispose()
  }
}
