// Machined stock drawn at the full simulation resolution.
//
// The grid heights live in one R32F texture (4 bytes per cell). The top surface is a small tile of
// (TILE + 1)^2 vertices drawn instanced across the grid; the vertex shader reads each vertex's height
// from the texture, so no per-cell geometry exists on the CPU. Vertices sit at cell centres, plus
// one extra row and column clamped to each stock edge, so the surface reaches the stock edge
// exactly and never beyond it. A wall between two cells is drawn as a slope across one cell width
// (0.05 mm by default). Side walls run down every stock edge to the stock bottom. Each fragment of the
// top surface is shaded from the four cells around it at full grid resolution, whatever the vertex
// step of its tile: the normal is the analytic normal of the bilinear patch through their centres.
// Where the material is cut down to the stock bottom or below, the surface is discarded, so
// through-cuts show as openings.
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
// With STEP parts placed, the comparison gives two heights per cell: below the first the cell is a
// gouge, above the second it is leftover. They stay on the CPU; a texture of one byte per cell holds
// the class of each cell (gouge, leftover, within tolerance), recomputed for the changed rectangle
// with every playback upload. One byte instead of two floats per cell keeps the fragment's read small,
// which matters most when the stock is seen from afar and neighbouring fragments read cells far
// apart. Each fragment takes the class of the highest of the cells around it, so a wall is coloured
// by its material side. Cells outside the part outlines are compared with the stock bottom, so
// material left there shows as leftover.
//
// Drawing cost is bounded per frame with chunked level of detail (Ulrich, "Rendering massive
// terrains using chunked level of detail control", 2002), driven by a screen-space error bound:
// - Per-tile frustum culling: each tile gets a bounding box from the min and max height of its
//   cells, so tiles outside the view are not drawn.
// - Per tile, the vertex step is the largest power of two cells whose projected size at the tile's
//   nearest point stays within MAX_QUAD_PX device pixels. Shading and colour come from every cell
//   (above), so a coarser step moves only the drawn outline of a wall, by at most that many pixels;
//   triangles of about one pixel would instead make the GPU shade most pixels several times. Up close,
//   where one cell covers MAX_QUAD_PX pixels or more, every tile is drawn at full resolution.
// - Cracks between tiles of different steps are closed by edge stitching: a vertex on the edge
//   shared with a coarser neighbour takes the height of the coarser edge at that point. The side
//   walls do the same with the step of the tile they border.
// - The bottom face faces down only, so it is skipped while the camera is above the stock bottom.
// - Tiles without a cell at or below the stock bottom use a shader without the discard, so the GPU
//   keeps its early depth test there; tiles are drawn nearest first to make the most of it.
import * as THREE from 'three'
import type { CellRect } from '../engine/simulation'
import type { GridInfo } from '../workers/simulationMessages'

const TILE = 128
/** Largest projected size of one drawn quad, in device pixels. */
const MAX_QUAD_PX = 4
const LEVELS = Math.log2(TILE) + 1
const STOCK_COLOR = new THREE.Color(0xb8bcc2)
/** Values of the per-cell class texture. */
const WITHIN = 0
const GOUGE = 1
const LEFTOVER = 2

