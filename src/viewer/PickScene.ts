// SPDX-License-Identifier: AGPL-3.0-only
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js'
import type { Vec3 } from '../core/types'
import type { ControlScheme } from './navSchemes'
import { OrthoNavigator } from './orthoNav'

const STAGE_BG = 0xd7d5cf
const PART_COLOR = 0x848a92

/** A point picked on the scan while setting up an alignment. */
export interface PickMarker {
  point: Vec3
  label: string
  color: string
}

/**
 * One half of the split-screen point picker: a part, freely rotatable, that
 * reports where it was clicked.
 *
 * The two halves keep independent cameras. Linking them would only help once
 * the parts are already roughly aligned, which is exactly the situation in
 * which nobody needs to pick points by hand — when this view is open the scan
 * is in some arbitrary pose and each side has to be turned to its own feature.
 *
 * The geometry is borrowed, never owned: the scan is a million-triangle mesh
 * with a BVH already built for it in the main viewport, and three.js keeps GPU
 * state per renderer, so the same BufferGeometry can be drawn and raycast in a
 * second canvas at no cost. Disposing it here would destroy the main view.
 */
export class PickScene {
  private renderer: THREE.WebGLRenderer
  private labelRenderer: CSS2DRenderer
  private scene = new THREE.Scene()
  private camera: THREE.OrthographicCamera
  /** Owns the target and the per-frame lookAt only — the navigator drives the
   *  camera, so the same buttons work here as in the main viewport. */
  private controls: OrbitControls
  private nav: OrthoNavigator
  private clipSphere = { center: new THREE.Vector3(), radius: 1 }
  private keyLight: THREE.DirectionalLight
  private material: THREE.MeshStandardMaterial
  private mesh: THREE.Mesh
  private markerGroup = new THREE.Group()
  private markerGeometry: THREE.SphereGeometry
  private markerCleanup: (() => void)[] = []
  private markerRadius: number
  private raycaster = new THREE.Raycaster()
  private fitExtent = { halfW: 1, halfH: 1 }
  private resizeObserver: ResizeObserver
  private rafId = 0
  private pointerDown: { x: number; y: number } | null = null
  /** Render-on-demand: the rAF loop keeps ticking (the early-out is nearly
   *  free) but the scene is only drawn on frames something marked. A missed
   *  mark shows as a stale image, so every path that could change what is on
   *  screen calls invalidate — an extra repaint costs nothing. */
  private needsRender = true

  private invalidate = (): void => {
    this.needsRender = true
  }

  onPick: ((point: Vec3) => void) | null = null

  constructor(private container: HTMLDivElement, geometry: THREE.BufferGeometry) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.container.appendChild(this.renderer.domElement)

    this.labelRenderer = new CSS2DRenderer()
    const labelDom = this.labelRenderer.domElement
    labelDom.style.position = 'absolute'
    labelDom.style.top = '0'
    labelDom.style.left = '0'
    labelDom.style.pointerEvents = 'none'
    this.container.appendChild(labelDom)

