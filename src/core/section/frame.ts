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
import { rigidApply, rigidFromAxisAngle, rigidRotate, type Rigid } from '../deviation/rigid'
import type { ElementKind, FitData, Vec3 } from '../types'
import { addScaled, angleBetween, cross, dot, normalize } from '../vec'

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

/** One of the scan's own coordinate axes — after a datum alignment, the
 *  datum's. */
export type WorldAxis = 'x' | 'y' | 'z'

/** What a section is taken across: an element, by id, or a coordinate axis
 *  — the plane square to it, the way a CAD sketch is put on the XY plane. */
export type SectionRef = number | WorldAxis

export const WORLD_AXES: readonly WorldAxis[] = ['x', 'y', 'z']

export function isWorldAxis(ref: unknown): ref is WorldAxis {
  return ref === 'x' || ref === 'y' || ref === 'z'
}

export function worldAxisDir(axis: WorldAxis): Vec3 {
  return axis === 'x' ? [1, 0, 0] : axis === 'y' ? [0, 1, 0] : [0, 0, 1]
}

/** The coordinate plane across an axis, named as CAD names it: the XY plane
 *  is the one the Z axis stands on. */
export function worldPlaneName(axis: WorldAxis): string {
  return axis === 'x' ? 'YZ plane' : axis === 'y' ? 'XZ plane' : 'XY plane'
}

/**
 * The line a section slides along a coordinate axis, parallel to it through
 * `through` — the part's centre, so the plane's gizmo sits on the part
 * rather than at the world origin, which a scan may lie nowhere near. The
 * line starts where it crosses the coordinate plane through the origin, so
 * the offset along it is the plane's coordinate on that axis. The in-plane
 * X is the next axis round, and the sheet's Y the one after — a right-handed
 * frame with the sheet seen from the axis's positive end.
 */
export function worldCutAxis(axis: WorldAxis, through: Vec3 = [0, 0, 0]): CutAxis {
  const dir = worldAxisDir(axis)
  const basisU: Vec3 = axis === 'x' ? [0, 1, 0] : axis === 'y' ? [0, 0, 1] : [1, 0, 0]
  return { origin: addScaled(through, dir, -dot(through, dir)), dir, basisU }
}

/** What a reference reads as in the list and the report: the element's
 *  name, a coordinate plane's, or null for an element since deleted. */
export function sectionRefName(
  ref: SectionRef | null,
  elements: readonly { id: number; name: string }[],
): string | null {
  if (ref === null) return null
  if (isWorldAxis(ref)) return worldPlaneName(ref)
  return elements.find((e) => e.id === ref)?.name ?? null
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

/**
 * The line turned by hand: the gizmo's ring rotates the plane `degrees`
 * about `about` — a unit direction lying in the plane — through the plane's
 * own origin, the point the gizmo sits on. The plane pivots where the hand
 * is and keeps its offset, so the line it slides along is moved to keep
 * both: it leaves the element it was taken along, which is why a turned
 * section carries its reference's direction separately — see tiltOf.
 */
export function turnAxis(axis: CutAxis, offset: number, about: Vec3, degrees: number): CutAxis {
  const dir = normalize(axis.dir)
  if (!dir || !Number.isFinite(degrees)) return axis
  const off = Number.isFinite(offset) ? offset : 0
  const pivot = addScaled(axis.origin, dir, off)
  const m = rigidFromAxisAngle(about, (degrees * Math.PI) / 180)
  const out = new Float64Array(3)
  rigidRotate(m, dir[0], dir[1], dir[2], out)
  const turned: Vec3 = [out[0], out[1], out[2]]
  let basisU = axis.basisU
  if (basisU) {
    rigidRotate(m, basisU[0], basisU[1], basisU[2], out)
    basisU = [out[0], out[1], out[2]]
  }
  return { origin: addScaled(pivot, turned, -off), dir: turned, basisU }
}

/** How far a plane has been turned off the direction it was taken across,
 *  in degrees — zero for one still square to its reference, and for one
 *  whose reference gave no direction to compare with. */
export function tiltOf(refDir: Vec3 | null | undefined, normal: Vec3): number {
  if (!refDir) return 0
  const a = normalize(refDir)
  const b = normalize(normal)
  if (!a || !b) return 0
  const deg = angleBetween(a, b)
  // The hair a rotation and its inverse leave behind is not a tilt.
  return deg < 0.005 ? 0 : deg
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

/** "along Plane 1, +2.000 mm" — for the list row, the report and the sheet.
 *  A plane turned off its reference by the gizmo says by how much: "along
 *  Plane 1, +2.000 mm, tilted 4.3°". */
export function describeCut(refName: string | null, offset: number, tilt = 0): string {
  const mm = `${offset >= 0 ? '+' : '−'}${Math.abs(offset).toFixed(3)} mm`
  const turned = tilt > 0 ? `, tilted ${tilt.toFixed(1)}°` : ''
  return refName ? `along ${refName}, ${mm}${turned}` : `${mm} from a deleted element${turned}`
}
