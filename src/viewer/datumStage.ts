// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The target coordinate frame, made visible while an alignment is being set
 * up: the three coordinate planes as translucent quads sized to the part,
 * with the global axes drawn as arrows out of the origin between them.
 *
 * It answers the question the alignment editor's controls keep referring to —
 * *where* is the floor the part will stand on, *which way* is +X — by putting
 * those things on the stage instead of leaving them to be imagined. The stage
 * sits in world coordinates and never moves: the part swings onto it as the
 * datums fill in.
 */
import * as THREE from 'three'
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js'

/** Axis colours, matching the corner gizmo: X red, Y green, Z blue. Each
 *  coordinate plane wears the colour of the axis it zeroes. */
const AXIS_COLORS = [0xe5534b, 0x2e7d46, 0x1877c0] as const

/** A small labelled chip in the 3D view. */
function stageLabel(text: string, color: number): CSS2DObject {
  const div = document.createElement('div')
  div.className = 'viewport-label stage-label'
  const t = document.createElement('div')
  t.className = 'label-title'
  t.textContent = text
  t.style.color = '#' + color.toString(16).padStart(6, '0')
  div.append(t)
  return new CSS2DObject(div)
}

export class DatumStage {
  private group: THREE.Group | null = null
  private cleanup: (() => void)[] = []
  private radius = 0

  constructor(private scene: THREE.Scene) {}

  /** Whether the stage is on, and at what size. */
  active(): boolean {
    return this.group !== null
  }

  /** Half the side length of the stage quads — what a camera framing the
   *  stage has to enclose. */
  extent(): number {
    return this.radius * 1.3
  }

  /** Show the stage sized to a part of the given radius, or take it down. */
  set(radius: number | null): void {
    if (radius !== null && this.group !== null && Math.abs(radius - this.radius) < 1e-9) return
    this.tearDown()
    if (radius === null) return
    this.radius = radius
    const group = new THREE.Group()
    this.group = group

    const half = this.extent()
    const quad = new THREE.PlaneGeometry(2 * half, 2 * half)
    const quadEdges = new THREE.EdgesGeometry(quad)
    this.cleanup.push(() => {
      quad.dispose()
      quadEdges.dispose()
    })

    // One coordinate plane per axis, each perpendicular to it: the unit quad
    // lies in XY (perpendicular to Z), so it is turned to face X and Y in turn.
    const facings: [THREE.Euler, string][] = [
      [new THREE.Euler(0, Math.PI / 2, 0), 'X = 0'],
      [new THREE.Euler(Math.PI / 2, 0, 0), 'Y = 0'],
      [new THREE.Euler(0, 0, 0), 'Z = 0'],
    ]
    // Where each plane's label sits: the corner of the quad nearest the
    // default front-top-right view, so the three do not pile up at the origin.
    const labelAt: [number, number, number][] = [
      [0, -half * 0.82, half * 0.82],
      [half * 0.82, 0, half * 0.82],
      [half * 0.82, -half * 0.82, 0],
    ]
    for (let axis = 0; axis < 3; axis++) {
      const color = AXIS_COLORS[axis]
      const fill = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.07,
        side: THREE.DoubleSide,
        depthWrite: false,
        // Nudged behind anything coplanar: a levelled face lies exactly on its
        // plane, and the part must win that tie without shimmering.
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      })
      const sheet = new THREE.Mesh(quad, fill)
      sheet.rotation.copy(facings[axis][0])
      group.add(sheet)

      const stroke = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.45 })
      const border = new THREE.LineSegments(quadEdges, stroke)
      border.rotation.copy(facings[axis][0])
      group.add(border)
      this.cleanup.push(() => {
        fill.dispose()
        stroke.dispose()
      })

      const label = stageLabel(facings[axis][1], color)
      label.position.set(...labelAt[axis])
      group.add(label)
      this.cleanup.push(() => label.element.remove())
    }

    // The three positive axes as arrows out of the origin, so "+X" in the
    // panel is a thing on screen rather than a convention to know.
    const shaftLen = half * 0.62
    const shaft = new THREE.CylinderGeometry(half * 0.006, half * 0.006, shaftLen, 10)
    shaft.translate(0, shaftLen / 2, 0)
    const head = new THREE.ConeGeometry(half * 0.018, half * 0.05, 14)
    head.translate(0, shaftLen + half * 0.025, 0)
    this.cleanup.push(() => {
      shaft.dispose()
      head.dispose()
    })
    const yUp = new THREE.Vector3(0, 1, 0)
    const dirs = [
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(0, 0, 1),
    ]
    const names = ['+X', '+Y', '+Z']
    for (let axis = 0; axis < 3; axis++) {
      const color = AXIS_COLORS[axis]
      const mat = new THREE.MeshBasicMaterial({ color })
      this.cleanup.push(() => mat.dispose())
      const q = new THREE.Quaternion().setFromUnitVectors(yUp, dirs[axis])
      for (const geo of [shaft, head]) {
        const part = new THREE.Mesh(geo, mat)
        part.quaternion.copy(q)
        group.add(part)
      }
      const label = stageLabel(names[axis], color)
      label.position.copy(dirs[axis]).multiplyScalar(shaftLen + half * 0.1)
      group.add(label)
      this.cleanup.push(() => label.element.remove())
    }

    this.scene.add(group)
  }

  private tearDown(): void {
    if (!this.group) return
    for (const fn of this.cleanup) fn()
    this.cleanup = []
    this.scene.remove(this.group)
    this.group = null
  }

  dispose(): void {
    this.tearDown()
  }
}
