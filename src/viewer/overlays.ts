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
import type { FitData, Vec3 } from '../core/types'
import type { PickMarker } from './PickScene'

/** The ghost shape of an unconfirmed fit is neutral grey — only the marked
 *  surfaces carry the colour the element will get, so "picked" and "measured"
 *  never look the same. */
const PREVIEW_SHAPE_COLOR = 0x8e9298

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

/** A deviation reading pinned to the part. */
export interface ProbeMarker {
  id: number
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

/** What the overlays need from the viewport around them. */
export interface OverlaysContext {
  partGroup: THREE.Group
  /** Half the scan's bounding-box diagonal — the scale sizeless things
   *  (points, lines, markers) are drawn at. */
  modelRadius(): number
  invalidate(): void
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
  /** Overlay meshes that can stand in for their element in a click, and the
   *  materials to restyle when that element is selected. */
  private overlayPickables: THREE.Mesh[] = []
  private shellMaterials = new Map<number, { material: THREE.MeshStandardMaterial; color: string }>()
  private highlightIds = new Set<number>()
  private lastOverlayElements: OverlayElement[] = []
  private previewShape: THREE.Mesh | null = null
  private unitSphere = new THREE.SphereGeometry(1, 48, 32)
  /** Open-ended so the scan surface stays visible through the tube. */
  private unitCylinder = new THREE.CylinderGeometry(1, 1, 1, 64, 1, true)
  private unitPlane = new THREE.PlaneGeometry(1, 1)
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
    /** Draw the elements as bare outlines rather than translucent bodies. For an
     *  element a deviation map is measured against: it sits exactly on the
     *  surface it was fitted to, so a shell over it would both fight the depth
     *  buffer along that surface and wash the colour of the reading underneath —
     *  and on a map the colour *is* the measurement. */
    outlined = false,
  ): void {
    this.ctx.invalidate()
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
      if (outlined) {
        const outline = this.buildOutline(el.fit, el.color)
        if (outline) {
          this.overlayGroup.add(outline.line)
          this.overlayCleanup.push(outline.dispose)
        }
      } else {
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
    const R = this.ctx.modelRadius() * 0.16
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
    const mesh = this.buildShape(fit, mat)
    if (fit.kind === 'sphere') {
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
   *  no border to trace. */
  private buildOutline(fit: FitData, color: string): { line: THREE.LineSegments; dispose: () => void } | null {
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
      opacity: 0.95,
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
    if (fit.kind === 'cylinder') {
      const out = this.acrossAxis(fit.axis)
      const lift = fit.radius * 1.15
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

  /** Translucent ghost of the element a pending fit produced. */
  setPreview(fit: FitData | null): void {
    this.ctx.invalidate()
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

  /** Pin deviation readings to the part. */
  setProbes(probes: ProbeMarker[]): void {
    for (const dispose of this.probeCleanup) dispose()
    this.probeCleanup = []
    this.probeGroup.clear()
    for (const probe of probes) {
      const material = new THREE.MeshBasicMaterial({ color: probe.color, depthTest: false })
      const dot = new THREE.Mesh(this.probeGeometry, material)
      dot.position.set(...probe.point)
      dot.scale.setScalar(this.ctx.modelRadius() * 0.009)
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
    this.ctx.invalidate()
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
      dot.scale.setScalar(this.ctx.modelRadius() * 0.009)
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
  }
}
