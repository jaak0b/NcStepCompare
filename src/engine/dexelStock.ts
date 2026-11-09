// Dexel stock: per grid cell a column of material along Z (van Hook, "Real-time shaded NC milling
// display", SIGGRAPH 1986, single-direction Z dexels). A 3-axis tool axis is always vertical, so every
// undercut is a gap along Z and a Z dexel stores it exactly.
//
// The stock extends the height grid: `heights` stays the topmost material Z of each column, so every
// consumer of the height grid keeps working. Material of a column is [bottom, heights] minus its air
// gaps. Gaps are stored only for columns that have them: per 128 x 128 cell tile, allocated on the
// first gap, an offset and a count per column into a shared Float32 pool of (lo, hi) pairs. Pool
// blocks come in power-of-two size classes, grow by doubling and are reused through a free list per
// size class. Gaps of a column are sorted, disjoint and do not touch: intervals merge only when they
// touch or overlap exactly, in the stock's float32 precision, with no snapping constant.
import { createHeightGrid, type HeightGrid } from './heightGrid'
import type { Box3D } from './stock'

export const DEXEL_TILE = 128
const TILE_SHIFT = 7
const TILE_MASK = DEXEL_TILE - 1
const TILE_CELLS = DEXEL_TILE * DEXEL_TILE

interface GapTile {
  /** Per column: start of its block in the pool, in floats; -1 without a block. */
  offset: Int32Array
  /** Per column: number of gaps. */
  count: Uint16Array
  /** Per column: log2 of the block capacity in gaps. */
  capLog: Uint8Array
  /** Columns of this tile that hold at least one gap. */
  used: number
}

/** Gaps of a set of columns, for checkpoints: column indices, gap counts and (lo, hi) pairs. */
export interface GapRecord {
  columns: Int32Array
  counts: Uint16Array
  pairs: Float32Array
}

export interface DexelStock extends HeightGrid {
  dexels: DexelGaps
}

export function createDexelStock(stock: Box3D, cellSize: number): DexelStock {
  const grid = createHeightGrid(stock, cellSize) as DexelStock
  grid.dexels = new DexelGaps(grid)
  return grid
}

export class DexelGaps {
  readonly tilesX: number
  readonly tilesY: number
  private readonly tiles: (GapTile | null)[]
  private pool = new Float32Array(1024)
  private poolUsed = 0
  private readonly free: number[][] = []
  private scratch = new Float32Array(64)
  /** Number of columns holding gaps, over the whole stock. */
  gapColumnCount = 0
  /** Highest material Z removed by the last `subtract`, NaN when it removed none. */
  lastHighestRemoved = NaN

  constructor(private readonly grid: HeightGrid) {
    this.tilesX = Math.ceil(grid.nx / DEXEL_TILE)
    this.tilesY = Math.ceil(grid.ny / DEXEL_TILE)
    this.tiles = new Array(this.tilesX * this.tilesY).fill(null)
  }

  /** True when the tile holding cell (i, j) has any gap. */
  tileHasGaps(tileIndex: number): boolean {
    const t = this.tiles[tileIndex]
    return t !== null && t.used > 0
  }

  /** Number of gaps of column c (= j * nx + i). */
  gapCount(c: number): number {
    const t = this.tileOf(c)
    return t === null ? 0 : t.count[this.local(c)]
  }

  /** Gap pairs of column c as a view into the pool; valid until the next change. */
  gapView(c: number): Float32Array {
    const t = this.tileOf(c)
    if (t === null) return this.pool.subarray(0, 0)
    const l = this.local(c)
    return this.pool.subarray(t.offset[l], t.offset[l] + t.count[l] * 2)
  }

  /** True when [s, e] lies inside one gap of column c (in float32), so cutting it removes nothing. */
  insideGap(c: number, s: number, e: number): boolean {
    if (this.gapColumnCount === 0) return false
    const t = this.tileOf(c)
    if (t === null) return false
    const l = this.local(c)
    const n = t.count[l]
    const off = t.offset[l]
    s = Math.fround(s)
    e = Math.fround(e)
    for (let k = 0; k < n; k++) {
      if (this.pool[off + 2 * k] <= s && this.pool[off + 2 * k + 1] >= e) return true
    }
    return false
  }

