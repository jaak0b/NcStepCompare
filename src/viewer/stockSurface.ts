// Machined stock drawn at the full simulation resolution.
//
// The grid heights live in one R32F texture (4 bytes per cell). The top surface is a small tile of
// (TILE + 1)^2 vertices drawn instanced across the grid; the vertex shader reads each vertex's height
// from the texture, so no per-cell geometry exists on the CPU. Vertices sit at cell centres, plus
// one extra row and column clamped to each stock edge, so the surface reaches the stock edge
// exactly and never beyond it. A wall between two cells is drawn as a slope across one cell width
// (0.05 mm by default). Side walls run down every stock edge to the stock bottom. Faces are
// flat-shaded from screen-space derivatives. Where the material is cut down to the stock bottom or
// below, the surface is discarded, so through-cuts show as openings.
//
// The stock is drawn as a closed solid: the same tile drawn at the stock bottom Z forms the bottom
// face, with the same openings (the discard rule uses the same interpolated heights, so its edge
// meets the top surface exactly). The bottom face shows its downward side only. The top surface stays
// two-sided so the walls of through-cuts show from any angle; seen from below, the bottom face hides
// it by the depth test. Where the cut reaches the stock bottom the two are coplanar, so the bottom
// face carries a polygon offset (depth only, the drawn heights are unchanged) and wins that tie.
//
// Playback uploads only the changed rectangle of cells into the texture.
//
// With STEP parts placed, a second texture holds two heights per cell from the comparison: below the
// first the cell is a gouge, above the second it is leftover. The fragment shader compares the shown
// machined height with them, so the deviation colours follow playback with no extra work. Each
// fragment takes the class of the highest of the cells around it, so a wall is coloured by its
// material side. Cells outside every part outline stay plain stock grey.
import * as THREE from 'three'
import type { CellRect } from '../engine/simulation'
import type { GridInfo } from '../workers/simulationMessages'

const TILE = 128
const STOCK_COLOR = new THREE.Color(0xb8bcc2)
/** Texture stand-ins for values a float texture lookup should not carry. */
const OUTSIDE_PARTS = 1e30
const NO_LIMIT = -1e30

const COMMON = /* glsl */ `
uniform highp sampler2D uHeights;
uniform ivec2 uGridSize;
uniform float uCellSize;
uniform vec2 uOrigin;
uniform vec2 uStockMax;
uniform float uBottom;

// Vertex (k, l) with k in [0, nx + 1]: k = 0 is the stock edge, k = 1..nx the cell centres.
float vertexHeight(ivec2 v) {
  ivec2 c = clamp(v - 1, ivec2(0), uGridSize - 1);
  return texelFetch(uHeights, c, 0).r;
}

vec2 vertexXY(ivec2 v) {
  return clamp(uOrigin + (vec2(v) - 0.5) * uCellSize, uOrigin, uStockMax);
}
`

const SURFACE_VERTEX = /* glsl */ `
${COMMON}
in vec2 aTile;
out vec3 vWorld;
out float vHeight;
out vec2 vXY;

void main() {
  ivec2 v = min(ivec2(position.xy + aTile), uGridSize + 1);
  float h = vertexHeight(v);
  vHeight = h;
#ifdef BOTTOM_FACE
  float z = uBottom;
#else
  float z = h;
#endif
  vXY = vertexXY(v);
  vec4 world = modelMatrix * vec4(vXY, z, 1.0);
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`

const SKIRT_VERTEX = /* glsl */ `
${COMMON}
in vec2 aVertex;
in float aBottom;
out vec3 vWorld;
out float vHeight;
out vec2 vXY;

void main() {
  ivec2 v = ivec2(aVertex);
  float top = max(vertexHeight(v), uBottom);
  float z = aBottom > 0.5 ? uBottom : top;
  vHeight = z;
  vXY = vertexXY(v);
  vec4 world = modelMatrix * vec4(vXY, z, 1.0);
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`

const FRAGMENT = /* glsl */ `
uniform highp sampler2D uHeights;
uniform highp sampler2D uLimits;
uniform bool uCompare;
uniform ivec2 uGridSize;
uniform float uCellSize;
uniform vec2 uOrigin;
uniform float uBottom;
uniform vec3 uColor;
uniform vec3 uGougeColor;
uniform vec3 uLeftoverColor;
uniform vec3 uWithinColor;
in vec3 vWorld;
in float vHeight;
in vec2 vXY;
out vec4 fragColor;

void main() {
#ifndef SKIRT
  if (vHeight <= uBottom) discard;
#endif
  vec3 color = uColor;
#ifndef BOTTOM_FACE
  if (uCompare) {
    // A fragment lies between the centres of up to 2 x 2 cells. It takes the class of the highest of
    // them: a wall is the slope from a high cell down to a low one, so the wall shows the material
    // side's colour over its full height (part walls, hole walls and the side walls alike).
    ivec2 base = ivec2(floor((vXY - uOrigin) / uCellSize - 0.5));
    ivec2 c = clamp(base, ivec2(0), uGridSize - 1);
    float h = texelFetch(uHeights, c, 0).r;
    for (int k = 1; k < 4; k++) {
      ivec2 n = clamp(base + ivec2(k & 1, k >> 1), ivec2(0), uGridSize - 1);
      float hn = texelFetch(uHeights, n, 0).r;
      if (hn > h) {
        h = hn;
        c = n;
      }
    }
    vec2 limit = texelFetch(uLimits, c, 0).rg;
    // Outside every part the texture holds 1e30 (OUTSIDE_PARTS).
    if (limit.g < 1e29) {
      color = h < limit.r ? uGougeColor : (h > limit.g ? uLeftoverColor : uWithinColor);
    }
  }
#endif
  vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
  if (dot(n, cameraPosition - vWorld) < 0.0) n = -n;
  vec3 light = normalize(vec3(0.35, -0.55, 1.0));
  float diffuse = max(dot(n, light), 0.0);
  fragColor = vec4(color * (0.42 + 0.58 * diffuse), 1.0);
}
`

