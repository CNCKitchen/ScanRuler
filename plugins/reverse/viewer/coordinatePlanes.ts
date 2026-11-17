// SPDX-License-Identifier: AGPL-3.0-only
// The part's three coordinate planes at the origin, as CAD draws its origin
// planes: a faint square in the colour of the axis each stands on, brighter
// and named under the cursor or while selected. What a model with no scan
// starts from — a click on one selects it, and the chips by it offer a
// sketch on it (ReScene's planes layer). Drawn in the depth buffer, unlike
// the planes a section is offered (src/viewer/sections.ts): these stay up
// while the part is modelled, and a body stands in front of them.

import * as THREE from 'three'
import type { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js'
import { WORLD_AXES, worldCutAxis, worldPlaneName, type WorldAxis } from '../../../src/core/section/frame'
import { AXIS_COLORS } from '../../../src/viewer/viewCube'
import { pinLabel } from '../../../src/viewer/overlays'

/** Half a plane's side, as a share of the part's size: across most of a
 *  part centred on the origin, and not so far past it that the planes are
 *  what the view is made of. */
const PLANE_HALF = 0.5
const SHEET_OPACITY = 0.06
const SHEET_LIT_OPACITY = 0.2
const BORDER_OPACITY = 0.45

export interface CoordinatePlanesContext {
  partGroup: THREE.Group
  raycaster: THREE.Raycaster
  setPickRay(clientX: number, clientY: number): void
  /** Half the part's bounding-box diagonal — what the planes are sized by. */
  modelRadius(): number
  invalidate(): void
}

interface DrawnPlane {
  axis: WorldAxis
  mesh: THREE.Mesh
  sheet: THREE.MeshBasicMaterial
  border: THREE.LineBasicMaterial
  borderGeo: THREE.BufferGeometry
  /** Where its name stands: its corner on the positive side of both of its
   *  axes, so the three names are not all at the origin. */
  corner: THREE.Vector3
}

export class CoordinatePlanes {
  private group = new THREE.Group()
  private planes: DrawnPlane[] = []
  private axes: readonly WorldAxis[] = []
  private half = 0
  private hovered: WorldAxis | null = null
  private selected: WorldAxis | null = null
  private label: CSS2DObject | null = null
  private unitPlane = new THREE.PlaneGeometry(1, 1)

  constructor(private ctx: CoordinatePlanesContext) {
    ctx.partGroup.add(this.group)
  }

  /** Draw these planes — none with an empty list — at the part's size as
   *  it is now; asked again whenever that size changes. */
  setShown(axes: readonly WorldAxis[]): void {
    const ordered = WORLD_AXES.filter((a) => axes.includes(a))
    const half = this.ctx.modelRadius() * PLANE_HALF
    if (half === this.half && ordered.length === this.axes.length && ordered.every((a, i) => a === this.axes[i])) return
    this.clear()
    this.axes = ordered
    this.half = half
    for (const axis of ordered) {
      const { dir, basisU } = worldCutAxis(axis)
      const n = new THREE.Vector3(...dir)
      const u = new THREE.Vector3(...basisU!)
      const v = n.clone().cross(u)
      const color = AXIS_COLORS[axis]
      const sheet = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: SHEET_OPACITY, depthWrite: false, side: THREE.DoubleSide })
      const mesh = new THREE.Mesh(this.unitPlane, sheet)
      mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(u, v, n))
      mesh.scale.set(2 * half, 2 * half, 1)
      mesh.renderOrder = 2
      mesh.userData.worldAxis = axis
      const corners = [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
        [-1, -1],
      ].map(([a, b]) => u.clone().multiplyScalar(a * half).addScaledVector(v, b * half))
      const borderGeo = new THREE.BufferGeometry().setFromPoints(corners)
      const border = new THREE.LineBasicMaterial({ color, transparent: true, opacity: BORDER_OPACITY })
      const line = new THREE.Line(borderGeo, border)
      line.renderOrder = 2
      this.group.add(mesh, line)
      this.planes.push({ axis, mesh, sheet, border, borderGeo, corner: corners[2] })
    }
    // A plane hovered and taken away stays hovered until the next hover
    // finds nothing there, which sets the cursor back.
    this.dress()
  }

  /** The plane the ray through a client point meets first, and how far
   *  along the ray. */
  hitAt(clientX: number, clientY: number): { axis: WorldAxis; distance: number } | null {
    if (this.planes.length === 0) return null
    this.ctx.setPickRay(clientX, clientY)
    this.group.updateWorldMatrix(true, true)
    const hit = this.ctx.raycaster.intersectObjects(
      this.planes.map((p) => p.mesh),
      false,
    )[0]
    return hit ? { axis: hit.object.userData.worldAxis as WorldAxis, distance: hit.distance } : null
  }

  /** Light the plane under the cursor, or none. Whether anything changed. */
  setHovered(axis: WorldAxis | null): boolean {
    if (axis === this.hovered) return false
    this.hovered = axis
    this.dress()
    return true
  }

  /** The plane selected, lit while it is. */
  setSelected(axis: WorldAxis | null): void {
    if (axis === this.selected) return
    this.selected = axis
    this.dress()
  }

  dispose(): void {
    this.clear()
    this.unitPlane.dispose()
    this.ctx.partGroup.remove(this.group)
  }

  /** The planes in their tones, and the name of the one lit — the one
   *  under the cursor before the one selected. */
  private dress(): void {
    for (const p of this.planes) {
      const lit = p.axis === this.hovered || p.axis === this.selected
      p.sheet.opacity = lit ? SHEET_LIT_OPACITY : SHEET_OPACITY
      p.border.opacity = lit ? 1 : BORDER_OPACITY
    }
    this.dropLabel()
    const named = this.planes.find((p) => p.axis === this.hovered) ?? this.planes.find((p) => p.axis === this.selected)
    if (named) {
      this.label = pinLabel('element-label', worldPlaneName(named.axis), '', `#${AXIS_COLORS[named.axis].toString(16).padStart(6, '0')}`)
      this.label.position.copy(named.corner)
      this.group.add(this.label)
    }
    this.ctx.invalidate()
  }

  private dropLabel(): void {
    if (!this.label) return
    this.group.remove(this.label)
    this.label.element.remove()
    this.label = null
  }

  private clear(): void {
    this.dropLabel()
    for (const p of this.planes) {
      p.sheet.dispose()
      p.border.dispose()
      p.borderGeo.dispose()
    }
    this.planes = []
    this.axes = []
    this.half = 0
    this.group.clear()
    this.ctx.invalidate()
  }
}
