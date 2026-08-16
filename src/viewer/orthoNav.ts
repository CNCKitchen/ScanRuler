// SPDX-License-Identifier: AGPL-3.0-only
// Mouse navigation for an orthographic viewport: orbit about the point under
// the cursor, screen-space 1:1 pan, and cursor-centric zoom — with WHICH
// buttons do what coming from the active ControlScheme (navSchemes.ts).
//
// Ported from meshStep (github.com/CNCKitchen/meshStep) so that both tools
// navigate identically. Shared by the main viewport and the split-screen point
// picker, because a navigation habit that only holds in one of them is worse
// than no setting at all.

import * as THREE from 'three'
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import {
  LMB,
  MMB,
  RMB,
  SCHEMES,
  type ControlScheme,
  type NavBinding,
  type NavAction,
} from './navSchemes'

/** Sphere enclosing everything drawn. Held by reference and re-read every
 *  frame, so the owner can re-frame its model without re-registering it. */
export interface ClipSphere {
  center: THREE.Vector3
  radius: number
}

export class OrthoNavigator {
  /** Marks the live orbit centre. The owner adds it to its own scene. */
  readonly pivotMarker: THREE.Mesh

  private scheme: ControlScheme = SCHEMES[0]
  /** The active scheme's bindings, with plain left-drag handed over to the
   *  brush while the user is painting a surface (see setPaintMode). */
  private bindings: NavBinding[] = SCHEMES[0].bindings
  private paintMode = false
  private action: NavAction | null = null
  /** Last seen `buttons` bitmask, so a chord change can be spotted. */
  private mask = 0
  private last: { x: number; y: number } | null = null
  /** Drag-zoom keeps zooming toward where the gesture started. */
  private zoomAnchor: { x: number; y: number } | null = null
  /** CATIA tick-zoom: when the second button of the chord went down. */
  private chordDown: { t: number; x: number; y: number } | null = null
  private catiaZoomLatch = false
  private pivot: THREE.Vector3 | null = null
  /** Reused when a drag starts off the part, so orbiting past the silhouette
   *  keeps turning about the same place instead of jumping to the view centre. */
  private lastPivot: THREE.Vector3 | null = null
  private orbitStart: { x: number; y: number } | null = null
  private orbitLast: { x: number; y: number } | null = null
  private orbiting = false
  private orbitRaycaster = new THREE.Raycaster()

  // Scratch: this maths runs per pointer event.
  private right = new THREE.Vector3()
  private up = new THREE.Vector3()
  private tmp = new THREE.Vector3()
  private tmp2 = new THREE.Vector3()
  private q1 = new THREE.Quaternion()
  private q2 = new THREE.Quaternion()

  constructor(
    private camera: THREE.OrthographicCamera,
    /** Owns the target and the per-frame lookAt only: its own rotate/pan/zoom
     *  must be off, because everything here drives the camera by hand. */
    private controls: OrbitControls,
    private canvas: HTMLCanvasElement,
    /** Meshes an orbit is allowed to pivot on, re-asked at every drag so
     *  hiding a model takes it out of reach. */
    private orbitTargets: () => THREE.Object3D[],
    private clipSphere: ClipSphere,
  ) {
    this.pivotMarker = new THREE.Mesh(
      new THREE.SphereGeometry(1, 16, 10),
      // Drawn over the part, so the pivot stays visible even when it sits on a
      // surface facing away.
      new THREE.MeshBasicMaterial({ color: 0xff2222, depthTest: false }),
    )
    this.pivotMarker.renderOrder = 10
    this.pivotMarker.visible = false

    const rc = this.orbitRaycaster as THREE.Raycaster & { firstHitOnly?: boolean }
    rc.firstHitOnly = true

    canvas.addEventListener('pointerdown', this.onDown)
    // Middle-click autoscroll (Windows) would swallow every middle-drag scheme.
    canvas.addEventListener('mousedown', this.onMouseDown)
    // A right-drag is navigation in most schemes (pan in the default, orbit in
    // Onshape/Tinkercad/Rhino), and the viewport has no menu of its own.
    canvas.addEventListener('contextmenu', this.onContextMenu)
    canvas.addEventListener('wheel', this.onWheel, { passive: false })
    // Move and release on the document, so a drag that leaves the canvas — off
    // the edge of the viewport, over the panel — still tracks the pointer.
    document.addEventListener('pointermove', this.onMove)
    document.addEventListener('pointerup', this.onUp)
  }

