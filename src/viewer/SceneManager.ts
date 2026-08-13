import * as THREE from 'three'
import { TrackballControls } from 'three/addons/controls/TrackballControls.js'
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js'
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh'

declare module 'three' {
  interface BufferGeometry {
    computeBoundsTree: typeof computeBoundsTree
    disposeBoundsTree: typeof disposeBoundsTree
  }
}

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree
THREE.Mesh.prototype.raycast = acceleratedRaycast

const BASE_COLOR: [number, number, number] = [186, 189, 196]

/** The ghost sphere of an unconfirmed fit is neutral grey — only the marked
 *  surfaces carry the colour the element will get, so "picked" and "measured"
 *  never look the same. */
const PREVIEW_SPHERE_COLOR = 0xb9bdc6

const GIZMO_AXES: [THREE.Vector3, number, string][] = [
  [new THREE.Vector3(1, 0, 0), 0xf2686b, 'X'],
  [new THREE.Vector3(0, 1, 0), 0x7ed491, 'Y'],
  [new THREE.Vector3(0, 0, 1), 0x57b6f2, 'Z'],
]

/** Canvas-textured letter for an axis tip. */
function axisLabel(text: string, color: number): THREE.Sprite {
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 64
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#' + color.toString(16).padStart(6, '0')
  ctx.font = 'bold 46px system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, 32, 34)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false }),
  )
  sprite.scale.setScalar(0.6)
  return sprite
}

/** Dominant direction of the vertex cloud (power iteration on the
 *  covariance of a subsample) — used to frame elongated parts broadside. */
function principalAxis(positions: Float32Array): THREE.Vector3 {
  const n = positions.length / 3
  const step = Math.max(1, Math.floor(n / 50_000))
  let mx = 0, my = 0, mz = 0, m = 0
  for (let v = 0; v < n; v += step) {
    mx += positions[v * 3]
    my += positions[v * 3 + 1]
    mz += positions[v * 3 + 2]
    m++
  }
  mx /= m; my /= m; mz /= m
  let cxx = 0, cxy = 0, cxz = 0, cyy = 0, cyz = 0, czz = 0
  for (let v = 0; v < n; v += step) {
    const x = positions[v * 3] - mx
    const y = positions[v * 3 + 1] - my
    const z = positions[v * 3 + 2] - mz
    cxx += x * x; cxy += x * y; cxz += x * z
    cyy += y * y; cyz += y * z; czz += z * z
  }
  const a = new THREE.Vector3(1, 1, 1).normalize()
  for (let i = 0; i < 50; i++) {
    a.set(
      cxx * a.x + cxy * a.y + cxz * a.z,
      cxy * a.x + cyy * a.y + cyz * a.z,
      cxz * a.x + cyz * a.y + czz * a.z,
    )
    const len = a.length()
    if (len < 1e-20) return new THREE.Vector3(1, 0, 0)
    a.divideScalar(len)
  }
  return a
}

export interface OverlayElement {
  id: number
  name: string
  color: string
  center: [number, number, number]
  radius: number
}

export interface OverlayPair {
  a: [number, number, number]
  b: [number, number, number]
  title: string
  value: string
}

/** A pin in the 3D view: what it marks on top, the measured value under it, so
 *  the numbers can be read off the model without going back to the sidebar. */
function pinLabel(kind: string, title: string, value: string, titleColor?: string): CSS2DObject {
  const div = document.createElement('div')
  div.className = `viewport-label ${kind}`
  const t = document.createElement('div')
  t.className = 'label-title'
  t.textContent = title
  if (titleColor) t.style.color = titleColor
  const v = document.createElement('div')
  v.className = 'label-value'
  v.textContent = value
  div.append(t, v)
  return new CSS2DObject(div)
}

/** Owns the Three.js scene: mesh display, BVH picking, per-vertex region
 *  tinting, the fitted-sphere / distance-line overlays, and the translucent
 *  preview of a fit the user has not confirmed yet. */
