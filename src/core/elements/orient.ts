// SPDX-License-Identifier: AGPL-3.0-only
// Aligning an element's direction with a reference plane.
//
// A scanned part rarely comes out perfectly square: a bore that was drilled
// perpendicular to the base fits at 89.7°, the top face at 0.2° to the bottom.
// For a measurement that is the truth and stays reported. But for geometry
// that is going on to CAD, or that a distance is going to be taken between,
// it is often the designed relation that is wanted — so an element can be
// asked to take its orientation from a reference plane instead of from the
// fit. The position stays where it was measured; only the direction turns,
// about the element's own centre, by the smallest rotation that gets it there.
//
// Unlike an extension or an assumed diameter, an alignment *does* change the
// element's geometry — that is its whole point. What it never changes is the
// residual statistics: sigma and form error are the measurement's and ride
// along untouched. The unaligned fit is kept beside the element so the
// alignment can be re-applied when the reference moves, and so the summary
// can say how far the measurement was from the designed relation.

import type { ElementKind, FitData, PlaneFit, Vec3 } from '../types'
import { transformFit } from '../alignment'
import { rigidFromAxisAngle } from '../deviation/rigid'
import { acuteAngle, addScaled, cross, dot, len, normalize } from '../vec'

/** How the element's direction relates to the reference plane: along its
 *  normal (a parallel plane, a perpendicular bore) or lying in the plane (a
 *  perpendicular face, an axis running parallel to the base). */
export type OrientRelation = 'normal' | 'inPlane'

export interface Orient {
  /** The id of the reference plane. */
  ref: number
  relation: OrientRelation
}

/** Past this the "aligned" element is probably not the one that was designed
 *  that way: scan noise and a little manufacturing error stay well under a
 *  degree, a 2° draft angle does not. */
export const ORIENT_TOLERANCE_DEG = 2

/** The kinds with a direction to align — everything but a point and a
 *  sphere, which have none. */
export const ORIENTABLE_KINDS: readonly ElementKind[] = [
  'plane',
  'line',
  'cylinder',
  'cone',
  'circle',
]

export type OrientableFit = Exclude<FitData, { kind: 'point' | 'sphere' }>

export function isOrientable(fit: FitData | undefined): fit is OrientableFit {
  return fit !== undefined && ORIENTABLE_KINDS.includes(fit.kind)
}

/** The direction an element aligns by: a plane's or a circle's normal, an
 *  axis for the rest. */
export function directionOf(fit: OrientableFit): Vec3 {
  if (fit.kind === 'plane' || fit.kind === 'circle') return fit.normal
  if (fit.kind === 'line') return fit.dir
  return fit.axis
}

/** The words the panel uses for each relation, from the element's point of
 *  view: a plane "parallel to" the reference has its normal along the
 *  reference normal, a cylinder "perpendicular to" it has the same. */
export function relationLabel(kind: ElementKind, relation: OrientRelation): string {
  const planar = kind === 'plane' || kind === 'circle'
  if (relation === 'normal') return planar ? 'Parallel to it' : 'Perpendicular to it'
  return planar ? 'Perpendicular to it' : 'Parallel to it'
}

export function relationWord(kind: ElementKind, relation: OrientRelation): string {
  return relationLabel(kind, relation).split(' ')[0].toLowerCase()
}

export interface Oriented {
  fit: FitData
  /** How far, in degrees, the measured direction was from where the
   *  alignment put it. */
  deviationDeg: number
  /** Set when the measurement is further off than ORIENT_TOLERANCE_DEG —
   *  the alignment still happens, but the element is probably not the
   *  feature it was taken for. */
  warning: string | null
}

export class OrientError extends Error {}

/** The unit direction the element should have: the reference normal, signed
 *  to match the measured direction, or the measured direction projected into
 *  the plane. */
function targetDirection(dir: Vec3, normal: Vec3, relation: OrientRelation): Vec3 {
  if (relation === 'normal') {
    return dot(dir, normal) < 0 ? [-normal[0], -normal[1], -normal[2]] : normal
  }
  const projected = normalize(addScaled(dir, normal, -dot(dir, normal)))
  if (!projected) {
    throw new OrientError(
      'Cannot align: the direction stands straight on the reference plane, so there is no way to lay it into it.',
    )
  }
  return projected
}

/**
 * The element turned onto its designed relation with the reference plane.
 * The smallest rotation that carries the measured direction onto the target
 * one, about the element's centre — so the centre stays put, a plane's
 * in-plane basis follows its normal, and nothing measured (sigma, radius,
 * extents, coverage) changes.
 */
export function orientFit(fit: FitData, reference: PlaneFit, relation: OrientRelation): Oriented {
  if (!isOrientable(fit)) return { fit, deviationDeg: 0, warning: null }
  const dir = directionOf(fit)
  const target = targetDirection(dir, reference.normal, relation)
  const deviationDeg = acuteAngle(dir, target)
  const warning =
    deviationDeg > ORIENT_TOLERANCE_DEG
      ? `Measured ${deviationDeg.toFixed(2)}° off the aligned direction — more than the ${ORIENT_TOLERANCE_DEG}° an aligned feature is expected to be within. Check that the right reference and relation are chosen.`
      : null

  const axis = cross(dir, target)
  const sin = len(axis)
  const cos = dot(dir, target)
  const angle = Math.atan2(sin, cos)
  let turned: FitData = fit
  if (angle > 1e-12) {
    // A direction exactly reversed has no unique rotation axis — it cannot
    // happen here (the target is signed to match), but the guard costs
    // nothing.
    const rotAxis = sin > 1e-12 ? axis : anyPerpendicular(dir)
    const rot = rigidFromAxisAngle(rotAxis, angle)
    // Rotate about the centre: p' = R(p − c) + c.
    const c = fit.center
    const rc = [
      rot.r[0] * c[0] + rot.r[1] * c[1] + rot.r[2] * c[2],
      rot.r[3] * c[0] + rot.r[4] * c[1] + rot.r[5] * c[2],
      rot.r[6] * c[0] + rot.r[7] * c[1] + rot.r[8] * c[2],
    ]
    rot.t[0] = c[0] - rc[0]
    rot.t[1] = c[1] - rc[1]
    rot.t[2] = c[2] - rc[2]
    turned = transformFit(fit, rot)
  }
  // Pin the direction to the target exactly, so an aligned plane really is
  // parallel to its reference and not parallel to within floating-point
  // dust. The centre is put back verbatim for the same reason.
  const exact = withDirection(turned as OrientableFit, target, fit.center)
  return { fit: exact, deviationDeg, warning }
}

function withDirection(fit: OrientableFit, d: Vec3, center: Vec3): FitData {
  if (fit.kind === 'plane' || fit.kind === 'circle') return { ...fit, normal: d, center }
  if (fit.kind === 'line') return { ...fit, dir: d, center }
  return { ...fit, axis: d, center }
}

function anyPerpendicular(d: Vec3): Vec3 {
  const trial: Vec3 = Math.abs(d[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]
  return cross(d, trial)
}
