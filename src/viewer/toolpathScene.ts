// three.js scene for the toolpath view. Work coordinates are used directly as scene coordinates:
// Z up, work origin at the scene origin, Z0 at the stock top.
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { MoveType, type MoveList } from '../engine/moveList'
import type { Box3D } from '../engine/stock'

const CUTTING_COLOR = 0x1f6fd1
const RAPID_COLOR = 0xe8590c
const STOCK_COLOR = 0x6b7280

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
    container.appendChild(this.renderer.domElement)

    this.camera.up.set(0, 0, 1)
    this.camera.position.set(75, -150, 150)
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.addEventListener('change', () => this.requestRender())
    this.controls.addEventListener('start', () => {
      this.userMovedCamera = true
    })

    this.scene.add(this.axes, this.jobGroup)

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
      this.jobGroup.add(new THREE.Box3Helper(box, STOCK_COLOR))
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
    // clearJob schedules a frame; cancel it so nothing renders into the disposed renderer.
    if (this.frameHandle !== null) cancelAnimationFrame(this.frameHandle)
    this.frameHandle = null
    this.axes.dispose()
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
    this.camera.near = distance / 1000
    this.camera.far = distance * 100
    this.camera.updateProjectionMatrix()
    this.controls.update()
    this.requestRender()
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
      this.renderer.render(this.scene, this.camera)
    })
  }
}
