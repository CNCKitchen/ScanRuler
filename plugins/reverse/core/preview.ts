// SPDX-License-Identifier: AGPL-3.0-only
// What a feature being set up shows in the viewport besides its ghost body:
// the grips that drag its numbers. An extrude wears an arrow on each face
// the distance sets — pull the far one and the body grows — and one on the
// far edge that leans the sides; a revolve wears a ring about its axis whose
// turn is the angle, the way Fusion and Onshape put a manipulator on the
// feature rather than a number in a box alone. Geometry only, in the part's
// coordinates; the viewer draws it.

import type { SectionFrame } from '../../../src/core/section/frame'
import type { Vec3 } from '../../../src/core/types'
import { addScaled, cross, dot, len, normalize, sub } from '../../../src/core/vec'
import type { ExtrudeExtent } from './features'
import { FULL_TURN_DEG, liftPoint } from './features'
import { movedPivot, ringAxes, type Placement } from './move'
import { AXIS_COLORS } from '../../../src/viewer/viewCube'
import type { Region } from './regions'
import { polygonCentroid2 } from '../../../src/core/flat/vec2'

/** The grips a feature wears. An arrow is dragged along `dir` and reports
 *  millimetres; a ring turns about `dir` and reports degrees. `taper` is
 *  an extrude's arrow on its far edge, `radius` a fillet's or a chamfer's
 *  on its first edge, `thickness` a shell's on the face it opens, `move` a
 *  moved face's along its normal; `moveX` to `turnZ` are a Move's gizmo,
 *  an arrow along each axis and a ring about each (moveGrips). */
export type FeatureGripSide = 'extrudeFrom' | 'extrudeTo' | 'taper' | 'turn' | 'radius' | 'thickness' | 'move' | MoveGripSide

/** The gizmo of a Move: the distance along an axis, the angle about it. */
export type MoveGripSide = 'moveX' | 'moveY' | 'moveZ' | 'turnX' | 'turnY' | 'turnZ'

const MOVE_GRIP_SIDES: readonly MoveGripSide[] = ['moveX', 'moveY', 'moveZ', 'turnX', 'turnY', 'turnZ']

/** Which of the six numbers a gizmo grip drags: the distance or the angle,
 *  and the axis — 0, 1, 2 for X, Y, Z. */
export function moveGripSlot(side: MoveGripSide): { field: 'translate' | 'rotate'; axis: 0 | 1 | 2 } {
  return { field: side.startsWith('move') ? 'translate' : 'rotate', axis: side.endsWith('X') ? 0 : side.endsWith('Y') ? 1 : 2 }
}

export function isMoveGripSide(side: string | null): side is MoveGripSide {
  return MOVE_GRIP_SIDES.includes(side as MoveGripSide)
}

/** A feature manipulator's sides, among the grips a drag can report. */
export function isFeatureSide(side: string | null): side is FeatureGripSide {
  return side === 'extrudeFrom' || side === 'extrudeTo' || side === 'taper' || side === 'turn' || side === 'radius' || side === 'thickness' || side === 'move' || isMoveGripSide(side)
}

/** The colours of the gizmo's axes, X, Y and Z — the app's own red, green
 *  and blue, as the view's axis triad and the coordinate planes wear them. */
export const MOVE_AXIS_COLORS = (['x', 'y', 'z'] as const).map((a) => `#${AXIS_COLORS[a].toString(16).padStart(6, '0')}`)

/** The steepest taper the box and the grip take, degrees either way. */
export const MAX_TAPER_DEG = 85

export interface FeatureGrip {
  side: FeatureGripSide
  shape: 'arrow' | 'ring'
  position: Vec3
  dir: Vec3
  /** An arrow's length, or a ring's radius: millimetres, or pixels on the
   *  screen with `pixels`. */
  size: number
  /** Held at its size on the screen whatever the zoom. */
  pixels?: boolean
  /** How far along `dir` an arrow stands off `position`, in the units of
   *  `size`. */
  standoff?: number
  /** Its own colour, where it is not the feature's — a gizmo's axes. */
  color?: string
}

/** How long a feature's arrow is on the screen, in pixels, at any zoom:
 *  enough to take hold of, and on a small face or a fine edge it leaves
 *  what it stands on in view — an arrow sized on the part buried those. */
export const ARROW_PX = 44

/** The Move gizmo's rings on the screen, in pixels, at any zoom — as a CAD
 *  manipulator is held. */
export const MOVE_GIZMO_PX = 90

/** A feature's arrow at `position` along `dir`, held on the screen. */
const arrowGrip = (side: FeatureGripSide, position: Vec3, dir: Vec3, size = ARROW_PX): FeatureGrip => ({ side, shape: 'arrow', position, dir, size, pixels: true })

