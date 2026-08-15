// SPDX-License-Identifier: AGPL-3.0-only
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js'
import type { ControlScheme } from './navSchemes'
import { OrthoNavigator } from './orthoNav'
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh'
import type { FitData, Vec3 } from '../core/types'
import { rigidApplyToPoints, rigidRotateVectors, type Rigid } from '../core/deviation/rigid'
import { UNMEASURED_RGB } from '../core/field/colormap'

declare module 'three' {
  interface BufferGeometry {
    computeBoundsTree: typeof computeBoundsTree
    disposeBoundsTree: typeof disposeBoundsTree
  }
}

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree
THREE.Mesh.prototype.raycast = acceleratedRaycast

/** Chassis gray, matching --chassis-adjacent `.stage` in the stylesheet — the
 *  canvas has to sit in the instrument, not on top of it. */
const STAGE_BG = 0xdedcd6

/** Unmeasured scan surface: a machined-aluminium grey. Dark enough that a
 *  brightly lit face still reads as material against the pale stage, quiet
 *  enough to leave the element colours all the contrast. Shared with the
 *  deviation map, where it marks surface the search distance never matched —
 *  the same meaning, that nothing has been measured here. */
const BASE_COLOR: [number, number, number] = [
  UNMEASURED_RGB[0],
  UNMEASURED_RGB[1],
  UNMEASURED_RGB[2],
]

/** The reference part: a translucent blue ghost the scan reads through. Blue
 *  rather than another grey, because for most of its life it is overlaid on a
 *  grey scan of very nearly the same shape, and two greys in the same place
 *  read as one washed-out object rather than as two parts being compared. */
const NOMINAL_COLOR = 0x5c86bd

/** The ghost shape of an unconfirmed fit is neutral grey — only the marked
 *  surfaces carry the colour the element will get, so "picked" and "measured"
 *  never look the same. */
const PREVIEW_SHAPE_COLOR = 0x8e9298

const GIZMO_AXES: [THREE.Vector3, number, string][] = [
  [new THREE.Vector3(1, 0, 0), 0xe5534b, 'X'],
  [new THREE.Vector3(0, 1, 0), 0x2e7d46, 'Y'],
  [new THREE.Vector3(0, 0, 1), 0x1877c0, 'Z'],
]

/** Canvas-textured letter for an axis tip. */
function axisLabel(text: string, color: number): THREE.Sprite {
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 64
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#' + color.toString(16).padStart(6, '0')
  ctx.font = 'bold 46px Barlow, system-ui, sans-serif'
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
  fit: FitData
}

export interface OverlayPair {
  a: Vec3
  b: Vec3
  title: string
  value: string
}

/** An angle dimension in the viewport: two rays from a vertex and the arc
 *  between them, labelled with the value. */
export interface OverlayAngle {
  vertex: Vec3
  dirA: Vec3
  dirB: Vec3
  title: string
  value: string
}

/** Where a ray met the scan. The barycentric weights come along so a caller
 *  holding a per-vertex field — the deviation map — can read its value at the
 *  exact point clicked rather than at the nearest vertex. */
export interface PickHit {
  vertices: [number, number, number]
  weights: [number, number, number]
  point: Vec3
  /** Cursor position that produced the hit, so a readout can follow it. */
  clientX: number
  clientY: number
}

/** A deviation reading pinned to the part. */
export interface ProbeMarker {
  id: number
  point: Vec3
  label: string
  color: string
}

/** A point picked on the scan while setting up an alignment. */
export interface PickMarker {
  point: Vec3
  label: string
  color: string
}

/** A pin in the 3D view: what it marks on top, the measured value under it, so
 *  the numbers can be read off the model without going back to the panel. An
 *  empty value leaves just the name — nothing is not a number. */
function pinLabel(kind: string, title: string, value: string, titleColor?: string): CSS2DObject {
  const div = document.createElement('div')
  div.className = `viewport-label ${kind}`
  const t = document.createElement('div')
  t.className = 'label-title'
  t.textContent = title
  if (titleColor) t.style.color = titleColor
  div.append(t)
  if (value) {
    const v = document.createElement('div')
    v.className = 'label-value'
    v.textContent = value
    div.append(v)
  }
  return new CSS2DObject(div)
}

/** What an element's viewport pin says under its name: the diameter where
 *  there is one, nothing otherwise — sigma and coordinates stay in the panel. */
function pinValue(fit: FitData): string {
  if (fit.kind === 'sphere' || fit.kind === 'cylinder') return `Ø ${(fit.radius * 2).toFixed(3)} mm`
  return ''
}

/** Owns the Three.js scene: mesh display, BVH picking, per-vertex region
 *  tinting, the fitted-sphere / distance-line overlays, and the translucent
 *  preview of a fit the user has not confirmed yet. */
