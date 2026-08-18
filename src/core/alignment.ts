// SPDX-License-Identifier: AGPL-3.0-only
// Datum alignment: carry the part into the global coordinate system using
// measured elements as datums — the 3-2-1 / plane-line-point workflow of CMM
// software. A primary datum levels the part onto one axis, an optional
// secondary datum clocks the remaining rotation, and an origin point (or the
// datums themselves) fixes the translation.

import type { FitData, PlaneFit, Vec3 } from './types'
import {
  identityRigid,
  reorthonormalize,
  rigidApply,
  rigidCompose,
  rigidFromAxisAngle,
  rigidRotate,
  rigidRotationAngle,
  type Rigid,
} from './deviation/rigid'
import { acuteAngle, addScaled, cross, dot, normalize } from './vec'
import { orthoBasis } from './fit/linalg'
import { ConstructionError, evaluateConstruction } from './elements/construct'

/** A degenerate datum combination — the message is written for the user. */
export class AlignmentError extends Error {}

/** The three roles of a 3-2-1 alignment: level the part, stop it turning,
 *  set the zero point. */
export type AlignSlot = 'primary' | 'secondary' | 'origin'

/** How many points picked on the scan stand in for an element per slot —
 *  three span the levelling plane, two the rotation line, one the origin. */
export const ALIGN_PICK_COUNT: Record<AlignSlot, number> = {
  primary: 3,
  secondary: 2,
  origin: 1,
}

/** The stand-in geometry for a slot filled by picking on the scan: a plane
 *  through three points, a line through two, the point itself. Null while the
 *  picks are still incomplete.
 *
 *  The three-point plane's normal sign would otherwise depend on the order the
 *  points were clicked in — so when the surface normals at the picks come
 *  along (`towards`), the plane is turned to face the way the scanned surface
 *  does. That is what lets the UI talk about the picked face becoming the
 *  bottom or the top of the part and be right every time. */
export function fitFromAlignPicks(
  slot: AlignSlot,
  picks: Vec3[],
  modelSize: number,
  towards?: Vec3[],
): FitData | null {
  if (picks.length < ALIGN_PICK_COUNT[slot]) return null
  const pts: FitData[] = picks.map((center) => ({
    kind: 'point',
    center,
    sigma: 0,
    usedPoints: 0,
    regionSize: 0,
  }))
  try {
    if (slot === 'primary') {
      const plane = evaluateConstruction('plane-three-points', pts, [], modelSize) as PlaneFit
      const out: Vec3 = (towards ?? []).reduce<Vec3>(
        (acc, n) => [acc[0] + n[0], acc[1] + n[1], acc[2] + n[2]],
        [0, 0, 0],
      )
      if (dot(plane.normal, out) >= 0) return plane
      // Flip the normal and one basis vector together, so U × V stays N.
      return {
        ...plane,
        normal: [-plane.normal[0], -plane.normal[1], -plane.normal[2]],
        basisV: [-plane.basisV[0], -plane.basisV[1], -plane.basisV[2]],
      }
    }
    if (slot === 'secondary') return evaluateConstruction('line-two-points', pts, [], modelSize)
    return pts[0]
  } catch (e) {
    if (!(e instanceof ConstructionError)) throw e
    throw new AlignmentError(
      slot === 'primary'
        ? 'The three picked points lie on a line — spread them out.'
        : 'The two picked points coincide — pick them further apart.',
    )
  }
}

/** A signed global axis a datum direction is mapped onto. */
export type AxisDir = 'x+' | 'x-' | 'y+' | 'y-' | 'z+' | 'z-'

export const AXIS_DIRS: readonly AxisDir[] = ['z+', 'z-', 'x+', 'x-', 'y+', 'y-']

export function axisDirLabel(a: AxisDir): string {
  return (a[1] === '+' ? '+' : '−') + a[0].toUpperCase()
}

export function axisIndex(a: AxisDir): number {
  return a[0] === 'x' ? 0 : a[0] === 'y' ? 1 : 2
}