/** Where the picked profiles sit, on the sheet: the area-weighted middle of
 *  their outer loops, or the sheet origin with nothing picked. */
export function regionsCentroid(regions: readonly Region[]): [number, number] {
  let x = 0
  let y = 0
  let w = 0
  for (const r of regions) {
    const [cx, cy] = polygonCentroid2(r.outer.polygon)
    const a = Math.max(r.area, 1e-9)
    x += cx * a
    y += cy * a
    w += a
  }
  return w > 0 ? [x / w, y / w] : [0, 0]
}

/**
 * The grips of an extrude: an arrow on the start face pointing back along
 * the normal, one on the end face pointing forward, each through the
 * profiles' centroid. An extent limited by a plane has no number on that
 * side and no grip there; a symmetric one's two arrows both move `total`.
 */
export function extrudeGrips(frame: SectionFrame, regions: readonly Region[], extent: ExtrudeExtent, along: Vec3 = frame.normal): FeatureGrip[] {
  if (regions.length === 0) return []
  return extrudeGripsAt(liftPoint(frame, regionsCentroid(regions)), along, extent)
}

/** The grips of an extrude through a given centre along a given normal —
 *  a face pulled straight has no regions, only its centroid and normal. */
export function extrudeGripsAt(centre: Vec3, normal: Vec3, extent: ExtrudeExtent): FeatureGrip[] {
  const n = normal
  const back: Vec3 = [-n[0], -n[1], -n[2]]
  const arrow = (side: FeatureGripSide, offset: number, dir: Vec3): FeatureGrip => arrowGrip(side, addScaled(centre, n, offset), dir)
  switch (extent.kind) {
    case 'distance':
      // The lower face wears the back-pointing arrow whichever number it
      // is, so pulling an arrow outward always grows the body.
      return extent.to >= extent.from
        ? [arrow('extrudeFrom', extent.from, back), arrow('extrudeTo', extent.to, n)]
        : [arrow('extrudeFrom', extent.from, n), arrow('extrudeTo', extent.to, back)]
    case 'symmetric':
      return [arrow('extrudeFrom', -extent.total / 2, back), arrow('extrudeTo', extent.total / 2, n)]
    case 'toPlane':
    case 'toFace':
    case 'toBody':
      return [arrow('extrudeFrom', extent.from, back)]
    // The start's arrow points away from where the body goes.
    case 'toNext':
    case 'toLast':
      return [arrow('extrudeFrom', extent.from, extent.reverse ? n : back)]
    case 'betweenPlanes':
      return []
  }
}

/**
 * Where an extrude's taper leans from and the end it leans furthest to, as
 * offsets along the normal: from the sketch plane, or the end of the extent
 * nearest it, to the end further from there. Null for an extent with an end
 * found on the part, which has no number to put the grip at.
 */
export function taperSpan(extent: ExtrudeExtent): { start: number; end: number } | null {
  if (extent.kind === 'symmetric') return { start: 0, end: extent.total / 2 }
  if (extent.kind !== 'distance') return null
  const lo = Math.min(extent.from, extent.to)
  const hi = Math.max(extent.from, extent.to)
  const start = Math.min(Math.max(0, lo), hi)
  // The far end; of two as far, To.
  const end = Math.abs(extent.to - start) >= Math.abs(extent.from - start) ? extent.to : extent.from
  return { start, end }
}

/**
 * The taper grip of an extrude: an arrow on the far edge of the body,
 * pointing out of it — pull it out and the sides lean out, push it in and
 * they lean in, as Fusion's taper handle does. It stands where the outline
 * reaches furthest along the sheet's X, half way along the side there,
 * carried to the far end and out by the lean, so it rides the ghost's edge.
 * `taperDeg` is the taper as the box shows it, positive leaning out. Null
 * with no profile, or an extent with no far end to stand on.
 */
export function taperGrip(frame: SectionFrame, regions: readonly Region[], extent: ExtrudeExtent, taperDeg: number): FeatureGrip | null {
  const span = taperSpan(extent)
  if (!span || regions.length === 0) return null
  const length = Math.abs(span.end - span.start)
  if (!(length > 1e-6)) return null
  let max = -Infinity
  for (const r of regions) for (const [x] of r.outer.polygon) if (x > max) max = x
  if (!Number.isFinite(max)) return null
  const tol = 1e-6 * Math.max(1, Math.abs(max))
  let v0 = Infinity
  let v1 = -Infinity
  for (const r of regions) {
    for (const [x, y] of r.outer.polygon) {
      if (x < max - tol) continue
      if (y < v0) v0 = y
      if (y > v1) v1 = y
    }
  }
  const edge = liftPoint(frame, [max, (v0 + v1) / 2])
  const lean = Math.tan((taperDeg * Math.PI) / 180)
  const position = addScaled(addScaled(edge, frame.normal, span.end), frame.basisU, length * lean)
  return arrowGrip('taper', position, frame.basisU, ARROW_PX * 0.8)
}