export class SceneManager {
  private renderer: THREE.WebGLRenderer
  private labelRenderer: CSS2DRenderer
  private scene = new THREE.Scene()
  private camera: THREE.OrthographicCamera
  /** Only the target and the per-frame lookAt: rotation, pan and zoom are all
   *  driven by hand from the active control scheme (see the navigation
   *  section), because which button does what is not OrbitControls' to decide. */
  private controls: OrbitControls
  private keyLight: THREE.DirectionalLight
  /** Orientation gizmo, drawn into a corner viewport of the same canvas. */
  private gizmoScene = new THREE.Scene()
  private gizmoCamera = new THREE.OrthographicCamera(-1.75, 1.75, 1.75, -1.75, 0.1, 12)
  private gizmoDisposables: { dispose(): void }[] = []
  /**
   * Everything that lives in the scan's own coordinates: the scan itself, the
   * fitted elements, the pending preview and any pinned readings.
   *
   * The alignment is carried here, on the group, because the reference is the
   * datum — a nominal part is the thing a measurement is *against*, so it does
   * not move. Moving the scan means moving everything measured on it too, and
   * a group is what keeps a fitted sphere on the ball it was fitted to.
   */
  private partGroup = new THREE.Group()
  private overlayGroup = new THREE.Group()
  private previewGroup = new THREE.Group()
  private probeGroup = new THREE.Group()
  private overlayCleanup: (() => void)[] = []
  private raycaster = new THREE.Raycaster()
  private mesh: THREE.Mesh | null = null
  private colorAttr: THREE.BufferAttribute | null = null
  private owner: Int32Array | null = null
  /** Colour each element paints its region with, so a preview can be lifted
   *  off again without repainting the whole mesh. */
  private elementColors = new Map<number, [number, number, number]>()
  /** Elements whose surface tint is switched off. Ownership stays recorded,
   *  so showing one again is a repaint, not a re-fit. */
  private hiddenRegions = new Set<number>()
  private previewRegion: Uint32Array | null = null
  private previewRgb: [number, number, number] = [255, 255, 255]
  private previewShape: THREE.Mesh | null = null
  private nominalMesh: THREE.Mesh | null = null
  /** When set, the scan wears the deviation map and element painting is held
   *  in reserve — the owner/colour bookkeeping stays live underneath, so
   *  switching back restores the measured elements without re-fitting. */
  private fieldColors: Uint8Array | null = null
  /** Skips rendering entirely while the viewport is hidden behind the
   *  split-screen picker; the mesh and its BVH stay loaded. */
  private paused = false
  private unitSphere = new THREE.SphereGeometry(1, 48, 32)
  /** Open-ended so the scan surface stays visible through the tube. */
  private unitCylinder = new THREE.CylinderGeometry(1, 1, 1, 64, 1, true)
  private unitPlane = new THREE.PlaneGeometry(1, 1)
  /** Half-extents of the model on the screen plane at the framing camera
   *  orientation; the frustum is rebuilt from these on every resize so the
   *  user's zoom survives. */
  private fitExtent = { halfW: 1, halfH: 1 }
  /** Long axis of the scan, kept so the camera can be re-framed later without
   *  walking the vertices again. */
  private scanAxis = new THREE.Vector3(1, 0, 0)
  private rafId = 0
  private resizeObserver: ResizeObserver
  private pointerDown: { x: number; y: number } | null = null

  /** Orbit / pan / zoom, bound to whichever CAD tool's buttons the user picked. */
  private nav: OrthoNavigator
  /** Sphere enclosing everything drawn, handed to the navigator by reference so
   *  re-framing a new model just writes to it. */
  private clipSphere = { center: new THREE.Vector3(), radius: 1 }

  private probeCleanup: (() => void)[] = []
  private probeGeometry = new THREE.SphereGeometry(1, 18, 12)
  private pickMarkerGroup = new THREE.Group()
  private pickMarkerCleanup: (() => void)[] = []
  private modelRadius = 1
  /** Last cursor position, and whether it has been raycast yet. Hover testing
   *  happens once per frame rather than once per pointermove: a mouse can emit
   *  hundreds of moves a second and only the latest one is on screen. */
  private hoverAt: { x: number; y: number } | null = null
  private hoverDirty = false
  private hoverEnabled = false
  private hoverWasHit = false
  /** While on, a click resolves to the element under the cursor (overlay
   *  shape or painted region) before falling back to a plain surface pick. */
  private elementPickEnabled = false
  /** Overlay meshes that can stand in for their element in a click, and the
   *  materials to restyle when that element is selected. */
  private overlayPickables: THREE.Mesh[] = []
  private shellMaterials = new Map<number, { material: THREE.MeshStandardMaterial; color: string }>()
  private highlightIds = new Set<number>()
  /** White selection strokes, rebuilt whenever the selection or the overlays
   *  change. Kept beside the overlays so clearing one never orphans the other. */
  private selectionGroup = new THREE.Group()
  private selectionCleanup: (() => void)[] = []
  private lastOverlayElements: OverlayElement[] = []

  onPick: ((hit: PickHit) => void) | null = null
  onHover: ((hit: PickHit | null) => void) | null = null
  onElementPick: ((id: number) => void) | null = null

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

