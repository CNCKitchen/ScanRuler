// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The measured results drawn on the part: element shells and their pins,
 * distance lines and angle arcs, white selection strokes, the translucent
 * ghost of a pending fit, and the pinned deviation readings and alignment
 * markers. Pure FitData-to-Object3D construction — everything here rides in
 * the part's group and is rebuilt wholesale when the data changes.
 */
import * as THREE from 'three'
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js'
import type { ExtendSide } from '../core/elements/extend'
import type { FitData, Vec3 } from '../core/types'
import type { PickMarker } from './PickScene'
import { DEFAULT_THEME, type ViewTheme } from './viewThemes'

/** Radius of a picked-point marker, in pixels of the canvas.
 *
 *  In pixels rather than in millimetres because a pick is a thing on the
 *  screen, not a feature of the part: sized to the model it is a speck on a
 *  casting and a boulder on a set screw, and either way it grows and shrinks
 *  under zoom — exactly when the operator is zooming *in* to place it
 *  precisely. Held at one size on screen it stays the same handle at every
 *  magnification, and the surface under the next click is never buried by the
 *  last one. */
const PICK_MARKER_PX = 14

export interface OverlayElement {
  id: number
  name: string
  color: string
  fit: FitData
  /**
   * How it is drawn, and with it what a click on it means.
   *
   * A **shell** is the translucent body — right on bare scan, and the only form
   * you can reasonably aim a click at, so shells are what element picking
   * resolves through.
   *
   * An **outline** is just the border. It is for the element a deviation map is
   * measured against: that one lies exactly on the surface it was fitted to, so
   * a shell there would both fight the depth buffer along that surface and wash
   * the colour of the reading underneath — and on a map the colour *is* the
   * measurement. It is also, deliberately, not clickable: it already is the
   * element in use, and a click on the surface it covers is a reading to pin.
   */
  style?: 'shell' | 'outline'
  /** Faded back: an element on offer rather than the one in use. */
  muted?: boolean
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

/** The dot a pinned reading puts on the part: ink, in the light instrument's
 *  figure whichever the chassis — it sits on the part, and the part does not
 *  change with the lights. The chip's title is ink too, but the chassis's
 *  own, which the stylesheet paints off the pin's `reading` class. */
const PROBE_INK = 0x26282a

/** A deviation reading pinned to the part. */
export interface ProbeMarker {
  id: number
  point: Vec3
  /** What the pin reads on top — the map it was taken off: DEV or WALL. */
  title: string
  label: string
}

/** How far short of a pin the first surface along the ray may be for the pin
 *  still to count as seen, as a fraction of the part's radius: the pin sits
 *  on that surface, and the hit on its own triangle lands a rounding error
 *  in front of it. */
const OCCLUSION_SLACK = 0.004

const _pinWorld = new THREE.Vector3()
const _pinNdc = new THREE.Vector3()
const _pinCoords = new THREE.Vector2()

/** A pin in the 3D view: what it marks on top, the measured value under it, so
 *  the numbers can be read off the model without going back to the panel. An
 *  empty value leaves just the name — nothing is not a number.
 *
 *  A tint is an element's own colour on the title. It goes on as `--tint`
 *  under the stylesheet's `tinted` rule rather than as the colour itself, so
 *  that the dark chassis can lift it toward white before it is used as text:
 *  the palette is tuned to hold on the light instrument, and its deeper tones
 *  sink into a dark chip. */
export function pinLabel(kind: string, title: string, value: string, tint?: string): CSS2DObject {
  const div = document.createElement('div')
  div.className = `viewport-label ${kind}`
  const t = document.createElement('div')
  t.className = 'label-title'
  t.textContent = title
  if (tint) {
    t.classList.add('tinted')
    t.style.setProperty('--tint', tint)
  }
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
  if (fit.kind === 'sphere' || fit.kind === 'cylinder' || fit.kind === 'circle')
    return `Ø ${(fit.radius * 2).toFixed(3)} mm`
  if (fit.kind === 'cone') return `∠ ${(fit.halfAngle * 2).toFixed(2)}°`
  return ''
}

/** The geometry a shape mesh had built for itself alone — the unit shapes are
 *  shared and long-lived, but a cone's frustum is per-element and must go when
 *  its mesh does. */
function ownedGeometry(mesh: THREE.Mesh): THREE.BufferGeometry | undefined {
  return mesh.userData.ownedGeometry as THREE.BufferGeometry | undefined
}

/** What the overlays need from the viewport around them. */
export interface OverlaysContext {
  partGroup: THREE.Group
  /** Half the scan's bounding-box diagonal — the scale sizeless things
   *  (points, lines, markers) are drawn at. */
  modelRadius(): number
  invalidate(): void
  /** The viewport's camera and its raycaster, for asking whether a pin's spot
   *  can be seen from where the camera stands. */
  camera: THREE.Camera
  raycaster: THREE.Raycaster
  /** What can stand between the camera and a pin: the scan, while it is
   *  shown. Null puts every pin in view. */
  occluder(): THREE.Mesh | null
}

/** A pinned reading on the part: its dot, its chip, and where it is in the
 *  part's own coordinates. */
interface ProbePin {
  dot: THREE.Mesh
  label: CSS2DObject
  point: THREE.Vector3
}

export class Overlays {
  private overlayGroup = new THREE.Group()
  /** White selection strokes, rebuilt whenever the selection or the overlays
   *  change. Kept beside the overlays so clearing one never orphans the other. */
  private selectionGroup = new THREE.Group()
  private previewGroup = new THREE.Group()
  private probeGroup = new THREE.Group()
  private pickMarkerGroup = new THREE.Group()
  private overlayCleanup: (() => void)[] = []
  private selectionCleanup: (() => void)[] = []
  private probeCleanup: (() => void)[] = []
  private pickMarkerCleanup: (() => void)[] = []
  /** The pick-marker dots alone, so a change of zoom can re-scale them without
   *  rebuilding anything. */
  private pickMarkerDots: THREE.Mesh[] = []
  /** Millimetres per pixel at the current zoom, from the viewport. Zero until
   *  the first frame has reported one. */
  private worldPerPixel = 0
  /** The pinned readings on the part, kept so a turn of the camera can put
   *  away the ones it can no longer see. */
  private probePins: ProbePin[] = []
  private hideOccludedProbes = false
  /** The view the pins were last tested from — camera, projection and the
   *  part's pose — so a frame that moved none of them tests nothing. Null
   *  when the pins or the setting have changed since. */
  private occlusionView: Float64Array | null = null
  private viewNow = new Float64Array(48)
  /** Overlay meshes that can stand in for their element in a click, and the
   *  materials to restyle when that element is selected. */
  private overlayPickables: THREE.Mesh[] = []
  private shellMaterials = new Map<number, { material: THREE.MeshStandardMaterial; color: string }>()
  /** The scheme's colours for the marks that carry no reading of their own —
   *  callout lines, the ghost of a pending fit. Element tints, and the labels'
   *  CSS, are not the theme's to touch. */
  private accents: ViewTheme['accents'] = DEFAULT_THEME.accents
  /** The callout materials on screen, kept so a scheme switch can recolour
   *  them in place instead of waiting for the next rebuild. */
  private calloutMaterials: THREE.LineBasicMaterial[] = []
  private highlightIds = new Set<number>()
  private lastOverlayElements: OverlayElement[] = []
  private previewShape: THREE.Mesh | null = null
  /** The ends of the ghost, drawn apart from its body: a ghost is translucent
   *  so the scan shows through it, and inside a bore that leaves nothing to
   *  say where a tube being pulled shorter actually stops. Two thin rims,
   *  always; a near-solid cap on the end the user has hold of. */
  private previewEnds = new THREE.Group()
  private previewEndCleanup: (() => void)[] = []
  private previewFit: FitData | null = null
  private previewActiveSide: ExtendSide | null = null
  /** The colour the element being made will get — its grips wear it, and so
   *  do the marks on the ends they sit on. */
  private previewColor = '#ffffff'
  /** A rim is a thin ring, the cap a disc; both lie in XY about the origin
   *  and are scaled to the tube's radius, so the ring stays the same fraction
   *  of the bore however big the bore is. */
  private unitRim = new THREE.TorusGeometry(1, 0.012, 8, 128)
  private unitDisc = new THREE.CircleGeometry(1, 96)
  private unitSphere = new THREE.SphereGeometry(1, 48, 32)
  /** Open-ended so the scan surface stays visible through the tube. */
  private unitCylinder = new THREE.CylinderGeometry(1, 1, 1, 64, 1, true)
  private unitPlane = new THREE.PlaneGeometry(1, 1)
  /** A circle element is drawn as a thin ring in its plane (axis along Z, like
   *  the torus itself). The tube is a fixed fraction of the ring radius so a
   *  uniform scale to the element's radius keeps it a crisp line at any size. */
  private unitRing = new THREE.TorusGeometry(1, 0.02, 12, 96)
  /** Just the borders of the two shapes that have any: the four edges of a
   *  plane patch, the two rims of a tube. Built off the same unit geometries the
   *  shells are, so an outline can never disagree with the body it outlines.
   *  A sphere is smooth all over and has none — its label and centre marker say
   *  where it is instead. */
  private unitPlaneEdges = new THREE.EdgesGeometry(this.unitPlane)
  private unitCylinderEdges = new THREE.EdgesGeometry(this.unitCylinder)
  private probeGeometry = new THREE.SphereGeometry(1, 18, 12)

