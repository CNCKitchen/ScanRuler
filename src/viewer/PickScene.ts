// SPDX-License-Identifier: AGPL-3.0-only
import * as THREE from 'three'
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js'
import type { Vec3 } from '../core/types'
import { SurfaceMarking, type PaintBrush } from './marking'
import type { ControlScheme } from './navSchemes'
import { OrthoViewport } from './orthoViewport'
import { paintUniform, patchPaintTint, setPaintUniform } from './paintTint'
import type { MarkingChannel } from './SceneManager'
import { applyFinish, setSurfaceColor, type ViewTheme } from './viewThemes'

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
 *
 * The scan's half also marks. Which surface a fit is measured on is a question
 * about the scan — spray, print supports, the fixture it was scanned on — and
 * this is where the operator is already looking at it, so the same three
 * gestures the rest of the tool marks with are offered here. What they lay down
 * is the scan's one marking (see SceneManager.markingChannel), not a copy of
 * it.
 */
export class PickScene {
  private viewport: OrthoViewport
  private material: THREE.MeshStandardMaterial
  private mesh: THREE.Mesh
  private markerGroup = new THREE.Group()
  private markerGeometry: THREE.SphereGeometry
  private markerCleanup: (() => void)[] = []
  private markerRadius: number
  /** The marking gestures for this canvas, or null in the half that shows the
   *  reference — a reference is CAD, and there is no surface on it to leave
   *  out of a fit. */
  private marking: SurfaceMarking | null = null
  /** Identity stand-in for the main viewport's part group: this half draws the
   *  scan in its own coordinates, and the marking still needs somewhere to hang
   *  its footprint and a frame to convert hits through. */
  private partGroup = new THREE.Group()
  private uPaintColor = paintUniform()
  /** Last cursor position, and whether it has been tested yet — the brush
   *  footprint is resolved once per frame rather than once per pointermove. */
  private hoverAt: { x: number; y: number } | null = null
  private hoverDirty = false

  onPick: ((point: Vec3) => void) | null = null
  /** How many vertices the marking covers, reported when a gesture ends. */
  onPaintChange: ((count: number) => void) | null = null

  constructor(
    container: HTMLDivElement,
    geometry: THREE.BufferGeometry,
    theme: ViewTheme,
    channel?: MarkingChannel,
  ) {
    this.viewport = new OrthoViewport(container, {
      theme,
      navTargets: () => [this.mesh],
      onPointerDown: (e) =>
        this.marking != null && this.marking.pointerGesture() !== null
          ? this.marking.handlePointerDown(e)
          : false,
      // A pinch beginning under a live stroke: the stroke keeps what it took
      // and ends there, rather than being dragged across the part by a hand
      // that has moved on to navigating.
      onMultiTouch: () => this.marking?.endGesture(),
      onTick: () => {
        this.marking?.drainStroke()
        this.updateHover()
      },
      onClick: (x, y) => {
        const point = this.pick(x, y)
        if (point) this.onPick?.(point)
      },
    })
    this.viewport.scene.add(this.markerGroup)
    this.viewport.scene.add(this.partGroup)

    // Flat colour, not the scan's vertex colours: in this view both parts have
    // to look like the same kind of object, so the eye is comparing shapes and
    // not a coloured map against a plain reference. Bare-surface colour for
    // both, because that is what an unmeasured part looks like in this scheme.
    this.material = new THREE.MeshStandardMaterial({
      side: THREE.DoubleSide,
      vertexColors: false,
    })
    setSurfaceColor(this.material.color, theme)
    applyFinish(this.material, theme)
    // The marking is the one thing that does colour this surface, and it
    // arrives through the mask rather than the vertex colours — see
    // paintTint.ts.
    if (channel) patchPaintTint(this.material, this.uPaintColor)
    this.mesh = new THREE.Mesh(geometry, this.material)
    this.viewport.scene.add(this.mesh)

    if (!geometry.boundingBox) geometry.computeBoundingBox()
    const box = geometry.boundingBox!
    const diagonal = box.min.distanceTo(box.max)
    this.markerRadius = Math.max(diagonal * 0.011, 1e-4)
    this.markerGeometry = new THREE.SphereGeometry(1, 20, 14)

    if (channel) this.armMarking(container, channel, theme)

    // No broadside axis here: the part is in an arbitrary pose and is about to
    // be turned by hand anyway, so the plain three-quarter view is enough.
    this.viewport.frameCamera(box, null)
  }