const COMMON = /* glsl */ `
uniform highp sampler2D uHeights;
uniform ivec2 uGridSize;
uniform float uCellSize;
uniform vec2 uOrigin;
uniform vec2 uStockMax;
uniform float uBottom;
uniform highp sampler2D uTileStep;
uniform ivec2 uTiles;

// Vertex (k, l) with k in [0, nx + 1]: k = 0 is the stock edge, k = 1..nx the cell centres.
float vertexHeight(ivec2 v) {
  ivec2 c = clamp(v - 1, ivec2(0), uGridSize - 1);
  return texelFetch(uHeights, c, 0).r;
}

vec2 vertexXY(ivec2 v) {
  return clamp(uOrigin + (vec2(v) - 0.5) * uCellSize, uOrigin, uStockMax);
}

int tileStep(ivec2 t) {
  return int(texelFetch(uTileStep, t, 0).r);
}

// Height at vertex v on a tile edge drawn with vertex step s: linear between the two vertices of
// that step around v along the edge (along X when alongX, else along Y), as the coarser tile draws it.
float edgeHeight(ivec2 v, bool alongX, int s) {
  int i = alongX ? v.x : v.y;
  int i0 = (i / s) * s;
  if (i0 == i) return vertexHeight(v);
  int i1 = min(i0 + s, (alongX ? uGridSize.x : uGridSize.y) + 1);
  ivec2 a = alongX ? ivec2(i0, v.y) : ivec2(v.x, i0);
  ivec2 b = alongX ? ivec2(i1, v.y) : ivec2(v.x, i1);
  vec2 p = vertexXY(v), pa = vertexXY(a), pb = vertexXY(b);
  float t = alongX ? (p.x - pa.x) / (pb.x - pa.x) : (p.y - pa.y) / (pb.y - pa.y);
  return mix(vertexHeight(a), vertexHeight(b), t);
}
`

const SURFACE_VERTEX = /* glsl */ `
${COMMON}
in vec2 aTile;
out vec3 vWorld;
out float vHeight;
out vec2 vXY;
flat out int vStep;

void main() {
  ivec2 local = ivec2(position.xy);
  ivec2 tile = ivec2(aTile) / TILE;
  ivec2 v = min(ivec2(aTile) + local, uGridSize + 1);
  int own = tileStep(tile);
  vStep = own;
  float h;
  if (local.x == 0 || local.x == TILE) {
    ivec2 n = tile + ivec2(local.x == 0 ? -1 : 1, 0);
    h = edgeHeight(v, false, n.x >= 0 && n.x < uTiles.x ? max(own, tileStep(n)) : own);
  } else if (local.y == 0 || local.y == TILE) {
    ivec2 n = tile + ivec2(0, local.y == 0 ? -1 : 1);
    h = edgeHeight(v, true, n.y >= 0 && n.y < uTiles.y ? max(own, tileStep(n)) : own);
  } else {
    h = vertexHeight(v);
  }
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
flat out int vStep;

void main() {
  ivec2 v = ivec2(aVertex);
  // Follow the edge of the tile this side wall borders, at that tile's vertex step.
  ivec2 last = uGridSize + 1;
  bool alongX = v.y == 0 || v.y == last.y;
  ivec2 tile = alongX
    ? ivec2(min(v.x / TILE, uTiles.x - 1), v.y == 0 ? 0 : uTiles.y - 1)
    : ivec2(v.x == 0 ? 0 : uTiles.x - 1, min(v.y / TILE, uTiles.y - 1));
  float top = max(edgeHeight(v, alongX, tileStep(tile)), uBottom);
  float z = aBottom > 0.5 ? uBottom : top;
  vStep = 1;
  vHeight = z;
  vXY = vertexXY(v);
  vec4 world = modelMatrix * vec4(vXY, z, 1.0);
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`