  /**
   * Removes the tool interval [s, e] (e may be Infinity) from column c. Values are taken in the
   * stock's float32 precision. Returns the thickness of material removed; the top lowers to s when
   * e reaches it, even below the stock bottom (a cut into the spoilboard keeps its real depth).
   * Returns -1 when the column did not change.
   */
  subtract(c: number, s: number, e: number): number {
    const h = this.grid.heights
    const bottom = this.grid.bottom
    s = Math.fround(s)
    if (e !== Infinity) e = Math.fround(e)
    const top = h[c]
    this.lastHighestRemoved = NaN
    if (!(s < top) || !(s < e)) return -1
    const t = this.tileOf(c)
    const l = t === null ? 0 : this.local(c)
    const n = t === null ? 0 : t.count[l]
    const off = t === null ? 0 : t.offset[l]
    const pool = this.pool
    // Material inside [s, e]: [max(s, bottom), min(e, top)] minus the gaps.
    const lo = s > bottom ? s : bottom
    const hi = e < top ? e : top
    let removed = hi > lo ? hi - lo : 0
    let highest = hi
    for (let k = n - 1; k >= 0 && removed > 0; k--) {
      const gl = pool[off + 2 * k]
      const gh = pool[off + 2 * k + 1]
      const ov = (gh < hi ? gh : hi) - (gl > lo ? gl : lo)
      if (ov > 0) removed -= ov
      // Gaps run downwards here: one covering the highest point so far moves it to the gap's floor.
      if (gl < highest && gh >= highest) highest = gl
    }
    if (!(removed > 0)) {
      removed = 0
      highest = NaN
    }
    if (e >= top) {
      // The top lowers to s, and every gap reaching s joins the air above.
      let newTop = s
      let m = n
      while (m > 0 && pool[off + 2 * m - 1] >= newTop) {
        const gl = pool[off + 2 * m - 2]
        if (gl < newTop) newTop = gl
        m--
      }
      h[c] = newTop
      if (m !== n) this.setCount(t!, l, m)
      this.lastHighestRemoved = highest
      return removed
    }
    if (removed === 0) return -1
    // A new gap inside the column: merge with every gap it overlaps or touches.
    let first = 0
    while (first < n && pool[off + 2 * first + 1] < s) first++
    let last = first
    let ms = s
    let me = e
    while (last < n && pool[off + 2 * last] <= e) {
      const gl = pool[off + 2 * last]
      const gh = pool[off + 2 * last + 1]
      if (gl < ms) ms = gl
      if (gh > me) me = gh
      last++
    }
    const newCount = n - (last - first) + 1
    if (this.scratch.length < newCount * 2) this.scratch = new Float32Array(newCount * 4)
    const tmp = this.scratch
    let w = 0
    for (let k = 0; k < first; k++) {
      tmp[w++] = pool[off + 2 * k]
      tmp[w++] = pool[off + 2 * k + 1]
    }
    tmp[w++] = ms
    tmp[w++] = me
    for (let k = last; k < n; k++) {
      tmp[w++] = pool[off + 2 * k]
      tmp[w++] = pool[off + 2 * k + 1]
    }
    this.writeGaps(c, tmp, newCount)
    this.lastHighestRemoved = highest
    return removed
  }

  /** Replaces the gaps of column c with `count` pairs from `pairs` (starting at `from`). */
  writeGaps(c: number, pairs: Float32Array, count: number, from = 0): void {
    let t = this.tileOf(c)
    if (t === null) {
      if (count === 0) return
      t = this.newTile(c)
    }
    const l = this.local(c)
    if (count > 0xffff) throw new RangeError('A dexel column holds more than 65535 gaps.')
    let off = t.offset[l]
    if (off < 0 || count > 1 << t.capLog[l]) {
      if (off >= 0) this.release(off, t.capLog[l])
      let capLog = 1
      while (1 << capLog < count) capLog++
      off = this.allocate(capLog)
      t.offset[l] = off
      t.capLog[l] = capLog
    }
    this.pool.set(pairs.subarray(from, from + count * 2), off)
    this.setCount(t, l, count)
  }

  /** Removes every gap. */
  clear(): void {
    this.tiles.fill(null)
    this.free.length = 0
    this.poolUsed = 0
    this.gapColumnCount = 0
  }

