// Placement of a STEP part in the stock, in work coordinates.
//
// Orientation is a proper rotation (never a mirror): first the chosen model axis is turned to point
// up (+Z), then the part is turned about Z in 90 degree steps, counter-clockwise seen from above.
// Then it is moved so the centre of its bounding box in X and Y and its lowest point land on the
// entered values.
import type { Box3D } from './stock'
import { meshBounds, type TriangleMesh } from './stepModel'

export type UpAxis = '+X' | '-X' | '+Y' | '-Y' | '+Z' | '-Z'
export const UP_AXES: UpAxis[] = ['+Z', '-Z', '+Y', '-Y', '+X', '-X']
export type QuarterTurns = 0 | 1 | 2 | 3
export const QUARTER_TURNS: QuarterTurns[] = [0, 1, 2, 3]

export interface PartPlacement {
  upAxis: UpAxis
  /** Rotation about Z in 90 degree steps, counter-clockwise seen from above. */
  quarterTurns: QuarterTurns
  centerX: number
  centerY: number
  bottomZ: number
}

/** Row-major 3x3 rotation that turns `up` to +Z (the rotation about X or Y by 90 or 180 degrees). */
const UP_ROTATION: Record<UpAxis, number[]> = {
  '+Z': [1, 0, 0, 0, 1, 0, 0, 0, 1],
  // 180 degrees about X.
  '-Z': [1, 0, 0, 0, -1, 0, 0, 0, -1],
  // +90 degrees about X: model +Y up, model +Z towards -Y (the front of the stock).
  '+Y': [1, 0, 0, 0, 0, -1, 0, 1, 0],
  // -90 degrees about X.
  '-Y': [1, 0, 0, 0, 0, 1, 0, -1, 0],
  // -90 degrees about Y.
  '+X': [0, 0, -1, 0, 1, 0, 1, 0, 0],
  // +90 degrees about Y.
  '-X': [0, 0, 1, 0, 1, 0, -1, 0, 0],
}

/** Rotation from model to work axes as a row-major 3x3 matrix. */
export function orientationMatrix(upAxis: UpAxis, quarterTurns: QuarterTurns): number[] {
  const u = UP_ROTATION[upAxis]
  // Exact cosines and sines of 0, 90, 180 and 270 degrees.
  const c = [1, 0, -1, 0][quarterTurns]
  const s = [0, 1, 0, -1][quarterTurns]
  const rz = [c, -s, 0, s, c, 0, 0, 0, 1]
  const m: number[] = []
  for (let r = 0; r < 3; r++) {
    for (let k = 0; k < 3; k++) {
      m.push(rz[r * 3] * u[k] + rz[r * 3 + 1] * u[3 + k] + rz[r * 3 + 2] * u[6 + k])
    }
  }
  return m
}

/** Oriented, not yet moved, vertex positions. */
function orient(positions: Float32Array, m: number[]): Float32Array {
  const out = new Float32Array(positions.length)
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]
    const y = positions[i + 1]
    const z = positions[i + 2]
    out[i] = m[0] * x + m[1] * y + m[2] * z
    out[i + 1] = m[3] * x + m[4] * y + m[5] * z
    out[i + 2] = m[6] * x + m[7] * y + m[8] * z
  }
  return out
}

/** Vertex positions of the mesh in work coordinates for this placement. */
export function placePositions(mesh: TriangleMesh, p: PartPlacement): Float32Array {
  const out = orient(mesh.positions, orientationMatrix(p.upAxis, p.quarterTurns))
  const b = meshBounds(out)
  const dx = p.centerX - (b.min.x + b.max.x) / 2
  const dy = p.centerY - (b.min.y + b.max.y) / 2
  const dz = p.bottomZ - b.min.z
  for (let i = 0; i < out.length; i += 3) {
    out[i] += dx
    out[i + 1] += dy
    out[i + 2] += dz
  }
  return out
}

/** Bounding box of the placed part in work coordinates. */
export function placedBounds(mesh: TriangleMesh, p: PartPlacement): Box3D {
  return meshBounds(placePositions(mesh, p))
}

/** A new part: Z up, no rotation, centred on the stock in X and Y, bottom on the stock bottom. */
export function defaultPlacement(stock: Box3D): PartPlacement {
  return {
    upAxis: '+Z',
    quarterTurns: 0,
    centerX: (stock.min.x + stock.max.x) / 2,
    centerY: (stock.min.y + stock.max.y) / 2,
    bottomZ: stock.min.z,
  }
}