  /** Swap the pointer-button control scheme (dropdown in the status strip). */
  setScheme(scheme: ControlScheme): void {
    this.scheme = scheme
    this.rebuildBindings()
    this.cancelGesture()
  }

  /**
   * Hand both plain left-drag and plain right-drag to the caller (the surface
   * brush, which marks with one and rubs out with the other) for as long as it
   * is painting.
   *
   * Most schemes drive the camera with at least one of those buttons, and a
   * brush that fought it would be unusable. Rather than taking the gesture
   * away, the binding moves out of the way one notch: where left-drag orbits,
   * Shift+left-drag orbits instead, and the same for the right button. Middle-
   * button bindings — pan in most schemes, orbit in several — are untouched
   * either way, so there is always a route to the camera that needs no
   * modifier at all.
   */
  setPaintMode(on: boolean): void {
    if (this.paintMode === on) return
    this.paintMode = on
    this.rebuildBindings()
    this.cancelGesture()
  }

  private rebuildBindings(): void {
    if (!this.paintMode) {
      this.bindings = this.scheme.bindings
      return
    }
    const moved = this.scheme.bindings.map((b) =>
      (b.buttons === LMB || b.buttons === RMB) && !b.shift && !b.ctrl && !b.alt
        ? { ...b, shift: true }
        : b,
    )
    // A scheme that already used Shift with that button now has two bindings
    // for the same chord (Rhino's Shift+right pan behind its right-drag orbit,
    // say). First match wins, which puts the gesture that was plain — the one
    // the user reaches for without thinking — in front of the one that already
    // asked for a modifier.
    this.bindings = moved
  }

  /** Drop any in-flight gesture, so stale state cannot leak across a change of
   *  what the buttons mean. */
  private cancelGesture(): void {
    this.endOrbit()
    this.action = null
    this.mask = 0
    this.last = null
    this.zoomAnchor = null
    this.chordDown = null
    this.catiaZoomLatch = false
  }

  /** Bracket the whole model between the clip planes, wherever orbiting and
   *  panning have carried the camera. Call once per frame.
   *
   *  The near plane is allowed to go negative: an orthographic frustum is a
   *  box, so a plane behind the camera is legal, and it is what keeps a part
   *  from being sliced away after the pivot has walked the camera in. Rays cast
   *  into the scene compensate — see setPickRay. */
  updateClipPlanes(): void {
    const d = this.camera.position.distanceTo(this.clipSphere.center)
    const r = this.clipSphere.radius * 1.5 + 1e-3
    this.camera.near = d - r
    this.camera.far = d + r
    this.camera.updateProjectionMatrix()
  }

