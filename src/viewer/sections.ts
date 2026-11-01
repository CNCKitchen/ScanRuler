// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Sections drawn on the part: the polylines a plane cut off the scan, in the
 * section's colour, and — while one is being made — the cutting plane itself
 * as a translucent sheet through the part with the cut drawn on top of
 * everything, so the whole of it can be judged from outside, bores included.
 *
 * What was measured on a section's sheet is drawn with it: the points, lines,
 * circles and arcs fitted there, stood up in the section's plane (see
 * core/section/lift), in the section's colour and on the surface like the
 * cut, a shade heavier so a circle through a rim reads over the chain under
 * it. They carry no pins of their own — the numbers are on the sheet, and
 * one label per section is enough.
 *
 * A shadow's loops lie on its plane, not on the scan — inside the part as
 * often as not — so they are drawn ahead of the depth buffer like the
 * preview's; an extruded one stands as a translucent block in its colour
 * through the part's thickness.
 *
 * While a section has nothing to cut across yet, the scan's coordinate
 * planes are on offer through the part's centre, each a faint sheet in its
 * axis's colour that lights under the cursor — see setWorldPlanes.
 *
 * Fat lines, sized in screen pixels: a cut is a curve lying exactly on a
 * surface, and a one-pixel line there is lost in the shading. The materials
 * need the canvas size, which the viewport reports every tick. How heavy they
 * are is the operator's to set (Settings → Lines): every width here is the
 * one the line has at the default setting, and the whole set scales together
 * so the preview and the sheet's curves keep standing off from the cut.
 */
import * as THREE from 'three'
import { Line2 } from 'three/addons/lines/Line2.js'
import { LineGeometry } from 'three/addons/lines/LineGeometry.js'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import { WORLD_AXES, worldCutAxis, type SectionFrame, type WorldAxis } from '../core/section/frame'
import { sectionStroke, type SectionGeometry } from '../core/section/lift'
import { outlinePoints, shadowRegions, type ShadowShape } from '../core/section/shadow'
import type { SectionCut } from '../core/section/slice'
import type { Vec3 } from '../core/types'
import { AXIS_COLORS } from './axisGizmo'
import { SECTION_LINE_DEFAULT } from './lineWidths'
import { pinLabel } from './overlays'
import { onFramePlane, planeSheet } from './frameBasis'
import { LineWidthRegistry } from './lineWidthRegistry'

/** How the coordinate planes on offer are drawn: a fifth of the part's size
 *  about its centre — small, so they stand in the way of no element but the
 *  ones at the very middle — through the part rather than hidden inside it,
 *  where a plane through the middle of a solid part would never be seen,
 *  and faint, brighter under the cursor. */
const WORLD_PLANE_HALF = 0.2
/** A point on a section, its radius in pixels of the canvas. */
const POINT_DOT_PX = 4
const WORLD_SHEET_OPACITY = 0.18
const WORLD_SHEET_LIT_OPACITY = 0.4
const WORLD_BORDER_OPACITY = 0.7

export interface SectionOverlayItem {
  id: number
  name: string
  color: string
  frame: SectionFrame
  cut: SectionCut | null
  /** The sheet's elements in the part, the visible ones with a fit. */
  elements: readonly SectionGeometry[]
  /** A shadow stood up through the part — drawn as a block. */
  extrude?: boolean
}

export interface SectionOverlayContext {
  partGroup: THREE.Group
  /** Half the scan's bounding-box diagonal — what the preview sheet is sized to. */
  modelRadius(): number
  /** Centre of the scan, so the preview sheet is centred on the part rather
   *  than on the element it was taken along. */
  modelCenter(): Vec3
  invalidate(): void
}

