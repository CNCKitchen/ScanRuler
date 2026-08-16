// SPDX-License-Identifier: AGPL-3.0-only
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js'
import type { ControlScheme } from './navSchemes'
import { OrthoNavigator } from './orthoNav'
import type { PickMarker } from './PickScene'
import {
  acceleratedRaycast,
  computeBoundsTree,
  disposeBoundsTree,
  INTERSECTED,
  NOT_INTERSECTED,
} from 'three-mesh-bvh'
import type { ExtendSide } from '../core/elements/extend'
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

/** The inside of the surface, when back-face tinting is switched on: a dull
 *  rose that no element colour, no deviation band and no unmeasured grey can
 *  be mistaken for. What it marks is worth seeing — a hole in the scan, an
 *  inverted normal, or simply that you are looking at the far wall of the
 *  part through one. */
const BACKFACE_COLOR = 0x9c5b70

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

/** One grip on an element being extended: where it sits, which way its side
 *  grows, and the mesh the cursor has to find to grab it. All in the part's own
 *  coordinates, like every other overlay. */
interface ExtendGrip {
  side: ExtendSide
  position: THREE.Vector3
  dir: THREE.Vector3
  mesh: THREE.Mesh
  material: THREE.MeshBasicMaterial
}

/** A deviation reading pinned to the part. */
export interface ProbeMarker {
  id: number
  point: Vec3
  label: string
  color: string
}

/** How a marking gesture takes surface: dragged over it with a round brush,
 *  swept with a rectangular window, or ringed with a freehand lasso. The last
 *  two are screen-space and take everything they enclose in one go, which is
 *  what makes excluding a whole riser or a run of spray practical. */
export type MarkGesture = 'brush' | 'window' | 'lasso'

/** The surface marking: a fit is measured on exactly what it covers, instead
 *  of on a region grown from a click or on the whole scan. */
export interface PaintBrush {
  /** Tint of the marked surface — the colour the pending element will get. */
  color: string
  /** Width of the brush on the surface, in the scan's own units (mm). */
  diameter: number
  /** Left-drag rubs the marking out instead of laying it down. Right-drag
   *  always rubs out, and Alt inverts whichever way the switch is set. */
  erase: boolean
  /** Which gesture marks. Defaults to the brush.
   *
   *  Explicitly null means armed but idle: the marking stays on the part and
   *  keeps its tint, no gesture takes or gives back surface, and the camera
   *  keeps both plain drags. That is the state both marking sessions — a
   *  hand-marked element and the local fine fit — open in and return to
   *  between markings; a tool that quietly held the mouse buttons hostage for
   *  as long as its panel was open would be a trap. */
  gesture?: MarkGesture | null
  /** Take triangles facing away from the camera as well. Off by default,
   *  because a window dragged over a closed part would otherwise mark the far
   *  wall along with the near one — and on a scan the far wall is usually the
   *  one you cannot see to judge. */
  backfaces?: boolean
}

/** A window or lasso being dragged: where it started, the outline so far, and
 *  which way it will go — decided when the button went down, so that letting
 *  go of Alt half way through does not turn a rub-out into a marking. */
interface Marquee {
  gesture: 'window' | 'lasso'
  erase: boolean
  /** Container-local pixels, the same frame the outline is drawn in. */
  points: { x: number; y: number }[]
  /** Where the container sat when the drag began, so client coordinates can be
   *  converted without asking the layout engine on every move. */
  origin: { left: number; top: number }
}

/** The brush footprint, drawn on the surface under the cursor: what a stroke
 *  would take, before it takes it. Erasing shows in the ring's own colour, so
 *  the mode is visible where the user is looking rather than only in the
 *  panel. */
const BRUSH_ERASE_COLOR = 0x26282a

/** The four corners of the window, from the two the user dragged between. */
function rectanglePoints(
  a: { x: number; y: number },
  b: { x: number; y: number },
): { x: number; y: number }[] {
  return [
    { x: a.x, y: a.y },
    { x: b.x, y: a.y },
    { x: b.x, y: b.y },
    { x: a.x, y: b.y },
  ]
}

/** Point-in-polygon by crossing number, with the outline's bounding box in
 *  front of it. The box rejects the great majority of a part's triangles for
 *  four comparisons, which matters when the test runs once per triangle of a
 *  million-triangle scan. A lasso that crosses itself is filled by the
 *  odd-even rule — the same thing every drawing program does with one. */
function polygonTester(outline: { x: number; y: number }[]): (x: number, y: number) => boolean {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of outline) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x)
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y)
  }
  const n = outline.length
  return (x, y) => {
    if (x < minX || x > maxX || y < minY || y > maxY) return false
    let inside = false
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const yi = outline[i].y
      const yj = outline[j].y
      if (yi > y === yj > y) continue
      const xi = outline[i].x
      if (x < ((outline[j].x - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
    }
    return inside
  }
}

/** Whether a triangle's front side is the one being looked at, from its
 *  winding and the view direction in the same (part-local) frame. */
function facesCamera(
  pos: Float32Array,
  a: number,
  b: number,
  c: number,
  view: THREE.Vector3,
): boolean {
  const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2]
  const ux = pos[b * 3] - ax, uy = pos[b * 3 + 1] - ay, uz = pos[b * 3 + 2] - az
  const vx = pos[c * 3] - ax, vy = pos[c * 3 + 1] - ay, vz = pos[c * 3 + 2] - az
  const nx = uy * vz - uz * vy
  const ny = uz * vx - ux * vz
  const nz = ux * vy - uy * vx
  return nx * view.x + ny * view.y + nz * view.z < 0
}

/** A point picked on the scan while setting up an alignment — the same marker
 *  the split picker's scenes place, so it is defined once, in PickScene. */
