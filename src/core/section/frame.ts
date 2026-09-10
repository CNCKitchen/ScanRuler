// SPDX-License-Identifier: AGPL-3.0-only
// Where a section cuts: the plane, and the two in-plane axes the 2D sheet is
// laid out along.
//
// A section is taken along an element that has a direction — a plane's
// normal, the axis of a cylinder, cone or line, a circle's normal — moved
// along that direction by an offset. The frame is frozen the moment the
// section is made: the reference element is remembered for the editor and
// the record, but re-fitting or deleting it afterwards leaves the cut where
// it was. What does move the frame is the part itself — a datum alignment
// carries it along with the scan it was cut from.
//
// The in-plane X axis is chosen once and kept: a plane hands over its own
// patch axes, everything else gets a deterministic perpendicular. An edit
// re-projects the axis it already had, so a section that is nudged by a
// millimetre does not turn its sheet under the measurements taken on it.
// U × V = normal, so laid flat the sheet is seen from the side the normal
// points to — for a plane fitted on a face, from outside the part.

import { orthoBasis } from '../fit/linalg'
import { rigidApply, rigidRotate, type Rigid } from '../deviation/rigid'
import type { ElementKind, FitData, Vec3 } from '../types'
import { addScaled, cross, dot, normalize } from '../vec'

export interface SectionFrame {
  origin: Vec3
  normal: Vec3
  basisU: Vec3
  basisV: Vec3
}

/** The kinds a section can be taken along: the ones with a direction. A
 *  sphere and a point have none to cut across. */
export const SECTION_REF_KINDS: readonly ElementKind[] = ['plane', 'cylinder', 'cone', 'line', 'circle']

export function canCutAlong(kind: ElementKind): boolean {
  return SECTION_REF_KINDS.includes(kind)
}

/** The line a section slides along: a point on it, the direction the offset
 *  counts positive in, and — from a plane — the in-plane X its patch is
 *  measured along. */
export interface CutAxis {
  origin: Vec3
  dir: Vec3
  basisU?: Vec3
}

/** The line a section slides along, off the element it is taken along. Null
 *  for the kinds with no direction. */
export function cutAxisOf(fit: FitData): CutAxis | null {
  switch (fit.kind) {
    case 'plane':
      return { origin: fit.center, dir: fit.normal, basisU: fit.basisU }
    case 'cylinder':
    case 'cone':
      return { origin: fit.center, dir: fit.axis }
    case 'line':
      return { origin: fit.center, dir: fit.dir }
    case 'circle':
      return { origin: fit.center, dir: fit.normal }
    default:
      return null
  }
}

/**
 * The frame a section takes along `fit`, `offset` millimetres along its
 * direction. `seedU` is an in-plane X to keep if one is already in use — it
 * is projected onto the new plane, and only a seed that has gone
 * perpendicular to it falls back to a fresh choice.
 */
export function sectionFrameFrom(fit: FitData, offset: number, seedU?: Vec3): SectionFrame | null {
  const axis = cutAxisOf(fit)
  return axis && sectionFrameAlong(axis, offset, seedU)
}

/** The frame `offset` millimetres along an axis already in hand. */
export function sectionFrameAlong(axis: CutAxis, offset: number, seedU?: Vec3): SectionFrame | null {
  const normal = normalize(axis.dir)
  if (!normal) return null
  const origin = addScaled(axis.origin, normal, Number.isFinite(offset) ? offset : 0)
  const basisU = inPlaneX(normal, seedU ?? axis.basisU)
  return { origin, normal, basisU, basisV: cross(normal, basisU) }
}

/** The axis a frozen frame slides along, given the offset it was taken at —
 *  what an edit works from when the element it was cut along is gone, or has
 *  since been re-fitted somewhere else: the section stays exactly where it
 *  is until the offset or the reference is actually changed. */
export function axisOfFrame(frame: SectionFrame, offset: number): CutAxis {
  return {
    origin: addScaled(frame.origin, frame.normal, -(Number.isFinite(offset) ? offset : 0)),
    dir: frame.normal,
    basisU: frame.basisU,
  }
}

/** The axis carried through a rigid motion of the scan. */
export function transformAxis(axis: CutAxis, m: Rigid): CutAxis {
  const out = new Float64Array(3)
  rigidApply(m, axis.origin[0], axis.origin[1], axis.origin[2], out)
  const origin: Vec3 = [out[0], out[1], out[2]]
  rigidRotate(m, axis.dir[0], axis.dir[1], axis.dir[2], out)
  const dir: Vec3 = [out[0], out[1], out[2]]
  if (!axis.basisU) return { origin, dir }
  rigidRotate(m, axis.basisU[0], axis.basisU[1], axis.basisU[2], out)
  return { origin, dir, basisU: [out[0], out[1], out[2]] }
}

/** A unit vector in the plane, as close to `want` as the plane allows. */
function inPlaneX(normal: Vec3, want: Vec3 | undefined): Vec3 {
  if (want) {
    const flat = normalize(addScaled(want, normal, -dot(want, normal)))
    if (flat) return flat
  }
  return orthoBasis(normal)[0]
}

/** The frame carried through a rigid motion of the scan. */
export function transformFrame(frame: SectionFrame, m: Rigid): SectionFrame {
  const out = new Float64Array(3)
  const move = (p: Vec3): Vec3 => {
    rigidApply(m, p[0], p[1], p[2], out)
    return [out[0], out[1], out[2]]
  }
  const turn = (d: Vec3): Vec3 => {
    rigidRotate(m, d[0], d[1], d[2], out)
    return [out[0], out[1], out[2]]
  }
  return {
    origin: move(frame.origin),
    normal: turn(frame.normal),
    basisU: turn(frame.basisU),
    basisV: turn(frame.basisV),
  }
}

/** A string that changes whenever the frame does, to a tenth of a micron —
 *  what tells a cut taken in one frame apart from the frame now in force. */
export function frameKey(frame: SectionFrame): string {
  const v = (a: Vec3) => a.map((x) => x.toFixed(4)).join(',')
  return `${v(frame.origin)}|${v(frame.normal)}|${v(frame.basisU)}`
}

/** "along Plane 1, +2.000 mm" — for the list row, the report and the sheet. */
export function describeCut(refName: string | null, offset: number): string {
  const mm = `${offset >= 0 ? '+' : '−'}${Math.abs(offset).toFixed(3)} mm`
  return refName ? `along ${refName}, ${mm}` : `${mm} from a deleted element`
}
