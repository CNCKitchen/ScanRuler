import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
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
  label: string
}

/** Owns the Three.js scene: mesh display, BVH picking, per-vertex region
 *  tinting, and the center-marker / distance-line overlays. */
export class SceneManager {
  private renderer: THREE.WebGLRenderer
  private labelRenderer: CSS2DRenderer
  private scene = new THREE.Scene()
  private camera: THREE.PerspectiveCamera
  private controls: OrbitControls
  private keyLight: THREE.DirectionalLight
  private overlayGroup = new THREE.Group()
  private overlayCleanup: (() => void)[] = []
  private raycaster = new THREE.Raycaster()
  private mesh: THREE.Mesh | null = null
  private colorAttr: THREE.BufferAttribute | null = null
  private owner: Int32Array | null = null
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
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000)
    this.camera.position.set(120, 80, 120)

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x585d68, 1.25))
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.55))
    this.keyLight = new THREE.DirectionalLight(0xffffff, 1.5)
    this.scene.add(this.keyLight)
    this.scene.add(this.keyLight.target)
    this.scene.add(this.overlayGroup)

    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.12

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
      this.controls.update()
      this.keyLight.position.copy(this.camera.position)
      this.keyLight.target.position.copy(this.controls.target)
      this.renderer.render(this.scene, this.camera)
      this.labelRenderer.render(this.scene, this.camera)
    }
    animate()
  }

  /** Replace the displayed mesh. Synchronous and heavy (includes the BVH
   *  build) — callers should show a status message and yield a frame first. */
  setMesh(positions: Float32Array, indices: Uint32Array, normals: Float32Array): void {
    this.disposeMesh()

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

    this.frameCamera(geometry.boundingSphere!, principalAxis(positions))
    geometry.computeBoundsTree()
  }

  private frameCamera(bs: THREE.Sphere, axis: THREE.Vector3): void {
    const r = Math.max(bs.radius, 1e-3)
    this.controls.target.copy(bs.center)
    // View the model broadside: perpendicular to its longest axis, slightly
    // elevated — an end-on view would hide most of an elongated part.
    const helper = Math.abs(axis.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)
    const side = new THREE.Vector3().crossVectors(axis, helper).normalize()
    const up = new THREE.Vector3().crossVectors(side, axis).normalize()
    if (up.y < 0) up.negate()
    const dir = side.clone().addScaledVector(up, 0.45).normalize()
    // Screen-up perpendicular to the long axis lays the part horizontally.
    this.camera.up.copy(up)
    // Distance so the bounding sphere fits the narrower of the two FOVs.
    const vFov = THREE.MathUtils.degToRad(this.camera.fov)
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this.camera.aspect)
    const dist = (r / Math.sin(Math.min(vFov, hFov) / 2)) * 1.12
    this.camera.position.copy(bs.center).addScaledVector(dir, dist)
    this.camera.near = r / 100
    this.camera.far = dist + r * 20
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

  /** First fitted element owning one of the given vertices (0 = none). */
  ownerOfAny(verts: [number, number, number]): number {
    if (!this.owner) return 0
    for (const v of verts) if (this.owner[v] !== 0) return this.owner[v]
    return 0
  }

  applyRegion(elementId: number, colorHex: string, region: Uint32Array): void {
    if (!this.colorAttr || !this.owner) return
    this.clearElement(elementId)
    const c = new THREE.Color(colorHex)
    const r = Math.round(c.r * 255)
    const g = Math.round(c.g * 255)
    const b = Math.round(c.b * 255)
    const arr = this.colorAttr.array as Uint8Array
    for (let i = 0; i < region.length; i++) {
      const v = region[i]
      this.owner[v] = elementId
      arr[v * 3] = r
      arr[v * 3 + 1] = g
      arr[v * 3 + 2] = b
    }
    this.colorAttr.needsUpdate = true
  }

  clearElement(elementId: number): void {
    if (!this.colorAttr || !this.owner) return
    const arr = this.colorAttr.array as Uint8Array
    for (let v = 0; v < this.owner.length; v++) {
      if (this.owner[v] !== elementId) continue
      this.owner[v] = 0
      arr[v * 3] = BASE_COLOR[0]
      arr[v * 3 + 1] = BASE_COLOR[1]
      arr[v * 3 + 2] = BASE_COLOR[2]
    }
    this.colorAttr.needsUpdate = true
  }

  clearAllRegions(): void {
    if (!this.colorAttr || !this.owner) return
    this.owner.fill(0)
    const arr = this.colorAttr.array as Uint8Array
    for (let v = 0; v < this.owner.length; v++) {
      arr[v * 3] = BASE_COLOR[0]
      arr[v * 3 + 1] = BASE_COLOR[1]
      arr[v * 3 + 2] = BASE_COLOR[2]
    }
    this.colorAttr.needsUpdate = true
  }

  updateOverlays(elements: OverlayElement[], pairs: OverlayPair[], visible: boolean): void {
    for (const fn of this.overlayCleanup) fn()
    this.overlayCleanup = []
    this.overlayGroup.clear()
    this.overlayGroup.visible = visible
    if (!visible) return

    for (const el of elements) {
      const geo = new THREE.SphereGeometry(Math.max(el.radius * 0.07, 1e-4), 16, 12)
      const mat = new THREE.MeshBasicMaterial({ color: el.color })
      const marker = new THREE.Mesh(geo, mat)
      marker.position.set(...el.center)
      this.overlayGroup.add(marker)
      this.overlayCleanup.push(() => {
        geo.dispose()
        mat.dispose()
      })

      const div = document.createElement('div')
      div.className = 'viewport-label element-label'
      div.textContent = el.name
      const label = new CSS2DObject(div)
      label.position.set(el.center[0], el.center[1] + el.radius * 1.25, el.center[2])
      this.overlayGroup.add(label)
      this.overlayCleanup.push(() => div.remove())
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

      const div = document.createElement('div')
      div.className = 'viewport-label distance-label'
      div.textContent = p.label
      const label = new CSS2DObject(div)
      label.position.set((p.a[0] + p.b[0]) / 2, (p.a[1] + p.b[1]) / 2, (p.a[2] + p.b[2]) / 2)
      this.overlayGroup.add(label)
      this.overlayCleanup.push(() => div.remove())
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
  }

  private resize(): void {
    const w = this.container.clientWidth || 1
    const h = this.container.clientHeight || 1
    this.renderer.setSize(w, h)
    this.labelRenderer.setSize(w, h)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  dispose(): void {
    cancelAnimationFrame(this.rafId)
    this.resizeObserver.disconnect()
    this.updateOverlays([], [], false)
    this.disposeMesh()
    this.controls.dispose()
    this.renderer.dispose()
    this.container.innerHTML = ''
  }
}