export class SectionOverlay {
  private group = new THREE.Group()
  private previewGroup = new THREE.Group()
  private cleanup: (() => void)[] = []
  /** The dots of points on the sections, and what a pixel is worth. */
  private pointDots = new Set<THREE.Mesh>()
  private worldPerPixel = 0
  private previewCleanup: (() => void)[] = []
  private worldGroup = new THREE.Group()
  private worldPlanes: {
    axis: WorldAxis
    mesh: THREE.Mesh
    sheet: THREE.MeshBasicMaterial
    border: THREE.LineBasicMaterial
  }[] = []
  /** The finished cuts on screen, for cutNear. */
  private cuts: { id: number; points: Float32Array }[] = []
  /** The sheets alone, for the ray test — built once with the planes. */
  private worldMeshes: THREE.Mesh[] = []
  private worldCleanup: (() => void)[] = []
  private hoveredWorld: WorldAxis | null = null
  /** Every live fat-line material, kept sized — see setLineWidth. */
  private fatLines = new LineWidthRegistry(SECTION_LINE_DEFAULT)
  private unitPlane = new THREE.PlaneGeometry(1, 1)
  /** The dot a sheet point is drawn as, scaled per section to the model. */
  private unitSphere = new THREE.SphereGeometry(1, 24, 16)

  constructor(private ctx: SectionOverlayContext) {
    ctx.partGroup.add(this.group)
    ctx.partGroup.add(this.previewGroup)
    ctx.partGroup.add(this.worldGroup)
  }

  /** The canvas size, for the fat-line materials — every tick, a no-op
   *  unless it changed. */
  setResolution(width: number, height: number): void {
    if (this.fatLines.setResolution(width, height)) this.ctx.invalidate()
  }

  /** The finished sections, for the section view to cut — not the one being
   *  made, whose sheet is drawn through the part to be set up, nor the
   *  coordinate planes on offer. See SceneManager.dressClipped. */
  clipRoots(): THREE.Object3D[] {
    return [this.group]
  }

  /** What a pixel is worth now, from the viewport, for the points drawn on the
   *  sections: a dot held in pixels, not one sized to the whole scan. */
  setPixelScale(worldPerPixel: number): void {
    if (worldPerPixel === this.worldPerPixel) return
    this.worldPerPixel = worldPerPixel
    if (this.pointDots.size === 0) return
    const r = this.pointDotRadius()
    for (const dot of this.pointDots) dot.scale.setScalar(r)
    this.ctx.invalidate()
  }

  private pointDotRadius(): number {
    return Math.max(POINT_DOT_PX * (this.worldPerPixel || this.ctx.modelRadius() / 400), 1e-5)
  }

  /** Whether the finished sections are on screen. */
  shown(): boolean {
    return this.group.visible
  }

  /** Put the finished sections away, or back — for a picture of the part on
   *  its own. The next setSections sets it again as the workspace has it. */
  setShown(on: boolean): void {
    this.group.visible = on
    this.ctx.invalidate()
  }

  /** How heavy a finished cut is drawn, in pixels. Everything else drawn
   *  here — the preview's cut, the sheet's curves — follows in proportion,
   *  and lines already on the part take the new width without a rebuild. */
  setLineWidth(px: number): void {
    if (this.fatLines.setLineWidth(px)) this.ctx.invalidate()
  }

  /** The finished sections, rebuilt wholesale when anything about them
   *  changes — the same policy as the element overlays. */
  setSections(items: readonly SectionOverlayItem[], visible: boolean): void {
    for (const fn of this.cleanup) fn()
    this.cleanup = []
    this.group.clear()
    this.group.visible = visible
    this.ctx.invalidate()
    this.cuts = visible ? items.flatMap((item) => (item.cut ? [{ id: item.id, points: item.cut.points }] : [])) : []
    if (!visible) return
    for (const item of items) {
      // On the surface it was cut from, and hidden with it: a section on the
      // far side of the part is read by turning the part, like its tint.
      if (item.cut)
        this.addPolylines(this.group, this.cleanup, item.cut, item.color, 0.95, SECTION_LINE_DEFAULT, !item.cut.shadow)
      if (item.extrude && item.cut?.shadow) this.addBlock(this.group, this.cleanup, item.cut.shadow, item.color)
      if (item.elements.length > 0) this.addElements(this.group, this.cleanup, item.elements, item.color)
      const label = pinLabel('element-label', item.name, '', item.color)
      const lift = this.ctx.modelRadius() * 0.02
      label.position.set(
        item.frame.origin[0] + item.frame.normal[0] * lift,
        item.frame.origin[1] + item.frame.normal[1] * lift,
        item.frame.origin[2] + item.frame.normal[2] * lift,
      )
      this.group.add(label)
      this.cleanup.push(() => label.element.remove())
    }
  }