  constructor(private ctx: OverlaysContext) {
    ctx.partGroup.add(this.overlayGroup)
    ctx.partGroup.add(this.selectionGroup)
    ctx.partGroup.add(this.previewGroup)
    this.previewGroup.add(this.previewEnds)
    ctx.partGroup.add(this.probeGroup)
    ctx.partGroup.add(this.pickMarkerGroup)
  }

  /** The overlay meshes a click may resolve to an element through — a fresh
   *  array the caller may extend, empty while the overlays are switched off. */
  pickTargets(): THREE.Object3D[] {
    return this.overlayGroup.visible ? [...this.overlayPickables] : []
  }

  updateOverlays(
    elements: OverlayElement[],
    pairs: OverlayPair[],
    angles: OverlayAngle[],
    visible: boolean,
  ): void {
    this.ctx.invalidate()
    for (const fn of this.overlayCleanup) fn()
    this.overlayCleanup = []
    this.overlayGroup.clear()
    this.overlayPickables = []
    this.shellMaterials.clear()
    this.calloutMaterials = []
    this.overlayGroup.visible = visible
    this.lastOverlayElements = visible ? elements : []
    if (!visible) {
      this.rebuildSelectionOutlines()
      return
    }

    for (const el of elements) {
      if (el.style === 'outline') {
        const outline = this.buildOutline(el.fit, el.color, el.muted === true)
        if (outline) {
          this.overlayGroup.add(outline.line)
          this.overlayCleanup.push(outline.dispose)
        }
      } else {
        // The fitted element itself stays on screen — translucent and without
        // depth writes so the scan surface, centre marker and distance lines
        // stay readable through it. The polygon offset is what keeps it from
        // fighting the depth buffer along a surface it was fitted to and lies
        // exactly on: coplanar with the scan, the two would stripe.
        const shell = new THREE.MeshStandardMaterial({
          color: el.color,
          transparent: true,
          opacity: el.muted ? 0.22 : 0.3,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -1,
          polygonOffsetUnits: -1,
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
        this.overlayCleanup.push(() => {
          shell.dispose()
          ownedGeometry(shape)?.dispose()
        })
      }

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
      const mat = new THREE.LineBasicMaterial({
        color: this.accents.callout,
        transparent: true,
        opacity: 0.8,
      })
      this.calloutMaterials.push(mat)
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
    const R = this.ctx.modelRadius() * 0.16
    const vertex = new THREE.Vector3(...a.vertex)
    const dirA = new THREE.Vector3(...a.dirA).normalize()
    const dirB = new THREE.Vector3(...a.dirB).normalize()
    const mat = new THREE.LineBasicMaterial({
      color: this.accents.callout,
      transparent: true,
      opacity: 0.8,
    })
    this.calloutMaterials.push(mat)
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

  /** Recolour the marks the scheme owns — callout lines and the pending
   *  ghost — in place: a scheme switch must land on what is already on
   *  screen, not wait for the next rebuild. */
  setTheme(theme: ViewTheme): void {
    this.accents = theme.accents
    for (const mat of this.calloutMaterials) mat.color.setHex(theme.accents.callout)
    if (this.previewShape)
      (this.previewShape.material as THREE.MeshStandardMaterial).color.setHex(theme.accents.ghost)
    this.ctx.invalidate()
  }

  /** Make the given elements read as selected: their translucent shells get
   *  denser, glow in their own colour, and wear a white stroke. */
  setHighlightedElements(ids: readonly number[]): void {
    this.highlightIds = new Set(ids)
    for (const [id, entry] of this.shellMaterials) this.applyHighlight(id, entry)
    this.rebuildSelectionOutlines()
    this.ctx.invalidate()
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
    const t = this.ctx.modelRadius() * 0.005

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

    if (fit.kind === 'cone') {
      // The stroke has to grow both radii by the same margin, which no scale
      // of the exact frustum can do — so the hull is a frustum of its own.
      const geo = new THREE.CylinderGeometry(
        Math.max(fit.radius2, 1e-5) + t,
        Math.max(fit.radius1, 1e-5) + t,
        Math.max(fit.length, 1e-5) + 2 * t,
        64,
        1,
        true,
      )
      const mesh = new THREE.Mesh(geo, mat)
      mesh.position.set(...fit.center)
      mesh.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3(...fit.axis).normalize(),
      )
      this.selectionGroup.add(mesh)
      this.selectionCleanup.push(() => {
        geo.dispose()
        mat.dispose()
      })
      return
    }

    const mesh = this.buildShape(fit, mat)
    if (fit.kind === 'sphere' || fit.kind === 'circle') {
      mesh.scale.setScalar(Math.max(fit.radius, 1e-5) + t)
    } else if (fit.kind === 'point') {
      mesh.scale.setScalar(Math.max(this.ctx.modelRadius() * 0.012, 1e-5) + t)
    } else if (fit.kind === 'cylinder') {
      const r = Math.max(fit.radius, 1e-5) + t
      mesh.scale.set(r, Math.max(fit.length, 1e-5) + 2 * t, r)
    } else {
      const r = Math.max(this.ctx.modelRadius() * 0.0035, 1e-5) + t
      mesh.scale.set(r, Math.max(fit.length * 1.05, 1e-5) + 2 * t, r)
    }
    this.selectionGroup.add(mesh)
    this.selectionCleanup.push(() => mat.dispose())
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
      mesh.scale.setScalar(Math.max(this.ctx.modelRadius() * 0.012, 1e-5))
      return mesh
    }
    if (fit.kind === 'line') {
      const mesh = new THREE.Mesh(this.unitCylinder, material)
      mesh.position.set(...fit.center)
      mesh.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3(...fit.dir).normalize(),
      )
      const r = Math.max(this.ctx.modelRadius() * 0.0035, 1e-5)
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
    if (fit.kind === 'cone') {
      // Two independent radii cannot come out of a scaled unit shape, so the
      // frustum gets a geometry of its own — the mesh carries it for whoever
      // must dispose it (see ownedGeometry).
      const geo = new THREE.CylinderGeometry(
        Math.max(fit.radius2, 1e-5),
        Math.max(fit.radius1, 1e-5),
        Math.max(fit.length, 1e-5),
        64,
        1,
        true,
      )
      const mesh = new THREE.Mesh(geo, material)
      mesh.position.set(...fit.center)
      mesh.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3(...fit.axis).normalize(),
      )
      mesh.userData.ownedGeometry = geo
      return mesh
    }
    if (fit.kind === 'circle') {
      const mesh = new THREE.Mesh(this.unitRing, material)
      mesh.position.set(...fit.center)
      mesh.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 0, 1),
        new THREE.Vector3(...fit.normal).normalize(),
      )
      mesh.scale.setScalar(Math.max(fit.radius, 1e-5))
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

  /** The border of an element rather than its body: the rectangle a plane patch
   *  covers, the two rims of a cylinder. Drawn ahead of the depth buffer, so it
   *  stays a crisp line even where it lies exactly on the surface it was fitted
   *  to — which, for the element a map is measured against, is everywhere.
   *
   *  It is placed by reusing buildShape's own transform, so the outline is the
   *  edge of the very shape the shell would have drawn. Null for the kinds with
   *  no border to trace.
   *
   *  Muted is an element merely on offer rather than the one in use: the same
   *  border, drawn back, so which of them the reading is measured against is
   *  still legible at a glance. */
  private buildOutline(
    fit: FitData,
    color: string,
    muted = false,
  ): { line: THREE.LineSegments; dispose: () => void } | null {
    const edges =
      fit.kind === 'plane'
        ? this.unitPlaneEdges
        : fit.kind === 'cylinder'
          ? this.unitCylinderEdges
          : null
    if (!edges) return null
    const material = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity: muted ? 0.5 : 0.95,
      depthWrite: false,
      depthTest: false,
    })
    const line = new THREE.LineSegments(edges, material)
    const placed = this.buildShape(fit, material)
    line.position.copy(placed.position)
    line.quaternion.copy(placed.quaternion)
    line.scale.copy(placed.scale)
    line.renderOrder = 3
    return { line, dispose: () => material.dispose() }
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
    if (fit.kind === 'cylinder' || fit.kind === 'cone') {
      const out = this.acrossAxis(fit.axis)
      const lift = fit.radius * 1.15
      return [out.x * lift, out.y * lift, out.z * lift]
    }
    if (fit.kind === 'circle') {
      // Just outside the ring, across its axis — the same reasoning as the
      // cylinder: the label belongs beside the curve that was measured.
      const out = this.acrossAxis(fit.normal)
      const lift = fit.radius * 1.2
      return [out.x * lift, out.y * lift, out.z * lift]
    }
    if (fit.kind === 'point' || fit.kind === 'line') return [0, this.ctx.modelRadius() * 0.03, 0]
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