  /** Removes the gaps of every column in the inclusive cell rectangle. */
  clearRect(minI: number, maxI: number, minJ: number, maxJ: number): void {
    if (this.gapColumnCount === 0) return
    for (let j = minJ; j <= maxJ; j++) {
      for (let i = minI; i <= maxI; i++) {
        const c = j * this.grid.nx + i
        const t = this.tileOf(c)
        if (t === null || t.used === 0) {
          // Skip to the end of this tile's row.
          i = ((i >> TILE_SHIFT) << TILE_SHIFT) + TILE_MASK
          continue
        }
        if (t.count[this.local(c)] > 0) this.setCount(t, this.local(c), 0)
      }
    }
  }

  /** Gaps of every column in the inclusive cell rectangle that has any. */
  record(minI: number, maxI: number, minJ: number, maxJ: number): GapRecord {
    const columns: number[] = []
    const counts: number[] = []
    let total = 0
    if (this.gapColumnCount > 0) {
      for (let j = minJ; j <= maxJ; j++) {
        for (let i = minI; i <= maxI; i++) {
          const c = j * this.grid.nx + i
          const t = this.tileOf(c)
          if (t === null || t.used === 0) {
            i = ((i >> TILE_SHIFT) << TILE_SHIFT) + TILE_MASK
            continue
          }
          const n = t.count[this.local(c)]
          if (n > 0) {
            columns.push(c)
            counts.push(n)
            total += n
          }
        }
      }
    }
    const pairs = new Float32Array(total * 2)
    let w = 0
    for (const c of columns) {
      const v = this.gapView(c)
      pairs.set(v, w)
      w += v.length
    }
    return { columns: Int32Array.from(columns), counts: Uint16Array.from(counts), pairs }
  }

  /** Writes a record back (after `clearRect` over the same rectangle). */
  apply(rec: GapRecord): void {
    let r = 0
    for (let k = 0; k < rec.columns.length; k++) {
      this.writeGaps(rec.columns[k], rec.pairs, rec.counts[k], r)
      r += rec.counts[k] * 2
    }
  }

  /** Bytes held by the gap index and pool. */
  bytes(): number {
    let n = this.pool.byteLength
    for (const t of this.tiles) if (t) n += TILE_CELLS * (4 + 2 + 1)
    return n
  }

  private tileOf(c: number): GapTile | null {
    const nx = this.grid.nx
    const j = (c / nx) | 0
    const i = c - j * nx
    return this.tiles[(j >> TILE_SHIFT) * this.tilesX + (i >> TILE_SHIFT)]
  }

  private local(c: number): number {
    const nx = this.grid.nx
    const j = (c / nx) | 0
    const i = c - j * nx
    return ((j & TILE_MASK) << TILE_SHIFT) | (i & TILE_MASK)
  }

  private newTile(c: number): GapTile {
    const nx = this.grid.nx
    const j = (c / nx) | 0
    const i = c - j * nx
    const t: GapTile = {
      offset: new Int32Array(TILE_CELLS).fill(-1),
      count: new Uint16Array(TILE_CELLS),
      capLog: new Uint8Array(TILE_CELLS),
      used: 0,
    }
    this.tiles[(j >> TILE_SHIFT) * this.tilesX + (i >> TILE_SHIFT)] = t
    return t
  }

  private setCount(t: GapTile, l: number, count: number): void {
    const before = t.count[l]
    if (before === 0 && count > 0) {
      t.used++
      this.gapColumnCount++
    } else if (before > 0 && count === 0) {
      t.used--
      this.gapColumnCount--
    }
    t.count[l] = count
  }

  private allocate(capLog: number): number {
    const list = this.free[capLog]
    if (list && list.length > 0) return list.pop()!
    const size = 2 << capLog
    if (this.poolUsed + size > this.pool.length) {
      let cap = this.pool.length * 2
      while (cap < this.poolUsed + size) cap *= 2
      const next = new Float32Array(cap)
      next.set(this.pool.subarray(0, this.poolUsed))
      this.pool = next
    }
    const off = this.poolUsed
    this.poolUsed += size
    return off
  }

  private release(off: number, capLog: number): void {
    ;(this.free[capLog] ??= []).push(off)
  }
}