    this.scene.background = new THREE.Color(STAGE_BG)
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 4000)
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xb9b6ae, 1.0))
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.35))
    this.keyLight = new THREE.DirectionalLight(0xffffff, 1.5)
    this.scene.add(this.keyLight)
    this.scene.add(this.keyLight.target)
    this.scene.add(this.markerGroup)

    // Flat colour, not the scan's vertex colours: in this view both parts have
    // to look like the same kind of object, so the eye is comparing shapes and
    // not a coloured map against a plain grey reference.
    this.material = new THREE.MeshStandardMaterial({
      color: PART_COLOR,
      roughness: 0.62,
      metalness: 0.05,
      side: THREE.DoubleSide,
      vertexColors: false,
    })
    this.mesh = new THREE.Mesh(geometry, this.material)
    this.scene.add(this.mesh)

    if (!geometry.boundingBox) geometry.computeBoundingBox()
    const box = geometry.boundingBox!
    const diagonal = box.min.distanceTo(box.max)
    this.markerRadius = Math.max(diagonal * 0.011, 1e-4)
    this.markerGeometry = new THREE.SphereGeometry(1, 20, 14)

    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableRotate = false
    this.controls.enableZoom = false
    this.controls.enablePan = false
    this.controls.minPolarAngle = 0
    this.controls.maxPolarAngle = Math.PI
    this.nav = new OrthoNavigator(
      this.camera,
      this.controls,
      this.renderer.domElement,
      () => [this.mesh],
      this.clipSphere,
    )
    this.scene.add(this.nav.pivotMarker)
    // The navigator says when a gesture changed the view; the controls'
    // 'change' event is the safety net behind it, fired by update() whenever
    // the camera turns out to have moved since the last frame.
    this.nav.onChange = this.invalidate
    this.controls.addEventListener('change', this.invalidate)

    const rc = this.raycaster as THREE.Raycaster & { firstHitOnly?: boolean }
    rc.firstHitOnly = true

    this.renderer.domElement.addEventListener('pointerdown', (e) => {
      if (e.button === 0) this.pointerDown = { x: e.clientX, y: e.clientY }
    })
    this.renderer.domElement.addEventListener('pointerup', (e) => {
      const down = this.pointerDown
      this.pointerDown = null
      if (!down || e.button !== 0) return
      // A drag is a rotation, not a pick.
      if (Math.abs(e.clientX - down.x) + Math.abs(e.clientY - down.y) > 6) return
      const point = this.pick(e.clientX, e.clientY)
      if (point) this.onPick?.(point)
    })

    this.frameCamera(box)
    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(this.container)
    this.resize()

    const animate = (): void => {
      this.rafId = requestAnimationFrame(animate)
      // These run every tick, rendered or not: the clip planes track the
      // camera (and let the navigator drop its cached canvas rect), and
      // update() is what notices camera motion and fires 'change'.
      this.nav.updateClipPlanes()
      this.controls.update()
      if (!this.needsRender) return
      this.needsRender = false
      this.keyLight.position.copy(this.camera.position)
      this.keyLight.target.position.copy(this.controls.target)
      this.renderer.render(this.scene, this.camera)
      this.labelRenderer.render(this.scene, this.camera)
    }
    animate()
  }

  private frameCamera(box: THREE.Box3): void {
    const center = box.getCenter(new THREE.Vector3())
    const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1e-3)
    const dir = new THREE.Vector3(0.62, 0.42, 1).normalize()
    this.camera.up.set(0, 1, 0)
    this.controls.target.copy(center)
    const dist = radius * 4 + 1
    this.camera.position.copy(center).addScaledVector(dir, dist)
    this.camera.zoom = 1
    // The clip planes are re-derived per frame from here, because orbiting
    // about the cursor moves the camera off any distance fixed now.
    this.clipSphere.center.copy(center)
    this.clipSphere.radius = radius
    this.camera.lookAt(center)
    this.camera.updateMatrixWorld(true)

    const toCamera = new THREE.Matrix4().copy(this.camera.matrixWorld).invert()
    const corner = new THREE.Vector3()
    let halfW = 1e-3
    let halfH = 1e-3
    for (let i = 0; i < 8; i++) {
      corner
        .set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z)
        .applyMatrix4(toCamera)
      halfW = Math.max(halfW, Math.abs(corner.x))
      halfH = Math.max(halfH, Math.abs(corner.y))
    }
    this.fitExtent = { halfW: halfW * 1.1, halfH: halfH * 1.1 }
    this.applyFrustum()
    this.controls.update()
  }

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

  /** Match the main viewport's buttons: a pose picked here is checked against
   *  the model there, so the two must not navigate differently. */
  setNavScheme(scheme: ControlScheme): void {
    this.nav.setScheme(scheme)
    this.invalidate()
  }

  private pick(clientX: number, clientY: number): Vec3 | null {
    this.nav.setPickRay(this.raycaster, clientX, clientY)
    const hit = this.raycaster.intersectObject(this.mesh, false)[0]
    return hit ? [hit.point.x, hit.point.y, hit.point.z] : null
  }

  setMarkers(markers: PickMarker[]): void {
    for (const dispose of this.markerCleanup) dispose()
    this.markerCleanup = []
    this.markerGroup.clear()
    for (const m of markers) {
      const material = new THREE.MeshBasicMaterial({ color: m.color, depthTest: false })
      const sphere = new THREE.Mesh(this.markerGeometry, material)
      sphere.position.set(...m.point)
      sphere.scale.setScalar(this.markerRadius)
      sphere.renderOrder = 3
      this.markerGroup.add(sphere)

      const div = document.createElement('div')
      div.className = 'pick-pin'
      div.textContent = m.label
      div.style.background = m.color
      const label = new CSS2DObject(div)
      label.position.set(...m.point)
      this.markerGroup.add(label)

      this.markerCleanup.push(() => {
        material.dispose()
        div.remove()
      })
    }
    this.invalidate()
  }

  private resize(): void {
    const w = this.container.clientWidth || 1
    const h = this.container.clientHeight || 1
    this.renderer.setSize(w, h)
    this.labelRenderer.setSize(w, h)
    this.applyFrustum()
    this.invalidate()
  }

  dispose(): void {
    cancelAnimationFrame(this.rafId)
    this.resizeObserver.disconnect()
    this.setMarkers([])
    this.markerGeometry.dispose()
    this.material.dispose()
    this.nav.dispose()
    this.controls.dispose()
    this.renderer.dispose()
    this.container.innerHTML = ''
  }
}