    this.scene.background = new THREE.Color(STAGE_BG)
    // Parallel projection: metrology views should not foreshorten, and equal
    // features must read the same size wherever they sit in the frame.
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 4000)
    this.camera.position.set(0, 0, 100)

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xb9b6ae, 1.0))
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.35))
    this.keyLight = new THREE.DirectionalLight(0xffffff, 1.6)
    this.scene.add(this.keyLight)
    this.scene.add(this.keyLight.target)
    this.partGroup.matrixAutoUpdate = false
    this.partGroup.add(this.overlayGroup)
    this.partGroup.add(this.selectionGroup)
    this.partGroup.add(this.previewGroup)
    this.partGroup.add(this.probeGroup)
    this.partGroup.add(this.pickMarkerGroup)
    this.scene.add(this.partGroup)

    // OrbitControls owns the target and the per-frame lookAt, nothing else:
    // its own rotate/pan/zoom are off because the control scheme decides which
    // buttons do what, and because orbiting has to happen about the point
    // under the cursor rather than about a fixed target.
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableRotate = false
    this.controls.enableZoom = false
    this.controls.enablePan = false
    // The free orbit below never lands on a pole (it rotates about the
    // camera's own axes and carries `up` with it), so nothing needs clamping.
    this.controls.minPolarAngle = 0
    this.controls.maxPolarAngle = Math.PI

    // An orbit pivots on whichever part is actually on screen: in the deviation
    // workspace the scan can be hidden behind the reference, or the other way
    // round, and turning about a surface nobody can see reads as a glitch.
    this.nav = new OrthoNavigator(
      this.camera,
      this.controls,
      this.renderer.domElement,
      () => {
        const targets: THREE.Object3D[] = []
        if (this.mesh?.visible) targets.push(this.mesh)
        if (this.nominalMesh?.visible) targets.push(this.nominalMesh)
        return targets
      },
      this.clipSphere,
    )
    this.scene.add(this.nav.pivotMarker)

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
      if (this.elementPickEnabled) {
        const id = this.elementAt(e.clientX, e.clientY)
        if (id !== null) {
          this.onElementPick?.(id)
          return
        }
      }
      const hit = this.pick(e.clientX, e.clientY)
      if (hit) this.onPick?.(hit)
    })

    this.renderer.domElement.addEventListener('pointermove', (e) => {
      this.hoverAt = { x: e.clientX, y: e.clientY }
      this.hoverDirty = true
    })
    this.renderer.domElement.addEventListener('pointerleave', () => {
      this.hoverAt = null
      this.hoverDirty = true
    })

    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(this.container)
    this.resize()

    const animate = () => {
      this.rafId = requestAnimationFrame(animate)
      if (this.paused) return
      const w = this.container.clientWidth || 1
      const h = this.container.clientHeight || 1
      this.nav.updateClipPlanes()
      this.controls.update()
      this.updateHover()
      this.keyLight.position.copy(this.camera.position)
      this.keyLight.target.position.copy(this.controls.target)
      this.renderer.setViewport(0, 0, w, h)
      this.renderer.render(this.scene, this.camera)
      this.renderGizmo(w, h)
      this.labelRenderer.render(this.scene, this.camera)
    }
    animate()
  }

  /** Swap the pointer-button control scheme (dropdown in the status strip). */
  setNavScheme(scheme: ControlScheme): void {
    this.nav.setScheme(scheme)
  }

  /** One hover test per frame, and only when the answer could have changed. */
  private updateHover(): void {
    if (!this.hoverEnabled || !this.hoverDirty) return
    this.hoverDirty = false
    const at = this.hoverAt
    const hit = at ? this.pick(at.x, at.y) : null
    // Silence is worth reporting once, not every frame the cursor spends off
    // the part.
    if (!hit && !this.hoverWasHit) return
    this.hoverWasHit = hit !== null
    this.onHover?.(hit)
  }

  setHoverEnabled(enabled: boolean): void {
    if (this.hoverEnabled === enabled) return
    this.hoverEnabled = enabled
    this.hoverDirty = true
    if (!enabled && this.hoverWasHit) {
      this.hoverWasHit = false
      this.onHover?.(null)
    }
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
    this.setPreview(null)

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
    this.partGroup.add(this.mesh)
    // A new scan is not aligned to anything yet.
    this.setAlignment(null)
    this.owner = new Int32Array(vertexCount)

    this.modelRadius = Math.max(
      geometry.boundingBox!.min.distanceTo(geometry.boundingBox!.max) / 2,
      1e-4,
    )
    this.scanAxis = principalAxis(positions)
    this.frameCamera(geometry.boundingBox!, this.scanAxis)
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
    // The clip planes are re-derived per frame from here, because orbiting
    // about the cursor moves the camera off any distance fixed now.
    this.clipSphere.center.copy(center)
    this.clipSphere.radius = radius
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

  private setPickRay(clientX: number, clientY: number): void {
    this.nav.setPickRay(this.raycaster, clientX, clientY)
  }

  private pick(clientX: number, clientY: number): PickHit | null {
    if (!this.mesh) return null
    this.setPickRay(clientX, clientY)
    const hits = this.raycaster.intersectObject(this.mesh, false)
    const hit = hits[0]
    if (!hit || hit.faceIndex === undefined || hit.faceIndex === null) return null
    const index = (this.mesh.geometry as THREE.BufferGeometry).getIndex()!
    const f = hit.faceIndex * 3
    const vertices: [number, number, number] = [
      index.getX(f),
      index.getX(f + 1),
      index.getX(f + 2),
    ]
    // hit.point is in world space, which is the *reference's* frame once the
    // scan has been aligned. Everything a caller does with it — pinning a
    // reading, reading a per-vertex field — belongs to the scan, so hand back
    // scan coordinates.
    this.partGroup.updateWorldMatrix(true, false)
    const local = this.partGroup.worldToLocal(hit.point.clone())
    return {
      vertices,
      weights: this.barycentric(vertices, local),
      point: [local.x, local.y, local.z],
      clientX,
      clientY,
    }
  }

  /** Where a hit sits inside its triangle, as the three corner weights, so a
   *  per-vertex field can be read at the point rather than at a corner. */
  private barycentric(
    vertices: [number, number, number],
    p: THREE.Vector3,
  ): [number, number, number] {
    const pos = (this.mesh!.geometry as THREE.BufferGeometry).getAttribute(
      'position',
    ) as THREE.BufferAttribute
    const a = new THREE.Vector3().fromBufferAttribute(pos, vertices[0])
    const v0 = new THREE.Vector3().fromBufferAttribute(pos, vertices[1]).sub(a)
    const v1 = new THREE.Vector3().fromBufferAttribute(pos, vertices[2]).sub(a)
    const v2 = p.clone().sub(a)
    const d00 = v0.dot(v0)
    const d01 = v0.dot(v1)
    const d11 = v1.dot(v1)
    const d20 = v2.dot(v0)
    const d21 = v2.dot(v1)
    const denom = d00 * d11 - d01 * d01
    // A degenerate sliver has no interior to interpolate over; fall back to one
    // corner rather than dividing by nothing.
    if (Math.abs(denom) < 1e-20) return [1, 0, 0]
    const v = (d11 * d20 - d01 * d21) / denom
    const w = (d00 * d21 - d01 * d20) / denom
    return [1 - v - w, v, w]
  }

  setElementPickEnabled(enabled: boolean): void {
    this.elementPickEnabled = enabled
  }

  /** The element under the cursor: the nearest hit among the overlay shapes
   *  and the scan, where a scan hit counts as the element whose painted
   *  region it landed on. Null over bare scan or empty space. */
  private elementAt(clientX: number, clientY: number): number | null {
    this.setPickRay(clientX, clientY)
    const targets: THREE.Object3D[] = this.overlayGroup.visible ? [...this.overlayPickables] : []
    if (this.mesh?.visible) targets.push(this.mesh)
    const hits = this.raycaster.intersectObjects(targets, false)
    for (const hit of hits) {
      if (hit.object !== this.mesh) {
        const id = hit.object.userData.elementId
        if (typeof id === 'number') return id
        continue
      }
      // On the scan the element is the owner of the nearest triangle corner.
      // Bare scan ends the search: it occludes whatever is behind it.
      if (hit.faceIndex === undefined || hit.faceIndex === null || !this.owner) return null
      const index = (this.mesh.geometry as THREE.BufferGeometry).getIndex()!
      const f = hit.faceIndex * 3
      const vertices: [number, number, number] = [
        index.getX(f),
        index.getX(f + 1),
        index.getX(f + 2),
      ]
      this.partGroup.updateWorldMatrix(true, false)
      const weights = this.barycentric(vertices, this.partGroup.worldToLocal(hit.point.clone()))
      const nearest = weights.indexOf(Math.max(...weights))
      const owner = this.owner[vertices[nearest]]
      return owner > 0 && !this.hiddenRegions.has(owner) && this.elementColors.has(owner)
        ? owner
        : null
    }
    return null
  }

  /** Make the given elements read as selected: their translucent shells get
   *  denser, glow in their own colour, and wear a white stroke. */
  setHighlightedElements(ids: readonly number[]): void {
    this.highlightIds = new Set(ids)
    for (const [id, entry] of this.shellMaterials) this.applyHighlight(id, entry)
    this.rebuildSelectionOutlines()
  }

  private applyHighlight(id: number, entry: { material: THREE.MeshStandardMaterial; color: string }): void {
    const on = this.highlightIds.has(id)
    entry.material.opacity = on ? 0.55 : 0.3
    entry.material.emissive.set(on ? entry.color : 0x000000)
    entry.material.emissiveIntensity = 0.45
  }

  private rebuildSelectionOutlines(): void {
    for (const fn of this.selectionCleanup) fn()
    this.selectionCleanup = []
    this.selectionGroup.clear()
    if (!this.overlayGroup.visible) return
    for (const el of this.lastOverlayElements) {
      if (this.highlightIds.has(el.id)) this.addOutline(el.fit)
    }
  }

  /** The white stroke itself. Volumes get an inverted hull — the same shape
   *  grown by the stroke width, showing only its back faces, so a white rim
   *  stands out past the silhouette. A plane patch is flat and has no
   *  silhouette to grow, so it gets a white frame drawn around the patch,
   *  on top of everything, since the patch hugs the noisy scan surface. */
  private addOutline(fit: FitData): void {
    const t = this.modelRadius * 0.005

    if (fit.kind === 'plane') {
      const U = Math.max(fit.extentU, 1e-5)
      const V = Math.max(fit.extentV, 1e-5)
      const shape = new THREE.Shape()
      shape.moveTo(-(U + t), -(V + t))
      shape.lineTo(U + t, -(V + t))
      shape.lineTo(U + t, V + t)
      shape.lineTo(-(U + t), V + t)
      shape.closePath()
      const hole = new THREE.Path()
      hole.moveTo(-U, -V)
      hole.lineTo(U, -V)
      hole.lineTo(U, V)
      hole.lineTo(-U, V)
      hole.closePath()
      shape.holes.push(hole)
      const geo = new THREE.ShapeGeometry(shape)
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
        depthTest: false,
      })
      const mesh = new THREE.Mesh(geo, mat)
      mesh.quaternion.setFromRotationMatrix(
        new THREE.Matrix4().makeBasis(
          new THREE.Vector3(...fit.basisU),
          new THREE.Vector3(...fit.basisV),
          new THREE.Vector3(...fit.normal),
        ),
      )
      mesh.position.set(...fit.center)
      mesh.renderOrder = 3
      this.selectionGroup.add(mesh)
      this.selectionCleanup.push(() => {
        geo.dispose()
        mat.dispose()
      })
      return
    }

    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      side: THREE.BackSide,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    })
    const mesh = this.buildShape(fit, mat)
    if (fit.kind === 'sphere') {
      mesh.scale.setScalar(Math.max(fit.radius, 1e-5) + t)
    } else if (fit.kind === 'point') {
      mesh.scale.setScalar(Math.max(this.modelRadius * 0.012, 1e-5) + t)
    } else if (fit.kind === 'cylinder') {
      const r = Math.max(fit.radius, 1e-5) + t
      mesh.scale.set(r, Math.max(fit.length, 1e-5) + 2 * t, r)
    } else {
      const r = Math.max(this.modelRadius * 0.0035, 1e-5) + t
      mesh.scale.set(r, Math.max(fit.length * 1.05, 1e-5) + 2 * t, r)
    }
    this.selectionGroup.add(mesh)
    this.selectionCleanup.push(() => mat.dispose())
  }

  /** Pin deviation readings to the part. */
  setProbes(probes: ProbeMarker[]): void {
    for (const dispose of this.probeCleanup) dispose()
    this.probeCleanup = []
    this.probeGroup.clear()
    for (const probe of probes) {
      const material = new THREE.MeshBasicMaterial({ color: probe.color, depthTest: false })
      const dot = new THREE.Mesh(this.probeGeometry, material)
      dot.position.set(...probe.point)
      dot.scale.setScalar(this.modelRadius * 0.009)
      dot.renderOrder = 4
      this.probeGroup.add(dot)

      const label = pinLabel('probe', 'DEV', probe.label, probe.color)
      label.position.set(...probe.point)
      this.probeGroup.add(label)

      this.probeCleanup.push(() => {
        material.dispose()
        label.element.remove()
      })
    }
  }

  /** Mark the points picked for an alignment slot on the part, labelled with
   *  what they are for. They ride in the part's group like everything else
   *  measured on the scan. */
  setPickMarkers(markers: PickMarker[]): void {
    for (const dispose of this.pickMarkerCleanup) dispose()
    this.pickMarkerCleanup = []
    this.pickMarkerGroup.clear()
    for (const marker of markers) {
      const material = new THREE.MeshBasicMaterial({ color: marker.color, depthTest: false })
      const dot = new THREE.Mesh(this.probeGeometry, material)
      dot.position.set(...marker.point)
      dot.scale.setScalar(this.modelRadius * 0.009)
      dot.renderOrder = 4
      this.pickMarkerGroup.add(dot)

      const label = pinLabel('probe', marker.label, '', marker.color)
      label.position.set(...marker.point)
      this.pickMarkerGroup.add(label)

      this.pickMarkerCleanup.push(() => {
        material.dispose()
        label.element.remove()
      })
    }
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
    for (let i = 0; i < region.length; i++) this.owner[region[i]] = elementId
    // While a deviation map is on the surface it owns every vertex colour; the
    // ownership recorded above is enough to repaint on the way back. The same
    // goes for an element that is currently hidden.
    if (this.fieldColors || this.hiddenRegions.has(elementId)) return
    const arr = this.colorAttr.array as Uint8Array
    for (let i = 0; i < region.length; i++) {
      const v = region[i]
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
    this.hiddenRegions.delete(elementId)
    const arr = this.colorAttr.array as Uint8Array
    const paint = this.fieldColors === null
    for (let v = 0; v < this.owner.length; v++) {
      if (this.owner[v] !== elementId) continue
      this.owner[v] = 0
      if (!paint) continue
      arr[v * 3] = BASE_COLOR[0]
      arr[v * 3 + 1] = BASE_COLOR[1]
      arr[v * 3 + 2] = BASE_COLOR[2]
    }
    if (!paint) return
    this.paintPreview(arr)
    this.colorAttr.needsUpdate = true
  }

  clearAllRegions(): void {
    if (!this.colorAttr || !this.owner) return
    this.owner.fill(0)
    this.elementColors.clear()
    this.hiddenRegions.clear()
    this.previewRegion = null
    if (this.fieldColors) return
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
    if (!this.colorAttr || !this.owner || this.fieldColors) return
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

  /** Shell mesh of an element: a sphere, a tube along the axis, the measured
   *  patch of a plane, a small ball for a point, a thin rod for a line — in
   *  the pose the geometry reports. */
  private buildShape(fit: FitData, material: THREE.Material): THREE.Mesh {
    if (fit.kind === 'sphere') {
      const mesh = new THREE.Mesh(this.unitSphere, material)
      mesh.position.set(...fit.center)
      mesh.scale.setScalar(Math.max(fit.radius, 1e-5))
      return mesh
    }
    if (fit.kind === 'point') {
      const mesh = new THREE.Mesh(this.unitSphere, material)
      mesh.position.set(...fit.center)
      mesh.scale.setScalar(Math.max(this.modelRadius * 0.012, 1e-5))
      return mesh
    }
    if (fit.kind === 'line') {
      const mesh = new THREE.Mesh(this.unitCylinder, material)
      mesh.position.set(...fit.center)
      mesh.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3(...fit.dir).normalize(),
      )
      const r = Math.max(this.modelRadius * 0.0035, 1e-5)
      mesh.scale.set(r, Math.max(fit.length * 1.05, 1e-5), r)
      return mesh
    }
    if (fit.kind === 'cylinder') {
      const mesh = new THREE.Mesh(this.unitCylinder, material)
      mesh.position.set(...fit.center)
      mesh.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3(...fit.axis).normalize(),
      )
      const r = Math.max(fit.radius, 1e-5)
      mesh.scale.set(r, Math.max(fit.length, 1e-5), r)
      return mesh
    }
    const mesh = new THREE.Mesh(this.unitPlane, material)
    // The unit quad lies in XY, so its own axes are mapped onto the patch's.
    mesh.quaternion.setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(
        new THREE.Vector3(...fit.basisU),
        new THREE.Vector3(...fit.basisV),
        new THREE.Vector3(...fit.normal),
      ),
    )
    mesh.position.set(...fit.center)
    mesh.scale.set(Math.max(2 * fit.extentU, 1e-5), Math.max(2 * fit.extentV, 1e-5), 1)
    return mesh
  }

  /** How far off the element's centre its label should float. */
  private labelOffset(fit: FitData): Vec3 {
    if (fit.kind === 'sphere') return [0, fit.radius * 1.35, 0]
    if (fit.kind === 'cylinder') return [0, fit.radius * 1.5, 0]
    if (fit.kind === 'point' || fit.kind === 'line') return [0, this.modelRadius * 0.03, 0]
    const lift = Math.max(fit.extentU, fit.extentV) * 0.12
    return [fit.normal[0] * lift, fit.normal[1] * lift, fit.normal[2] * lift]
  }

  /** Translucent ghost of the element a pending fit produced. */
  setPreview(fit: FitData | null): void {
    if (this.previewShape) {
      this.previewGroup.remove(this.previewShape)
      ;(this.previewShape.material as THREE.Material).dispose()
      this.previewShape = null
    }
    if (!fit) return
    const mat = new THREE.MeshStandardMaterial({
      color: PREVIEW_SHAPE_COLOR,
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
      roughness: 0.4,
      metalness: 0,
      side: THREE.DoubleSide,
    })
    this.previewShape = this.buildShape(fit, mat)
    this.previewGroup.add(this.previewShape)
  }

  updateOverlays(
    elements: OverlayElement[],
    pairs: OverlayPair[],
    angles: OverlayAngle[],
    visible: boolean,
  ): void {
    for (const fn of this.overlayCleanup) fn()
    this.overlayCleanup = []
    this.overlayGroup.clear()
    this.overlayPickables = []
    this.shellMaterials.clear()
    this.overlayGroup.visible = visible
    this.lastOverlayElements = visible ? elements : []
    if (!visible) {
      this.rebuildSelectionOutlines()
      return
    }

    for (const el of elements) {
      // The fitted element itself stays on screen — translucent and without
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
      const shape = this.buildShape(el.fit, shell)
      shape.userData.elementId = el.id
      this.overlayGroup.add(shape)
      this.overlayPickables.push(shape)
      const entry = { material: shell, color: el.color }
      this.shellMaterials.set(el.id, entry)
      this.applyHighlight(el.id, entry)
      this.overlayCleanup.push(() => shell.dispose())

      const dotMat = new THREE.MeshBasicMaterial({ color: el.color })
      const marker = new THREE.Mesh(this.unitSphere, dotMat)
      marker.position.set(...el.fit.center)
      marker.scale.setScalar(Math.max(this.markerSize(el.fit), 1e-4))
      marker.userData.elementId = el.id
      this.overlayGroup.add(marker)
      this.overlayPickables.push(marker)
      this.overlayCleanup.push(() => dotMat.dispose())

      // The line a cylinder is measured along, and the direction a plane
      // faces, are results in their own right — both get drawn.
      const guide = this.buildGuide(el.fit, el.color)
      if (guide) {
        this.overlayGroup.add(guide.line)
        this.overlayCleanup.push(guide.dispose)
      }

      const label = pinLabel('element-label', el.name, pinValue(el.fit), el.color)
      const off = this.labelOffset(el.fit)
      label.position.set(
        el.fit.center[0] + off[0],
        el.fit.center[1] + off[1],
        el.fit.center[2] + off[2],
      )
      this.overlayGroup.add(label)
      this.overlayCleanup.push(() => label.element.remove())
    }

    for (const p of pairs) {
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(...p.a),
        new THREE.Vector3(...p.b),
      ])
      const mat = new THREE.LineBasicMaterial({ color: 0x26282a, transparent: true, opacity: 0.8 })
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

    for (const a of angles) this.addAngle(a)
    this.rebuildSelectionOutlines()
  }

  /** Two rays out of the vertex and the arc swept between them. */
  private addAngle(a: OverlayAngle): void {
    const R = this.modelRadius * 0.16
    const vertex = new THREE.Vector3(...a.vertex)
    const dirA = new THREE.Vector3(...a.dirA).normalize()
    const dirB = new THREE.Vector3(...a.dirB).normalize()
    const mat = new THREE.LineBasicMaterial({ color: 0x26282a, transparent: true, opacity: 0.8 })
    this.overlayCleanup.push(() => mat.dispose())

    const ray = (dir: THREE.Vector3) => {
      const geo = new THREE.BufferGeometry().setFromPoints([
        vertex,
        vertex.clone().addScaledVector(dir, R),
      ])
      this.overlayGroup.add(new THREE.Line(geo, mat))
      this.overlayCleanup.push(() => geo.dispose())
    }
    ray(dirA)
    ray(dirB)

    // Sweep dirA onto dirB around their common normal. Opposite directions
    // have no unique normal — any perpendicular gives a valid half-circle.
    const sweep = Math.acos(Math.max(-1, Math.min(1, dirA.dot(dirB))))
    let axis = new THREE.Vector3().crossVectors(dirA, dirB)
    if (axis.lengthSq() < 1e-12) {
      axis = new THREE.Vector3(0, 1, 0).cross(dirA)
      if (axis.lengthSq() < 1e-12) axis = new THREE.Vector3(1, 0, 0).cross(dirA)
    }
    axis.normalize()

    const mid = dirA.clone().applyAxisAngle(axis, sweep / 2)
    if (sweep > 1e-3) {
      const points: THREE.Vector3[] = []
      const steps = Math.max(8, Math.ceil(sweep / 0.12))
      for (let i = 0; i <= steps; i++) {
        points.push(
          vertex
            .clone()
            .addScaledVector(dirA.clone().applyAxisAngle(axis, (sweep * i) / steps), R * 0.72),
        )
      }
      const geo = new THREE.BufferGeometry().setFromPoints(points)
      this.overlayGroup.add(new THREE.Line(geo, mat))
      this.overlayCleanup.push(() => geo.dispose())
    }

    const label = pinLabel('distance-label', a.title, a.value)
    label.position.copy(vertex.clone().addScaledVector(mid, R * 0.95))
    this.overlayGroup.add(label)
    this.overlayCleanup.push(() => label.element.remove())
  }

  /** Radius of the centre marker — a fraction of whatever size the element
   *  has, so it stays visible without swamping small features. */
  private markerSize(fit: FitData): number {
    if (fit.kind === 'plane') return Math.max(fit.extentU, fit.extentV) * 0.04
    if (fit.kind === 'point') return this.modelRadius * 0.008
    if (fit.kind === 'line') return this.modelRadius * 0.006
    return fit.radius * 0.07
  }

  /** A cylinder's axis, or a plane's normal, drawn as a line from the centre. */
  private buildGuide(fit: FitData, color: string): { line: THREE.Line; dispose: () => void } | null {
    if (fit.kind === 'sphere' || fit.kind === 'point' || fit.kind === 'line') return null
    const center = new THREE.Vector3(...fit.center)
    let a: THREE.Vector3
    let b: THREE.Vector3
    if (fit.kind === 'cylinder') {
      const dir = new THREE.Vector3(...fit.axis).normalize()
      const half = fit.length / 2 + fit.radius * 0.6
      a = center.clone().addScaledVector(dir, -half)
      b = center.clone().addScaledVector(dir, half)
    } else {
      const dir = new THREE.Vector3(...fit.normal).normalize()
      a = center
      b = center.clone().addScaledVector(dir, Math.max(fit.extentU, fit.extentV) * 0.35)
    }
    const geo = new THREE.BufferGeometry().setFromPoints([a, b])
    const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 })
    return {
      line: new THREE.Line(geo, mat),
      dispose: () => {
        geo.dispose()
        mat.dispose()
      },
    }
  }

  setPaused(paused: boolean): void {
    this.paused = paused
    if (!paused) this.resize()
  }

  /** The scan's geometry, BVH and all. Handed to the split-screen picker so it
   *  can draw and raycast the same 1.4-million-triangle mesh without a second
   *  copy or a second tree — three.js keeps per-renderer GPU state, so one
   *  geometry can safely appear in two canvases. */
  scanGeometry(): THREE.BufferGeometry | null {
    return (this.mesh?.geometry as THREE.BufferGeometry) ?? null
  }

  /** Half the scan's bounding-box diagonal — the scale hand-made elements
   *  (coordinate planes, picked points) are drawn at. */
  modelSize(): number {
    return this.modelRadius
  }

  nominalGeometry(): THREE.BufferGeometry | null {
    return (this.nominalMesh?.geometry as THREE.BufferGeometry) ?? null
  }

  /** Load the reference part. It never moves: a nominal is the datum a
   *  measurement is taken against, so the alignment is applied to the scan and
   *  the world ends up in the reference's coordinates. */
  setNominal(positions: Float32Array, indices: Uint32Array, normals: Float32Array): void {
    this.disposeNominal()
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
    geometry.setIndex(new THREE.BufferAttribute(indices, 1))
    geometry.computeBoundingBox()
    geometry.computeBoundingSphere()
    geometry.computeBoundsTree()

    const material = new THREE.MeshStandardMaterial({
      color: NOMINAL_COLOR,
      roughness: 0.55,
      metalness: 0.05,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.5,
      // Without this the ghost writes depth and punches holes in the scan
      // behind it, which reads as missing scan data rather than as a ghost.
      depthWrite: false,
    })
    this.nominalMesh = new THREE.Mesh(geometry, material)
    this.nominalMesh.visible = false
    this.nominalMesh.renderOrder = 1
    this.scene.add(this.nominalMesh)
  }

  /** Bake a datum alignment into the scan's vertices. Vertex order is
   *  untouched, so painted regions, element ownership and the deviation field
   *  all stay valid; only the coordinates (and the BVH built over them)
   *  change. Heavy — the BVH is rebuilt synchronously. */
  applyTransform(m: Rigid): void {
    if (!this.mesh) return
    const geometry = this.mesh.geometry as THREE.BufferGeometry
    const positions = geometry.getAttribute('position') as THREE.BufferAttribute
    const normals = geometry.getAttribute('normal') as THREE.BufferAttribute
    rigidApplyToPoints(m, positions.array as Float32Array)
    rigidRotateVectors(m, normals.array as Float32Array)
    positions.needsUpdate = true
    normals.needsUpdate = true
    geometry.computeBoundingBox()
    geometry.computeBoundingSphere()
    geometry.disposeBoundsTree?.()
    geometry.computeBoundsTree()
    // Keep framing the part broadside: its long axis moved with it.
    const a = this.scanAxis
    const r = m.r
    this.scanAxis = new THREE.Vector3(
      r[0] * a.x + r[1] * a.y + r[2] * a.z,
      r[3] * a.x + r[4] * a.y + r[5] * a.z,
      r[6] * a.x + r[7] * a.y + r[8] * a.z,
    ).normalize()
    this.frameCamera(geometry.boundingBox!, this.scanAxis)
  }

  /** Column-major 4×4 carrying the scan into the reference's frame, or null
   *  for an unaligned scan sitting in its own. */
  setAlignment(columnMajor: number[] | null): void {
    if (columnMajor) this.partGroup.matrix.fromArray(columnMajor)
    else this.partGroup.matrix.identity()
    this.partGroup.matrixWorldNeedsUpdate = true
    this.partGroup.updateMatrixWorld(true)
  }

  setNominalVisible(visible: boolean): void {
    if (this.nominalMesh) this.nominalMesh.visible = visible
  }

  setScanVisible(visible: boolean): void {
    if (this.mesh) this.mesh.visible = visible
  }

  /**
   * Whether the reference is a ghost or a solid part.
   *
   * A ghost is right while it is being fitted, where the scan has to be
   * readable through it. It is useless for confirming that the right file was
   * loaded, though: once aligned it lies inside a scan of nearly the same
   * shape, fails the depth test almost everywhere, and simply cannot be seen.
   * Solid — writing depth, fully opaque — is what makes it a part you can look
   * at.
   */
  setNominalGhost(ghost: boolean): void {
    if (!this.nominalMesh) return
    const material = this.nominalMesh.material as THREE.MeshStandardMaterial
    material.transparent = ghost
    material.opacity = ghost ? 0.5 : 1
    material.depthWrite = !ghost
    material.needsUpdate = true
  }

  /** Frame the camera so that both models are on screen, wherever the
   *  reference happens to sit before anything has been fitted. */
  frameAll(): void {
    const box = new THREE.Box3()
    this.partGroup.updateMatrixWorld(true)
    if (this.mesh) {
      const g = this.mesh.geometry as THREE.BufferGeometry
      if (g.boundingBox) box.union(g.boundingBox.clone().applyMatrix4(this.partGroup.matrixWorld))
    }
    if (this.nominalMesh) {
      const g = this.nominalMesh.geometry as THREE.BufferGeometry
      if (g.boundingBox) box.union(g.boundingBox)
    }
    if (!box.isEmpty()) this.frameCamera(box, this.scanAxis)
  }

  /** Paint the scan from a measured map — deviation, wall thickness — or pass
   *  null to hand the surface back to the element colours. */
  setFieldColors(colors: Uint8Array | null): void {
    this.fieldColors = colors
    if (!this.colorAttr) return
    const arr = this.colorAttr.array as Uint8Array
    if (colors && colors.length === arr.length) arr.set(colors)
    else this.repaintFromElements(arr)
    this.colorAttr.needsUpdate = true
  }

  private repaintFromElements(arr: Uint8Array): void {
    if (!this.owner) return
    for (let v = 0; v < this.owner.length; v++) {
      const id = this.owner[v]
      const c = (!this.hiddenRegions.has(id) && this.elementColors.get(id)) || BASE_COLOR
      arr[v * 3] = c[0]
      arr[v * 3 + 1] = c[1]
      arr[v * 3 + 2] = c[2]
    }
    this.paintPreview(arr)
  }

  /** Switch the surface tint of the given elements off (and everyone else's
   *  back on). Cheap enough to run on every visibility toggle. */
  setHiddenRegions(ids: readonly number[]): void {
    const next = new Set(ids)
    if (next.size === this.hiddenRegions.size && ids.every((id) => this.hiddenRegions.has(id)))
      return
    this.hiddenRegions = next
    if (!this.colorAttr || this.fieldColors) return
    this.repaintFromElements(this.colorAttr.array as Uint8Array)
    this.colorAttr.needsUpdate = true
  }

  private disposeNominal(): void {
    if (!this.nominalMesh) return
    const geometry = this.nominalMesh.geometry as THREE.BufferGeometry
    geometry.disposeBoundsTree?.()
    geometry.dispose()
    ;(this.nominalMesh.material as THREE.Material).dispose()
    this.scene.remove(this.nominalMesh)
    this.nominalMesh = null
  }

  private disposeMesh(): void {
    this.fieldColors = null
    if (!this.mesh) return
    const geometry = this.mesh.geometry as THREE.BufferGeometry
    geometry.disposeBoundsTree?.()
    geometry.dispose()
    ;(this.mesh.material as THREE.Material).dispose()
    this.partGroup.remove(this.mesh)
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
  }

  dispose(): void {
    cancelAnimationFrame(this.rafId)
    this.resizeObserver.disconnect()
    // The navigator listens on the document so drags can leave the canvas;
    // nothing else takes those down with the container.
    this.nav.dispose()
    this.updateOverlays([], [], [], false)
    this.setPreview(null)
    this.setProbes([])
    this.setPickMarkers([])
    this.probeGeometry.dispose()
    for (const d of this.gizmoDisposables) d.dispose()
    this.unitSphere.dispose()
    this.unitCylinder.dispose()
    this.unitPlane.dispose()
    this.disposeNominal()
    this.disposeMesh()
    this.controls.dispose()
    this.renderer.dispose()
    this.container.innerHTML = ''
  }
}
