// STEP model as a triangle mesh, read with occt-import-js (OpenCascade's STEP reader and BRepMesh
// tessellation). The caller passes the initialised occt module, so the browser worker and the tests
// share this code. All bodies in one file are merged into one mesh: one STEP file is one part.
import type { Box3D } from './stock'

/**
 * Tessellation chord deviation in mm (OpenCascade "linear deflection", absolute). Each triangle
 * lies within this distance of the true surface. Assumed default, set well below the smallest
 * default tolerance (gouge 0.05 mm) so the mesh itself never reads as a gouge or leftover.
 */
export const TESSELLATION_DEFLECTION_MM = 0.005
/** Tessellation angular deflection in radians (OpenCascade default range), assumed. */
export const TESSELLATION_ANGLE_RAD = 0.5

export interface TriangleMesh {
  /** xyz per vertex, in mm, model coordinates. */
  positions: Float32Array
  /** Three vertex indices per triangle. */
  indices: Uint32Array
}

export interface StepPart {
  fileName: string
  /** Name from the STEP file (product or body name), or the file name when it has none. */
  label: string
  mesh: TriangleMesh
  triangleCount: number
  /** Model bounding box, model coordinates, mm. */
  bounds: Box3D
  /** Length unit the file declares, or null when it declares none we can read. */
  fileUnit: string | null
  readMs: number
}

/** The part of the occt-import-js API this module uses. */
export interface OcctModule {
  ReadStepFile(
    content: Uint8Array,
    params: {
      linearUnit: 'millimeter'
      linearDeflectionType: 'absolute_value'
      linearDeflection: number
      angularDeflection: number
    } | null,
  ): OcctResult
}

export interface OcctResult {
  success: boolean
  root?: { name?: string }
  meshes: {
    name?: string
    attributes: { position: { array: ArrayLike<number> } }
    index: { array: ArrayLike<number> }
  }[]
}

/**
 * Length unit declared by the STEP file: the LENGTH_UNIT among the entities listed in
 * GLOBAL_UNIT_ASSIGNED_CONTEXT. Returns e.g. "millimetre", "metre", "inch", or null.
 */
export function stepLengthUnit(text: string): string | null {
  const ctx = /GLOBAL_UNIT_ASSIGNED_CONTEXT\s*\(\s*\(([^)]*)\)/.exec(text)
  if (!ctx) return null
  for (const ref of ctx[1].split(',')) {
    const id = ref.trim().replace('#', '')
    if (!/^\d+$/.test(id)) continue
    const entity = new RegExp(`#${id}\\s*=([^;]*);`).exec(text)
    if (!entity || !entity[1].includes('LENGTH_UNIT')) continue
    const si = /SI_UNIT\s*\(\s*(\.[A-Z]+\.|\$)\s*,\s*\.METRE\.\s*\)/.exec(entity[1])
    if (si) {
      const prefix = si[1] === '$' ? '' : si[1].replace(/\./g, '').toLowerCase()
      return `${prefix}metre`
    }
    const conv = /CONVERSION_BASED_UNIT\s*\(\s*'([^']*)'/.exec(entity[1])
    if (conv) return conv[1].toLowerCase()
    return null
  }
  return null
}

/** Reads a STEP file into one merged mesh in mm. Throws with a readable message on failure. */
export function readStepPart(occt: OcctModule, bytes: Uint8Array, fileName: string): StepPart {
  const t0 = performance.now()
  // Only the header and unit entities are needed as text; the reader parses the bytes itself.
  const text = new TextDecoder('latin1').decode(bytes)
  const result = occt.ReadStepFile(bytes, {
    linearUnit: 'millimeter',
    linearDeflectionType: 'absolute_value',
    linearDeflection: TESSELLATION_DEFLECTION_MM,
    angularDeflection: TESSELLATION_ANGLE_RAD,
  })
  if (!result.success) throw new Error('OpenCascade could not read this file as STEP.')
  let vertexCount = 0
  let indexCount = 0
  for (const m of result.meshes) {
    vertexCount += m.attributes.position.array.length / 3
    indexCount += m.index.array.length
  }
  if (indexCount === 0) throw new Error('The file contains no solid or surface geometry.')
  const positions = new Float32Array(vertexCount * 3)
  const indices = new Uint32Array(indexCount)
  let vo = 0
  let io = 0
  for (const m of result.meshes) {
    const p = m.attributes.position.array
    const idx = m.index.array
    positions.set(p, vo * 3)
    for (let k = 0; k < idx.length; k++) indices[io + k] = idx[k] + vo
    vo += p.length / 3
    io += idx.length
  }
  const fileNameInStep = /FILE_NAME\s*\(\s*(?:\/\*[^*]*\*\/\s*)?'([^']*)'/.exec(text)?.[1]
  const label =
    [result.root?.name, ...result.meshes.map((m) => m.name), fileNameInStep]
      .map((n) => n?.trim())
      .find((n) => n) ?? fileName
  return {
    fileName,
    label,
    mesh: { positions, indices },
    triangleCount: indexCount / 3,
    bounds: meshBounds(positions),
    fileUnit: stepLengthUnit(text),
    readMs: performance.now() - t0,
  }
}

export function meshBounds(positions: ArrayLike<number>): Box3D {
  const min = { x: Infinity, y: Infinity, z: Infinity }
  const max = { x: -Infinity, y: -Infinity, z: -Infinity }
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]
    const y = positions[i + 1]
    const z = positions[i + 2]
    if (x < min.x) min.x = x
    if (y < min.y) min.y = y
    if (z < min.z) min.z = z
    if (x > max.x) max.x = x
    if (y > max.y) max.y = y
    if (z > max.z) max.z = z
  }
  return { min, max }
}
