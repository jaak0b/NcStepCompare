// three.js scene for the toolpath view. Work coordinates are used directly as scene coordinates:
// Z up, work origin at the scene origin, Z0 at the stock top.
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { MoveType, type MoveList } from '../engine/moveList'
import type { Box3D } from '../engine/stock'
import type { CellRect } from '../engine/simulation'
import type { GridInfo } from '../workers/simulationMessages'
import type { MissingMaterial } from '../engine/comparisonView'
import { missingMaterialMesh } from './missingMaterial'
import { StockSurface } from './stockSurface'
import { StockGaps, UndercutMesh } from './undercutMesh'
import type { GapRecord } from '../engine/dexelStock'

const CUTTING_COLOR = 0x1f6fd1
const RAPID_COLOR = 0xe8590c
const STOCK_COLOR = 0x6b7280
const TOOL_MARKER_COLOR = 0xd9a400
const PART_OUTLINE_COLOR = 0x1d2733
const FINDING_COLOR = 0x0891b2
/** Smallest radius the camera frames around a finding, mm, so a one-cell finding is not filled edge to edge. */
const MIN_FINDING_VIEW_RADIUS_MM = 3
/** Faces meeting at a smaller angle than this (degrees) share no outline edge. */
const OUTLINE_CREASE_ANGLE = 20

export interface ToolMarker {
  tip: { x: number; y: number; z: number }
  radius: number
  length: number
}

interface ToolpathLines {
  cutting: THREE.LineSegments | null
  rapid: THREE.LineSegments | null
}

