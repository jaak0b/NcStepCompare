// Connected-component labelling of flagged grid cells, and the hole test for one component.
//
// Components are 8-connected (cells touching at an edge or a corner belong together). Labelling is a
// flood fill with an explicit stack from every unlabelled flagged cell: each cell is pushed once.
// The background is then 4-connected, the dual connectivity, so a closed 8-connected ring always
// separates its inside from its outside (digital topology, Rosenfeld).

export interface Components {
  /** Per cell: component number from 0, or -1 for cells not flagged. */
  labels: Int32Array
  count: number
}

export function labelComponents(flags: Uint8Array, nx: number, ny: number): Components {
  const labels = new Int32Array(nx * ny).fill(-1)
  const stack: number[] = []
  let count = 0
  for (let start = 0; start < flags.length; start++) {
    if (!flags[start] || labels[start] >= 0) continue
    const label = count++
    labels[start] = label
    stack.push(start)
    while (stack.length > 0) {
      const c = stack.pop()!
      const i = c % nx
      const j = (c - i) / nx
      for (let dj = -1; dj <= 1; dj++) {
        const qj = j + dj
        if (qj < 0 || qj >= ny) continue
        for (let di = -1; di <= 1; di++) {
          const qi = i + di
          if (qi < 0 || qi >= nx) continue
          const q = qj * nx + qi
          if (flags[q] && labels[q] < 0) {
            labels[q] = label
            stack.push(q)
          }
        }
      }
    }
  }
  return { labels, count }
}

/** Inclusive cell rectangle. */
export interface CellBounds {
  i0: number
  i1: number
  j0: number
  j1: number
}

/**
 * Cells (grid indices) that component `label` encloses: the other cells inside its rectangle that a
 * 4-connected flood fill from a border one cell outside the rectangle does not reach. Empty when the
 * component encloses nothing.
 */
export function enclosedCells(labels: Int32Array, nx: number, label: number, b: CellBounds): number[] {
  // Local rectangle with a one-cell margin, so the border is all outside cells.
  const w = b.i1 - b.i0 + 3
  const h = b.j1 - b.j0 + 3
  const inComponent = (li: number, lj: number) => {
    const i = b.i0 + li - 1
    const j = b.j0 + lj - 1
    if (li === 0 || lj === 0 || li === w - 1 || lj === h - 1) return false
    return labels[j * nx + i] === label
  }
  const reached = new Uint8Array(w * h)
  const stack = [0]
  reached[0] = 1
  while (stack.length > 0) {
    const c = stack.pop()!
    const li = c % w
    const lj = (c - li) / w
    const next = [
      [li - 1, lj],
      [li + 1, lj],
      [li, lj - 1],
      [li, lj + 1],
    ]
    for (const [qi, qj] of next) {
      if (qi < 0 || qj < 0 || qi >= w || qj >= h) continue
      const q = qj * w + qi
      if (reached[q] || inComponent(qi, qj)) continue
      reached[q] = 1
      stack.push(q)
    }
  }
  const out: number[] = []
  for (let lj = 1; lj < h - 1; lj++) {
    for (let li = 1; li < w - 1; li++) {
      if (!reached[lj * w + li] && !inComponent(li, lj)) out.push((b.j0 + lj - 1) * nx + b.i0 + li - 1)
    }
  }
  return out
}
