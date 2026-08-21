// SPDX-License-Identifier: AGPL-3.0-only
// Mouse navigation for an orthographic viewport: orbit about the point under
// the cursor, screen-space 1:1 pan, and cursor-centric zoom — with WHICH
// buttons do what coming from the active ControlScheme (navSchemes.ts).
//
// Touch drives the same three gestures through a separate reading of the
// pointer stream (see "touch gestures" below): a finger has no buttons, so no
// control scheme could describe it, and the tablet convention — one finger
// turns, two fingers pan and pinch — is the same in every CAD tool that has an
// iPad client.
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

  /** Fires whenever a gesture here changes what is on screen — the camera
   *  moving, the pivot marker coming or going — so an owner that only renders
   *  on demand knows the frame is worth drawing. */
  onChange: (() => void) | null = null

  private scheme: ControlScheme = SCHEMES[0]
  /** The active scheme's bindings, with plain left-drag handed over to the
   *  brush while the user is painting a surface (see setPaintMode). */
  private bindings: NavBinding[] = SCHEMES[0].bindings
  private paintMode = false
  /** A flat document has no third dimension to turn into: every orbit binding
   *  pans instead, and a single finger drags the sheet. See setPlanar. */
  private planar = false
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

  /** Fingers currently down on the canvas, in the order they landed — the
   *  first two are the ones a two-finger gesture is read from, so resting a
   *  third on the glass mid-pinch changes nothing. */
  private touches = new Map<number, { x: number; y: number }>()
  /** Midpoint and spacing of the live two-finger gesture: the next move reads
   *  the midpoint's travel as a pan and the change in spacing as a pinch. */
  private pinch: { x: number; y: number; dist: number } | null = null
  /** Whether the single finger down is turning the model. Separate from
   *  `action`, which only ever describes a mouse chord. */
  private touchOrbit = false
  /** Where the single planar-mode finger last was — it drags the sheet. */
  private touchPan: { x: number; y: number } | null = null

  // Scratch: this maths runs per pointer event.
  private right = new THREE.Vector3()
  private up = new THREE.Vector3()
  private tmp = new THREE.Vector3()
  private tmp2 = new THREE.Vector3()
  private q1 = new THREE.Quaternion()
  private q2 = new THREE.Quaternion()
  private pickNdc = new THREE.Vector2()
  /** The canvas rect, asked of the layout engine at most once per frame:
   *  getBoundingClientRect can force a layout pass, and setPickRay runs for
   *  every dab of a brush stroke. Cleared in updateClipPlanes, which the owner
   *  already calls once per frame. */
  private rect: DOMRect | null = null

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
    // A pointer the system takes back never sends pointerup: an iPadOS edge
    // swipe or a palm landing on the glass would otherwise leave the gesture
    // latched and the model turning under a finger that has already gone.
    document.addEventListener('pointercancel', this.onUp)
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

  /** Flatten the navigation for a 2D document: whatever chord a scheme gives
   *  to orbiting drags the sheet instead, so no scheme can turn the image
   *  edge-on, and the buttons still mean what the user's scheme says. */
  setPlanar(on: boolean): void {
    if (this.planar === on) return
    this.planar = on
    this.rebuildBindings()
    this.cancelGesture()
  }

  private rebuildBindings(): void {
    const base = this.planar
      ? this.scheme.bindings.map((b) => (b.action === 'orbit' ? { ...b, action: 'pan' as NavAction } : b))
      : this.scheme.bindings
    // A sheet always pans on a plain right-drag, whatever the scheme gives
    // the button otherwise (many give it nothing): the 2D tools take the
    // left button for picking and region boxes, and a viewport that cannot be
    // moved with the other hand is no viewport. Appended, so a scheme's own
    // plain right-button binding still wins.
    const planarExtra: NavBinding[] = this.planar ? [{ buttons: RMB, action: 'pan' }] : []
    if (!this.paintMode) {
      this.bindings = [...base, ...planarExtra]
      return
    }
    // Only the brush in 3D rubs out with the right button; the 2D region
    // tool claims the left alone, so the right stays the camera's there.
    const claimed = this.planar ? [LMB] : [LMB, RMB]
    const moved = base.map((b) =>
      claimed.includes(b.buttons) && !b.shift && !b.ctrl && !b.alt ? { ...b, shift: true } : b,
    )
    // A scheme that already used Shift with that button now has two bindings
    // for the same chord (Rhino's Shift+right pan behind its right-drag orbit,
    // say). First match wins, which puts the gesture that was plain — the one
    // the user reaches for without thinking — in front of the one that already
    // asked for a modifier.
    this.bindings = [...moved, ...planarExtra]
  }

  /** Drop any in-flight gesture, so stale state cannot leak across a change of
   *  what the buttons mean. Fingers already on the glass are kept — they are
   *  physically still there — and simply re-read under the new rules. */
  private cancelGesture(): void {
    this.endOrbit()
    this.action = null
    this.mask = 0
    this.last = null
    this.zoomAnchor = null
    this.chordDown = null
    this.catiaZoomLatch = false
    this.pinch = null
    this.touchOrbit = false
    this.touchPan = null
    this.retuneTouch()
  }

  /** Bracket the whole model between the clip planes, wherever orbiting and
   *  panning have carried the camera. Call once per frame.
   *
   *  The near plane is allowed to go negative: an orthographic frustum is a
   *  box, so a plane behind the camera is legal, and it is what keeps a part
   *  from being sliced away after the pivot has walked the camera in. Rays cast
   *  into the scene compensate — see setPickRay. */
  updateClipPlanes(): void {
    // A new frame may mean new layout; the rect is re-read on the next ray.
    this.rect = null
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
    const rect = this.canvasRect()
    const ndc = this.pickNdc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    )
    raycaster.setFromCamera(ndc, this.camera)
    const ray = raycaster.ray
    const along = this.tmp.copy(this.clipSphere.center).sub(ray.origin).dot(ray.direction)
    const back = along - this.clipSphere.radius * 1.01
    if (back < 0) ray.recast(back)
  }

  private canvasRect(): DOMRect {
    if (!this.rect) this.rect = this.canvas.getBoundingClientRect()
    return this.rect
  }

  dispose(): void {
    this.canvas.removeEventListener('pointerdown', this.onDown)
    this.canvas.removeEventListener('mousedown', this.onMouseDown)
    this.canvas.removeEventListener('contextmenu', this.onContextMenu)
    this.canvas.removeEventListener('wheel', this.onWheel)
    document.removeEventListener('pointermove', this.onMove)
    document.removeEventListener('pointerup', this.onUp)
    document.removeEventListener('pointercancel', this.onUp)
    this.pivotMarker.geometry.dispose()
    ;(this.pivotMarker.material as THREE.Material).dispose()
  }

  // ---------- chord resolution ----------

  private onDown = (e: PointerEvent): void => {
    if (e.pointerType === 'touch') return this.touchDown(e)
    this.syncButtons(e)
  }

  /** Release, and a cancel taken as a release — see the pointercancel listener. */
  private onUp = (e: PointerEvent): void => {
    if (e.pointerType === 'touch') return this.touchUp(e)
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
      this.beginOrbit(e.clientX, e.clientY)
    } else {
      this.last = { x: e.clientX, y: e.clientY }
      if (action === 'zoom') this.zoomAnchor = { x: e.clientX, y: e.clientY }
    }
  }

  private onMove = (e: PointerEvent): void => {
    if (e.pointerType === 'touch') return this.touchMove(e)
    // Chorded button changes (a second button pressed or released mid-drag)
    // arrive as pointermove — catch them by the mask changing under a gesture.
    if (this.mask && (e.buttons & 7) !== this.mask) {
      this.syncButtons(e)
      return
    }
    if (this.action === 'orbit') this.orbitMove(e.clientX, e.clientY)
    else if (this.action === 'pan') this.onPanMove(e)
    else if (this.action === 'zoom') this.onZoomMove(e)
  }

  // ---------- touch gestures ----------
  //
  // One finger turns the model, two pan and pinch it. The two-finger reading
  // is deliberately one gesture and not a mode: the midpoint's travel is the
  // pan and the fingers' spacing is the zoom, both applied every move, so a
  // hand that pans and spreads at once does both instead of having to pick.

  private touchDown(e: PointerEvent): void {
    this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY })
    this.retuneTouch()
  }

  private touchUp(e: PointerEvent): void {
    if (!this.touches.delete(e.pointerId)) return
    this.retuneTouch()
  }

  private touchMove(e: PointerEvent): void {
    // Only fingers that landed on the canvas count; one that started on the
    // panel and wandered over the viewport was never ours.
    const touch = this.touches.get(e.pointerId)
    if (!touch) return
    touch.x = e.clientX
    touch.y = e.clientY
    const pair = this.touchPair()
    if (!pair) {
      if (this.touchOrbit) this.orbitMove(e.clientX, e.clientY)
      else if (this.touchPan) {
        this.panByPixels(e.clientX - this.touchPan.x, e.clientY - this.touchPan.y)
        this.touchPan = { x: e.clientX, y: e.clientY }
      }
      return
    }
    const [a, b] = pair
    const x = (a.x + b.x) / 2
    const y = (a.y + b.y) / 2
    const dist = Math.hypot(a.x - b.x, a.y - b.y)
    const prev = this.pinch
    this.pinch = { x, y, dist }
    if (!prev) return // first move of the gesture: this frame only sets the datum
    this.panByPixels(x - prev.x, y - prev.y)
    // Below a finger's width apart the spacing is mostly noise, and dividing by
    // it would fling the zoom; a two-finger drag with the fingers together
    // still pans, it just does not scale.
    if (prev.dist > 24 && dist > 24) this.zoomAt(dist / prev.dist, x, y)
  }

  /** The two fingers a two-finger gesture is read from, oldest first. */
  private touchPair(): [{ x: number; y: number }, { x: number; y: number }] | null {
    if (this.touches.size < 2) return null
    const [a, b] = [...this.touches.values()]
    return [a, b]
  }

  /** Settle on the gesture the fingers now on the glass describe. Called at
   *  every touch down and up, so lifting one finger out of a pinch hands the
   *  other straight back to the orbit — re-anchored where it currently is,
   *  which is what keeps the model from jumping as the second finger goes. */
  private retuneTouch(): void {
    if (this.touchPair()) {
      if (this.touchOrbit) {
        this.endOrbit()
        this.touchOrbit = false
      }
      this.touchPan = null
      // Datum is taken on the next move, by which time both fingers have
      // reported a position through touchMove.
      this.pinch = null
      return
    }
    this.pinch = null
    const [only] = [...this.touches.values()]
    if (this.touchOrbit) {
      this.endOrbit()
      this.touchOrbit = false
    }
    this.touchPan = null
    // A brush or a grip that has claimed the plain drag keeps the single
    // finger; two fingers still navigate, exactly as the middle button does
    // for a mouse.
    if (!only || this.paintMode) return
    // On a flat document the single finger drags the sheet instead of
    // turning it — there is nothing to turn.
    if (this.planar) {
      this.touchPan = { x: only.x, y: only.y }
      return
    }
    this.beginOrbit(only.x, only.y)
    this.touchOrbit = true
  }

  // ---------- the three gestures ----------

  private beginOrbit(clientX: number, clientY: number): void {
    // Turn about the surface under the cursor; fall back to the previous pivot
    // and then to the view centre, so a drag that starts off the part still
    // rotates about something sensible.
    const pivot = this.surfaceAt(clientX, clientY) ?? this.lastPivot ?? this.controls.target.clone()
    this.pivot = pivot.clone()
    this.lastPivot = pivot.clone()
    this.orbitStart = { x: clientX, y: clientY }
    this.orbitLast = { x: clientX, y: clientY }
    this.orbiting = false // promoted once the drag passes the threshold
  }

  private surfaceAt(clientX: number, clientY: number): THREE.Vector3 | null {
    const targets = this.orbitTargets()
    if (!targets.length) return null
    this.setPickRay(this.orbitRaycaster, clientX, clientY)
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

  private orbitMove(clientX: number, clientY: number): void {
    if (!this.pivot || !this.orbitLast || !this.orbitStart) return
    if (!this.orbiting) {
      const moved = Math.hypot(clientX - this.orbitStart.x, clientY - this.orbitStart.y)
      if (moved < 3) return // tolerate a click without flashing the marker
      this.orbiting = true
      this.showPivotMarker()
    }
    const dx = clientX - this.orbitLast.x
    const dy = clientY - this.orbitLast.y
    this.orbitLast = { x: clientX, y: clientY }
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
    this.onChange?.()
  }

  private endOrbit(): void {
    if (!this.pivot) return
    this.pivot = null
    this.orbitStart = null
    this.orbitLast = null
    this.orbiting = false // the free orbit keeps its tilt — no re-levelling
    this.pivotMarker.visible = false
    // The marker leaving the screen is a visible change of its own, even
    // though the camera stays put.
    this.onChange?.()
  }

  private onPanMove(e: PointerEvent): void {
    if (!this.last) return
    const dx = e.clientX - this.last.x
    const dy = e.clientY - this.last.y
    this.last = { x: e.clientX, y: e.clientY }
    this.panByPixels(dx, dy)
  }

  /** Screen-space pan: translate camera and target along the view plane, so the
   *  model follows the cursor — or the middle of the two fingers — exactly
   *  1:1. */
  private panByPixels(dx: number, dy: number): void {
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
    this.onChange?.()
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
    const rect = this.canvasRect()
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
    this.onChange?.()
  }
}