function axisVector(a: AxisDir): Vec3 {
  const v: Vec3 = [0, 0, 0]
  v[axisIndex(a)] = a[1] === '+' ? 1 : -1
  return v
}

/** The direction an element contributes as a datum: a plane its normal, a
 *  line or cylinder its axis. Points and spheres have none. */
export function datumDirection(fit: FitData): Vec3 | null {
  if (fit.kind === 'plane') return fit.normal
  if (fit.kind === 'line') return fit.dir
  if (fit.kind === 'cylinder') return fit.axis
  return null
}

export interface DatumSpec {
  fit: FitData
  axis: AxisDir
}

/** Below this angle two datum directions cannot clock a rotation. Matches the
 *  plane-intersection threshold in the constructions. */
const MIN_CLOCK_ANGLE = 0.2

/**
 * The rigid transform that carries the part into the global system defined by
 * the datums:
 *
 * - The primary datum's direction becomes the chosen signed axis. A plane also
 *   sets the zero of that axis (the plane lands on coordinate 0); a cylinder
 *   or line axis sets the zero of both perpendicular coordinates (the datum
 *   axis lands on the global axis line).
 * - The secondary datum's direction, projected perpendicular to the primary,
 *   becomes its chosen axis and clocks the rotation. It sets any of its
 *   coordinates the primary left open the same way.
 * - The origin point sets the zero of every coordinate the datums left open.
 *
 * With `centerOf` given (the part's bounding-box centre), any coordinate still
 * open after that is moved so the part ends up centred on it — a part fresh
 * from the scanner lands on the coordinate planes instead of keeping an
 * arbitrary offset. Without it, anything unconstrained keeps its position:
 * the rotation pivots about the primary datum's centre so the part does not
 * fly off screen.
 */
export function computeDatumAlignment(
  primary: DatumSpec,
  secondary: DatumSpec | null,
  origin: FitData | null,
  centerOf?: Vec3 | null,
): Rigid {
  const d1raw = datumDirection(primary.fit)
  if (!d1raw)
    throw new AlignmentError(
      'Levelling needs a direction — use a plane, cylinder, line, or three picked points.',
    )
  const d1 = normalize(d1raw)!
  const e1 = axisVector(primary.axis)

  const m = identityRigid()

  if (secondary) {
    const d2raw = datumDirection(secondary.fit)
    if (!d2raw)
      throw new AlignmentError(
        'The rotation step needs a direction — use a plane, cylinder, line, or two picked points.',
      )
    if (axisIndex(secondary.axis) === axisIndex(primary.axis))
      throw new AlignmentError('Levelling and rotation cannot use the same axis.')
    if (acuteAngle(d1, d2raw) < MIN_CLOCK_ANGLE)
      throw new AlignmentError(
        'These two directions are parallel — they cannot set the rotation. Use a different element or points.',
      )
    // Project the secondary direction perpendicular to the primary: the
    // primary always wins exactly, the secondary only clocks.
    const d2 = normalize(addScaled(d2raw, d1, -dot(d2raw, d1)))!
    const e2 = axisVector(secondary.axis)
    const d3 = cross(d1, d2)
    const e3 = cross(e1, e2)
    // R = Σₖ eₖ ⊗ dₖ maps the datum frame onto the global one.
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        m.r[i * 3 + j] = e1[i] * d1[j] + e2[i] * d2[j] + e3[i] * d3[j]
      }
    }
  } else {
    // Minimal rotation carrying d1 onto e1.
    const axis = cross(d1, e1)
    const sin = Math.hypot(...axis)
    const cos = dot(d1, e1)
    if (sin < 1e-12) {
      if (cos < 0) {
        // Antiparallel: a half-turn about any perpendicular.
        setRotationAxisAngle(m, orthoBasis(d1)[0], Math.PI)
      }
    } else {
      setRotationAxisAngle(m, axis, Math.atan2(sin, cos))
    }
  }
  const rigid = reorthonormalize(m)

  // Translation: pivot about the primary centre, then let each datum zero the
  // coordinates it owns, and the origin point everything still open.
  const c1 = primary.fit.center
  const out = new Float64Array(3)
  rigidRotate(rigid, c1[0], c1[1], c1[2], out)
  rigid.t[0] = c1[0] - out[0]
  rigid.t[1] = c1[1] - out[1]
  rigid.t[2] = c1[2] - out[2]

  const constrained = new Set<number>()
  const zeroAt = (anchor: Vec3, coords: number[]) => {
    rigidApply(rigid, anchor[0], anchor[1], anchor[2], out)
    for (const k of coords) {
      if (constrained.has(k)) continue
      rigid.t[k] -= out[k]
      constrained.add(k)
    }
  }
  const datumCoords = (spec: DatumSpec): number[] => {
    const k = axisIndex(spec.axis)
    // A plane owns the coordinate along its normal; an axis the two across it.
    return spec.fit.kind === 'plane' ? [k] : [0, 1, 2].filter((i) => i !== k)
  }
  zeroAt(c1, datumCoords(primary))
  if (secondary) zeroAt(secondary.fit.center, datumCoords(secondary))
  if (origin) zeroAt(origin.center, [0, 1, 2])
  if (centerOf) zeroAt(centerOf, [0, 1, 2])

  return rigid
}

