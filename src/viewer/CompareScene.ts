// SPDX-License-Identifier: AGPL-3.0-only
// The reference half of the deviation split view: the nominal part on its own,
// solid, turning with the scan in the viewport beside it.
//
// A viewport of its own rather than a second pass over the main scene, for the
// same reason the point picker's halves are: the two parts have to be looked at
// apart from each other, and three.js keeps GPU state per renderer, so the
// reference geometry — BVH and all — is drawn here without a second copy of it.
// Borrowed, never owned: disposing it here would take the main view's reference
// with it.

import * as THREE from 'three'
import { CameraLink, type LinkedView } from './cameraLink'
import type { ControlScheme } from './navSchemes'
import { OrthoViewport } from './orthoViewport'
import { applyFinish, setSurfaceColor, type ViewTheme } from './viewThemes'

export class CompareScene {
  private viewport: OrthoViewport
  private material: THREE.MeshStandardMaterial
  private mesh: THREE.Mesh
  private link: CameraLink | null = null

  constructor(container: HTMLDivElement, geometry: THREE.BufferGeometry, theme: ViewTheme) {
    this.viewport = new OrthoViewport(container, {
      theme,
      navTargets: () => [this.mesh],
      // Nothing is picked on this side. Every reading is taken on the scan, in
      // the other half; this one is the shape being compared against.
      onClick: () => {},
      // The link is driven from the frame loop rather than from the two cameras'
      // change events: writing one camera makes the other fire a change of its
      // own, and telling that echo apart from a gesture costs more than the
      // handful of comparisons a tick does.
      onTick: () => this.link?.tick(),
    })

    // Bare-surface colour, not the reference's own: the ghost is a contrasting
    // blue because it lies *inside* a scan of nearly the same shape, and two
    // greys in one place read as one washed-out object. Here each part has a
    // frame to itself, so that reason is gone and the opposite applies — one
    // material under one light in both halves is what leaves the shape as the
    // only thing that differs between the two pictures. The captions say which
    // is which. Double-sided like every other part in the tool: a reference mesh
    // may have holes too.
    this.material = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide })
    setSurfaceColor(this.material.color, theme)
    applyFinish(this.material, theme)
    this.mesh = new THREE.Mesh(geometry, this.material)
    this.viewport.scene.add(this.mesh)

    if (!geometry.boundingBox) geometry.computeBoundingBox()
    // Framed on its own part first, so the half is never empty for a frame; the
    // link overwrites this with the main viewport's pose the moment it is made.
    // It also leaves this half a clip sphere of its own, which is what its near
    // and far planes are rebuilt from every frame.
    this.viewport.frameCamera(geometry.boundingBox!, null)
  }

  /** Hold this half in the same pose as the scan's viewport, in both
   *  directions: either half can be the one under the hand. */
  linkTo(scan: LinkedView): void {
    this.link = new CameraLink(scan, this.viewport.viewLink())
  }

  /** Match the main viewport's buttons — one navigation habit across the whole
   *  tool, and doubly so for two halves side by side. */
  setNavScheme(scheme: ControlScheme): void {
    this.viewport.setNavScheme(scheme)
  }

  /** And the same colour scheme, for the same reason: two halves of one view
   *  lit differently would read as two instruments. */
  setViewTheme(theme: ViewTheme): void {
    this.viewport.setTheme(theme)
    setSurfaceColor(this.material.color, theme)
    applyFinish(this.material, theme)
    this.viewport.invalidate()
  }

  dispose(): void {
    this.material.dispose()
    this.viewport.dispose()
  }
}
