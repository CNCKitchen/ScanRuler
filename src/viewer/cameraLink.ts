// SPDX-License-Identifier: AGPL-3.0-only
// Two orthographic viewports held in one pose, so the scan and the reference can
// be turned, panned and zoomed as though they were one part.
//
// One camera in world coordinates, not one camera per part: the reference is the
// datum and the fit carries the scan into the reference's frame, so the same
// world window in both halves puts a feature on the left at exactly the screen
// position its counterpart takes on the right — which is the whole of what makes
// a side-by-side comparison readable. A pair that has not been fitted yet is
// simply shown where the two parts actually are; the camera was framed on both
// of them when the reference loaded, so each half has its own in view.
//
// Shared explicitly rather than by handing both halves the same THREE.Camera,
// because the frustum is per-viewport: each rebuilds it for its own aspect on
// every resize (see OrthoViewport.applyFrustum). What travels is the framing
// extents, which is what holds the two at one scale.

import * as THREE from 'three'

/** One half of a linked pair. Implemented by OrthoViewport.viewLink. */
export interface LinkedView {
  readonly camera: THREE.OrthographicCamera
  /** The orbit target — the point the camera looks at, owned by OrbitControls. */
  readonly target: THREE.Vector3
  /** Framing half-extents. Shared so both halves are read at one scale; the
   *  frustum built from them stays each viewport's own. */
  extents: () => { halfW: number; halfH: number }
  setExtents: (halfW: number, halfH: number) => void
  invalidate: () => void
}

interface Pose {
  position: THREE.Vector3
  target: THREE.Vector3
  up: THREE.Vector3
  zoom: number
  halfW: number
  halfH: number
}

function emptyPose(): Pose {
  return {
    position: new THREE.Vector3(),
    target: new THREE.Vector3(),
    up: new THREE.Vector3(),
    zoom: 1,
    halfW: 1,
    halfH: 1,
  }
}

function readPose(view: LinkedView, into: Pose): void {
  into.position.copy(view.camera.position)
  into.target.copy(view.target)
  into.up.copy(view.camera.up)
  into.zoom = view.camera.zoom
  const { halfW, halfH } = view.extents()
  into.halfW = halfW
  into.halfH = halfH
}

/** Whether a gesture has moved this view since its pose was last recorded.
 *  The tolerance is relative to what is on screen: a round trip through the
 *  link costs a few ulps, and anything above that came from a hand. */
function moved(view: LinkedView, pose: Pose): boolean {
  const eps = Math.max(pose.halfW, pose.halfH, 1e-9) * 1e-6
  const { halfW, halfH } = view.extents()
  return (
    view.camera.position.distanceTo(pose.position) > eps ||
    view.target.distanceTo(pose.target) > eps ||
    view.camera.up.distanceTo(pose.up) > 1e-9 ||
    Math.abs(view.camera.zoom - pose.zoom) > pose.zoom * 1e-9 ||
    Math.abs(halfW - pose.halfW) > eps ||
    Math.abs(halfH - pose.halfH) > eps
  )
}

/** Put `to` in the pose `from` is in. */
function push(from: LinkedView, to: LinkedView): void {
  to.camera.position.copy(from.camera.position)
  to.target.copy(from.target)
  to.camera.up.copy(from.camera.up)
  to.camera.zoom = from.camera.zoom
  const { halfW, halfH } = from.extents()
  to.setExtents(halfW, halfH)
  // lookAt here rather than leaving it to the follower's OrbitControls: its
  // update() has already run for this frame by the time the link ticks, and a
  // half that took its orientation a frame late would visibly lag the drag.
  to.camera.lookAt(to.target)
  to.camera.updateMatrixWorld(true)
  to.invalidate()
}

/**
 * Keeps two views in one pose, whichever of them the hand is on.
 *
 * Driven by polling from a frame loop rather than by the cameras' change
 * events: writing one camera makes the other fire a change of its own, and
 * telling that echo apart from a genuine gesture costs more than the dozen
 * float comparisons a tick does here. Whoever has moved since the last tick is
 * the driver; a frame in which neither has costs nothing.
 */
export class CameraLink {
  private poseA = emptyPose()
  private poseB = emptyPose()

  constructor(
    private a: LinkedView,
    private b: LinkedView,
  ) {
    push(a, b)
    readPose(a, this.poseA)
    readPose(b, this.poseB)
  }

  tick(): void {
    // A drag is on one canvas at a time, so there is no contest to resolve
    // beyond taking the first that moved.
    if (moved(this.a, this.poseA)) push(this.a, this.b)
    else if (moved(this.b, this.poseB)) push(this.b, this.a)
    else return
    readPose(this.a, this.poseA)
    readPose(this.b, this.poseB)
  }
}