const FRAGMENT = /* glsl */ `
uniform highp sampler2D uHeights;
uniform sampler2D uClass;
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
flat in int vStep;
out vec4 fragColor;

void main() {
  // The fragment lies between the centres of 2 x 2 cells; their heights h00, h10, h01, h11 (x then y)
  // span a bilinear patch, read at full grid resolution whatever the vertex step of the tile.
  vec2 p = (vXY - uOrigin) / uCellSize - 0.5;
  ivec2 base = ivec2(floor(p));
  vec2 f = p - vec2(base);
  ivec2 c00 = clamp(base, ivec2(0), uGridSize - 1);
  ivec2 c11 = clamp(base + 1, ivec2(0), uGridSize - 1);
  ivec2 c10 = ivec2(c11.x, c00.y);
  ivec2 c01 = ivec2(c00.x, c11.y);
  float h00 = texelFetch(uHeights, c00, 0).r;
  float h10 = texelFetch(uHeights, c10, 0).r;
  float h01 = texelFetch(uHeights, c01, 0).r;
  float h11 = texelFetch(uHeights, c11, 0).r;
#ifdef THROUGH_CUTS
  // At the full vertex step the drawn surface is the grid itself; a coarser tile takes the opening
  // from the grid so it keeps every cell of it.
  float hCut = vStep == 1 ? vHeight : mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
  if (hCut <= uBottom) discard;
#endif
  vec3 color = uColor;
#ifndef BOTTOM_FACE
  if (uCompare) {
    // The fragment takes the class of the highest of its 2 x 2 cells: a wall is the slope from a
    // high cell down to a low one, so the wall shows the material side's colour over its full height
    // (part walls, hole walls and the side walls alike).
    ivec2 c = c00;
    float h = h00;
    if (h10 > h) { h = h10; c = c10; }
    if (h01 > h) { h = h01; c = c01; }
    if (h11 > h) { h = h11; c = c11; }
    int cls = int(texelFetch(uClass, c, 0).r * 255.0 + 0.5);
    color = cls == GOUGE ? uGougeColor : (cls == LEFTOVER ? uLeftoverColor : uWithinColor);
  }
#endif
#if defined(SKIRT)
  vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
#elif defined(BOTTOM_FACE)
  vec3 n = vec3(0.0, 0.0, -1.0);
#else
  // Analytic normal of the bilinear patch: the grid's own slope, also on tiles drawn coarser.
  float dx = mix(h10 - h00, h11 - h01, f.y);
  float dy = mix(h01 - h00, h11 - h10, f.x);
  vec3 n = normalize(vec3(-dx, -dy, uCellSize));
#endif
  if (dot(n, cameraPosition - vWorld) < 0.0) n = -n;
  vec3 light = normalize(vec3(0.35, -0.55, 1.0));
  float diffuse = max(dot(n, light), 0.0);
  fragColor = vec4(color * (0.42 + 0.58 * diffuse), 1.0);
}
`

/** Deviation colours, shared with the legend. */
export const DEVIATION_COLORS = { gouge: '#d63c3c', leftover: '#2f66d0', within: '#8fc48a' }

/** Tiles of one vertex step and shader variant, drawn as one instanced mesh each for top and bottom. */
interface TileBatch {
  geometry: THREE.InstancedBufferGeometry
  offsets: THREE.InstancedBufferAttribute
  top: THREE.Mesh
  bottom: THREE.Mesh
}

export class StockSurface {
  private readonly texture: THREE.DataTexture
  /** Comparison limits per cell, interleaved gouge and leftover height; null for plain stock. */
  private limits: Float32Array | null = null
  private classTexture: THREE.DataTexture
  private readonly group = new THREE.Group()
  private readonly skirt: THREE.Mesh
  private readonly uniforms: Record<string, THREE.IUniform>
  private readonly materials: THREE.ShaderMaterial[] = []
  private readonly tilesX: number
  private readonly tilesY: number
  /** Lowest and highest cell height under each tile, row by row. */
  private readonly tileMin: Float32Array
  private readonly tileMax: Float32Array
  /** Vertex step of each tile (1, 2, 4, ... TILE cells), read by the vertex shaders. */
  private readonly stepTexture: THREE.DataTexture
  /** Batches indexed by [shader variant (0 without, 1 with the through-cut discard)][level]. */
  private readonly batches: TileBatch[][]
  private readonly frustum = new THREE.Frustum()
  private readonly box = new THREE.Box3()
  private readonly matrix = new THREE.Matrix4()
  private readonly bufferSize = new THREE.Vector2()

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

    // Vertex indices run 0..nx + 1, so nx + 1 quads per row.
    this.tilesX = Math.ceil((nx + 1) / TILE)
    this.tilesY = Math.ceil((ny + 1) / TILE)
    const tileCount = this.tilesX * this.tilesY
    this.tileMin = new Float32Array(tileCount)
    this.tileMax = new Float32Array(tileCount)
    this.updateTileHeights(0, this.tilesX - 1, 0, this.tilesY - 1)
    this.stepTexture = new THREE.DataTexture(
      new Float32Array(tileCount).fill(1),
      this.tilesX,
      this.tilesY,
      THREE.RedFormat,
      THREE.FloatType,
    )
    this.stepTexture.minFilter = THREE.NearestFilter
    this.stepTexture.magFilter = THREE.NearestFilter
    this.stepTexture.generateMipmaps = false
    this.stepTexture.needsUpdate = true

