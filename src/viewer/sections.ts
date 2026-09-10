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
 * While a section has nothing to cut across yet, the scan's coordinate
 * planes are on offer through the part's centre, each a faint sheet in its
 * axis's colour that lights under the cursor — see setWorldPlanes.
 *
 * Fat lines, sized in screen pixels: a cut is a curve lying exactly on a
 * surface, and a one-pixel line there is lost in the shading. The materials
 * need the canvas size, which the viewport reports every tick.
 */
import * as THREE from 'three'
import { Line2 } from 'three/addons/lines/Line2.js'
import { LineGeometry } from 'three/addons/lines/LineGeometry.js'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import { WORLD_AXES, worldCutAxis, type SectionFrame, type WorldAxis } from '../core/section/frame'
import { sectionStroke, type SectionGeometry } from '../core/section/lift'
import type { SectionCut } from '../core/section/slice'
import type { Vec3 } from '../core/types'
import { AXIS_COLORS } from './axisGizmo'
import { pinLabel } from './overlays'

/** How the coordinate planes on offer are drawn: faint, and brighter under
 *  the cursor — the part has to stay legible through three of them. */
const WORLD_SHEET_OPACITY = 0.1
const WORLD_SHEET_LIT_OPACITY = 0.28
const WORLD_BORDER_OPACITY = 0.55

export interface SectionOverlayItem {
  id: number
  name: string
  color: string
  frame: SectionFrame
  cut: SectionCut | null
  /** The sheet's elements in the part, the visible ones with a fit. */
  elements: readonly SectionGeometry[]
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
  private previewCleanup: (() => void)[] = []
  private worldGroup = new THREE.Group()
  private worldPlanes: {
    axis: WorldAxis
    mesh: THREE.Mesh
    sheet: THREE.MeshBasicMaterial
    border: THREE.LineBasicMaterial
  }[] = []
  /** The sheets alone, for the ray test — built once with the planes. */
  private worldMeshes: THREE.Mesh[] = []
  private worldCleanup: (() => void)[] = []
  private hoveredWorld: WorldAxis | null = null
  private resolution = new THREE.Vector2(1, 1)
  private lineMaterials = new Set<LineMaterial>()
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
    if (this.resolution.x === width && this.resolution.y === height) return
    this.resolution.set(width, height)
    for (const m of this.lineMaterials) m.resolution.copy(this.resolution)
    this.ctx.invalidate()
  }

  /** The finished sections, rebuilt wholesale when anything about them
   *  changes — the same policy as the element overlays. */
  setSections(items: readonly SectionOverlayItem[], visible: boolean): void {
    for (const fn of this.cleanup) fn()
    this.cleanup = []
    this.group.clear()
    this.group.visible = visible
    this.ctx.invalidate()
    if (!visible) return
    for (const item of items) {
      // On the surface it was cut from, and hidden with it: a section on the
      // far side of the part is read by turning the part, like its tint.
      if (item.cut) this.addPolylines(this.group, this.cleanup, item.cut, item.color, 0.95, 2.5, true)
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

  /** The section being made: its plane through the part, and its cut drawn
   *  ahead of the depth buffer so every chain of it shows. Null clears. */
  setPreview(frame: SectionFrame | null, cut: SectionCut | null, color: string): void {
    for (const fn of this.previewCleanup) fn()
    this.previewCleanup = []
    this.previewGroup.clear()
    this.ctx.invalidate()
    if (!frame) return

    // The sheet: a square wide enough to cross the whole part, centred where
    // the part's centre falls on the plane — the element it was taken along
    // may sit right at an edge of the scan.
    const n = new THREE.Vector3(...frame.normal)
    const c = new THREE.Vector3(...this.ctx.modelCenter())
    const o = new THREE.Vector3(...frame.origin)
    const centre = c.clone().addScaledVector(n, -c.clone().sub(o).dot(n))
    const half = this.ctx.modelRadius() * 1.15
    const pose = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(
        new THREE.Vector3(...frame.basisU),
        new THREE.Vector3(...frame.basisV),
        n,
      ),
    )
    const sheetMat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.12,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
    const sheet = new THREE.Mesh(this.unitPlane, sheetMat)
    sheet.position.copy(centre)
    sheet.quaternion.copy(pose)
    sheet.scale.set(2 * half, 2 * half, 1)
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

    if (cut) this.addPolylines(this.previewGroup, this.previewCleanup, cut, color, 1, 3, false)
  }

  /** The coordinate planes on offer while a section has nothing to cut
   *  across yet: the XY, YZ and XZ planes through `centre`, sized like the
   *  preview sheet, each in its axis's colour. The part hides what is behind
   *  it, so a plane reads as running through the part rather than lying on
   *  it. Null takes them away. */
  setWorldPlanes(centre: Vec3 | null): void {
    for (const fn of this.worldCleanup) fn()
    this.worldCleanup = []
    this.worldGroup.clear()
    this.worldPlanes = []
    this.worldMeshes = []
    this.ctx.invalidate()
    if (!centre) return
    const half = this.ctx.modelRadius() * 1.15
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
        depthWrite: false,
        side: THREE.DoubleSide,
      })
      const mesh = new THREE.Mesh(this.unitPlane, sheet)
      mesh.position.copy(c)
      mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(u, v, n))
      mesh.scale.set(2 * half, 2 * half, 1)
      mesh.renderOrder = 1
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

  hasWorldPlanes(): boolean {
    return this.worldMeshes.length > 0
  }

  /** The coordinate plane the ray meets first, and how far along it — for
   *  the owner to weigh against whatever of the part is in front of it. */
  worldPlaneHit(raycaster: THREE.Raycaster): { axis: WorldAxis; distance: number } | null {
    if (this.worldMeshes.length === 0) return null
    this.worldGroup.updateWorldMatrix(true, true)
    const hit = raycaster.intersectObjects(this.worldMeshes, false)[0]
    return hit ? { axis: hit.object.userData.worldAxis as WorldAxis, distance: hit.distance } : null
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
      linewidth: width,
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
    mat.resolution.copy(this.resolution)
    this.lineMaterials.add(mat)
    cleanup.push(() => {
      this.lineMaterials.delete(mat)
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
    const mat = new LineMaterial({
      color: new THREE.Color(color).getHex(),
      linewidth: 3.5,
      transparent: true,
      opacity: 1,
      depthTest: true,
      depthWrite: false,
      worldUnits: false,
    })
    mat.polygonOffset = true
    mat.polygonOffsetFactor = -3
    mat.polygonOffsetUnits = -3
    mat.resolution.copy(this.resolution)
    this.lineMaterials.add(mat)
    cleanup.push(() => {
      this.lineMaterials.delete(mat)
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
        dot.scale.setScalar(Math.max(this.ctx.modelRadius() * 0.008, 1e-4))
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