export type { PickMarker }

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
  /** The two things that can move the scan's group: the best fit onto a
   *  reference, and the live preview of a datum alignment still being set up.
   *  Held apart so either can be lifted without disturbing the other. */
  private alignMatrix = new THREE.Matrix4()
  private previewMatrix = new THREE.Matrix4()
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
  /** Grip shapes: an arrow for an end that grows along an axis, a bar for an
   *  edge that grows across itself. Both unit-sized about their own middle. */
  private unitCone = new THREE.ConeGeometry(0.5, 1, 20)
  private unitBox = new THREE.BoxGeometry(1, 1, 1)
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
  /** What frameCamera last enclosed, kept so an alignment preview can bound
   *  "the framed scene plus the moved scan" absolutely each call instead of
   *  ratcheting clipSphere up and never back down. */
  private framedClip = { center: new THREE.Vector3(), radius: 1 }

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

  /** Back-face tinting, shared by every material that opts in: a flag and a
   *  colour rather than two materials, so switching it is a uniform write
   *  instead of a shader recompile mid-session. */
  private backface = {
    uBackfaceTint: { value: 0 },
    uBackfaceColor: { value: new THREE.Color(BACKFACE_COLOR) },
  }

  /** Hand-painted surface selection: one byte per vertex, live only while the
   *  brush is armed. Vertex indices, like everything else the fitter speaks. */
  private paint: PaintBrush | null = null
  private paintMask: Uint8Array | null = null
  private paintCount = 0
  private paintRgb: [number, number, number] = [0, 0, 0]
  private painting = false
  private paintLast: { x: number; y: number } | null = null
  private paintSphere = new THREE.Sphere()
  /** Scratch for the per-triangle brush test, which runs thousands of times
   *  per stroke and must not allocate. */
  private scratchA = new THREE.Vector3()
  private scratchB = new THREE.Vector3()
  private scratchC = new THREE.Vector3()
  /** Whether the brush would rub out right now — from the switch, from Alt, or
   *  from the right button being the one that is down. Drives the ring colour. */
  private paintErasing = false
  /** Footprint of the brush on the surface: a ring the size of a stroke, laid
   *  flat on the face under the cursor. Rides in the part's group, so it stays
   *  put on the scan whatever the alignment does. */
  private brushRing: THREE.LineLoop
  private brushRingMaterial: THREE.LineBasicMaterial
  /** The window or lasso in flight, and the outline drawn for it. An SVG over
   *  the canvas rather than a line in the scene: the gesture is a screen-space
   *  one, and a rubber band that swung about with the part would be unusable. */
  private marquee: Marquee | null = null
  private marqueeSvg: SVGSVGElement
  private marqueeShape: SVGPolygonElement

  /** Grips for extending the element being made: one per end of a cylinder,
   *  one per edge of a plane. Live only while a draft is open, and always on
   *  top of everything — a grip that could hide inside the part it belongs to
   *  would be a grip that cannot be grabbed. */
  private handleGroup = new THREE.Group()
  private handles: ExtendGrip[] = []
  private handleCleanup: (() => void)[] = []
  private handleColor = '#ffffff'
  private hoveredHandle: ExtendSide | null = null
  private handleDrag: {
    side: ExtendSide
    /** Where the grip sat and which way it grows, in the part's own
     *  coordinates — the drag is measured along that line. */
    origin: THREE.Vector3
    dir: THREE.Vector3
    /** Line parameter the drag started at, so what is reported is how far it
     *  has come rather than where it is. */
    start: number
  } | null = null
  /** Who currently owns the plain left-drag. The brush and the grips both need
   *  it and must not fight over handing it back — the navigator is told once,
   *  from whether anyone is holding it at all. */
  private dragClaims = new Set<'paint' | 'handle'>()

  onPick: ((hit: PickHit) => void) | null = null
  onHover: ((hit: PickHit | null) => void) | null = null
  onElementPick: ((id: number) => void) | null = null
  /** How many vertices the brush has marked, reported when a stroke ends. */
  onPaintChange: ((count: number) => void) | null = null
  /** A grip being dragged: which side, and how many millimetres it has been
   *  pulled out (negative in) since the drag began. */
  onExtendDrag: ((side: ExtendSide, delta: number, phase: 'start' | 'move' | 'end') => void) | null =
    null

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

    const NS = 'http://www.w3.org/2000/svg'
    this.marqueeSvg = document.createElementNS(NS, 'svg')
    this.marqueeSvg.setAttribute('class', 'marquee')
    this.marqueeShape = document.createElementNS(NS, 'polygon')
    this.marqueeSvg.append(this.marqueeShape)
    this.marqueeSvg.style.display = 'none'
    this.container.appendChild(this.marqueeSvg)

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
    // Unit circle in XY, turned to lie on whatever face it is over. Drawn over
    // the part rather than into it: a ring that lost the depth test against
    // the very surface it is lying on would flicker with every wobble of the
    // scan.
    const ringPoints: THREE.Vector3[] = []
    for (let i = 0; i < 96; i++) {
      const a = (i / 96) * Math.PI * 2
      ringPoints.push(new THREE.Vector3(Math.cos(a), Math.sin(a), 0))
    }
    this.brushRingMaterial = new THREE.LineBasicMaterial({
      color: 0xffffff,
      depthTest: false,
      transparent: true,
      opacity: 0.95,
    })
    this.brushRing = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(ringPoints),
      this.brushRingMaterial,
    )
    this.brushRing.renderOrder = 5
    this.brushRing.visible = false

    this.partGroup.matrixAutoUpdate = false
    this.partGroup.add(this.brushRing)
    this.partGroup.add(this.overlayGroup)
    this.partGroup.add(this.selectionGroup)
    this.partGroup.add(this.previewGroup)
    this.partGroup.add(this.handleGroup)
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
      // With the brush armed, a plain drag is a stroke: left lays the marking
      // down, right takes it away — the navigator has stepped both of those
      // bindings aside for exactly this. Anything with a modifier still
      // belongs to the camera.
      // Nothing is marked on a scan that is switched off: a gesture over a
      // hidden part would take surface the user cannot see to judge, and the
      // window and lasso do not raycast, so nothing else would stop them.
      const gesture = this.paint && this.mesh?.visible ? this.gestureOf(this.paint!) : null
      if (gesture && (e.button === 0 || e.button === 2) && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
        const erase = this.eraseFor(e.button === 2, e.altKey)
        this.painting = true
        if (gesture === 'brush') {
          this.paintLast = null
          this.stroke(e.clientX, e.clientY, erase)
        } else {
          this.beginMarquee(gesture, erase, e.clientX, e.clientY)
        }
        return
      }
      // A grip under the cursor takes the plain left-drag — the navigator has
      // already stepped aside for it, the same way it does for the brush.
      // Never while a marking gesture is live: that one asked first.
      if (
        !gesture &&
        this.hoveredHandle !== null &&
        e.button === 0 &&
        !e.shiftKey &&
        !e.ctrlKey &&
        !e.metaKey
      ) {
        const grip = this.handles.find((h) => h.side === this.hoveredHandle)
        if (grip) {
          this.beginHandleDrag(grip, e.clientX, e.clientY)
          return
        }
      }
      if (e.button !== 0) return
      this.pointerDown = { x: e.clientX, y: e.clientY }
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

    // A stroke that runs off the edge of the viewport keeps painting, and one
    // released outside it still ends — same reasoning as the navigator's.
    document.addEventListener('pointermove', this.onPaintMove)
    document.addEventListener('pointerup', this.onPaintUp)
    // A grip dragged off the edge of the viewport keeps pulling, and one
    // released outside it still lets go.
    document.addEventListener('pointermove', this.onHandleMove)
    document.addEventListener('pointerup', this.onHandleUp)

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

  /** One pointer test per frame, and only when the answer could have changed:
   *  the hover readout when a map is showing, the brush footprint when the
   *  brush is armed. A mouse can emit hundreds of moves a second and only the
   *  last of them is on screen. */
  private updateHover(): void {
    if (!this.hoverDirty) return
    this.hoverDirty = false
    if (this.paint) this.updateBrushRing()
    // Grips first, and only when nothing is being marked: while a marking
    // gesture is armed both plain drags are the brush's, so a grip that lit up
    // would be one the user could not grab. A grip that has gone away is still
    // worth resolving — that is where a lit one hands the drag back after the
    // draft it belonged to was closed under it.
    if (this.handleDrag === null && (this.handles.length > 0 || this.hoveredHandle !== null)) {
      const marking = this.paint !== null && this.gestureOf(this.paint) !== null
      const at = this.hoverAt
      this.setHoveredHandle(marking || !at ? null : (this.handleAt(at.x, at.y)?.side ?? null))
    }
    if (!this.hoverEnabled) return
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
    this.tintBackfaces(material)
    this.mesh = new THREE.Mesh(geometry, material)
    this.paintMask = new Uint8Array(vertexCount)
    this.paintCount = 0
    this.partGroup.add(this.mesh)
    // A new scan is not aligned to anything yet, and nothing is being
    // previewed on it.
    this.previewMatrix.identity()
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

  /**
   * Make a material paint its back faces in the flag colour when back-face
   * tinting is on.
   *
   * Done in the shader rather than by drawing the mesh a second time with the
   * faces flipped, because the second pass would have to be the same million
   * triangles again — and because a front-face-only main pass would take the
   * inside of the part out of reach of the raycaster, which is what picking,
   * hovering and the brush all run on.
   */
  private tintBackfaces(material: THREE.Material): void {
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uBackfaceTint = this.backface.uBackfaceTint
      shader.uniforms.uBackfaceColor = this.backface.uBackfaceColor
      shader.fragmentShader =
        'uniform float uBackfaceTint;\nuniform vec3 uBackfaceColor;\n' +
        shader.fragmentShader.replace(
          '#include <color_fragment>',
          `#include <color_fragment>
          if ( uBackfaceTint > 0.5 && ! gl_FrontFacing ) diffuseColor.rgb = uBackfaceColor;`,
        )
    }
  }

  /** Show which way the surface faces: the far side of every triangle gets a
   *  colour of its own, so holes and flipped normals stop reading as part. */
  setBackfaceTint(on: boolean): void {
    this.backface.uBackfaceTint.value = on ? 1 : 0
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
    this.framedClip.center.copy(center)
    this.framedClip.radius = radius
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
    // Raycasting ignores visibility, so gate by hand — a hidden scan must not
    // swallow clicks meant for whatever is shown in its place.
    if (!this.mesh?.visible) return null
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

  // ---- the surface brush ---------------------------------------------------

  /**
   * Arm the brush, change what it does, or (with null) put it away.
   *
   * Re-arming keeps whatever is already marked: the panel calls this on every
   * change of radius or of the erase switch, and a stroke the user has already
   * laid down must survive reaching for the slider.
   */
  setPaintBrush(brush: PaintBrush | null): void {
    const wasOn = this.paint !== null
    this.paint = brush
    // Only a live gesture takes the plain drags away from the camera. Idle —
    // and that is the state both marking sessions open in — the camera keeps
    // everything it normally has.
    const gesture = brush && this.gestureOf(brush)
    this.claimDrag('paint', gesture !== null)
    if (!brush) {
      this.painting = false
      this.paintLast = null
      this.paintErasing = false
      this.brushRing.visible = false
      this.endMarquee()
      this.clearPaint()
      return
    }
    // Switching gesture mid-session leaves the marking alone but takes the
    // footprint of the old one off the part, and abandons anything in flight.
    if (gesture !== 'brush') this.brushRing.visible = false
    if (gesture === null) {
      this.painting = false
      this.paintLast = null
      this.endMarquee()
    }
    // The footprint follows the settings even if the cursor never moves again.
    this.hoverDirty = true
    this.paintErasing = brush.erase
    this.updateRingColor()
    const c = new THREE.Color(brush.color)
    const rgb: [number, number, number] = [
      Math.round(c.r * 255),
      Math.round(c.g * 255),
      Math.round(c.b * 255),
    ]
    const recolour = wasOn && rgb.some((v, i) => v !== this.paintRgb[i])
    this.paintRgb = rgb
    if (this.mesh && !this.paintMask) {
      this.paintMask = new Uint8Array(this.mesh.geometry.getAttribute('position').count)
      this.paintCount = 0
    }
    if (recolour && this.paintCount > 0 && this.colorAttr) {
      this.applyPaint(this.colorAttr.array as Uint8Array)
      this.colorAttr.needsUpdate = true
    }
  }

  /** Which gesture a marker is set to, with the brush standing in for a caller
   *  that never said. Null is a deliberate idle, not an omission. */
  private gestureOf(brush: PaintBrush): MarkGesture | null {
    return brush.gesture === undefined ? 'brush' : brush.gesture
  }

  /** The vertices marked so far, as the fitter wants them. */
  paintedVertices(): Uint32Array {
    const mask = this.paintMask
    if (!mask || this.paintCount === 0) return new Uint32Array(0)
    const out = new Uint32Array(this.paintCount)
    let w = 0
    for (let v = 0; v < mask.length && w < out.length; v++) if (mask[v]) out[w++] = v
    return w === out.length ? out : out.slice(0, w)
  }

  /**
   * Put a marking back on the part — the surface an element was measured on,
   * when that element is re-opened for editing.
   *
   * Called before the brush itself is armed (the panel does that on its next
   * render), so it sets up the mask and the colour the same way arming would;
   * setPaintBrush then finds both in place and leaves them alone.
   */
  setPaintedVertices(vertices: Uint32Array, colorHex: string): void {
    if (!this.mesh) return
    const count = this.mesh.geometry.getAttribute('position').count
    if (!this.paintMask || this.paintMask.length !== count) this.paintMask = new Uint8Array(count)
    else this.paintMask.fill(0)
    const c = new THREE.Color(colorHex)
    this.paintRgb = [Math.round(c.r * 255), Math.round(c.g * 255), Math.round(c.b * 255)]
    let marked = 0
    for (let i = 0; i < vertices.length; i++) {
      const v = vertices[i]
      if (v >= count || this.paintMask[v]) continue
      this.paintMask[v] = 1
      marked++
    }
    this.paintCount = marked
    if (!this.colorAttr) return
    this.applyPaint(this.colorAttr.array as Uint8Array)
    this.colorAttr.needsUpdate = true
  }

  /** Rub out the whole marking and hand the surface back to whatever was
   *  underneath it. */
  clearPaint(): void {
    if (!this.paintMask || this.paintCount === 0) {
      this.paintCount = 0
      this.paintMask?.fill(0)
      return
    }
    const mask = this.paintMask
    const arr = this.colorAttr?.array as Uint8Array | undefined
    for (let v = 0; v < mask.length; v++) {
      if (!mask[v]) continue
      mask[v] = 0
      if (!arr) continue
      const c = this.baseColorOf(v)
      arr[v * 3] = c[0]
      arr[v * 3 + 1] = c[1]
      arr[v * 3 + 2] = c[2]
    }
    this.paintCount = 0
    if (this.colorAttr) this.colorAttr.needsUpdate = true
  }

  /** One dab per few pixels along the segment the pointer covered, so a fast
   *  drag paints a stroke rather than a dotted line. */
  private stroke(x: number, y: number, erase: boolean): void {
    const last = this.paintLast
    const steps = last
      ? Math.min(24, Math.max(1, Math.round(Math.hypot(x - last.x, y - last.y) / 5)))
      : 1
    for (let i = 1; i <= steps; i++) {
      const t = i / steps
      this.dab(last ? last.x + (x - last.x) * t : x, last ? last.y + (y - last.y) * t : y, erase)
    }
    this.paintLast = { x, y }
    if (this.colorAttr) this.colorAttr.needsUpdate = true
  }

  /**
   * Mark (or unmark) every triangle the brush touches, by marking its corners.
   *
   * Triangles rather than corners on their own, because a triangle is what the
   * user sees change colour: a vertex-only rule on a coarse mesh paints a wide
   * patch — the tint is interpolated across each triangle — while handing the
   * fit the two or three corners that happened to fall inside the brush. What
   * is marked has to be what is measured.
   *
   * A ball around the hit point would also reach straight through a thin wall
   * and mark the far side, which is invisible from here and would quietly
   * corrupt the fit — so a triangle has to face roughly the way the surface
   * under the cursor does. That same test keeps a stroke near an edge from
   * spilling onto the face around the corner.
   */
  private dab(clientX: number, clientY: number, erase: boolean): void {
    const mesh = this.mesh
    const brush = this.paint
    if (!mesh || !brush || !this.colorAttr) return
    if (!this.paintMask) this.paintMask = new Uint8Array(mesh.geometry.getAttribute('position').count)

    this.setPickRay(clientX, clientY)
    const hit = this.raycaster.intersectObject(mesh, false)[0]
    if (!hit || hit.faceIndex === undefined || hit.faceIndex === null) return

    const geometry = mesh.geometry as THREE.BufferGeometry
    const bvh = geometry.boundsTree
    const index = geometry.getIndex()
    if (!bvh || !index) return
    const idx = index.array as ArrayLike<number>
    const pos = (geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array

    // The hit arrives in world space, which is the reference's frame once the
    // scan has been aligned; everything below is in the scan's own.
    this.partGroup.updateWorldMatrix(true, false)
    const centre = this.partGroup.worldToLocal(hit.point.clone())
    const f = hit.faceIndex * 3
    const face = this.faceNormal(pos, idx[f], idx[f + 1], idx[f + 2])
    if (!face) return

    const radius = Math.max(brush.diameter / 2, 1e-6)
    this.paintSphere.center.copy(centre)
    this.paintSphere.radius = radius
    const sphere = this.paintSphere
    const arr = this.colorAttr.array as Uint8Array
    const near = this.scratchA
    const edge1 = this.scratchB
    const edge2 = this.scratchC
    // With back faces allowed the brush marks straight through: the test that
    // keeps a stroke on the face under the cursor is the same one that keeps
    // it off the far wall, so switching it off does both.
    const anyFacing = brush.backfaces === true

    const touch = (v: number): void => this.markVertex(v, erase, arr)

    bvh.shapecast({
      intersectsBounds: (box) => (sphere.intersectsBox(box) ? INTERSECTED : NOT_INTERSECTED),
      intersectsTriangle: (tri, triIndex) => {
        // The box the BVH pruned by is not the triangle: check the triangle
        // itself before taking it.
        tri.closestPointToPoint(centre, near)
        if (near.distanceToSquared(centre) > radius * radius) return false
        // Same winding convention as the face under the cursor, so the two
        // normals can be compared at all.
        if (!anyFacing) {
          edge1.subVectors(tri.b, tri.a)
          edge2.subVectors(tri.c, tri.a)
          edge1.cross(edge2)
          if (edge1.dot(face) <= 0) return false
        }
        const f = triIndex * 3
        touch(idx[f])
        touch(idx[f + 1])
        touch(idx[f + 2])
        return false
      },
    })
  }

  private faceNormal(
    pos: Float32Array,
    a: number,
    b: number,
    c: number,
  ): THREE.Vector3 | null {
    const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2]
    const ux = pos[b * 3] - ax, uy = pos[b * 3 + 1] - ay, uz = pos[b * 3 + 2] - az
    const vx = pos[c * 3] - ax, vy = pos[c * 3 + 1] - ay, vz = pos[c * 3 + 2] - az
    const n = new THREE.Vector3(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx)
    // A degenerate sliver has no direction to compare anything against.
    if (n.lengthSq() < 1e-24) return null
    return n.normalize()
  }

  /** Lay the marking on one vertex, or take it off, and put the right colour
   *  under it either way. The single place the mask and the count move
   *  together — every gesture goes through here. */
  private markVertex(v: number, erase: boolean, arr: Uint8Array): void {
    const mask = this.paintMask
    if (!mask || mask[v] === (erase ? 0 : 1)) return
    mask[v] = erase ? 0 : 1
    this.paintCount += erase ? -1 : 1
    const c = erase ? this.baseColorOf(v) : this.paintRgb
    const j = v * 3
    arr[j] = c[0]
    arr[j + 1] = c[1]
    arr[j + 2] = c[2]
  }

  /** What a vertex should be coloured when nothing is marked on it: the
   *  measured map where one is showing — marking surface for a fine fit is
   *  done on top of the deviation map, and rubbing it out has to give the
   *  reading back — otherwise its element's tint, otherwise bare scan. */
  private baseColorOf(v: number): [number, number, number] {
    const field = this.fieldColors
    if (field) return [field[v * 3], field[v * 3 + 1], field[v * 3 + 2]]
    const id = this.owner ? this.owner[v] : 0
    if (id > 0 && !this.hiddenRegions.has(id)) return this.elementColors.get(id) ?? BASE_COLOR
    return BASE_COLOR
  }

  // ---- window and lasso ----------------------------------------------------

  private beginMarquee(
    gesture: 'window' | 'lasso',
    erase: boolean,
    clientX: number,
    clientY: number,
  ): void {
    const box = this.container.getBoundingClientRect()
    const origin = { left: box.left, top: box.top }
    this.marquee = {
      gesture,
      erase,
      origin,
      points: [{ x: clientX - origin.left, y: clientY - origin.top }],
    }
    this.marqueeShape.setAttribute('class', erase ? 'erase' : '')
    this.marqueeSvg.style.display = ''
    this.drawMarquee()
  }

  private extendMarquee(clientX: number, clientY: number): void {
    const m = this.marquee
    if (!m) return
    const p = { x: clientX - m.origin.left, y: clientY - m.origin.top }
    if (m.gesture === 'window') {
      // A window is its two corners and nothing else, however the cursor got
      // from one to the other.
      m.points[1] = p
    } else {
      // Thinning the trail keeps the point-in-polygon test — which runs once
      // per vertex of the scan — from carrying a thousand edges for a gesture
      // a hundred would describe.
      const last = m.points[m.points.length - 1]
      if (Math.hypot(p.x - last.x, p.y - last.y) < 4) return
      m.points.push(p)
    }
    this.drawMarquee()
  }

  private drawMarquee(): void {
    const m = this.marquee
    if (!m) return
    const outline =
      m.gesture === 'window' ? rectanglePoints(m.points[0], m.points[1] ?? m.points[0]) : m.points
    this.marqueeShape.setAttribute('points', outline.map((p) => `${p.x},${p.y}`).join(' '))
  }

  private endMarquee(): void {
    this.marquee = null
    this.marqueeSvg.style.display = 'none'
  }

  /**
   * Take every triangle the outline encloses.
   *
   * A triangle counts when its centre falls inside — the resolution of a scan
   * is far finer than anything drawn by hand, so where exactly the boundary
   * cuts a single triangle is below the noise of the gesture itself.
   *
   * There is no depth buffer in this: what stops a window from marking the
   * whole part front to back is the facing test, which is how every CAD
   * selection does it and is why "include back faces" is a switch the user
   * holds. On an open scan seen through a hole, surface behind the cursor
   * *facing this way* is marked too — which is the honest answer, since from
   * this side of the part there is nothing to tell it apart from the near
   * wall.
   */
  private markMarquee(outline: { x: number; y: number }[], erase: boolean): void {
    const mesh = this.mesh
    const marker = this.paint
    if (!mesh || !marker || !this.colorAttr || outline.length < 3) return
    const geometry = mesh.geometry as THREE.BufferGeometry
    const index = geometry.getIndex()
    if (!index) return
    const pos = (geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array
    const idx = index.array as ArrayLike<number>
    const vertexCount = pos.length / 3
    if (!this.paintMask) this.paintMask = new Uint8Array(vertexCount)

    const w = this.container.clientWidth || 1
    const h = this.container.clientHeight || 1
    this.partGroup.updateWorldMatrix(true, false)
    this.camera.updateMatrixWorld()
    const toClip = new THREE.Matrix4()
      .multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse)
      .multiply(this.partGroup.matrixWorld)

    // Every vertex projected once, rather than three times per triangle: at a
    // million triangles that is the difference between a gesture that lands
    // and one that stalls the frame. The projection is affine (parallel
    // camera), so a triangle's centre on screen is the mean of its corners'.
    const sx = new Float32Array(vertexCount)
    const sy = new Float32Array(vertexCount)
    const clipped = new Uint8Array(vertexCount)
    const p = new THREE.Vector3()
    for (let v = 0; v < vertexCount; v++) {
      p.set(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]).applyMatrix4(toClip)
      sx[v] = ((p.x + 1) / 2) * w
      sy[v] = ((1 - p.y) / 2) * h
      // Outside the depth range is behind a clipping plane, so it is not on
      // screen and must not be marked from here.
      clipped[v] = p.z < -1 || p.z > 1 ? 1 : 0
    }

    // The view direction in the part's own coordinates, so the facing test is
    // a dot product against the triangle's own normal with no per-triangle
    // matrix work.
    const viewLocal = new THREE.Vector3(0, 0, -1)
      .applyQuaternion(this.camera.quaternion)
      .applyMatrix3(new THREE.Matrix3().setFromMatrix4(this.partGroup.matrixWorld).invert())
    const anyFacing = marker.backfaces === true

    const test = polygonTester(outline)
    const arr = this.colorAttr.array as Uint8Array
    const before = this.paintCount
    for (let f = 0; f < idx.length; f += 3) {
      const a = idx[f], b = idx[f + 1], c = idx[f + 2]
      if (clipped[a] || clipped[b] || clipped[c]) continue
      if (!test((sx[a] + sx[b] + sx[c]) / 3, (sy[a] + sy[b] + sy[c]) / 3)) continue
      if (!anyFacing && !facesCamera(pos, a, b, c, viewLocal)) continue
      this.markVertex(a, erase, arr)
      this.markVertex(b, erase, arr)
      this.markVertex(c, erase, arr)
    }
    if (this.paintCount !== before) this.colorAttr.needsUpdate = true
  }

  /** Whether the brush takes marking away rather than laying it down: the
   *  right button always does, the switch says what the left one does, and Alt
   *  turns whichever of those applies around. */
  private eraseFor(rightButton: boolean, alt: boolean): boolean {
    if (!this.paint) return false
    return rightButton ? !alt : this.paint.erase !== alt
  }

  private onPaintMove = (e: PointerEvent): void => {
    if (!this.paint || this.gestureOf(this.paint) === null) return
    if (this.marquee) {
      this.extendMarquee(e.clientX, e.clientY)
      return
    }
    const erasing = this.eraseFor((e.buttons & 2) !== 0, e.altKey)
    if (erasing !== this.paintErasing) {
      this.paintErasing = erasing
      this.updateRingColor()
    }
    if (!this.painting) return
    this.stroke(e.clientX, e.clientY, erasing)
  }

  private onPaintUp = (e: PointerEvent): void => {
    if (!this.painting || (e.button !== 0 && e.button !== 2)) return
    this.painting = false
    this.paintLast = null
    const m = this.marquee
    if (m) {
      // A window needs its second corner and a lasso needs enough of a loop to
      // enclose anything; either way an accidental click marks nothing rather
      // than sweeping the whole part.
      const outline =
        m.gesture === 'window'
          ? m.points.length > 1
            ? rectanglePoints(m.points[0], m.points[1])
            : []
          : m.points
      this.endMarquee()
      if (outline.length >= 3) this.markMarquee(outline, m.erase)
    }
    // One report per gesture: the fit behind it is worth running when the user
    // lifts the button, not sixty times a second while they draw.
    this.onPaintChange?.(this.paintCount)
  }

  /**
   * Lay the brush footprint on the surface under the cursor.
   *
   * The ring is flat and the scan is not, so it is a reading of where a stroke
   * would land rather than a tracing of it — the same bargain every CAD brush
   * cursor makes, and at a brush width that is small against the feature being
   * marked the difference does not show.
   */
  private updateBrushRing(): void {
    const at = this.hoverAt
    if (!this.paint || this.gestureOf(this.paint) !== 'brush' || !at || !this.mesh?.visible) {
      this.brushRing.visible = false
      return
    }
    this.setPickRay(at.x, at.y)
    const hit = this.raycaster.intersectObject(this.mesh, false)[0]
    if (!hit || hit.faceIndex === undefined || hit.faceIndex === null) {
      this.brushRing.visible = false
      return
    }
    const geometry = this.mesh.geometry as THREE.BufferGeometry
    const index = geometry.getIndex()
    if (!index) {
      this.brushRing.visible = false
      return
    }
    const pos = (geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array
    const f = hit.faceIndex * 3
    const normal = this.faceNormal(pos, index.getX(f), index.getX(f + 1), index.getX(f + 2))
    if (!normal) {
      this.brushRing.visible = false
      return
    }
    this.partGroup.updateWorldMatrix(true, false)
    const centre = this.partGroup.worldToLocal(hit.point.clone())
    this.brushRing.position.copy(centre)
    this.brushRing.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal)
    this.brushRing.scale.setScalar(Math.max(this.paint.diameter / 2, 1e-6))
    this.brushRing.visible = true
  }

  private updateRingColor(): void {
    if (!this.paint) return
    this.brushRingMaterial.color.set(this.paintErasing ? BRUSH_ERASE_COLOR : this.paint.color)
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
    this.paintOverlays(arr)
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
    this.paintOverlays(arr)
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
        const c = this.baseColorOf(v)
        arr[v * 3] = c[0]
        arr[v * 3 + 1] = c[1]
        arr[v * 3 + 2] = c[2]
      }
    }
    this.previewRegion = region
    this.paintOverlays(arr)
    this.colorAttr.needsUpdate = true
  }

  /** The two layers that sit above the element tints: the preview region of a
   *  pending auto-fit, and the surface marked by hand for one. */
  private paintOverlays(arr: Uint8Array): void {
    if (this.previewRegion) {
      for (let i = 0; i < this.previewRegion.length; i++) {
        const v = this.previewRegion[i]
        arr[v * 3] = this.previewRgb[0]
        arr[v * 3 + 1] = this.previewRgb[1]
        arr[v * 3 + 2] = this.previewRgb[2]
      }
    }
    this.applyPaint(arr)
  }

  private applyPaint(arr: Uint8Array): void {
    const mask = this.paintMask
    if (!mask || this.paintCount === 0) return
    for (let v = 0; v < mask.length; v++) {
      if (!mask[v]) continue
      arr[v * 3] = this.paintRgb[0]
      arr[v * 3 + 1] = this.paintRgb[1]
      arr[v * 3 + 2] = this.paintRgb[2]
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

  /** How far off the element's centre its label should float.
   *
   *  A sphere is the same in every direction, so straight up is as good as
   *  anywhere. A cylinder is not: lifting its label along world Y walks it out
   *  along the axis of an upright cylinder, leaving the pin hanging a radius
   *  and a half off the end of the tube with nothing under it. The offset has
   *  to be across the axis, so the label always sits just off the wall of the
   *  piece of surface that was measured. */
  private labelOffset(fit: FitData): Vec3 {
    if (fit.kind === 'sphere') return [0, fit.radius * 1.35, 0]
    if (fit.kind === 'cylinder') {
      const out = this.acrossAxis(fit.axis)
      const lift = fit.radius * 1.15
      return [out.x * lift, out.y * lift, out.z * lift]
    }
    if (fit.kind === 'point' || fit.kind === 'line') return [0, this.modelRadius * 0.03, 0]
    const lift = Math.max(fit.extentU, fit.extentV) * 0.12
    return [fit.normal[0] * lift, fit.normal[1] * lift, fit.normal[2] * lift]
  }

  /** The direction across the given axis that points as far up the screen as
   *  it can — an upright label beside the feature, not one buried behind it. */
  private acrossAxis(axis: Vec3): THREE.Vector3 {
    const a = new THREE.Vector3(...axis).normalize()
    const out = new THREE.Vector3(0, 1, 0)
    out.addScaledVector(a, -out.dot(a))
    // The axis itself is vertical: any direction across it is as good.
    if (out.lengthSq() < 1e-8) out.set(1, 0, 0).addScaledVector(a, -a.x)
    if (out.lengthSq() < 1e-8) out.set(0, 0, 1)
    return out.normalize()
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

  // ---- grips for extending an element --------------------------------------

  /**
   * Put grips on the element being made, or take them away with null.
   *
   * The fit handed in is the one being *drawn* — already carrying whatever it
   * has been extended by — so the grips sit on the ends and edges the user can
   * see, and follow them as the numbers change. Anything else (a sphere, a
   * point, a line) has no size to give and gets none.
   */
  setExtendHandles(fit: FitData | null, color: string): void {
    for (const fn of this.handleCleanup) fn()
    this.handleCleanup = []
    this.handleGroup.clear()
    this.handles = []
    this.handleColor = color
    if (this.hoveredHandle !== null && this.handleDrag === null) this.setHoveredHandle(null)
    if (!fit) return

    // Drawn on top of everything, so a grip on the far side of the element is
    // still grabbable. The floor keeps a grip on a tiny feature from vanishing
    // on a large part.
    const size = Math.max(this.modelRadius * 0.03, 1e-5)

    if (fit.kind === 'cylinder') {
      const axis = new THREE.Vector3(...fit.axis).normalize()
      const length = Math.max(fit.length, 1e-5)
      const centre = new THREE.Vector3(...fit.center)
      // An arrow off each end, sized to the tube it belongs to rather than to
      // the part: on a bore in a large casting a grip scaled to the whole scan
      // would be bigger than the hole, and on a long shaft it would be a speck.
      const arrow = Math.max(
        Math.min(Math.max(fit.radius, 1e-5) * 0.8, length * 0.3),
        this.modelRadius * 0.02,
      )
      const half = length / 2
      this.addGrip('start', centre.clone().addScaledVector(axis, -half), axis.clone().negate(), arrow)
      this.addGrip('end', centre.clone().addScaledVector(axis, half), axis.clone(), arrow)
      return
    }

    if (fit.kind === 'plane') {
      const u = new THREE.Vector3(...fit.basisU).normalize()
      const v = new THREE.Vector3(...fit.basisV).normalize()
      const eu = Math.max(fit.extentU, 1e-5)
      const ev = Math.max(fit.extentV, 1e-5)
      const centre = new THREE.Vector3(...fit.center)
      // A bar lying along each edge: the grip is the edge, which is the thing
      // being dragged. Half the edge long, so all four stay clear of the
      // corners even on a patch that is much longer than it is wide, and never
      // thicker than a fair share of the patch it belongs to.
      const bar = (along: THREE.Vector3, span: number) => ({ along, span })
      const thick = Math.max(Math.min(size, Math.min(eu, ev) * 0.6), this.modelRadius * 0.008)
      this.addGrip('uMin', centre.clone().addScaledVector(u, -eu), u.clone().negate(), thick, bar(v, ev))
      this.addGrip('uMax', centre.clone().addScaledVector(u, eu), u.clone(), thick, bar(v, ev))
      this.addGrip('vMin', centre.clone().addScaledVector(v, -ev), v.clone().negate(), thick, bar(u, eu))
      this.addGrip('vMax', centre.clone().addScaledVector(v, ev), v.clone(), thick, bar(u, eu))
    }
  }

  /** One grip: an arrow on an axis, or a bar along an edge when the side it
   *  belongs to has an edge to lie on. */
  private addGrip(
    side: ExtendSide,
    position: THREE.Vector3,
    dir: THREE.Vector3,
    size: number,
    edge?: { along: THREE.Vector3; span: number },
  ): void {
    const material = new THREE.MeshBasicMaterial({
      // A rebuild in the middle of a drag must not put the lit grip out.
      color: side === this.hoveredHandle ? 0xffffff : this.handleColor,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
    const mesh = new THREE.Mesh(edge ? this.unitBox : this.unitCone, material)
    if (edge) {
      // The bar lies in the plane, along the edge, and reaches a little past it
      // on the outside so the shape it will grow into is legible.
      mesh.quaternion.setFromRotationMatrix(
        new THREE.Matrix4().makeBasis(edge.along, dir, edge.along.clone().cross(dir).normalize()),
      )
      mesh.scale.set(Math.max(edge.span, size), size * 0.42, size * 0.42)
      mesh.position.copy(position)
    } else {
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir)
      mesh.scale.setScalar(size)
      // Base on the end face, tip pointing the way the drag will take it.
      mesh.position.copy(position).addScaledVector(dir, size / 2)
    }
    mesh.renderOrder = 6
    mesh.userData.extendSide = side
    this.handleGroup.add(mesh)
    this.handles.push({ side, position: position.clone(), dir: dir.clone(), mesh, material })
    this.handleCleanup.push(() => material.dispose())
  }

  /** The grip under the cursor, if the cursor is on one. Grips are tested
   *  before anything else and ignore what is in front of them: they are drawn
   *  on top, so they have to be grabbable on top. */
  private handleAt(clientX: number, clientY: number): ExtendGrip | null {
    if (this.handles.length === 0) return null
    this.nav.setPickRay(this.raycaster, clientX, clientY)
    // Grips are built and moved between frames; the ray has to meet them where
    // they are now, not where the last render left them.
    this.handleGroup.updateWorldMatrix(true, true)
    const hits = this.raycaster.intersectObjects(
      this.handles.map((h) => h.mesh),
      false,
    )
    if (hits.length === 0) return null
    const side = hits[0].object.userData.extendSide as ExtendSide
    return this.handles.find((h) => h.side === side) ?? null
  }

  /** Light the grip under the cursor and say so with the pointer, and take the
   *  plain left-drag off the camera for as long as one is under it. */
  private setHoveredHandle(side: ExtendSide | null): void {
    if (this.hoveredHandle === side) return
    this.hoveredHandle = side
    for (const h of this.handles) h.material.color.set(h.side === side ? 0xffffff : this.handleColor)
    this.claimDrag('handle', side !== null)
    this.renderer.domElement.style.cursor = side !== null ? 'grab' : ''
  }

  private beginHandleDrag(grip: ExtendGrip, clientX: number, clientY: number): void {
    const world = this.gripLine(grip)
    const t = this.paramAlong(world.origin, world.dir, clientX, clientY)
    if (t === null) return
    this.handleDrag = { side: grip.side, origin: world.origin, dir: world.dir, start: t }
    this.renderer.domElement.style.cursor = 'grabbing'
    this.onExtendDrag?.(grip.side, 0, 'start')
  }

  /** A grip's line in world space — the part can be sitting under an alignment,
   *  and the pointer ray is cast in world coordinates. */
  private gripLine(grip: ExtendGrip): { origin: THREE.Vector3; dir: THREE.Vector3 } {
    this.partGroup.updateWorldMatrix(true, false)
    const origin = grip.position.clone().applyMatrix4(this.partGroup.matrixWorld)
    const dir = grip.dir
      .clone()
      .transformDirection(this.partGroup.matrixWorld)
      .normalize()
    return { origin, dir }
  }

  /**
   * Where the cursor is along a line, in millimetres from its origin: the point
   * on the line closest to the ray under the pointer.
   *
   * Null when the two are within a few degrees of parallel — looking straight
   * down the axis being dragged, the answer runs off to infinity and the grip
   * would jump. Holding still is the honest response.
   */
  private paramAlong(
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    clientX: number,
    clientY: number,
  ): number | null {
    this.nav.setPickRay(this.raycaster, clientX, clientY)
    const ray = this.raycaster.ray
    const b = dir.dot(ray.direction)
    const denom = 1 - b * b
    if (Math.abs(denom) < 1e-3) return null
    const w = origin.clone().sub(ray.origin)
    return (b * w.dot(ray.direction) - w.dot(dir)) / denom
  }

  private onHandleMove = (e: PointerEvent): void => {
    const drag = this.handleDrag
    if (!drag) return
    const t = this.paramAlong(drag.origin, drag.dir, e.clientX, e.clientY)
    if (t === null) return
    this.onExtendDrag?.(drag.side, t - drag.start, 'move')
  }

  private onHandleUp = (): void => {
    const drag = this.handleDrag
    if (!drag) return
    this.handleDrag = null
    this.renderer.domElement.style.cursor = this.hoveredHandle !== null ? 'grab' : ''
    this.onExtendDrag?.(drag.side, 0, 'end')
    // The cursor may have left the grip while it was held; settle the hover
    // from where it actually is now.
    this.hoverDirty = true
  }

  /** Take the plain left-drag away from the camera, or give it back, for one
   *  reason among several. The navigator only ever hears the total. */
  private claimDrag(reason: 'paint' | 'handle', on: boolean): void {
    const had = this.dragClaims.size > 0
    if (on) this.dragClaims.add(reason)
    else this.dragClaims.delete(reason)
    const has = this.dragClaims.size > 0
    if (had !== has) this.nav.setPaintMode(has)
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
    if (columnMajor) this.alignMatrix.fromArray(columnMajor)
    else this.alignMatrix.identity()
    this.updatePartMatrix()
  }

  /**
   * Show a datum alignment before it is baked: the scan, and everything
   * measured on it, swings onto the axes the draft would put it on. Pass null
   * to put it back.
   *
   * Nothing about the geometry changes — this is a matrix on the group, so it
   * costs a matrix write rather than a pass over a million vertices and a BVH
   * rebuild, and can therefore follow every pick and every axis change. Scan
   * coordinates are unaffected: picking already reads hits back through the
   * group's matrix, so points clicked on the previewed part land where they
   * would have landed on the part sitting still.
   *
   * The camera stays where the operator put it. A preview that re-framed as
   * well would take their zoom away on every pick, and the part is only being
   * tried on for size here — applying the alignment is what re-frames.
   */
  setAlignPreview(columnMajor: number[] | null): void {
    // Filling one slot re-runs this with the pose unchanged; there is nothing
    // to do then, and the scan is the largest thing in the scene.
    const next = columnMajor ? new THREE.Matrix4().fromArray(columnMajor) : new THREE.Matrix4()
    if (next.equals(this.previewMatrix)) return
    this.previewMatrix.copy(next)
    this.updatePartMatrix()

    const geometry = this.mesh?.geometry as THREE.BufferGeometry | undefined
    if (!geometry?.boundingSphere) return
    // The preview turns the part about the picked feature and drops that
    // feature onto the global zero plane, so the clip planes — which follow the
    // scan, not the camera — have to be re-centred on where it now sits, or the
    // far side of a large rotation is sliced off.
    const moved = geometry.boundingSphere.clone().applyMatrix4(this.partGroup.matrix)
    // The smallest sphere holding both the framed scene and the moved scan,
    // written absolutely: clearing the preview or a smaller rotation must
    // shrink the clip range back, not leave it where the largest swing put it.
    const base = this.framedClip
    const d = moved.center.distanceTo(base.center)
    if (moved.radius >= d + base.radius) {
      this.clipSphere.center.copy(moved.center)
      this.clipSphere.radius = moved.radius
    } else if (base.radius >= d + moved.radius) {
      this.clipSphere.center.copy(base.center)
      this.clipSphere.radius = base.radius
    } else {
      const radius = (d + base.radius + moved.radius) / 2
      this.clipSphere.center
        .copy(moved.center)
        .sub(base.center)
        .normalize()
        .multiplyScalar(radius - base.radius)
        .add(base.center)
      this.clipSphere.radius = radius
    }
  }

  private updatePartMatrix(): void {
    this.partGroup.matrix.multiplyMatrices(this.alignMatrix, this.previewMatrix)
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
    if (colors && colors.length === arr.length) {
      arr.set(colors)
      // The marking sits above the map: re-scaling the colours must not rub
      // out the surface a fine fit is about to be run on.
      this.applyPaint(arr)
    } else this.repaintFromElements(arr)
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
    this.paintOverlays(arr)
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
    this.hiddenRegions.clear()
    this.previewRegion = null
    this.paintMask = null
    this.paintCount = 0
    this.painting = false
    this.paintLast = null
    this.endMarquee()
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
    document.removeEventListener('pointermove', this.onPaintMove)
    document.removeEventListener('pointerup', this.onPaintUp)
    document.removeEventListener('pointermove', this.onHandleMove)
    document.removeEventListener('pointerup', this.onHandleUp)
    // The navigator listens on the document so drags can leave the canvas;
    // nothing else takes those down with the container.
    this.nav.dispose()
    this.updateOverlays([], [], [], false)
    this.setPreview(null)
    this.setExtendHandles(null, '#ffffff')
    this.setProbes([])
    this.setPickMarkers([])
    this.probeGeometry.dispose()
    this.brushRing.geometry.dispose()
    this.brushRingMaterial.dispose()
    for (const d of this.gizmoDisposables) d.dispose()
    this.unitSphere.dispose()
    this.unitCylinder.dispose()
    this.unitPlane.dispose()
    this.unitCone.dispose()
    this.unitBox.dispose()
    this.disposeNominal()
    this.disposeMesh()
    this.controls.dispose()
    this.renderer.dispose()
    this.container.innerHTML = ''
  }
}