  /** Radius of the centre marker — a fraction of whatever size the element
   *  has, so it stays visible without swamping small features. */
  private markerSize(fit: FitData): number {
    if (fit.kind === 'plane') return Math.max(fit.extentU, fit.extentV) * 0.04
    if (fit.kind === 'point') return this.ctx.modelRadius() * 0.008
    if (fit.kind === 'line') return this.ctx.modelRadius() * 0.006
    return fit.radius * 0.07
  }

  /** A cylinder's axis, or a plane's or circle's normal, drawn as a line from
   *  the centre. */
  private buildGuide(fit: FitData, color: string): { line: THREE.Line; dispose: () => void } | null {
    if (fit.kind === 'sphere' || fit.kind === 'point' || fit.kind === 'line') return null
    const center = new THREE.Vector3(...fit.center)
    let a: THREE.Vector3
    let b: THREE.Vector3
    if (fit.kind === 'cylinder' || fit.kind === 'cone') {
      const dir = new THREE.Vector3(...fit.axis).normalize()
      const over = fit.kind === 'cone' ? fit.radius2 : fit.radius
      const half = fit.length / 2 + over * 0.6
      a = center.clone().addScaledVector(dir, -half)
      b = center.clone().addScaledVector(dir, half)
    } else if (fit.kind === 'circle') {
      const dir = new THREE.Vector3(...fit.normal).normalize()
      a = center
      b = center.clone().addScaledVector(dir, fit.radius * 0.6)
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

  /** Translucent ghost of the element a pending fit produced. */
  setPreview(fit: FitData | null): void {
    this.ctx.invalidate()
    if (this.previewShape) {
      this.previewGroup.remove(this.previewShape)
      ;(this.previewShape.material as THREE.Material).dispose()
      ownedGeometry(this.previewShape)?.dispose()
      this.previewShape = null
    }
    this.previewFit = fit
    this.rebuildPreviewEnds()
    if (!fit) return
    const mat = new THREE.MeshStandardMaterial({
      color: this.accents.ghost,
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

  /** The end of the ghost the user has hold of, or null for none. */
  setPreviewActiveSide(side: ExtendSide | null): void {
    if (this.previewActiveSide === side) return
    this.previewActiveSide = side
    this.rebuildPreviewEnds()
    this.ctx.invalidate()
  }

  /** The colour the ghost's end marks wear — the draft's own. */
  setPreviewColor(color: string): void {
    if (this.previewColor === color) return
    this.previewColor = color
    this.rebuildPreviewEnds()
    this.ctx.invalidate()
  }

  /** The two rims of a cylinder ghost, and the cap on the end in hand. Drawn
   *  ahead of the depth buffer, like the grips: the whole point is to be seen
   *  from outside a bore, through its wall. Under the grips in draw order, so
   *  the arrow stays on top of the cap it sits on. Only a cylinder has ends
   *  to mark — a plane's edges are the bars of its grips already. */
  private rebuildPreviewEnds(): void {
    for (const fn of this.previewEndCleanup) fn()
    this.previewEndCleanup = []
    this.previewEnds.clear()
    const fit = this.previewFit
    if (!fit || fit.kind !== 'cylinder') return

    const axis = new THREE.Vector3(...fit.axis).normalize()
    const centre = new THREE.Vector3(...fit.center)
    const r = Math.max(fit.radius, 1e-5)
    const half = Math.max(fit.length, 1e-5) / 2
    // The ring and the disc lie in XY with Z as their normal; turn Z onto
    // the axis.
    const pose = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), axis)

    const ends: [ExtendSide, number][] = [
      ['start', -1],
      ['end', 1],
    ]
    for (const [side, sign] of ends) {
      const held = side === this.previewActiveSide
      const at = centre.clone().addScaledVector(axis, sign * half)

      // The rim, in the draft's colour.
      const rimMat = new THREE.MeshBasicMaterial({
        color: this.previewColor,
        transparent: true,
        opacity: 0.85,
        depthTest: false,
        depthWrite: false,
      })
      const rim = new THREE.Mesh(this.unitRim, rimMat)
      rim.position.copy(at)
      rim.quaternion.copy(pose)
      rim.scale.setScalar(r)
      rim.renderOrder = 5
      this.previewEnds.add(rim)
      this.previewEndCleanup.push(() => rimMat.dispose())
      if (!held) continue

      // The cap: an almost solid disc across the end in hand, so where the
      // tube stops reads as a surface — one that can be seen moving.
      const capMat = new THREE.MeshBasicMaterial({
        color: this.previewColor,
        transparent: true,
        opacity: 0.9,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
      })
      const cap = new THREE.Mesh(this.unitDisc, capMat)
      cap.position.copy(at)
      cap.quaternion.copy(pose)
      cap.scale.setScalar(r)
      cap.renderOrder = 4
      this.previewEnds.add(cap)
      this.previewEndCleanup.push(() => capMat.dispose())
    }
  }

  /** Pin readings to the part, each titled with the map it came off. */
  setProbes(probes: ProbeMarker[]): void {
    for (const dispose of this.probeCleanup) dispose()
    this.probeCleanup = []
    this.probeGroup.clear()
    this.probePins = []
    this.occlusionView = null
    for (const probe of probes) {
      const material = new THREE.MeshBasicMaterial({ color: PROBE_INK, depthTest: false })
      const dot = new THREE.Mesh(this.probeGeometry, material)
      dot.position.set(...probe.point)
      dot.scale.setScalar(this.ctx.modelRadius() * 0.009)
      dot.renderOrder = 4
      this.probeGroup.add(dot)

      const label = pinLabel('probe reading', probe.title, probe.label)
      label.position.set(...probe.point)
      this.probeGroup.add(label)
      this.probePins.push({ dot, label, point: new THREE.Vector3(...probe.point) })

      this.probeCleanup.push(() => {
        material.dispose()
        label.element.remove()
      })
    }
    this.ctx.invalidate()
  }

  /** Put away the pins whose spot cannot be seen from where the camera
   *  stands — on the far side of the part, or behind a feature of it — until
   *  the part turns to show them. Off, every pin shows through the part, as
   *  the dots always have. */
  setProbeOcclusion(on: boolean): void {
    if (on === this.hideOccludedProbes) return
    this.hideOccludedProbes = on
    this.occlusionView = null
    if (!on) for (const pin of this.probePins) pin.dot.visible = pin.label.visible = true
    this.ctx.invalidate()
  }

  /** Once a frame, from the viewport, before it draws: test the pins against
   *  the part again if the view has changed since they were last tested. A
   *  hover frame that moved nothing tests nothing.
   *
   *  A pin is seen when the first surface along the ray from the camera to
   *  its spot is the spot itself, give or take OCCLUSION_SLACK; anything
   *  nearer is the part in the way. The ray is set up from the spot's place
   *  on screen, exactly as a click there would be, so the test agrees with
   *  what a click would hit. */
  updateProbeOcclusion(): void {
    if (!this.hideOccludedProbes || this.probePins.length === 0) return
    const { camera, partGroup, raycaster } = this.ctx
    // The controls have moved the camera this frame; its matrices follow only
    // at render time, which is after this.
    camera.updateMatrixWorld()
    partGroup.updateMatrixWorld(true)
    const view = this.viewNow
    view.set(camera.matrixWorld.elements, 0)
    view.set(camera.projectionMatrix.elements, 16)
    view.set(partGroup.matrixWorld.elements, 32)
    const last = this.occlusionView
    if (last && view.every((v, i) => v === last[i])) return
    this.occlusionView = last ? (last.set(view), last) : view.slice()

    const occluder = this.ctx.occluder()
    const slack = this.ctx.modelRadius() * OCCLUSION_SLACK
    for (const pin of this.probePins) {
      let seen = true
      if (occluder) {
        _pinWorld.copy(pin.point).applyMatrix4(partGroup.matrixWorld)
        _pinNdc.copy(_pinWorld).project(camera)
        raycaster.setFromCamera(_pinCoords.set(_pinNdc.x, _pinNdc.y), camera)
        const hit = raycaster.intersectObject(occluder, false)[0]
        seen = !hit || hit.distance >= raycaster.ray.origin.distanceTo(_pinWorld) - slack
      }
      pin.dot.visible = pin.label.visible = seen
    }
  }

  /** Millimetres per pixel at the current zoom, reported every frame by the
   *  viewport. Only the picked-point markers ride on it — see PICK_MARKER_PX —
   *  and only a real change is worth a re-scale and a repaint. */
  setPixelScale(worldPerPixel: number): void {
    if (!(worldPerPixel > 0) || worldPerPixel === this.worldPerPixel) return
    this.worldPerPixel = worldPerPixel
    if (this.pickMarkerDots.length === 0) return
    const r = this.pickMarkerRadius()
    for (const dot of this.pickMarkerDots) dot.scale.setScalar(r)
    this.ctx.invalidate()
  }

  /** A pick marker's radius in millimetres: PICK_MARKER_PX pixels' worth at the
   *  current zoom, falling back to a fraction of the part before the first
   *  frame has said what a pixel is worth. */
  private pickMarkerRadius(): number {
    const r = this.worldPerPixel * PICK_MARKER_PX
    return r > 0 ? r : Math.max(this.ctx.modelRadius() * 0.009, 1e-5)
  }

  /** Mark the points picked for an alignment slot or for the element being
   *  fitted on the part, labelled with what they are for. They ride in the
   *  part's group like everything else measured on the scan. */
  setPickMarkers(markers: PickMarker[]): void {
    for (const dispose of this.pickMarkerCleanup) dispose()
    this.pickMarkerCleanup = []
    this.pickMarkerGroup.clear()
    this.pickMarkerDots = []
    const radius = this.pickMarkerRadius()
    for (const marker of markers) {
      const material = new THREE.MeshBasicMaterial({ color: marker.color, depthTest: false })
      const dot = new THREE.Mesh(this.probeGeometry, material)
      dot.position.set(...marker.point)
      dot.scale.setScalar(radius)
      dot.renderOrder = 4
      this.pickMarkerGroup.add(dot)
      this.pickMarkerDots.push(dot)

      const label = pinLabel('probe', marker.label, '', marker.color)
      label.position.set(...marker.point)
      this.pickMarkerGroup.add(label)

      this.pickMarkerCleanup.push(() => {
        material.dispose()
        label.element.remove()
      })
    }
    this.ctx.invalidate()
  }

  dispose(): void {
    this.updateOverlays([], [], [], false)
    this.setPreview(null)
    this.setProbes([])
    this.setPickMarkers([])
    this.probeGeometry.dispose()
    this.unitSphere.dispose()
    this.unitCylinder.dispose()
    this.unitPlane.dispose()
    this.unitRing.dispose()
    this.unitRim.dispose()
    this.unitDisc.dispose()
  }
}