/** The taper a drag of the taper grip makes: `delta` millimetres pulled
 *  out along the arrow since the drag began, `length` the extrude's run
 *  from where the taper starts to the grip — the edge moves out by the
 *  pull, and the taper is the angle that puts it there. Degrees, positive
 *  leaning out, to a tenth, within MAX_TAPER_DEG. */
export function dragTaper(startDeg: number, length: number, delta: number): number {
  if (!(length > 1e-9)) return startDeg
  const out = length * Math.tan((startDeg * Math.PI) / 180) + delta
  const deg = Math.round(((Math.atan2(out, length) * 180) / Math.PI) * 10) / 10
  // Back where it started from a lean, the rounding makes −0 of it: none.
  return deg === 0 ? 0 : Math.max(-MAX_TAPER_DEG, Math.min(MAX_TAPER_DEG, deg))
}

/** The extent an extrude grip's drag makes: `delta` millimetres pulled
 *  along the arrow since the drag began, applied to the extent it began
 *  with. Outward is always growth, whichever way the arrow points. */
export function dragExtrudeExtent(start: ExtrudeExtent, side: FeatureGripSide, delta: number): ExtrudeExtent {
  switch (start.kind) {
    case 'distance': {
      const forward = start.to >= start.from
      if (side === 'extrudeTo') return { ...start, to: start.to + (forward ? delta : -delta) }
      if (side === 'extrudeFrom') return { ...start, from: start.from - (forward ? delta : -delta) }
      return start
    }
    case 'symmetric':
      // Either arrow pulled out by d grows the whole by 2d — the other side
      // follows, that being what symmetric means.
      return { ...start, total: Math.max(start.total + 2 * delta, 0.01) }
    case 'toPlane':
    case 'toFace':
    case 'toBody':
      return side === 'extrudeFrom' ? { ...start, from: start.from - delta } : start
    case 'toNext':
    case 'toLast':
      return side === 'extrudeFrom' ? { ...start, from: start.from - (start.reverse ? -delta : delta) } : start
    case 'betweenPlanes':
      return start
  }
}

/** Which end of an extrude a point clicked on the part sets. */
export type ExtrudeEnd = 'from' | 'to'

/**
 * The extent an extrude has once one of its ends is put through a point
 * clicked on the part: `height` is the point's height over the sketch plane
 * along its normal, negative behind it — so a click behind the plane turns
 * the extrude round, and a click for each end makes one that reaches both
 * ways. A symmetric extent reaches the point with either half. An end found
 * on the part — a plane, a face, the next one — keeps that end and takes the
 * point for its start only. Null when the point gives the extent nothing: a
 * body of no height, an end that is not a number.
 */
export function extentThroughPoint(extent: ExtrudeExtent, end: ExtrudeEnd, height: number): ExtrudeExtent | null {
  if (!Number.isFinite(height)) return null
  const h = Math.round(height * 100) / 100
  switch (extent.kind) {
    case 'distance': {
      const next = end === 'to' ? { ...extent, to: h } : { ...extent, from: h }
      return Math.abs(next.to - next.from) < 1e-9 ? null : next
    }
    case 'symmetric':
      return Math.abs(h) < 1e-9 ? null : { ...extent, total: Math.abs(h) * 2 }
    case 'toPlane':
    case 'toFace':
    case 'toBody':
    case 'toNext':
    case 'toLast':
      return end === 'from' ? { ...extent, from: h } : null
    case 'betweenPlanes':
      return null
  }
}

/**
 * A straight extrude's ghost, stretched instead of built again: the affine
 * map that carries a prism reaching from `from0` to `to0` along `normal`
 * onto the one from `from1` to `to1` — heights over the sketch plane scaled
 * and shifted, nothing moved across it — as a column-major 4 × 4, the way
 * three.js takes one. What a grip's drag shows between the kernel's answers.
 * Null for a prism of no height, which has nothing to stretch.
 */
export function prismStretch(origin: Vec3, normal: Vec3, from0: number, to0: number, from1: number, to1: number): number[] | null {
  const span = to0 - from0
  if (Math.abs(span) < 1e-9) return null
  const s = (to1 - from1) / span
  // p' = p + n · ((s − 1)·h + from1 − s·from0), with h = (p − origin) · n.
  const shift = from1 - s * from0 - (s - 1) * dot(origin, normal)
  const m = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) m[c * 4 + r] += (s - 1) * normal[r] * normal[c]
    m[12 + r] = shift * normal[r]
  }
  return m
}

/**
 * The grip of a revolve: a ring about the axis, through the plane of the
 * profiles' centroid, as wide as the centroid's distance from the axis so
 * the ring runs through the body being turned. Null when the centroid lies
 * on the axis — a profile revolving about its own middle is not a solid.
 */