  /**
   * The finished section whose cut passes nearest the ray, within `reach` of
   * it (world units), and how far along the ray that is — or null. A cut is
   * a curve a few pixels wide lying on the scan, too thin for a ray to meet,
   * so the test is the distance from the ray: the projection is parallel, so
   * that is the distance on screen. Nothing further along the ray than
   * `maxDepth` counts — where the scan is met, give or take its scatter: a
   * cut on the far side of the part is drawn hidden and must not take the
   * click.
   */
  cutNear(ray: THREE.Ray, reach: number, maxDepth = Infinity): { id: number; depth: number } | null {
    if (!this.group.visible || this.cuts.length === 0) return null
    this.group.updateWorldMatrix(true, false)
    const m = this.group.matrixWorld
    const p = new THREE.Vector3()
    const d = new THREE.Vector3()
    let best: { id: number; depth: number } | null = null
    let bestSq = reach * reach
    for (const cut of this.cuts) {
      const n = cut.points.length / 3
      // A long cut is thinned for the test: its points lie closer together
      // than any reach a hand can hold a pointer to.
      const step = Math.max(1, Math.floor(n / 20000))
      for (let i = 0; i < n; i += step) {
        p.fromArray(cut.points, i * 3).applyMatrix4(m)
        const t = d.subVectors(p, ray.origin).dot(ray.direction)
        if (t > maxDepth) continue
        const sq = d.lengthSq() - t * t
        if (sq <= bestSq && (best === null || sq < bestSq || t < best.depth)) {
          bestSq = sq
          best = { id: cut.id, depth: t }
        }
      }
    }
    return best
  }