    this.classTexture = StockSurface.classTextureFrom(new Uint8Array(1), 1, 1)
    this.uniforms = {
      uHeights: { value: this.texture },
      uClass: { value: this.classTexture },
      uTileStep: { value: this.stepTexture },
      uTiles: { value: new THREE.Vector2(this.tilesX, this.tilesY) },
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

    const variants: Record<string, number>[] = [{}, { THROUGH_CUTS: 1 }]
    const topMaterials = variants.map((defines) => this.material(SURFACE_VERTEX, defines, THREE.DoubleSide))
    // Tile triangles wind counter-clockwise seen from +Z, so the back side of the bottom face faces down.
    const bottomMaterials = variants.map((defines) => {
      const m = this.material(SURFACE_VERTEX, { BOTTOM_FACE: 1, ...defines }, THREE.BackSide)
      m.polygonOffset = true
      m.polygonOffsetFactor = -1
      m.polygonOffsetUnits = -1
      return m
    })
    this.batches = variants.map((_, variant) =>
      Array.from({ length: LEVELS }, (_, level) => {
        const geometry = StockSurface.tileGeometry(1 << level)
        const offsets = new THREE.InstancedBufferAttribute(new Float32Array(tileCount * 2), 2)
        offsets.setUsage(THREE.DynamicDrawUsage)
        geometry.setAttribute('aTile', offsets)
        geometry.instanceCount = 0
        const top = new THREE.Mesh(geometry, topMaterials[variant])
        const bottom = new THREE.Mesh(geometry, bottomMaterials[variant])
        // Tiles without the discard first and fine levels (the near ones) first, so their depth
        // hides more of what is drawn after them.
        top.renderOrder = bottom.renderOrder = -100 + variant * LEVELS + level
        for (const m of [top, bottom]) {
          // Culling is done per tile in updateView; the geometry has no meaningful bounds of its own.
          m.frustumCulled = false
          m.visible = false
        }
        this.group.add(top, bottom)
        return { geometry, offsets, top, bottom }
      }),
    )
    this.skirt = new THREE.Mesh(this.skirtGeometry(), this.material(SKIRT_VERTEX, { SKIRT: 1 }, THREE.DoubleSide))
    this.skirt.frustumCulled = false
    this.group.add(this.skirt)
    parent.add(this.group)
    renderer.initTexture(this.texture)
  }