/** The translation that puts the given point at 0, 0, 0 — an alignment made of
 *  nothing but a zero point, for the user who only wants to say where zero is. */
export function translationToOrigin(point: Vec3): Rigid {
  const m = identityRigid()
  m.t.set([-point[0], -point[1], -point[2]])
  return m
}

function setRotationAxisAngle(m: Rigid, axis: Vec3, angle: number): void {
  const n = normalize(axis)!
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  const t = 1 - c
  const [x, y, z] = n
  m.r.set([
    t * x * x + c, t * x * y - s * z, t * x * z + s * y,
    t * x * y + s * z, t * y * y + c, t * y * z - s * x,
    t * x * z - s * y, t * y * z + s * x, t * z * z + c,
  ])
}

/** The transform of the manual move / rotate box: turn the part about the
 *  global zero point — about X, then Y, then Z — then move it. */
export function manualRigid(move: Vec3, rotateDeg: Vec3): Rigid {
  const rot = (axis: Vec3, deg: number) => rigidFromAxisAngle(axis, (deg * Math.PI) / 180)
  const m = rigidCompose(
    rot([0, 0, 1], rotateDeg[2]),
    rigidCompose(rot([0, 1, 0], rotateDeg[1]), rot([1, 0, 0], rotateDeg[0])),
  )
  m.t.set(move)
  return m
}

/** How far a transform moves the part, for the preview readout. */
export function describeRigid(m: Rigid): { rotationDeg: number; translation: number } {
  return {
    rotationDeg: (rigidRotationAngle(m) * 180) / Math.PI,
    translation: Math.hypot(m.t[0], m.t[1], m.t[2]),
  }
}

const tmp = new Float64Array(3)

function movePoint(m: Rigid, p: Vec3): Vec3 {
  rigidApply(m, p[0], p[1], p[2], tmp)
  return [tmp[0], tmp[1], tmp[2]]
}

function moveDir(m: Rigid, d: Vec3): Vec3 {
  rigidRotate(m, d[0], d[1], d[2], tmp)
  return normalize([tmp[0], tmp[1], tmp[2]]) ?? [tmp[0], tmp[1], tmp[2]]
}

/** The same element geometry, carried through a rigid transform. Residual
 *  statistics are distances and survive a rigid motion unchanged. */
export function transformFit(fit: FitData, m: Rigid): FitData {
  switch (fit.kind) {
    case 'point':
    case 'sphere':
      return { ...fit, center: movePoint(m, fit.center) }
    case 'line':
      return { ...fit, center: movePoint(m, fit.center), dir: moveDir(m, fit.dir) }
    case 'cylinder':
      return { ...fit, center: movePoint(m, fit.center), axis: moveDir(m, fit.axis) }
    case 'plane':
      return {
        ...fit,
        center: movePoint(m, fit.center),
        normal: moveDir(m, fit.normal),
        basisU: moveDir(m, fit.basisU),
        basisV: moveDir(m, fit.basisV),
      }
  }
}