export class SceneManager {
  private renderer: THREE.WebGLRenderer
  private labelRenderer: CSS2DRenderer
  private scene = new THREE.Scene()
  private camera: THREE.OrthographicCamera
  private controls: TrackballControls
  private keyLight: THREE.DirectionalLight
  /** Orientation gizmo, drawn into a corner viewport of the same canvas. */
  private gizmoScene = new THREE.Scene()
  private gizmoCamera = new THREE.OrthographicCamera(-1.75, 1.75, 1.75, -1.75, 0.1, 12)
  private gizmoDisposables: { dispose(): void }[] = []
  private overlayGroup = new THREE.Group()
  private previewGroup = new THREE.Group()
  private overlayCleanup: (() => void)[] = []
  private raycaster = new THREE.Raycaster()
  private mesh: THREE.Mesh | null = null
  private colorAttr: THREE.BufferAttribute | null = null
  private owner: Int32Array | null = null
  /** Colour each element paints its region with, so a preview can be lifted
   *  off again without repainting the whole mesh. */
  private elementColors = new Map<number, [number, number, number]>()
  private previewRegion: Uint32Array | null = null
  private previewRgb: [number, number, number] = [255, 255, 255]
  private previewSphere: THREE.Mesh | null = null
  private unitSphere = new THREE.SphereGeometry(1, 48, 32)
  /** Half-extents of the model on the screen plane at the framing camera
   *  orientation; the frustum is rebuilt from these on every resize so the
   *  user's zoom survives. */
  private fitExtent = { halfW: 1, halfH: 1 }
  private rafId = 0
  private resizeObserver: ResizeObserver
  private pointerDown: { x: number; y: number } | null = null

  onPick: ((faceVertices: [number, number, number]) => void) | null = null

