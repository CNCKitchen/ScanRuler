// SPDX-License-Identifier: AGPL-3.0-only
import * as THREE from 'three'
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js'
import type { Vec3 } from '../core/types'
import type { ControlScheme } from './navSchemes'
import { OrthoViewport } from './orthoViewport'

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
  private viewport: OrthoViewport
  private material: THREE.MeshStandardMaterial
  private mesh: THREE.Mesh
  private markerGroup = new THREE.Group()
  private markerGeometry: THREE.SphereGeometry
  private markerCleanup: (() => void)[] = []
  private markerRadius: number

  onPick: ((point: Vec3) => void) | null = null

  constructor(container: HTMLDivElement, geometry: THREE.BufferGeometry) {
    this.viewport = new OrthoViewport(container, {
      background: STAGE_BG,
      keyLightIntensity: 1.5,
      navTargets: () => [this.mesh],
      onClick: (x, y) => {
        const point = this.pick(x, y)
        if (point) this.onPick?.(point)
      },
    })
    this.viewport.scene.add(this.markerGroup)

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
    this.viewport.scene.add(this.mesh)

    if (!geometry.boundingBox) geometry.computeBoundingBox()
    const box = geometry.boundingBox!
    const diagonal = box.min.distanceTo(box.max)
    this.markerRadius = Math.max(diagonal * 0.011, 1e-4)
    this.markerGeometry = new THREE.SphereGeometry(1, 20, 14)

    // No broadside axis here: the part is in an arbitrary pose and is about to
    // be turned by hand anyway, so the plain three-quarter view is enough.
    this.viewport.frameCamera(box, null)
  }

  /** Match the main viewport's buttons: a pose picked here is checked against
   *  the model there, so the two must not navigate differently. */
  setNavScheme(scheme: ControlScheme): void {
    this.viewport.setNavScheme(scheme)
  }

  private pick(clientX: number, clientY: number): Vec3 | null {
    this.viewport.setPickRay(clientX, clientY)
    const hit = this.viewport.raycaster.intersectObject(this.mesh, false)[0]
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
    this.viewport.invalidate()
  }

  dispose(): void {
    this.setMarkers([])
    this.markerGeometry.dispose()
    this.material.dispose()
    this.viewport.dispose()
  }
}
