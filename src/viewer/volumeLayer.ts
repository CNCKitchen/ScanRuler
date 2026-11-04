// SPDX-License-Identifier: AGPL-3.0-only
// The deviation as volumes, drawn: each region's cells' outer faces
// (core/deviation/volume), excess in the map's red, missing in violet —
// the scan itself is drawn blue in some schemes —
// unsure in grey, in the reference's frame. Drawn twice: once against the
// parts like any surface, and once more faintly through them, so a region
// behind a wall or inside a cavity is not hidden by it. The region under the
// pointer in the panel's list lights up.

import * as THREE from 'three'
import type { VolumeDeviation, VolumeKind, VolumeShell } from '../core/deviation/volume'

/** The kinds' colours, the panel's swatches too: material the reference has
 *  and the part has not in the red of a reading proud of the part, material
 *  missing in violet, off the blue some schemes draw the scan in. */
export const VOLUME_COLORS: Record<VolumeKind, string> = { excess: '#d63c2f', missing: '#8a3fe0', unsure: '#9b948a' }
const HOVER_COLOR = '#ffc21a'
const KINDS: VolumeKind[] = ['excess', 'missing', 'unsure']

export class VolumeLayer {
  readonly group = new THREE.Group()
  private shells: { kind: VolumeKind; shell: VolumeShell; colors: THREE.BufferAttribute }[] = []
  /** The two materials every measurement is drawn with, kept for the layer's
   *  life: a measurement replaced would otherwise let them go and, with them,
   *  the shader programs they hold, to be compiled again for the next. */
  private front: THREE.MeshStandardMaterial | null = null
  private through: THREE.MeshBasicMaterial | null = null
  private geometries: THREE.BufferGeometry[] = []
  private hovered: number | null = null

  constructor() {
    this.group.visible = false
    this.group.name = 'volume-regions'
  }

  /** The regions of a measurement, or none. */
  set(volume: VolumeDeviation | null): void {
    this.clear()
    if (!volume?.meshes) return
    const front = (this.front ??= new THREE.MeshStandardMaterial({ vertexColors: true, transparent: true, opacity: 0.85, side: THREE.DoubleSide, roughness: 1, metalness: 0, polygonOffset: true, polygonOffsetFactor: -1 }))
    const through = (this.through ??= new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthTest: false, depthWrite: false }))
    for (const kind of KINDS) {
      const shell = volume.meshes[kind]
      if (shell.indices.length === 0) continue
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(shell.positions, 3))
      const colors = new THREE.BufferAttribute(new Float32Array(shell.positions.length), 3)
      geometry.setAttribute('color', colors)
      geometry.setIndex(new THREE.BufferAttribute(shell.indices, 1))
      geometry.computeVertexNormals()
      geometry.computeBoundingSphere()
      this.geometries.push(geometry)
      const solid = new THREE.Mesh(geometry, front)
      solid.renderOrder = 4
      const ghost = new THREE.Mesh(geometry, through)
      ghost.renderOrder = 5
      this.group.add(solid, ghost)
      this.shells.push({ kind, shell, colors })
    }
    this.paint()
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible && this.shells.length > 0
  }

  /** Light up one region, by its index in the measurement's list, or none. */
  highlight(region: number | null): void {
    if (region === this.hovered) return
    this.hovered = region
    this.paint()
  }

  private paint(): void {
    const hover = new THREE.Color(HOVER_COLOR)
    for (const { kind, shell, colors } of this.shells) {
      const base = new THREE.Color(VOLUME_COLORS[kind])
      const a = colors.array as Float32Array
      // Four corners a face, two triangles a face: a vertex's region is its
      // face's first triangle's.
      for (let v = 0; v < a.length / 3; v++) {
        const c = shell.region[(v >> 2) * 2] === this.hovered ? hover : base
        a[v * 3] = c.r
        a[v * 3 + 1] = c.g
        a[v * 3 + 2] = c.b
      }
      colors.needsUpdate = true
    }
  }

  private clear(): void {
    this.group.clear()
    for (const g of this.geometries) g.dispose()
    this.geometries = []
    this.shells = []
    this.hovered = null
    this.group.visible = false
  }

  dispose(): void {
    this.clear()
    this.front?.dispose()
    this.through?.dispose()
    this.front = this.through = null
  }
}