export function revolveGrip(frame: SectionFrame, regions: readonly Region[], axis: { origin: Vec3; dir: Vec3 }): FeatureGrip | null {
  if (regions.length === 0) return null
  const centre = liftPoint(frame, regionsCentroid(regions))
  const dir = normalize(axis.dir)
  if (!dir) return null
  const along = dot(sub(centre, axis.origin), dir)
  const foot = addScaled(axis.origin, dir, along)
  const radius = len(sub(centre, foot))
  if (radius < 1e-6) return null
  return { side: 'turn', shape: 'ring', position: foot, dir, size: radius }
}

/** A length dragged: millimetres pulled along the arrow since the drag
 *  began, applied to what it began at, kept positive. */
export function dragLength(start: number, delta: number): number {
  return Math.max(start + delta, 0.01)
}

/** The grip of a fillet or a chamfer: an arrow at the middle of its first
 *  edge, pointing into the body along the bisector of the two faces'
 *  outward normals — pull it in and the round grows. Null with no edge or
 *  no faces to bisect. */
export function edgeGrip(edge: { mid: Vec3; faces: { dir: Vec3 }[] }): FeatureGrip | null {
  if (edge.faces.length < 2) return null
  const bisector = normalize([edge.faces[0].dir[0] + edge.faces[1].dir[0], edge.faces[0].dir[1] + edge.faces[1].dir[1], edge.faces[0].dir[2] + edge.faces[1].dir[2]])
  if (!bisector) return null
  return arrowGrip('radius', edge.mid, [-bisector[0], -bisector[1], -bisector[2]])
}

/** The grip of a shell: an arrow on the first opened face, into the body
 *  along its normal — pull it in and the wall thickens. */
export function faceGrip(face: { centroid: Vec3; dir: Vec3 }): FeatureGrip {
  return arrowGrip('thickness', face.centroid, [-face.dir[0], -face.dir[1], -face.dir[2]])
}

/** The grip of a moved face: on a flat face an arrow where it stands now —
 *  its middle carried by the offset — out along its normal; pull it and
 *  the face comes out, push it and it goes in. On a round face an arrow out
 *  from the axis at the radius it will have, half way along: pull it and
 *  the radius grows, a boss's and a bore's alike. */
export function moveGrip(face: { kind?: string; centroid: Vec3; dir: Vec3; radius?: number; center?: Vec3 }, offset: number): FeatureGrip {
  if (face.kind === 'cylinder' && face.radius !== undefined) {
    const axis = normalize(face.dir) ?? [0, 0, 1]
    // Square to the axis, off whichever coordinate axis it is furthest from.
    const ref: Vec3 = Math.abs(axis[0]) < 0.6 ? [1, 0, 0] : Math.abs(axis[1]) < 0.6 ? [0, 1, 0] : [0, 0, 1]
    const out = normalize(cross(axis, ref)) ?? [1, 0, 0]
    return arrowGrip('move', addScaled(face.center ?? face.centroid, out, face.radius + offset), out)
  }
  return arrowGrip('move', addScaled(face.centroid, face.dir, offset), face.dir)
}

/**
 * The gizmo of a Move, where the moved bodies' middle stands: an arrow
 * along X, Y and Z, standing off the middle just outside the rings so the
 * three read as a triad, and a ring for each angle — about the axis that
 * angle turns about (move.ts ringAxes), the X ring riding on the Y and Z
 * turns as a gimbal's does. Held on the screen: `radius` is the rings', in
 * pixels; the arrows are a third of it long.
 */
export function moveGrips(placement: Placement, radius = MOVE_GIZMO_PX): FeatureGrip[] {
  const at = movedPivot(placement)
  const rings = ringAxes(placement.rotate)
  const axes: Vec3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
  const out: FeatureGrip[] = []
  for (let i = 0; i < 3; i++) {
    out.push({ ...arrowGrip(MOVE_GRIP_SIDES[i], at, axes[i], radius / 3), standoff: radius * 1.08, color: MOVE_AXIS_COLORS[i] })
    out.push({ side: MOVE_GRIP_SIDES[i + 3], shape: 'ring', position: at, dir: rings[i], size: radius, pixels: true, color: MOVE_AXIS_COLORS[i] })
  }
  return out
}

/** The angle a revolve grip's drag makes: degrees turned about the axis
 *  since the drag began, applied to the angle it began with, kept positive
 *  and within `maxDeg` — a full turn for a plain revolve, as many as a coil
 *  takes for one with a pitch, the ring wound round and round. */
export function dragRevolveAngle(startDeg: number, deltaDeg: number, maxDeg = FULL_TURN_DEG): number {
  const a = startDeg + deltaDeg
  return Math.min(maxDeg, Math.max(1, Math.round(a * 10) / 10))
}
