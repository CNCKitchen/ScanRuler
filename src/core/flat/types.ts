// SPDX-License-Identifier: AGPL-3.0-only
// The type spine of the flat (2D) measuring workspace. Deliberately its own
// small world rather than the 3D element types with a dead coordinate: the
// flat workspace measures in a plane — a flatbed scan today, a section
// through a mesh later — and everything downstream of the sources works in
// plane millimetres only.

export type Vec2 = [number, number]

export type FlatElementKind = 'point' | 'line' | 'circle' | 'arc'

/** What every flat fit reports regardless of geometry. Mirrors the 3D
 *  FitBase: sigma is the RMS residual, formError the peak-to-peak residual —
 *  the number GD&T calls straightness or circularity. Picked and constructed
 *  geometry has no residuals and carries zeros / no form error. */
export interface FlatFitBase {
  sigma: number
  usedPoints: number
  formError?: number
}

/** A reference point: picked on the image, or constructed. */
export interface FlatPointFit extends FlatFitBase {
  kind: 'point'
  at: Vec2
}

/** A straight edge. The line the math uses is infinite; center, dir and
 *  length describe the measured segment, to draw it and to sanity-check
 *  measurements against. */
export interface FlatLineFit extends FlatFitBase {
  kind: 'line'
  center: Vec2
  dir: Vec2
  length: number
}

export interface FlatCircleFit extends FlatFitBase {
  kind: 'circle'
  center: Vec2
  radius: number
}

/** A partial circle: the fit is the full circle's, the angles record which
 *  part of it was actually measured. Counter-clockwise from `start`, in
 *  radians from the +X axis; `sweep` is positive and at most a full turn. */
export interface FlatArcFit extends FlatFitBase {
  kind: 'arc'
  center: Vec2
  radius: number
  start: number
  sweep: number
}

export type FlatFit = FlatPointFit | FlatLineFit | FlatCircleFit | FlatArcFit