  /** Hang the marking gestures off this canvas, over the scan's shared mask. */
  private armMarking(
    container: HTMLDivElement,
    channel: MarkingChannel,
    theme: ViewTheme,
  ): void {
    this.marking = new SurfaceMarking({
      container,
      camera: this.viewport.camera,
      partGroup: this.partGroup,
      raycaster: this.viewport.raycaster,
      regions: channel.regions,
      setPickRay: (x, y) => this.viewport.setPickRay(x, y),
      mesh: () => this.mesh,
      paintAttr: channel.paintAttr,
      // Both uniforms: one mask, two renderers, and the tint has to be the same
      // colour on this canvas as on the main one.
      setPaintColor: (rgb) => {
        setPaintUniform(this.uPaintColor, rgb)
        channel.setPaintColor(rgb)
        this.viewport.invalidate()
      },
      invalidate: this.viewport.invalidate,
      claimDrag: (on) => this.viewport.nav.setPaintMode(on),
      requestHover: () => {
        this.hoverDirty = true
      },
      onPaintChange: (count) => this.onPaintChange?.(count),
    })
    this.marking.setTheme(theme)
    const canvas = this.viewport.renderer.domElement
    canvas.addEventListener('pointermove', (e) => {
      this.hoverAt = { x: e.clientX, y: e.clientY }
      this.hoverDirty = true
    })
    canvas.addEventListener('pointerleave', () => {
      this.hoverAt = null
      this.hoverDirty = true
    })
  }

  /** Match the main viewport's buttons: a pose picked here is checked against
   *  the model there, so the two must not navigate differently. */
  setNavScheme(scheme: ControlScheme): void {
    this.viewport.setNavScheme(scheme)
  }

  /** And the same colour scheme: the pose picked here is checked against the
   *  model in the main viewport, so the two must not look different either. */
  setViewTheme(theme: ViewTheme): void {
    this.viewport.setTheme(theme)
    setSurfaceColor(this.material.color, theme)
    applyFinish(this.material, theme)
    this.marking?.setTheme(theme)
    this.viewport.invalidate()
  }

  /** Bring the part back into the frame from wherever it has been turned to,
   *  without turning it any further — see OrthoViewport.fitCamera. */
  fitToView(): void {
    const box = (this.mesh.geometry as THREE.BufferGeometry).boundingBox
    if (box) this.viewport.fitCamera(box)
  }

  /** Arm the marking for this half, or pass null to put it away — which also
   *  rubs out what it marked, the same bargain every other marking session
   *  makes. Only the scan's half has one. */
  setPaintBrush(brush: PaintBrush | null): void {
    this.marking?.setPaintBrush(brush)
  }

  /** Rub out the marking; the tools stay as they are. */
  clearPaint(): void {
    this.marking?.clearPaint()
  }

  /** One pointer test per frame, and only when the answer could have changed —
   *  a mouse emits hundreds of moves a second and only the last is on screen. */
  private updateHover(): void {
    if (!this.hoverDirty || !this.marking) return
    this.hoverDirty = false
    if (this.marking.armed()) this.marking.updateBrushRing(this.hoverAt)
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
    // The gestures go; the marking itself does not. It lives on the scan's
    // shared mask, and what becomes of it is decided by whoever opened this
    // picker, not by the canvas closing.
    this.marking?.dispose()
    this.markerGeometry.dispose()
    this.material.dispose()
    this.viewport.dispose()
  }
}