  /** Aim a raycaster through a client point.
   *
   *  Orthographic trap: setFromCamera puts the ray origin on the *camera
   *  plane*, but updateClipPlanes lets the near plane go negative, so geometry
   *  between the two is drawn yet sits behind the ray start and could never be
   *  hit. Walk the origin back until the whole model is in front of it. */
  setPickRay(raycaster: THREE.Raycaster, clientX: number, clientY: number): void {
    const rect = this.canvas.getBoundingClientRect()
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    )
    raycaster.setFromCamera(ndc, this.camera)
    const ray = raycaster.ray
    const along = this.tmp.copy(this.clipSphere.center).sub(ray.origin).dot(ray.direction)
    const back = along - this.clipSphere.radius * 1.01
    if (back < 0) ray.recast(back)
  }

  dispose(): void {
    this.canvas.removeEventListener('pointerdown', this.onDown)
    this.canvas.removeEventListener('mousedown', this.onMouseDown)
    this.canvas.removeEventListener('contextmenu', this.onContextMenu)
    this.canvas.removeEventListener('wheel', this.onWheel)
    document.removeEventListener('pointermove', this.onMove)
    document.removeEventListener('pointerup', this.onUp)
    this.pivotMarker.geometry.dispose()
    ;(this.pivotMarker.material as THREE.Material).dispose()
  }

  // ---------- chord resolution ----------

  private onDown = (e: PointerEvent): void => {
    this.syncButtons(e)
  }

  private onUp = (e: PointerEvent): void => {
    if (this.mask) this.syncButtons(e)
  }

  private onMouseDown = (e: MouseEvent): void => {
    if (e.button === 1) e.preventDefault()
  }

  private onContextMenu = (e: MouseEvent): void => {
    e.preventDefault()
  }

  /** Track the pressed-button chord and re-resolve the gesture when it changes.
   *
   *  The spec quirk this exists for: pressing or releasing a SECOND button
   *  while one is already down arrives as pointermove — not pointerdown or
   *  pointerup — so every pointer event funnels through here (via onMove for
   *  the chorded case) before being routed. */
  private syncButtons(e: PointerEvent): void {
    const mask = e.buttons & 7
    if (mask === this.mask) return
    const prev = this.mask
    this.mask = mask
    // CATIA tick-zoom: a second button quickly CLICKED (rather than held, which
    // orbits) while middle stays down flips the rest of the drag from pan to
    // zoom.
    if (this.scheme.catiaZoomTick && prev & MMB && mask & MMB) {
      if (mask & ~MMB & ~prev) {
        this.chordDown = { t: performance.now(), x: e.clientX, y: e.clientY }
      } else if (prev & ~MMB & ~mask && this.chordDown) {
        const d = this.chordDown
        if (performance.now() - d.t < 300 && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5) {
          this.catiaZoomLatch = true
        }
        this.chordDown = null
      }
    } else {
      this.chordDown = null
    }
    this.updateAction(e)
  }

  /** Re-resolve the drag action from the current button chord and modifiers.
   *  Called at every press and release, so chords switch mid-gesture. */
  private updateAction(e: PointerEvent): void {
    const mask = e.buttons & 7
    if (!(mask & MMB)) this.catiaZoomLatch = false // chord over
    let action: NavAction | null = null
    if (this.catiaZoomLatch && mask === MMB) {
      action = 'zoom'
    } else if (mask) {
      const b = this.bindings.find(
        (b) =>
          b.buttons === mask &&
          !!b.shift === e.shiftKey &&
          !!b.ctrl === e.ctrlKey &&
          !!b.alt === e.altKey,
      )
      action = b?.action ?? null
    }
    if (action === this.action) return
    this.endOrbit()
    this.action = null
    this.last = null
    this.zoomAnchor = null
    if (!action) return
    this.action = action
    if (action === 'orbit') {
      this.beginOrbit(e)
    } else {
      this.last = { x: e.clientX, y: e.clientY }
      if (action === 'zoom') this.zoomAnchor = { x: e.clientX, y: e.clientY }
    }
  }

  private onMove = (e: PointerEvent): void => {
    // Chorded button changes (a second button pressed or released mid-drag)
    // arrive as pointermove — catch them by the mask changing under a gesture.
    if (this.mask && (e.buttons & 7) !== this.mask) {
      this.syncButtons(e)
      return
    }
    if (this.action === 'orbit') this.onOrbitMove(e)
    else if (this.action === 'pan') this.onPanMove(e)
    else if (this.action === 'zoom') this.onZoomMove(e)
  }

  // ---------- the three gestures ----------

  private beginOrbit(e: PointerEvent): void {
    // Turn about the surface under the cursor; fall back to the previous pivot
    // and then to the view centre, so a drag that starts off the part still
    // rotates about something sensible.
    const pivot = this.surfaceAt(e) ?? this.lastPivot ?? this.controls.target.clone()
    this.pivot = pivot.clone()
    this.lastPivot = pivot.clone()
    this.orbitStart = { x: e.clientX, y: e.clientY }
    this.orbitLast = { x: e.clientX, y: e.clientY }
    this.orbiting = false // promoted once the drag passes the threshold
  }

  private surfaceAt(e: PointerEvent): THREE.Vector3 | null {
    const targets = this.orbitTargets()
    if (!targets.length) return null
    this.setPickRay(this.orbitRaycaster, e.clientX, e.clientY)
    const hits = this.orbitRaycaster.intersectObjects(targets, false)
    return hits.length ? hits[0].point.clone() : null
  }

  private showPivotMarker(): void {
    if (!this.pivot) return
    this.pivotMarker.position.copy(this.pivot)
    // ~1.5% of the visible half-height, so the marker reads the same size at
    // any zoom.
    this.pivotMarker.scale.setScalar((this.camera.top / this.camera.zoom) * 0.015)
    this.pivotMarker.visible = true
  }

  private onOrbitMove(e: PointerEvent): void {
    if (!this.pivot || !this.orbitLast || !this.orbitStart) return
    if (!this.orbiting) {
      const moved = Math.hypot(e.clientX - this.orbitStart.x, e.clientY - this.orbitStart.y)
      if (moved < 3) return // tolerate a click without flashing the marker
      this.orbiting = true
      this.showPivotMarker()
    }
    const dx = e.clientX - this.orbitLast.x
    const dy = e.clientY - this.orbitLast.y
    this.orbitLast = { x: e.clientX, y: e.clientY }
    if (dx === 0 && dy === 0) return

    const pivot = this.pivot
    const rotSpeed = 0.005
    // Free trackball orbit: yaw about the camera's own up axis, pitch about its
    // right axis — both screen-relative, so there is no fixed world up, no
    // polar clamp and no pole to get stuck at. camera.up follows the same
    // rotation, so OrbitControls' per-frame lookAt reproduces this orientation
    // exactly at any tilt (up is never parallel to the view direction).
    this.camera.updateMatrixWorld()
    this.right.setFromMatrixColumn(this.camera.matrixWorld, 0).normalize()
    this.up.setFromMatrixColumn(this.camera.matrixWorld, 1).normalize()

    this.q1.setFromAxisAngle(this.up, -dx * rotSpeed)
    this.q2.setFromAxisAngle(this.right, -dy * rotSpeed)
    this.q1.premultiply(this.q2)

    // Swing both the camera and the orbit target around the pivot, so the
    // target OrbitControls still owns stays consistent with the new pose.
    this.tmp.copy(this.camera.position).sub(pivot).applyQuaternion(this.q1)
    this.camera.position.copy(pivot).add(this.tmp)
    this.tmp2.copy(this.controls.target).sub(pivot).applyQuaternion(this.q1)
    this.controls.target.copy(pivot).add(this.tmp2)
    this.camera.up.applyQuaternion(this.q1)
    this.camera.quaternion.premultiply(this.q1)
    this.camera.updateMatrixWorld()
  }

  private endOrbit(): void {
    if (!this.pivot) return
    this.pivot = null
    this.orbitStart = null
    this.orbitLast = null
    this.orbiting = false // the free orbit keeps its tilt — no re-levelling
    this.pivotMarker.visible = false
  }

  /** Screen-space pan: translate camera and target along the view plane, so the
   *  model follows the cursor exactly 1:1. */
  private onPanMove(e: PointerEvent): void {
    if (!this.last) return
    const dx = e.clientX - this.last.x
    const dy = e.clientY - this.last.y
    this.last = { x: e.clientX, y: e.clientY }
    if (dx === 0 && dy === 0) return
    const h = Math.max(1, this.canvas.clientHeight)
    const worldPerPx = (this.camera.top - this.camera.bottom) / this.camera.zoom / h
    this.camera.updateMatrixWorld()
    this.right.setFromMatrixColumn(this.camera.matrixWorld, 0).normalize()
    this.up.setFromMatrixColumn(this.camera.matrixWorld, 1).normalize()
    this.tmp
      .copy(this.right)
      .multiplyScalar(-dx * worldPerPx)
      .addScaledVector(this.up, dy * worldPerPx)
    this.camera.position.add(this.tmp)
    this.controls.target.add(this.tmp)
    this.controls.update()
  }

  /** Drag-zoom (Shift+middle in SolidWorks, the CATIA chord, …): drag up to
   *  zoom in, about the point where the gesture started. */
  private onZoomMove(e: PointerEvent): void {
    if (!this.last || !this.zoomAnchor) return
    const dy = e.clientY - this.last.y
    this.last = { x: e.clientX, y: e.clientY }
    if (dy === 0) return
    this.zoomAt(Math.exp(-dy * 0.005), this.zoomAnchor.x, this.zoomAnchor.y)
  }

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault()
    // SolidWorks/Autodesk/NX muscle memory: their schemes zoom OUT on scroll up.
    const zoomIn = this.scheme.wheelZoomsOut ? e.deltaY > 0 : e.deltaY < 0
    this.zoomAt(zoomIn ? 1.1 : 1 / 1.1, e.clientX, e.clientY)
  }

  /** Cursor-centric zoom: scale the frustum, then shift the camera so the world
   *  point under (clientX, clientY) re-projects to the same screen position. */
  private zoomAt(factor: number, clientX: number, clientY: number): void {
    const rect = this.canvas.getBoundingClientRect()
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1
    const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1
    this.camera.updateMatrixWorld()
    this.tmp.set(ndcX, ndcY, 0).unproject(this.camera)
    this.camera.zoom = Math.max(0.02, Math.min(2000, this.camera.zoom * factor))
    this.camera.updateProjectionMatrix()
    this.tmp2.set(ndcX, ndcY, 0).unproject(this.camera)
    this.tmp.sub(this.tmp2)
    this.camera.position.add(this.tmp)
    this.controls.target.add(this.tmp)
    this.controls.update()
    if (this.orbiting) this.showPivotMarker()
  }
}