export class ToolpathScene {
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene = new THREE.Scene()
  private readonly camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10000)
  private readonly controls: OrbitControls
  private readonly resizeObserver: ResizeObserver
  private readonly jobGroup = new THREE.Group()
  private readonly lines = new Map<number, ToolpathLines>()
  private readonly cuttingMaterial = new THREE.LineBasicMaterial({ color: CUTTING_COLOR })
  private readonly rapidMaterial = new THREE.LineBasicMaterial({
    color: RAPID_COLOR,
    transparent: true,
    opacity: 0.6,
  })
  private readonly axes = new THREE.AxesHelper(10)
  /**
   * The STEP outline is drawn in its own pass with hidden-line removal against the parts only: after
   * the main scene the depth buffer is cleared, the part faces are drawn into depth alone, then the
   * edges are drawn depth-tested. So the stock never hides the outline (the placement can be checked
   * before anything is cut), but edges behind the part's own faces are not drawn.
   */
  private readonly outlineScene = new THREE.Scene()
  private readonly outlineGroup = new THREE.Group()
  private readonly outlines = new Map<string, { positions: Float32Array; lines: THREE.LineSegments; faces: THREE.Mesh }>()
  private readonly outlineMaterial = new THREE.LineBasicMaterial({
    color: PART_OUTLINE_COLOR,
    transparent: true,
    opacity: 0.55,
  })
  // Depth only. The polygon offset pushes the faces back by a slope-scaled depth bias, so the edges
  // lying on them pass the depth test instead of flickering against them.
  private readonly outlineFaceMaterial = new THREE.MeshBasicMaterial({
    colorWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  })
  private stockSurface: StockSurface | null = null
  private stockGaps: StockGaps | null = null
  private undercuts: UndercutMesh | null = null
  /** Section plane cutting everything drawn in work space (stock, outline, toolpaths, markers), or none. */
  private clipPlanes: THREE.Plane[] = []
  private grid: GridInfo | null = null
  private missing: THREE.Mesh | null = null
  private missingVisible = false
  /** Box around the selected finding, drawn over everything like the outline. */
  private findingBox: THREE.Box3Helper | null = null
  /** CPU time of the last renderer.render call in ms, measured (GPU work runs after it). */
  lastRenderMs = 0
  private readonly toolMarker: THREE.Mesh
  private hiddenToolpaths = new Set<number>()
  private rapidsVisible = true
  private frameHandle: number | null = null
  /** Region the camera is fitted to; refitted on resize until the user moves the camera. */
  private fitBox: THREE.Box3 | null = null
  private userMovedCamera = false

  constructor(private readonly container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true })
    this.renderer.setPixelRatio(window.devicePixelRatio)
    this.renderer.setClearColor(0xffffff)
    this.renderer.localClippingEnabled = true
    container.appendChild(this.renderer.domElement)

    this.camera.up.set(0, 0, 1)
    this.camera.position.set(75, -150, 150)
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.addEventListener('change', () => this.requestRender())
    this.controls.addEventListener('start', () => {
      this.userMovedCamera = true
    })

    const sun = new THREE.DirectionalLight(0xffffff, 2.2)
    sun.position.set(1, -1.5, 2)
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x666666, 1.4), sun)

    // Unit cylinder standing on its tip point: axis along Z from 0 to 1.
    const markerGeometry = new THREE.CylinderGeometry(1, 1, 1, 24).rotateX(Math.PI / 2).translate(0, 0, 0.5)
    this.toolMarker = new THREE.Mesh(
      markerGeometry,
      new THREE.MeshLambertMaterial({ color: TOOL_MARKER_COLOR, transparent: true, opacity: 0.75 }),
    )
    this.toolMarker.visible = false

    this.scene.add(this.axes, this.jobGroup, this.toolMarker)
    this.outlineScene.add(this.outlineGroup)

    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(container)
    this.resize()
  }

  setJob(moves: MoveList, stockBox: Box3D | null, pathBounds: Box3D | null): void {
    this.clearJob()

    // Count segments per toolpath and kind, then fill one position buffer for each.
    const counts = new Map<number, { cutting: number; rapid: number }>()
    for (let i = 0; i < moves.count; i++) {
      const tp = moves.toolpath[i]
      let c = counts.get(tp)
      if (!c) counts.set(tp, (c = { cutting: 0, rapid: 0 }))
      if (moves.type[i] === MoveType.Rapid) c.rapid++
      else c.cutting++
    }
    const buffers = new Map<number, { cutting: Float32Array; rapid: Float32Array; ci: number; ri: number }>()
    for (const [tp, c] of counts) {
      buffers.set(tp, {
        cutting: new Float32Array(c.cutting * 6),
        rapid: new Float32Array(c.rapid * 6),
        ci: 0,
        ri: 0,
      })
    }
    for (let i = 0; i < moves.count; i++) {
      const b = buffers.get(moves.toolpath[i])!
      const rapid = moves.type[i] === MoveType.Rapid
      const target = rapid ? b.rapid : b.cutting
      let k = rapid ? b.ri : b.ci
      const j = i * 3
      target[k++] = moves.start[j]
      target[k++] = moves.start[j + 1]
      target[k++] = moves.start[j + 2]
      target[k++] = moves.end[j]
      target[k++] = moves.end[j + 1]
      target[k++] = moves.end[j + 2]
      if (rapid) b.ri = k
      else b.ci = k
    }
    for (const [tp, b] of buffers) {
      const entry: ToolpathLines = {
        cutting: this.makeLines(b.cutting, this.cuttingMaterial),
        rapid: this.makeLines(b.rapid, this.rapidMaterial),
      }
      this.lines.set(tp, entry)
    }

    if (stockBox) {
      const box = new THREE.Box3(
        new THREE.Vector3(stockBox.min.x, stockBox.min.y, stockBox.min.z),
        new THREE.Vector3(stockBox.max.x, stockBox.max.y, stockBox.max.z),
      )
      const stockOutline = new THREE.Box3Helper(box, STOCK_COLOR)
      this.clipMaterial(stockOutline.material as THREE.Material)
      this.jobGroup.add(stockOutline)
    }
    this.applyVisibility()

    // Fit the camera to everything that is drawn: the stock and the toolpath extent.
    const fit = new THREE.Box3()
    for (const b of [stockBox, pathBounds]) {
      if (b) fit.union(new THREE.Box3(new THREE.Vector3(b.min.x, b.min.y, b.min.z), new THREE.Vector3(b.max.x, b.max.y, b.max.z)))
    }
    this.fitBox = fit.isEmpty() ? null : fit
    this.userMovedCamera = false
    this.fitCamera()
  }

  /** Shows the machined stock from the whole simulation grid. */
  setStockGrid(grid: GridInfo, heights: Float32Array, gaps: GapRecord): void {
    this.clearStock()
    this.grid = grid
    const surface = new StockSurface(this.renderer, this.scene, grid, heights)
    this.stockSurface = surface
    this.stockGaps = new StockGaps(grid.nx)
    const all = { minI: 0, maxI: grid.nx - 1, minJ: 0, maxJ: grid.ny - 1 }
    this.stockGaps.applyRect(all, gaps)
    surface.updateGaps(this.stockGaps, null)
    this.undercuts = new UndercutMesh(this.scene, grid, this.stockGaps, surface.heights)
    this.applyClipPlanes()
    this.requestRender()
  }

  /** Updates the changed cells of the machined stock. */
  applyStockRect(rect: CellRect, data: Float32Array, gaps: GapRecord): void {
    this.stockSurface?.applyRect(rect, data)
    if (this.stockGaps && this.stockSurface && this.undercuts) {
      const before = this.stockGaps.columns.size
      this.stockGaps.applyRect(rect, gaps)
      if (before > 0 || this.stockGaps.columns.size > 0) {
        this.stockSurface.updateGaps(this.stockGaps, rect)
        this.undercuts.rebuild(rect)
      }
    }
    this.requestRender()
  }

  /**
   * Cuts the drawing with the plane `axis` = `position` (work coordinates), keeping the side with the
   * larger coordinate; null removes the plane. Stock, STEP outline, toolpaths, missing material and the
   * finding box are all cut. Only the drawing is cut, never the material data.
   */
  setSectionPlane(section: { axis: 'x' | 'y'; position: number } | null): void {
    this.clipPlanes = section
      ? [new THREE.Plane(new THREE.Vector3(section.axis === 'x' ? 1 : 0, section.axis === 'y' ? 1 : 0, 0), -section.position)]
      : []
    this.applyClipPlanes()
    this.requestRender()
  }

  private applyClipPlanes(): void {
    this.stockSurface?.setClipPlanes(this.clipPlanes)
    if (this.undercuts) this.clipMaterial(this.undercuts.material)
    for (const m of [this.cuttingMaterial, this.rapidMaterial, this.outlineMaterial, this.outlineFaceMaterial]) {
      this.clipMaterial(m)
    }
    if (this.missing) this.clipMaterial(this.missing.material as THREE.Material)
    if (this.findingBox) this.clipMaterial(this.findingBox.material as THREE.Material)
    for (const child of this.jobGroup.children) {
      if (child instanceof THREE.Box3Helper) this.clipMaterial(child.material as THREE.Material)
    }
  }

  /** Gives a material the current section plane; a change of plane count needs a new shader. */
  private clipMaterial(m: THREE.Material): void {
    m.clippingPlanes = this.clipPlanes
    m.needsUpdate = true
  }

  /** Colours the stock by the comparison limits and cell classes (see StockSurface.setLimits), or plain for null. */
  setStockLimits(limits: Float32Array | null, classes: Uint8Array | null): void {
    this.stockSurface?.setLimits(limits, classes)
    this.undercuts?.setComparison(limits, classes)
    this.requestRender()
  }

  /** The material the model needs but the G-code cut away (see missingMaterial), or none for null. */
  setMissingMaterial(m: MissingMaterial | null): void {
    this.clearMissing()
    if (m && this.grid) {
      this.missing = missingMaterialMesh(this.grid, m)
      if (this.missing) {
        this.clipMaterial(this.missing.material as THREE.Material)
        this.missing.visible = this.missingVisible
        this.scene.add(this.missing)
      }
    }
    this.requestRender()
  }

  setMissingMaterialVisible(visible: boolean): void {
    this.missingVisible = visible
    if (this.missing) this.missing.visible = visible
    this.requestRender()
  }

  private clearMissing(): void {
    if (!this.missing) return
    this.scene.remove(this.missing)
    this.missing.geometry.dispose()
    ;(this.missing.material as THREE.Material).dispose()
    this.missing = null
  }

  /**
   * Shows the feature edges of each placed part (work coordinates). A part whose positions array is
   * the same object as last time keeps its outline; only new or moved parts are rebuilt.
   */
  setPartOutlines(parts: { id: string; positions: Float32Array; indices: Uint32Array }[]): void {
    const keep = new Set(parts.map((p) => p.id))
    for (const [id, o] of this.outlines) {
      if (keep.has(id)) continue
      this.removeOutline(o)
      this.outlines.delete(id)
    }
    for (const p of parts) {
      const old = this.outlines.get(p.id)
      if (old?.positions === p.positions) continue
      if (old) this.removeOutline(old)
      const mesh = new THREE.BufferGeometry()
      mesh.setAttribute('position', new THREE.BufferAttribute(p.positions, 3))
      mesh.setIndex(new THREE.BufferAttribute(p.indices, 1))
      const lines = new THREE.LineSegments(new THREE.EdgesGeometry(mesh, OUTLINE_CREASE_ANGLE), this.outlineMaterial)
      const faces = new THREE.Mesh(mesh, this.outlineFaceMaterial)
      this.outlineGroup.add(faces, lines)
      this.outlines.set(p.id, { positions: p.positions, lines, faces })
    }
    this.requestRender()
  }

  /**
   * Marks a finding's region with a box and turns the camera to it, keeping the viewing direction.
   * Null removes the box and leaves the camera.
   */
  showFinding(box: Box3D | null): void {
    if (this.findingBox) {
      this.outlineScene.remove(this.findingBox)
      this.findingBox.geometry.dispose()
      ;(this.findingBox.material as THREE.Material).dispose()
      this.findingBox = null
    }
    if (box) {
      const b = new THREE.Box3(
        new THREE.Vector3(box.min.x, box.min.y, box.min.z),
        new THREE.Vector3(box.max.x, box.max.y, box.max.z),
      )
      this.findingBox = new THREE.Box3Helper(b, FINDING_COLOR)
      // Drawn through the parts and the stock: a gouge lies below the model surface.
      ;(this.findingBox.material as THREE.LineBasicMaterial).depthTest = false
      this.clipMaterial(this.findingBox.material as THREE.Material)
      this.outlineScene.add(this.findingBox)
      const sphere = b.getBoundingSphere(new THREE.Sphere())
      const radius = Math.max(sphere.radius, MIN_FINDING_VIEW_RADIUS_MM)
      const vFov = THREE.MathUtils.degToRad(this.camera.fov)
      const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this.camera.aspect)
      const distance = Math.max(radius / Math.sin(vFov / 2), radius / Math.sin(hFov / 2))
      const direction = this.camera.position.clone().sub(this.controls.target).normalize()
      this.controls.target.copy(sphere.center)
      this.camera.position.copy(sphere.center).addScaledVector(direction, distance)
      this.controls.update()
      this.userMovedCamera = true
    }
    this.requestRender()
  }

  setPartOutlinesVisible(visible: boolean): void {
    this.outlineGroup.visible = visible
    this.requestRender()
  }

  private removeOutline(o: { lines: THREE.LineSegments; faces: THREE.Mesh }): void {
    this.outlineGroup.remove(o.lines, o.faces)
    o.lines.geometry.dispose()
    o.faces.geometry.dispose()
  }

  private clearPartOutlines(): void {
    for (const o of this.outlines.values()) this.removeOutline(o)
    this.outlines.clear()
  }

  clearStock(): void {
    this.stockSurface?.dispose()
    this.stockSurface = null
    this.undercuts?.dispose()
    this.undercuts = null
    this.stockGaps = null
    this.clearMissing()
    this.requestRender()
  }

  /** Shows the tool as a cylinder with its tip at the given point, or hides it for null. */
  setToolMarker(tip: { x: number; y: number; z: number } | null, radius: number, length: number): void {
    if (!tip || !(radius > 0)) {
      this.toolMarker.visible = false
    } else {
      this.toolMarker.visible = true
      this.toolMarker.position.set(tip.x, tip.y, tip.z)
      this.toolMarker.scale.set(radius, radius, length > 0 ? length : radius * 4)
    }
    this.requestRender()
  }

  setHiddenToolpaths(hidden: Set<number>): void {
    this.hiddenToolpaths = new Set(hidden)
    this.applyVisibility()
  }

  setRapidsVisible(visible: boolean): void {
    this.rapidsVisible = visible
    this.applyVisibility()
  }

  dispose(): void {
    this.resizeObserver.disconnect()
    this.clearJob()
    this.clearStock()
    this.clearPartOutlines()
    this.showFinding(null)
    this.outlineMaterial.dispose()
    this.outlineFaceMaterial.dispose()
    // Clearing schedules a frame; cancel it so nothing renders into the disposed renderer.
    if (this.frameHandle !== null) cancelAnimationFrame(this.frameHandle)
    this.frameHandle = null
    this.axes.dispose()
    this.toolMarker.geometry.dispose()
    ;(this.toolMarker.material as THREE.Material).dispose()
    this.controls.dispose()
    this.cuttingMaterial.dispose()
    this.rapidMaterial.dispose()
    this.renderer.dispose()
    this.renderer.forceContextLoss()
    this.renderer.domElement.remove()
  }

  private makeLines(positions: Float32Array, material: THREE.Material): THREE.LineSegments | null {
    if (positions.length === 0) return null
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    const lines = new THREE.LineSegments(geometry, material)
    this.jobGroup.add(lines)
    return lines
  }

  private applyVisibility(): void {
    for (const [tp, entry] of this.lines) {
      const shown = !this.hiddenToolpaths.has(tp)
      if (entry.cutting) entry.cutting.visible = shown
      if (entry.rapid) entry.rapid.visible = shown && this.rapidsVisible
    }
    this.requestRender()
  }

  private clearJob(): void {
    for (const child of [...this.jobGroup.children]) {
      this.jobGroup.remove(child)
      if (child instanceof THREE.LineSegments) child.geometry.dispose()
      if (child instanceof THREE.Box3Helper) {
        child.geometry.dispose()
        ;(child.material as THREE.Material).dispose()
      }
    }
    this.lines.clear()
    this.requestRender()
  }

  /**
   * Places the camera so the bounding sphere of the fit box fills the view, using whichever of the
   * vertical and horizontal field of view is tighter for the current aspect ratio.
   */
  private fitCamera(): void {
    if (!this.fitBox) return
    const sphere = this.fitBox.getBoundingSphere(new THREE.Sphere())
    const radius = Math.max(sphere.radius, 1)
    const vFov = THREE.MathUtils.degToRad(this.camera.fov)
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this.camera.aspect)
    const distance = Math.max(radius / Math.sin(vFov / 2), radius / Math.sin(hFov / 2))
    // View from the front, above the stock.
    const direction = new THREE.Vector3(0, -1, 0.8).normalize()
    this.controls.target.copy(sphere.center)
    this.camera.position.copy(sphere.center).addScaledVector(direction, distance)
    this.controls.update()
    this.requestRender()
  }

  /**
   * Near and far planes for the current camera: the near plane a thousandth of the distance to the
   * orbit target (depth precision follows it when zooming in), the far plane beyond the farthest
   * point of the job's region seen from the camera, so nothing drawn is clipped after any zoom.
   */
  private updateClipPlanes(): void {
    const d = Math.max(this.camera.position.distanceTo(this.controls.target), 1e-3)
    let far = d * 100
    if (this.fitBox) {
      const sphere = this.fitBox.getBoundingSphere(new THREE.Sphere())
      far = Math.max(far, (this.camera.position.distanceTo(sphere.center) + sphere.radius) * 1.01)
    }
    if (this.camera.near !== d / 1000 || this.camera.far !== far) {
      this.camera.near = d / 1000
      this.camera.far = far
      this.camera.updateProjectionMatrix()
    }
  }

  private resize(): void {
    const w = Math.max(1, this.container.clientWidth)
    const h = Math.max(1, this.container.clientHeight)
    this.renderer.setSize(w, h)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    if (!this.userMovedCamera) this.fitCamera()
    this.requestRender()
  }

  private requestRender(): void {
    if (this.frameHandle !== null) return
    this.frameHandle = requestAnimationFrame(() => {
      this.frameHandle = null
      const t0 = performance.now()
      this.updateClipPlanes()
      this.stockSurface?.updateView(this.camera)
      this.renderer.render(this.scene, this.camera)
      if ((this.outlineGroup.visible && this.outlines.size > 0) || this.findingBox) {
        this.renderer.autoClear = false
        this.renderer.clearDepth()
        this.renderer.render(this.outlineScene, this.camera)
        this.renderer.autoClear = true
      }
      this.lastRenderMs = performance.now() - t0
    })
  }
}
