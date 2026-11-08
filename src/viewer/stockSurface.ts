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
// Playback uploads only the changed rectangle of cells into the texture.
import * as THREE from 'three'
import type { CellRect } from '../engine/simulation'
import type { GridInfo } from '../workers/simulationMessages'

const TILE = 128
const STOCK_COLOR = new THREE.Color(0xb8bcc2)

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

void main() {
  ivec2 v = min(ivec2(position.xy + aTile), uGridSize + 1);
  float h = vertexHeight(v);
  vHeight = h;
  vec4 world = modelMatrix * vec4(vertexXY(v), h, 1.0);
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

void main() {
  ivec2 v = ivec2(aVertex);
  float top = max(vertexHeight(v), uBottom);
  float z = aBottom > 0.5 ? uBottom : top;
  vHeight = z;
  vec4 world = modelMatrix * vec4(vertexXY(v), z, 1.0);
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`

const FRAGMENT = /* glsl */ `
uniform float uBottom;
uniform vec3 uColor;
in vec3 vWorld;
in float vHeight;
out vec4 fragColor;

void main() {
#ifndef SKIRT
  if (vHeight <= uBottom) discard;
#endif
  vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
  if (dot(n, cameraPosition - vWorld) < 0.0) n = -n;
  vec3 light = normalize(vec3(0.35, -0.55, 1.0));
  float diffuse = max(dot(n, light), 0.0);
  fragColor = vec4(uColor * (0.42 + 0.58 * diffuse), 1.0);
}
`

export class StockSurface {
  private readonly texture: THREE.DataTexture
  private readonly surface: THREE.Mesh
  private readonly skirt: THREE.Mesh
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

    this.uniforms = {
      uHeights: { value: this.texture },
      uGridSize: { value: new THREE.Vector2(nx, ny) },
      uCellSize: { value: grid.cellSize },
      uOrigin: { value: new THREE.Vector2(grid.originX, grid.originY) },
      uStockMax: { value: new THREE.Vector2(grid.stock.max.x, grid.stock.max.y) },
      uBottom: { value: grid.stock.min.z },
      uColor: { value: STOCK_COLOR },
    }

    this.surface = new THREE.Mesh(this.surfaceGeometry(), this.material(SURFACE_VERTEX, false))
    this.skirt = new THREE.Mesh(this.skirtGeometry(), this.material(SKIRT_VERTEX, true))
    // Positions come from the texture, so the geometry has no meaningful bounds to cull with.
    this.surface.frustumCulled = false
    this.skirt.frustumCulled = false
    parent.add(this.surface, this.skirt)
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

  dispose(): void {
    this.parent.remove(this.surface, this.skirt)
    for (const mesh of [this.surface, this.skirt]) {
      mesh.geometry.dispose()
      ;(mesh.material as THREE.Material).dispose()
    }
    this.texture.dispose()
  }

  private material(vertexShader: string, skirt: boolean): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader,
      fragmentShader: FRAGMENT,
      uniforms: this.uniforms,
      defines: skirt ? { SKIRT: 1 } : {},
      side: THREE.DoubleSide,
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