/** Deviation colours, shared with the legend. */
export const DEVIATION_COLORS = { gouge: '#d63c3c', leftover: '#2f66d0', within: '#8fc48a' }

export class StockSurface {
  private readonly texture: THREE.DataTexture
  private limitsTexture: THREE.DataTexture
  private readonly surface: THREE.Mesh
  private readonly skirt: THREE.Mesh
  private readonly bottomFace: THREE.Mesh
  private readonly uniforms: Record<string, THREE.IUniform>

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly parent: THREE.Object3D,
    private readonly grid: GridInfo,
    heights: Float32Array,
  ) {
    const { nx, ny } = grid
    this.texture = new THREE.DataTexture(heights, nx, ny, THREE.RedFormat, THREE.FloatType)
    this.texture.minFilter = THREE.NearestFilter
    this.texture.magFilter = THREE.NearestFilter
    this.texture.generateMipmaps = false
    this.texture.needsUpdate = true

    this.limitsTexture = StockSurface.limitsTextureFrom(new Float32Array([OUTSIDE_PARTS, OUTSIDE_PARTS]), 1, 1)
    this.uniforms = {
      uHeights: { value: this.texture },
      uLimits: { value: this.limitsTexture },
      uCompare: { value: false },
      uGougeColor: { value: new THREE.Color(DEVIATION_COLORS.gouge) },
      uLeftoverColor: { value: new THREE.Color(DEVIATION_COLORS.leftover) },
      uWithinColor: { value: new THREE.Color(DEVIATION_COLORS.within) },
      uGridSize: { value: new THREE.Vector2(nx, ny) },
      uCellSize: { value: grid.cellSize },
      uOrigin: { value: new THREE.Vector2(grid.originX, grid.originY) },
      uStockMax: { value: new THREE.Vector2(grid.stock.max.x, grid.stock.max.y) },
      uBottom: { value: grid.stock.min.z },
      uColor: { value: STOCK_COLOR },
    }

    this.surface = new THREE.Mesh(this.surfaceGeometry(), this.material(SURFACE_VERTEX, {}, THREE.DoubleSide))
    // Tile triangles wind counter-clockwise seen from +Z, so the back side of the bottom face faces down.
    const bottomMaterial = this.material(SURFACE_VERTEX, { BOTTOM_FACE: 1 }, THREE.BackSide)
    bottomMaterial.polygonOffset = true
    bottomMaterial.polygonOffsetFactor = -1
    bottomMaterial.polygonOffsetUnits = -1
    this.bottomFace = new THREE.Mesh(this.surface.geometry, bottomMaterial)
    this.skirt = new THREE.Mesh(this.skirtGeometry(), this.material(SKIRT_VERTEX, { SKIRT: 1 }, THREE.DoubleSide))
    // Positions come from the texture, so the geometry has no meaningful bounds to cull with.
    for (const m of [this.surface, this.bottomFace, this.skirt]) m.frustumCulled = false
    parent.add(this.surface, this.bottomFace, this.skirt)
    renderer.initTexture(this.texture)
  }

  /** Writes the changed cells into the texture, uploading only that rectangle. */
  applyRect(rect: CellRect, data: Float32Array): void {
    const w = rect.maxI - rect.minI + 1
    const h = rect.maxJ - rect.minJ + 1
    if (w <= 0 || h <= 0) return
    // Keep the texture's own copy current too (used if three.js ever re-uploads it in full).
    const full = this.texture.image.data as Float32Array
    for (let j = 0; j < h; j++) {
      full.set(data.subarray(j * w, (j + 1) * w), (rect.minJ + j) * this.grid.nx + rect.minI)
    }
    const patch = new THREE.DataTexture(data, w, h, THREE.RedFormat, THREE.FloatType)
    patch.needsUpdate = true
    this.renderer.copyTextureToTexture(patch, this.texture, null, new THREE.Vector2(rect.minI, rect.minJ))
    patch.dispose()
  }

  /**
   * Shows the comparison: per cell, interleaved, the gouge and leftover limit heights (NaN outside
   * the parts, -Infinity for no gouge limit). Null shows plain stock.
   */
  setLimits(limits: Float32Array | null): void {
    this.limitsTexture.dispose()
    if (!limits) {
      this.limitsTexture = StockSurface.limitsTextureFrom(new Float32Array([OUTSIDE_PARTS, OUTSIDE_PARTS]), 1, 1)
      this.uniforms.uCompare.value = false
    } else {
      const data = new Float32Array(limits.length)
      for (let k = 0; k < limits.length; k++) {
        const v = limits[k]
        data[k] = Number.isNaN(v) ? OUTSIDE_PARTS : v === -Infinity ? NO_LIMIT : v
      }
      this.limitsTexture = StockSurface.limitsTextureFrom(data, this.grid.nx, this.grid.ny)
      this.uniforms.uCompare.value = true
    }
    this.uniforms.uLimits.value = this.limitsTexture
  }

  private static limitsTextureFrom(data: Float32Array, w: number, h: number): THREE.DataTexture {
    const t = new THREE.DataTexture(data, w, h, THREE.RGFormat, THREE.FloatType)
    t.minFilter = THREE.NearestFilter
    t.magFilter = THREE.NearestFilter
    t.generateMipmaps = false
    t.needsUpdate = true
    return t
  }

  dispose(): void {
    this.parent.remove(this.surface, this.bottomFace, this.skirt)
    for (const mesh of [this.surface, this.bottomFace, this.skirt]) {
      mesh.geometry.dispose()
      ;(mesh.material as THREE.Material).dispose()
    }
    this.texture.dispose()
    this.limitsTexture.dispose()
  }

  private material(vertexShader: string, defines: Record<string, number>, side: THREE.Side): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader,
      fragmentShader: FRAGMENT,
      uniforms: this.uniforms,
      defines,
      side,
    })
  }

  private surfaceGeometry(): THREE.InstancedBufferGeometry {
    const n = TILE + 1
    const positions = new Float32Array(n * n * 3)
    for (let l = 0; l < n; l++) {
      for (let k = 0; k < n; k++) {
        const p = (l * n + k) * 3
        positions[p] = k
        positions[p + 1] = l
      }
    }
    const index = new Uint32Array(TILE * TILE * 6)
    let m = 0
    for (let l = 0; l < TILE; l++) {
      for (let k = 0; k < TILE; k++) {
        const a = l * n + k
        index[m++] = a
        index[m++] = a + 1
        index[m++] = a + n + 1
        index[m++] = a
        index[m++] = a + n + 1
        index[m++] = a + n
      }
    }
    // Vertex indices run 0..nx + 1, so nx + 1 quads per row.
    const tilesX = Math.ceil((this.grid.nx + 1) / TILE)
    const tilesY = Math.ceil((this.grid.ny + 1) / TILE)
    const offsets = new Float32Array(tilesX * tilesY * 2)
    for (let ty = 0; ty < tilesY; ty++) {
      for (let tx = 0; tx < tilesX; tx++) {
        offsets[(ty * tilesX + tx) * 2] = tx * TILE
        offsets[(ty * tilesX + tx) * 2 + 1] = ty * TILE
      }
    }
    const geometry = new THREE.InstancedBufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geometry.setIndex(new THREE.BufferAttribute(index, 1))
    geometry.setAttribute('aTile', new THREE.InstancedBufferAttribute(offsets, 2))
    geometry.instanceCount = tilesX * tilesY
    return geometry
  }

  private skirtGeometry(): THREE.BufferGeometry {
    const kMax = this.grid.nx + 1
    const lMax = this.grid.ny + 1
    // Boundary vertices once around the stock outline.
    const ring: [number, number][] = []
    for (let k = 0; k < kMax; k++) ring.push([k, 0])
    for (let l = 0; l < lMax; l++) ring.push([kMax, l])
    for (let k = kMax; k > 0; k--) ring.push([k, lMax])
    for (let l = lMax; l > 0; l--) ring.push([0, l])
    const count = ring.length
    const vertex = new Float32Array(count * 2 * 2)
    const bottom = new Float32Array(count * 2)
    for (let i = 0; i < count; i++) {
      for (let b = 0; b < 2; b++) {
        vertex[(i * 2 + b) * 2] = ring[i][0]
        vertex[(i * 2 + b) * 2 + 1] = ring[i][1]
        bottom[i * 2 + b] = b
      }
    }
    const index = new Uint32Array(count * 6)
    for (let i = 0; i < count; i++) {
      const a = i * 2
      const c = ((i + 1) % count) * 2
      index.set([a, a + 1, c, c, a + 1, c + 1], i * 6)
    }
    const geometry = new THREE.BufferGeometry()
    // three.js needs a position attribute to size the draw; the shader computes the real position.
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 2 * 3), 3))
    geometry.setAttribute('aVertex', new THREE.BufferAttribute(vertex, 2))
    geometry.setAttribute('aBottom', new THREE.BufferAttribute(bottom, 1))
    geometry.setIndex(new THREE.BufferAttribute(index, 1))
    return geometry
  }
}