  /** Chooses the tiles to draw and the vertex step of each for this camera. Call before every render. */
  updateView(camera: THREE.PerspectiveCamera): void {
    camera.updateMatrixWorld()
    this.matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    this.frustum.setFromProjectionMatrix(this.matrix)
    this.renderer.getDrawingBufferSize(this.bufferSize)
    // Device pixels covered by a length of 1 seen face-on at distance 1.
    const focal = this.bufferSize.y / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2))
    const { cellSize, stock, nx, ny } = this.grid
    const bottomZ = stock.min.z
    const cam = camera.position
    const steps = this.stepTexture.image.data as Float32Array
    let stepsChanged = false
    const visible: { tile: number; distance: number }[] = []
    for (let ty = 0; ty < this.tilesY; ty++) {
      for (let tx = 0; tx < this.tilesX; tx++) {
        const t = ty * this.tilesX + tx
        this.box.min.set(this.vertexX(tx * TILE), this.vertexY(ty * TILE), Math.min(this.tileMin[t], bottomZ))
        this.box.max.set(
          this.vertexX(Math.min(tx * TILE + TILE, nx + 1)),
          this.vertexY(Math.min(ty * TILE + TILE, ny + 1)),
          Math.max(this.tileMax[t], bottomZ),
        )
        // The nearest point of the tile bounds how large one of its cells can appear.
        const distance = this.box.distanceToPoint(cam)
        const cellPx = distance > 0 ? (cellSize * focal) / distance : Infinity
        const level = Math.min(LEVELS - 1, Math.max(0, Math.floor(Math.log2(MAX_QUAD_PX / cellPx))))
        const step = 1 << level
        if (steps[t] !== step) {
          steps[t] = step
          stepsChanged = true
        }
        if (this.frustum.intersectsBox(this.box)) visible.push({ tile: t, distance })
      }
    }
    if (stepsChanged) this.stepTexture.needsUpdate = true

    visible.sort((a, b) => a.distance - b.distance)
    const counts = this.batches.map((levels) => levels.map(() => 0))
    for (const { tile } of visible) {
      const variant = this.tileMin[tile] <= bottomZ ? 1 : 0
      const level = Math.log2(steps[tile])
      const offsets = this.batches[variant][level].offsets.array
      const k = counts[variant][level]++
      offsets[k * 2] = (tile % this.tilesX) * TILE
      offsets[k * 2 + 1] = Math.floor(tile / this.tilesX) * TILE
    }
    // The bottom face shows its downward side only, so it can be seen only from below the stock bottom.
    const showBottom = cam.z < bottomZ
    this.batches.forEach((levels, variant) =>
      levels.forEach((batch, level) => {
        const count = counts[variant][level]
        batch.geometry.instanceCount = count
        batch.top.visible = count > 0
        batch.bottom.visible = count > 0 && showBottom
        if (count > 0) {
          batch.offsets.clearUpdateRanges()
          batch.offsets.addUpdateRange(0, count * 2)
          batch.offsets.needsUpdate = true
        }
      }),
    )
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
    const position = new THREE.Vector2(rect.minI, rect.minJ)
    const patch = new THREE.DataTexture(data, w, h, THREE.RedFormat, THREE.FloatType)
    patch.needsUpdate = true
    this.renderer.copyTextureToTexture(patch, this.texture, null, position)
    patch.dispose()
    if (this.limits) {
      const classes = new Uint8Array(w * h)
      this.classify(rect, classes, w)
      const fullClasses = this.classTexture.image.data as Uint8Array
      for (let j = 0; j < h; j++) {
        fullClasses.set(classes.subarray(j * w, (j + 1) * w), (rect.minJ + j) * this.grid.nx + rect.minI)
      }
      const classPatch = StockSurface.classTextureFrom(classes, w, h)
      this.renderer.copyTextureToTexture(classPatch, this.classTexture, null, position)
      classPatch.dispose()
    }
    // Cell c is read by vertex c + 1, which lies in tile (c + 1) / TILE and, on a tile edge, also
    // in the tile before it.
    this.updateTileHeights(
      Math.max(0, Math.floor((rect.minI + 1) / TILE) - 1),
      Math.min(this.tilesX - 1, Math.floor((rect.maxI + 1) / TILE)),
      Math.max(0, Math.floor((rect.minJ + 1) / TILE) - 1),
      Math.min(this.tilesY - 1, Math.floor((rect.maxJ + 1) / TILE)),
    )
  }

  /**
   * Shows the comparison: per cell, interleaved, the gouge and leftover limit heights (-Infinity for
   * no gouge limit). Null shows plain stock.
   */
  setLimits(limits: Float32Array | null): void {
    this.classTexture.dispose()
    this.limits = limits
    const { nx, ny } = this.grid
    if (!limits) {
      this.classTexture = StockSurface.classTextureFrom(new Uint8Array(1), 1, 1)
    } else {
      const classes = new Uint8Array(nx * ny)
      this.classify({ minI: 0, maxI: nx - 1, minJ: 0, maxJ: ny - 1 }, classes, nx)
      this.classTexture = StockSurface.classTextureFrom(classes, nx, ny)
    }
    this.uniforms.uCompare.value = limits !== null
    this.uniforms.uClass.value = this.classTexture
  }

  /** Writes the class of each cell of rect into out: rows of `stride` bytes from rect's corner. */
  private classify(rect: CellRect, out: Uint8Array, stride: number): void {
    const limits = this.limits!
    const heights = this.texture.image.data as Float32Array
    const nx = this.grid.nx
    for (let j = rect.minJ; j <= rect.maxJ; j++) {
      const row = (j - rect.minJ) * stride - rect.minI
      for (let i = rect.minI; i <= rect.maxI; i++) {
        const c = j * nx + i
        const h = heights[c]
        out[row + i] = h < limits[c * 2] ? GOUGE : h > limits[c * 2 + 1] ? LEFTOVER : WITHIN
      }
    }
  }

  private static classTextureFrom(data: Uint8Array, w: number, h: number): THREE.DataTexture {
    const t = new THREE.DataTexture(data, w, h, THREE.RedFormat, THREE.UnsignedByteType)
    t.minFilter = THREE.NearestFilter
    t.magFilter = THREE.NearestFilter
    t.generateMipmaps = false
    // Rows of one byte per cell are not padded to four bytes.
    t.unpackAlignment = 1
    t.needsUpdate = true
    return t
  }

  dispose(): void {
    this.parent.remove(this.group)
    for (const levels of this.batches) for (const b of levels) b.geometry.dispose()
    this.skirt.geometry.dispose()
    for (const m of this.materials) m.dispose()
    this.texture.dispose()
    this.classTexture.dispose()
    this.stepTexture.dispose()
  }

  /** X of vertex column k: the stock edge for k = 0 and nx + 1, else the cell centre (as vertexXY). */
  private vertexX(k: number): number {
    const g = this.grid
    return Math.min(Math.max(g.originX + (k - 0.5) * g.cellSize, g.originX), g.stock.max.x)
  }

  private vertexY(l: number): number {
    const g = this.grid
    return Math.min(Math.max(g.originY + (l - 0.5) * g.cellSize, g.originY), g.stock.max.y)
  }

  /** Recomputes the lowest and highest cell height of the tiles in the given tile range. */
  private updateTileHeights(tx0: number, tx1: number, ty0: number, ty1: number): void {
    const { nx, ny } = this.grid
    const heights = this.texture.image.data as Float32Array
    for (let ty = ty0; ty <= ty1; ty++) {
      // Vertex l reads cell l - 1, clamped to the grid.
      const j0 = Math.max(0, ty * TILE - 1)
      const j1 = Math.min(ny - 1, ty * TILE + TILE - 1)
      for (let tx = tx0; tx <= tx1; tx++) {
        const i0 = Math.max(0, tx * TILE - 1)
        const i1 = Math.min(nx - 1, tx * TILE + TILE - 1)
        let lo = Infinity
        let hi = -Infinity
        for (let j = j0; j <= j1; j++) {
          const row = j * nx
          for (let i = i0; i <= i1; i++) {
            const h = heights[row + i]
            if (h < lo) lo = h
            if (h > hi) hi = h
          }
        }
        this.tileMin[ty * this.tilesX + tx] = lo
        this.tileMax[ty * this.tilesX + tx] = hi
      }
    }
  }

  private material(vertexShader: string, defines: Record<string, number>, side: THREE.Side): THREE.ShaderMaterial {
    const m = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader,
      fragmentShader: FRAGMENT,
      uniforms: this.uniforms,
      defines: { TILE, WITHIN, GOUGE, LEFTOVER, ...defines },
      side,
    })
    this.materials.push(m)
    return m
  }

  /** One tile of TILE x TILE cells with a vertex every `step` cells; positions in cell units. */
  private static tileGeometry(step: number): THREE.InstancedBufferGeometry {
    const q = TILE / step
    const n = q + 1
    const positions = new Float32Array(n * n * 3)
    for (let l = 0; l < n; l++) {
      for (let k = 0; k < n; k++) {
        const p = (l * n + k) * 3
        positions[p] = k * step
        positions[p + 1] = l * step
      }
    }
    const index = new Uint32Array(q * q * 6)
    let m = 0
    for (let l = 0; l < q; l++) {
      for (let k = 0; k < q; k++) {
        const a = l * n + k
        index[m++] = a
        index[m++] = a + 1
        index[m++] = a + n + 1
        index[m++] = a
        index[m++] = a + n + 1
        index[m++] = a + n
      }
    }
    const geometry = new THREE.InstancedBufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geometry.setIndex(new THREE.BufferAttribute(index, 1))
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
