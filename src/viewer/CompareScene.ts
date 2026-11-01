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
import { OrthoViewport, type Projection } from './orthoViewport'
import { applyFinish, setSurfaceColor, type ViewTheme } from './viewThemes'
import { backfaceUniforms, spliceBackfaceTint } from './backfaceTint'
import { CAP_SLOT, closedPartOf, cutColor, SliceCap } from './sliceCap'
import {
  SEE_THROUGH_OPACITY,
  setSurfaceOpacity,
  spliceWireframe,
  wireUniforms,
} from './surfaceModes'

export class CompareScene {
  private viewport: OrthoViewport
  private material: THREE.MeshStandardMaterial
  private mesh: THREE.Mesh
  private link: CameraLink | null = null
  /** This half's own pair of back-face uniforms: the switch is one statement
   *  about the models, but three.js keeps GPU state per renderer and this is a
   *  renderer of its own. */
  private backface: ReturnType<typeof backfaceUniforms>
  /** And its own mesh-mode switch, for the same reason. */
  private wire = wireUniforms()
  /** The section view's plane, read off the scan's half every frame — see
   *  followSection — held here as the one plane the material clips by, with
   *  the cap that closes the part where it is closed. */
  private sectionSource: (() => THREE.Plane | null) | null = null
  private clipPlane = new THREE.Plane()
  private clipList = [this.clipPlane]
  private cut = false
  private cap: SliceCap | null = null
  private capGeometry = new THREE.PlaneGeometry(1, 1)
  private theme: ViewTheme
  private seeThrough = false

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
      onTick: () => {
        this.link?.tick()
        this.followCut()
      },
    })
    this.theme = theme
    // The section view's plane is a clip on the material — see followSection.
    this.viewport.renderer.localClippingEnabled = true

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
    // Double-sided means the far side of every triangle is drawn, so this half
    // needs the same flag the scan's half has: a reference with a hole in it —
    // a STEP tessellation that came apart, an open mesh — must not read as
    // solid part on one side of the screen and as a warning on the other.
    this.backface = backfaceUniforms(theme.backface)
    this.material.onBeforeCompile = (shader) => {
      spliceBackfaceTint(shader, this.backface)
      spliceWireframe(shader, this.wire)
    }
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

  /** Cut this half where the scan's half is cut by the section view: the
   *  plane, in world coordinates — the reference's, which both halves share
   *  — read every frame, so a drag of it on the other side moves it here
   *  too; null while it cuts nothing. */
  followSection(source: () => THREE.Plane | null): void {
    this.sectionSource = source
  }

  private followCut(): void {
    const plane = this.sectionSource?.() ?? null
    if (!plane) {
      if (!this.cut) return
      this.cut = false
      this.material.clippingPlanes = null
      this.material.needsUpdate = true
      this.updateCap()
      this.viewport.invalidate()
      return
    }
    if (this.cut && this.clipPlane.equals(plane)) return
    this.clipPlane.copy(plane)
    if (!this.cut) {
      this.cut = true
      this.material.clippingPlanes = this.clipList
      this.material.needsUpdate = true
    }
    this.updateCap()
    this.viewport.invalidate()
  }

  /** Closed where the part is closed, in the cut colour the scan's half
   *  wears — one material in both halves — while it is drawn solid. */
  private updateCap(): void {
    const closed = this.cut && !this.seeThrough ? closedPartOf(this.mesh.geometry) : null
    if (!closed || closed.count === 0) {
      this.cap?.dispose()
      this.cap = null
      return
    }
    this.cap ??= new SliceCap(this.mesh, this.clipList, this.capGeometry, {
      slot: CAP_SLOT.scan,
      color: cutColor(CAP_SLOT.scan),
      flat: true,
      theme: this.theme,
      closed,
    })
    const box = this.mesh.geometry.boundingBox!
    this.cap.place(box.getCenter(new THREE.Vector3()), (box.min.distanceTo(box.max) / 2) * 1.3)
  }

  /** Match the main viewport's buttons — one navigation habit across the whole
   *  tool, and doubly so for two halves side by side. */
  setNavScheme(scheme: ControlScheme): void {
    this.viewport.setNavScheme(scheme)
  }

  /** Drawn the way the main view is, in parallel or in perspective: the
   *  two halves are held in one pose and must read as one view. */
  setProjection(projection: Projection): void {
    this.viewport.setProjection(projection)
  }

  /** And the same colour scheme, for the same reason: two halves of one view
   *  lit differently would read as two instruments. */
  setViewTheme(theme: ViewTheme): void {
    this.viewport.setTheme(theme)
    setSurfaceColor(this.material.color, theme)
    applyFinish(this.material, theme)
    this.backface.uBackfaceColor.value.setHex(theme.backface)
    this.theme = theme
    // The cap is lit in the new scheme's finish.
    this.cap?.dispose()
    this.cap = null
    this.updateCap()
    this.viewport.invalidate()
  }

  /** Which way the reference's surface faces, driven by the one switch in the
   *  view bar. Opening the split view has to push the switch's current
   *  state in here, or this half would start off disagreeing with the other. */
  setBackfaceTint(on: boolean): void {
    this.backface.uBackfaceTint.value = on ? 1 : 0
    this.viewport.invalidate()
  }

  /** The triangle edges, from the same switch as the scan's half. */
  setWireframe(on: boolean): void {
    this.wire.uWire.value = on ? 1 : 0
    this.viewport.invalidate()
  }

  /** See-through, from the same switch as the scan's half. */
  setTranslucent(on: boolean): void {
    setSurfaceOpacity(this.material, on ? SEE_THROUGH_OPACITY : 1)
    // Cut but not capped while see-through, as in the scan's half.
    this.seeThrough = on
    this.updateCap()
    this.viewport.invalidate()
  }

  dispose(): void {
    this.cap?.dispose()
    this.capGeometry.dispose()
    this.material.dispose()
    this.viewport.dispose()
  }
}