  constructor(private container: HTMLDivElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.container.appendChild(this.renderer.domElement)

    this.labelRenderer = new CSS2DRenderer()
    const labelDom = this.labelRenderer.domElement
    labelDom.style.position = 'absolute'
    labelDom.style.top = '0'
    labelDom.style.left = '0'
    labelDom.style.pointerEvents = 'none'
    this.container.appendChild(labelDom)

    this.scene.background = new THREE.Color(0x17181c)
    // Parallel projection: metrology views should not foreshorten, and equal
    // features must read the same size wherever they sit in the frame.
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 4000)
    this.camera.position.set(0, 0, 100)

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x585d68, 1.25))
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.55))
    this.keyLight = new THREE.DirectionalLight(0xffffff, 1.5)
    this.scene.add(this.keyLight)
    this.scene.add(this.keyLight.target)
    this.scene.add(this.overlayGroup)
    this.scene.add(this.previewGroup)

    // Trackball rather than orbit: rotation is a free rotation of the whole
    // view, so there is no fixed up-axis and therefore no poles to get stuck
    // at — you can roll all the way around the part in any direction.
    this.controls = new TrackballControls(this.camera, this.renderer.domElement)
    this.controls.rotateSpeed = 3.2
    this.controls.zoomSpeed = 1.2
    this.controls.dynamicDampingFactor = 0.2

    this.buildGizmo()

    const rc = this.raycaster as THREE.Raycaster & { firstHitOnly?: boolean }
    rc.firstHitOnly = true

    this.renderer.domElement.addEventListener('pointerdown', (e) => {
      if (e.button === 0) this.pointerDown = { x: e.clientX, y: e.clientY }
    })
    this.renderer.domElement.addEventListener('pointerup', (e) => {
      const down = this.pointerDown
      this.pointerDown = null
      if (!down || e.button !== 0) return
      if (Math.abs(e.clientX - down.x) + Math.abs(e.clientY - down.y) > 6) return
      const verts = this.pick(e.clientX, e.clientY)
      if (verts) this.onPick?.(verts)
    })

    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(this.container)
    this.resize()

    const animate = () => {
      this.rafId = requestAnimationFrame(animate)
      const w = this.container.clientWidth || 1
      const h = this.container.clientHeight || 1
      this.syncPanSpeed(w)
      this.controls.update()
      this.keyLight.position.copy(this.camera.position)
      this.keyLight.target.position.copy(this.controls.target)
      this.renderer.setViewport(0, 0, w, h)
      this.renderer.render(this.scene, this.camera)
      this.renderGizmo(w, h)
      this.labelRenderer.render(this.scene, this.camera)
    }
    animate()
  }

  /** Make panning track the cursor exactly 1:1.
   *
   *  Per frame TrackballControls shifts the world by
   *  `(dx/W)·(Wworld/(zoom·W))·|eye|·panSpeed`, and one screen pixel is
   *  `Wworld/(zoom·W)` world units — but it applies the *whole* remaining drag
   *  every frame while only closing `dynamicDampingFactor` of the gap, so the
   *  total comes out `1/dampingFactor` times larger. Both the frustum and the
   *  zoom cancel, leaving `panSpeed = W·damping/|eye|`.
   *
   *  A constant panSpeed can therefore only be 1:1 for one model size at one
   *  window width — hence deriving it per frame. */
  private syncPanSpeed(width: number): void {
    const eye = this.camera.position.distanceTo(this.controls.target)
    const damping = this.controls.staticMoving ? 1 : this.controls.dynamicDampingFactor
    this.controls.panSpeed = eye > 1e-6 ? (width * damping) / eye : 1
  }

  private buildGizmo(): void {
    const shaft = new THREE.CylinderGeometry(0.035, 0.035, 0.72, 8)
    shaft.translate(0, 0.36, 0)
    const head = new THREE.ConeGeometry(0.1, 0.26, 12)
    head.translate(0, 0.85, 0)
    this.gizmoDisposables.push(shaft, head)

    const y = new THREE.Vector3(0, 1, 0)
    for (const [dir, color, text] of GIZMO_AXES) {
      const mat = new THREE.MeshBasicMaterial({ color })
      this.gizmoDisposables.push(mat)
      const q = new THREE.Quaternion().setFromUnitVectors(y, dir)
      for (const geo of [shaft, head]) {
        const part = new THREE.Mesh(geo, mat)
        part.quaternion.copy(q)
        this.gizmoScene.add(part)
      }
      const label = axisLabel(text, color)
      label.position.copy(dir).multiplyScalar(1.3)
      this.gizmoScene.add(label)
      this.gizmoDisposables.push(label.material, label.material.map!)
    }
  }

  /** Draw the gizmo into a bottom-right corner of the same canvas, sharing the
   *  main camera's orientation so it reads as the part's world axes. */
  private renderGizmo(w: number, h: number): void {
    const size = Math.min(120, Math.max(74, Math.min(w, h) * 0.18))
    const pad = 14
    this.gizmoCamera.position
      .subVectors(this.camera.position, this.controls.target)
      .normalize()
      .multiplyScalar(6)
    this.gizmoCamera.quaternion.copy(this.camera.quaternion)

    this.renderer.autoClear = false
    this.renderer.setViewport(w - size - pad, pad, size, size)
    this.renderer.setScissor(w - size - pad, pad, size, size)
    this.renderer.setScissorTest(true)
    this.renderer.clearDepth()
    this.renderer.render(this.gizmoScene, this.gizmoCamera)
    this.renderer.setScissorTest(false)
    this.renderer.autoClear = true
  }

  /** Replace the displayed mesh. Synchronous and heavy (includes the BVH
   *  build) — callers should show a status message and yield a frame first. */
  setMesh(positions: Float32Array, indices: Uint32Array, normals: Float32Array): void {
    this.disposeMesh()
    this.setPreviewSphere(null)

    const vertexCount = positions.length / 3
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
    const colors = new Uint8Array(vertexCount * 3)
    for (let i = 0; i < vertexCount; i++) {
      colors[i * 3] = BASE_COLOR[0]
      colors[i * 3 + 1] = BASE_COLOR[1]
      colors[i * 3 + 2] = BASE_COLOR[2]
    }
    this.colorAttr = new THREE.BufferAttribute(colors, 3, true)
    geometry.setAttribute('color', this.colorAttr)
    geometry.setIndex(new THREE.BufferAttribute(indices, 1))
    geometry.computeBoundingBox()
    geometry.computeBoundingSphere()

    // Scans have holes; double-sided rendering keeps interior surfaces
    // visible instead of culling them to black.
    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.62,
      metalness: 0.05,
      side: THREE.DoubleSide,
    })
    this.mesh = new THREE.Mesh(geometry, material)
    this.scene.add(this.mesh)
    this.owner = new Int32Array(vertexCount)

    this.frameCamera(geometry.boundingBox!, principalAxis(positions))
    geometry.computeBoundsTree()
  }

  /** Point the camera at the bounding-box centre from a broadside direction,
   *  then size the frustum to the box's actual on-screen extents. */
  private frameCamera(box: THREE.Box3, axis: THREE.Vector3): void {
    const center = box.getCenter(new THREE.Vector3())
    const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1e-3)

    // Look from the three-quarter-ish direction that is still perpendicular to
    // the part's long axis — an end-on view would hide most of an elongated
    // part, and a rolled camera makes orbiting feel inverted, so screen-up
    // stays world-up no matter how the part is oriented.
    const dir = new THREE.Vector3(0.62, 0.42, 1).normalize()
    dir.addScaledVector(axis, -dir.dot(axis))
    if (dir.lengthSq() < 1e-6) dir.set(-axis.y, axis.x, 0)
    if (dir.lengthSq() < 1e-6) dir.set(1, 0, 0)
    dir.normalize()

    this.camera.up.set(0, 1, 0)
    this.controls.target.copy(center)
    const dist = radius * 4 + 1
    this.camera.position.copy(center).addScaledVector(dir, dist)
    this.camera.zoom = 1
    this.camera.near = 0.01
    this.camera.far = dist + radius * 4
    this.camera.lookAt(center)
    this.camera.updateMatrixWorld(true)

    // Screen-plane half-extents of the eight box corners. Orthographic x/y are
    // independent of depth, so this frames the part exactly.
    const toCamera = new THREE.Matrix4().copy(this.camera.matrixWorld).invert()
    const corner = new THREE.Vector3()
    let halfW = 1e-3
    let halfH = 1e-3
    for (let i = 0; i < 8; i++) {
      corner
        .set(
          i & 1 ? box.max.x : box.min.x,
          i & 2 ? box.max.y : box.min.y,
          i & 4 ? box.max.z : box.min.z,
        )
        .applyMatrix4(toCamera)
      halfW = Math.max(halfW, Math.abs(corner.x))
      halfH = Math.max(halfH, Math.abs(corner.y))
    }
    this.fitExtent = { halfW: halfW * 1.08, halfH: halfH * 1.08 }
    this.applyFrustum()
    this.controls.update()
  }

  /** Rebuild the orthographic frustum for the current viewport aspect,
   *  leaving camera.zoom (the user's zoom) alone. */
  private applyFrustum(): void {
    const aspect = (this.container.clientWidth || 1) / (this.container.clientHeight || 1)
    const { halfW, halfH } = this.fitExtent
    const h = Math.max(halfH, halfW / aspect)
    this.camera.top = h
    this.camera.bottom = -h
    this.camera.right = h * aspect
    this.camera.left = -h * aspect
    this.camera.updateProjectionMatrix()
  }

  private pick(clientX: number, clientY: number): [number, number, number] | null {
    if (!this.mesh) return null
    const rect = this.renderer.domElement.getBoundingClientRect()
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    )
    this.raycaster.setFromCamera(ndc, this.camera)
    const hits = this.raycaster.intersectObject(this.mesh, false)
    const hit = hits[0]
    if (!hit || hit.faceIndex === undefined || hit.faceIndex === null) return null
    const index = (this.mesh.geometry as THREE.BufferGeometry).getIndex()!
    const f = hit.faceIndex * 3
    return [index.getX(f), index.getX(f + 1), index.getX(f + 2)]
  }

  applyRegion(elementId: number, colorHex: string, region: Uint32Array): void {
    if (!this.colorAttr || !this.owner) return
    this.clearElement(elementId)
    const c = new THREE.Color(colorHex)
    const rgb: [number, number, number] = [
      Math.round(c.r * 255),
      Math.round(c.g * 255),
      Math.round(c.b * 255),
    ]
    this.elementColors.set(elementId, rgb)
    const arr = this.colorAttr.array as Uint8Array
    for (let i = 0; i < region.length; i++) {
      const v = region[i]
      this.owner[v] = elementId
      arr[v * 3] = rgb[0]
      arr[v * 3 + 1] = rgb[1]
      arr[v * 3 + 2] = rgb[2]
    }
    this.paintPreview(arr)
    this.colorAttr.needsUpdate = true
  }

  clearElement(elementId: number): void {
    if (!this.colorAttr || !this.owner) return
    this.elementColors.delete(elementId)
    const arr = this.colorAttr.array as Uint8Array
    for (let v = 0; v < this.owner.length; v++) {
      if (this.owner[v] !== elementId) continue
      this.owner[v] = 0
      arr[v * 3] = BASE_COLOR[0]
      arr[v * 3 + 1] = BASE_COLOR[1]
      arr[v * 3 + 2] = BASE_COLOR[2]
    }
    this.paintPreview(arr)
    this.colorAttr.needsUpdate = true
  }

  clearAllRegions(): void {
    if (!this.colorAttr || !this.owner) return
    this.owner.fill(0)
    this.elementColors.clear()
    this.previewRegion = null
    const arr = this.colorAttr.array as Uint8Array
    for (let v = 0; v < this.owner.length; v++) {
      arr[v * 3] = BASE_COLOR[0]
      arr[v * 3 + 1] = BASE_COLOR[1]
      arr[v * 3 + 2] = BASE_COLOR[2]
    }
    this.colorAttr.needsUpdate = true
  }

  /** Tint the surfaces a pending fit is using, in the colour the element will
   *  get once it is created. Unlike applyRegion this takes no ownership, so
   *  lifting the preview restores whatever was underneath. */
  setPreviewRegion(region: Uint32Array | null, colorHex?: string): void {
    if (!this.colorAttr || !this.owner) return
    if (colorHex) {
      const c = new THREE.Color(colorHex)
      this.previewRgb = [Math.round(c.r * 255), Math.round(c.g * 255), Math.round(c.b * 255)]
    }
    const arr = this.colorAttr.array as Uint8Array
    if (this.previewRegion) {
      for (let i = 0; i < this.previewRegion.length; i++) {
        const v = this.previewRegion[i]
        const c = this.elementColors.get(this.owner[v]) ?? BASE_COLOR
        arr[v * 3] = c[0]
        arr[v * 3 + 1] = c[1]
        arr[v * 3 + 2] = c[2]
      }
    }
    this.previewRegion = region
    this.paintPreview(arr)
    this.colorAttr.needsUpdate = true
  }

  private paintPreview(arr: Uint8Array): void {
    if (!this.previewRegion) return
    for (let i = 0; i < this.previewRegion.length; i++) {
      const v = this.previewRegion[i]
      arr[v * 3] = this.previewRgb[0]
      arr[v * 3 + 1] = this.previewRgb[1]
      arr[v * 3 + 2] = this.previewRgb[2]
    }
  }

  /** Translucent ghost of the sphere a pending fit produced. */
  setPreviewSphere(center: [number, number, number] | null, radius = 1): void {
    if (!center) {
      if (this.previewSphere) {
        this.previewGroup.remove(this.previewSphere)
        ;(this.previewSphere.material as THREE.Material).dispose()
        this.previewSphere = null
      }
      return
    }
    if (!this.previewSphere) {
      const mat = new THREE.MeshStandardMaterial({
        color: PREVIEW_SPHERE_COLOR,
        transparent: true,
        opacity: 0.4,
        depthWrite: false,
        roughness: 0.4,
        metalness: 0,
        side: THREE.DoubleSide,
      })
      this.previewSphere = new THREE.Mesh(this.unitSphere, mat)
      this.previewGroup.add(this.previewSphere)
    }
    this.previewSphere.position.set(...center)
    this.previewSphere.scale.setScalar(Math.max(radius, 1e-5))
  }

  updateOverlays(elements: OverlayElement[], pairs: OverlayPair[], visible: boolean): void {
    for (const fn of this.overlayCleanup) fn()
    this.overlayCleanup = []
    this.overlayGroup.clear()
    this.overlayGroup.visible = visible
    if (!visible) return

    for (const el of elements) {
      // The fitted sphere itself stays on screen — translucent and without
      // depth writes so the scan surface, centre marker and distance lines
      // stay readable through it.
      const shell = new THREE.MeshStandardMaterial({
        color: el.color,
        transparent: true,
        opacity: 0.3,
        depthWrite: false,
        roughness: 0.4,
        metalness: 0,
        side: THREE.DoubleSide,
      })
      const sphere = new THREE.Mesh(this.unitSphere, shell)
      sphere.position.set(...el.center)
      sphere.scale.setScalar(Math.max(el.radius, 1e-5))
      this.overlayGroup.add(sphere)
      this.overlayCleanup.push(() => shell.dispose())

      const dotMat = new THREE.MeshBasicMaterial({ color: el.color })
      const marker = new THREE.Mesh(this.unitSphere, dotMat)
      marker.position.set(...el.center)
      marker.scale.setScalar(Math.max(el.radius * 0.07, 1e-4))
      this.overlayGroup.add(marker)
      this.overlayCleanup.push(() => dotMat.dispose())

      const label = pinLabel(
        'element-label',
        el.name,
        `Ø ${(el.radius * 2).toFixed(3)} mm`,
        el.color,
      )
      label.position.set(el.center[0], el.center[1] + el.radius * 1.35, el.center[2])
      this.overlayGroup.add(label)
      this.overlayCleanup.push(() => label.element.remove())
    }

    for (const p of pairs) {
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(...p.a),
        new THREE.Vector3(...p.b),
      ])
      const mat = new THREE.LineBasicMaterial({ color: 0xdfe3ea, transparent: true, opacity: 0.85 })
      this.overlayGroup.add(new THREE.Line(geo, mat))
      this.overlayCleanup.push(() => {
        geo.dispose()
        mat.dispose()
      })

      const label = pinLabel('distance-label', p.title, p.value)
      label.position.set((p.a[0] + p.b[0]) / 2, (p.a[1] + p.b[1]) / 2, (p.a[2] + p.b[2]) / 2)
      this.overlayGroup.add(label)
      this.overlayCleanup.push(() => label.element.remove())
    }
  }

  private disposeMesh(): void {
    if (!this.mesh) return
    const geometry = this.mesh.geometry as THREE.BufferGeometry
    geometry.disposeBoundsTree?.()
    geometry.dispose()
    ;(this.mesh.material as THREE.Material).dispose()
    this.scene.remove(this.mesh)
    this.mesh = null
    this.colorAttr = null
    this.owner = null
    this.elementColors.clear()
    this.previewRegion = null
  }

  private resize(): void {
    const w = this.container.clientWidth || 1
    const h = this.container.clientHeight || 1
    this.renderer.setSize(w, h)
    this.labelRenderer.setSize(w, h)
    this.applyFrustum()
    // TrackballControls maps pointer positions through a cached screen rect.
    this.controls.handleResize()
  }

  dispose(): void {
    cancelAnimationFrame(this.rafId)
    this.resizeObserver.disconnect()
    this.updateOverlays([], [], false)
    this.setPreviewSphere(null)
    for (const d of this.gizmoDisposables) d.dispose()
    this.unitSphere.dispose()
    this.disposeMesh()
    this.controls.dispose()
    this.renderer.dispose()
    this.container.innerHTML = ''
  }
}