  /** The section being made: its plane through the part, and its cut drawn
   *  ahead of the depth buffer so every chain of it shows. Null clears. */
  setPreview(frame: SectionFrame | null, cut: SectionCut | null, color: string, extrude = false): void {
    for (const fn of this.previewCleanup) fn()
    this.previewCleanup = []
    this.previewGroup.clear()
    this.ctx.invalidate()
    if (!frame) return

    // The sheet: a square wide enough to cross the whole part, centred where
    // the part's centre falls on the plane — the element it was taken along
    // may sit right at an edge of the scan.
    const centre = onFramePlane(frame, this.ctx.modelCenter())
    const half = this.ctx.modelRadius() * 1.15
    const sheetMat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.12,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
    const sheet = planeSheet(this.unitPlane, sheetMat, frame, centre, half)
    sheet.renderOrder = 2
    this.previewGroup.add(sheet)
    this.previewCleanup.push(() => sheetMat.dispose())

    // Its border, so the sheet reads as a plane where it leaves the part.
    const u = new THREE.Vector3(...frame.basisU)
    const v = new THREE.Vector3(...frame.basisV)
    const corners = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
      [-1, -1],
    ].map(([a, b]) => centre.clone().addScaledVector(u, a * half).addScaledVector(v, b * half))
    const borderGeo = new THREE.BufferGeometry().setFromPoints(corners)
    const borderMat = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity: 0.7,
      depthTest: false,
    })
    const border = new THREE.Line(borderGeo, borderMat)
    border.renderOrder = 3
    this.previewGroup.add(border)
    this.previewCleanup.push(() => {
      borderGeo.dispose()
      borderMat.dispose()
    })

    if (cut)
      this.addPolylines(this.previewGroup, this.previewCleanup, cut, color, 1, SECTION_LINE_DEFAULT + 0.5, false)
    if (extrude && cut?.shadow) this.addBlock(this.previewGroup, this.previewCleanup, cut.shadow, color)
  }

  /** A shadow extruded: each outer loop with its holes as a shape on the
   *  sheet, stood up from the part's lowest point along the normal to its
   *  highest — translucent, so the part shows through it. */
  private addBlock(group: THREE.Group, cleanup: (() => void)[], sh: ShadowShape, color: string): void {
    const depth = sh.extent.max - sh.extent.min
    if (!(depth > 0)) return
    const step = Math.PI / 36
    const shapeOf = (pts: readonly [number, number][]) => new THREE.Path(pts.map(([u, v]) => new THREE.Vector2(u, v)))
    const shapes = shadowRegions(sh).map(({ outer, holes }) => {
      const shape = new THREE.Shape(outlinePoints(outer.pieces, step).map(([u, v]) => new THREE.Vector2(u, v)))
      shape.holes = holes.map((h) => shapeOf(outlinePoints(h.pieces, step)))
      return shape
    })
    if (shapes.length === 0) return
    const geo = new THREE.ExtrudeGeometry(shapes, { depth, bevelEnabled: false, curveSegments: 1 })
    const { origin, basisU, basisV, normal } = sh.frame
    // The sheet's [u, v] and the extrusion's z laid onto the frame, from
    // the part's lowest point along the normal.
    const base = new THREE.Vector3(...origin).addScaledVector(new THREE.Vector3(...normal), sh.extent.min)
    geo.applyMatrix4(
      new THREE.Matrix4().makeBasis(new THREE.Vector3(...basisU), new THREE.Vector3(...basisV), new THREE.Vector3(...normal)).setPosition(base),
    )
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.18,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
    const block = new THREE.Mesh(geo, mat)
    block.renderOrder = 2
    group.add(block)
    const edges = new THREE.EdgesGeometry(geo, 30)
    const edgeMat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.6, depthWrite: false })
    const outline = new THREE.LineSegments(edges, edgeMat)
    outline.renderOrder = 3
    group.add(outline)
    cleanup.push(() => {
      geo.dispose()
      mat.dispose()
      edges.dispose()
      edgeMat.dispose()
    })
  }

  /** The coordinate planes on offer while a section has nothing to cut
   *  across yet: the XY, YZ and XZ planes through `centre`, a fifth of the
   *  part's size, each in its axis's colour and drawn ahead of the depth
   *  buffer like the gizmo — a small plane through the middle of the part
   *  is inside it. Null takes them away. */
  setWorldPlanes(centre: Vec3 | null): void {
    for (const fn of this.worldCleanup) fn()
    this.worldCleanup = []
    this.worldGroup.clear()
    this.worldPlanes = []
    this.worldMeshes = []
    this.ctx.invalidate()
    if (!centre) return
    const half = this.ctx.modelRadius() * WORLD_PLANE_HALF
    const c = new THREE.Vector3(...centre)
    for (const axis of WORLD_AXES) {
      const { dir, basisU } = worldCutAxis(axis)
      const n = new THREE.Vector3(...dir)
      const u = new THREE.Vector3(...basisU!)
      const v = n.clone().cross(u)
      const color = AXIS_COLORS[axis]
      const sheet = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: WORLD_SHEET_OPACITY,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
      })
      const mesh = new THREE.Mesh(this.unitPlane, sheet)
      mesh.position.copy(c)
      mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(u, v, n))
      mesh.scale.set(2 * half, 2 * half, 1)
      mesh.renderOrder = 2
      mesh.userData.worldAxis = axis
      this.worldGroup.add(mesh)
      this.worldMeshes.push(mesh)
      const corners = [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
        [-1, -1],
      ].map(([a, b]) => c.clone().addScaledVector(u, a * half).addScaledVector(v, b * half))
      const borderGeo = new THREE.BufferGeometry().setFromPoints(corners)
      const border = new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity: WORLD_BORDER_OPACITY,
        depthTest: false,
      })
      const line = new THREE.Line(borderGeo, border)
      line.renderOrder = 3
      this.worldGroup.add(line)
      this.worldPlanes.push({ axis, mesh, sheet, border })
      this.worldCleanup.push(() => {
        sheet.dispose()
        border.dispose()
        borderGeo.dispose()
      })
    }
    // Rebuilt under a cursor that is already on one: keep that one lit.
    this.applyWorldHover()
  }

  /** Whether a coordinate plane is lit under the cursor. */
  worldPlaneLit(): boolean {
    return this.hoveredWorld !== null
  }

  hasWorldPlanes(): boolean {
    return this.worldMeshes.length > 0
  }

  /** The coordinate plane the ray meets first. The planes are drawn ahead
   *  of everything, so nothing of the part can be in front of one. */
  worldPlaneHit(raycaster: THREE.Raycaster): WorldAxis | null {
    if (this.worldMeshes.length === 0) return null
    this.worldGroup.updateWorldMatrix(true, true)
    const hit = raycaster.intersectObjects(this.worldMeshes, false)[0]
    return hit ? (hit.object.userData.worldAxis as WorldAxis) : null
  }

  /** Light the coordinate plane under the cursor, or none. Returns whether
   *  anything changed, so the owner knows to set the cursor. */
  setHoveredWorldPlane(axis: WorldAxis | null): boolean {
    if (this.hoveredWorld === axis) return false
    this.hoveredWorld = axis
    this.applyWorldHover()
    return true
  }

  private applyWorldHover(): void {
    for (const p of this.worldPlanes) {
      const lit = p.axis === this.hoveredWorld
      p.sheet.opacity = lit ? WORLD_SHEET_LIT_OPACITY : WORLD_SHEET_OPACITY
      p.border.opacity = lit ? 1 : WORLD_BORDER_OPACITY
    }
    this.ctx.invalidate()
  }

  /** The chains of a cut as screen-space fat lines. `onSurface` hides them
   *  behind the part like anything else on it; otherwise they draw ahead of
   *  the depth buffer. */
  private addPolylines(
    group: THREE.Group,
    cleanup: (() => void)[],
    cut: SectionCut,
    color: string,
    opacity: number,
    width: number,
    onSurface: boolean,
  ): void {
    const mat = new LineMaterial({
      color: new THREE.Color(color).getHex(),
      linewidth: width * this.fatLines.scale,
      transparent: true,
      opacity,
      depthTest: onSurface,
      depthWrite: false,
      worldUnits: false,
    })
    // On the surface, a hair in front of it: the curve lies exactly on the
    // triangles it was cut from and would stripe with them otherwise.
    if (onSurface) {
      mat.polygonOffset = true
      mat.polygonOffsetFactor = -2
      mat.polygonOffsetUnits = -2
    }
    const letGo = this.fatLines.track(mat, width)
    cleanup.push(() => {
      letGo()
      mat.dispose()
    })
    for (let c = 0; c + 1 < cut.offsets.length; c++) {
      const start = cut.offsets[c]
      const end = cut.offsets[c + 1]
      if (end - start < 2) continue
      const geo = new LineGeometry()
      geo.setPositions(Array.from(cut.points.subarray(start * 3, end * 3)))
      const line = new Line2(geo, mat)
      line.computeLineDistances()
      line.renderOrder = onSurface ? 3 : 5
      group.add(line)
      cleanup.push(() => geo.dispose())
    }
  }

  /** The sheet's elements, stood up in the section's plane: lines, circles
   *  and arcs as fat lines over the cut, points as dots the size of a picked
   *  point's marker. Drawn ahead of the cut in the same colour, on the
   *  surface like it. */
  private addElements(
    group: THREE.Group,
    cleanup: (() => void)[],
    elements: readonly SectionGeometry[],
    color: string,
  ): void {
    const width = SECTION_LINE_DEFAULT + 1
    const mat = new LineMaterial({
      color: new THREE.Color(color).getHex(),
      linewidth: width * this.fatLines.scale,
      transparent: true,
      opacity: 1,
      depthTest: true,
      depthWrite: false,
      worldUnits: false,
    })
    mat.polygonOffset = true
    mat.polygonOffsetFactor = -3
    mat.polygonOffsetUnits = -3
    const letGo = this.fatLines.track(mat, width)
    cleanup.push(() => {
      letGo()
      mat.dispose()
    })
    let dotMat: THREE.MeshBasicMaterial | null = null
    for (const g of elements) {
      const stroke = sectionStroke(g)
      if (!stroke) {
        // Only a point has no stroke — it is a dot where it was picked.
        if (g.kind !== 'point') continue
        dotMat ??= new THREE.MeshBasicMaterial({ color })
        const dot = new THREE.Mesh(this.unitSphere, dotMat)
        dot.position.set(g.center[0], g.center[1], g.center[2])
        this.pointDots.add(dot)
        cleanup.push(() => this.pointDots.delete(dot))
        dot.scale.setScalar(this.pointDotRadius())
        dot.renderOrder = 4
        group.add(dot)
        continue
      }
      const geo = new LineGeometry()
      geo.setPositions(stroke)
      const line = new Line2(geo, mat)
      line.computeLineDistances()
      line.renderOrder = 4
      group.add(line)
      cleanup.push(() => geo.dispose())
    }
    if (dotMat) {
      const m = dotMat
      cleanup.push(() => m.dispose())
    }
  }

  dispose(): void {
    this.setSections([], false)
    this.setPreview(null, null, '#ffffff')
    this.setWorldPlanes(null)
    this.unitPlane.dispose()
    this.unitSphere.dispose()
  }
}
