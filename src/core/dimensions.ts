// SPDX-License-Identifier: AGPL-3.0-only
import type { FitData, PlaneFit, Vec3 } from './types'
import type { RefRole } from './elements/refs'
import { refAxis, refPlane, refPoint } from './elements/refs'
import {
  acuteAngle,
  add,
  addScaled,
  angleBetween,
  closestBetweenLines,
  cross,
  dot,
  footOnLine,
  len,
  mid,
  normalize,
  paramOnLine,
  scale,
  sub,
} from './vec'

/**
 * User-created measurements between elements, replacing the old "measure
 * everything against everything" list. The type system follows the standard
 * metrology reduction (see refs.ts): every element acts as a point, an axis
 * or a plane, and each dimension type picks two of those roles.
 */

export type DimensionGroup = 'distance' | 'angle'

/** How a point–point distance between two spheres is anchored. */
export type SphereAnchor = 'center' | 'gap' | 'span'

export interface DimensionTypeInfo {
  id: string
  group: DimensionGroup
  label: string
  /** What the value means, for the creation UI. */
  hint: string
  slots: { role: RefRole; label: string }[]
}

export const DIMENSION_TYPES: readonly DimensionTypeInfo[] = [
  {
    id: 'dist-point-point',
    group: 'distance',
    label: 'Point – Point',
    hint: 'Straight-line distance between two points or sphere centers.',
    slots: [
      { role: 'point', label: 'From' },
      { role: 'point', label: 'To' },
    ],
  },
  {
    id: 'dist-point-axis',
    group: 'distance',
    label: 'Point – Axis',
    hint: 'Perpendicular distance from a point to a cylinder axis or line.',
    slots: [
      { role: 'point', label: 'Point' },
      { role: 'axis', label: 'Axis' },
    ],
  },
  {
    id: 'dist-point-plane',
    group: 'distance',
    label: 'Point – Plane',
    hint: 'Perpendicular distance from a point to a plane, signed along the plane normal.',
    slots: [
      { role: 'point', label: 'Point' },
      { role: 'plane', label: 'Plane' },
    ],
  },
  {
    id: 'dist-axis-axis',
    group: 'distance',
    label: 'Axis – Axis',
    hint: 'Distance between two near-parallel axes, or at the closest approach of skew axes.',
    slots: [
      { role: 'axis', label: 'Axis A' },
      { role: 'axis', label: 'Axis B' },
    ],
  },
  {
    id: 'dist-axis-plane',
    group: 'distance',
    label: 'Axis – Plane',
    hint: 'Distance from the middle of an axis to a near-parallel plane, signed along the normal.',
    slots: [
      { role: 'axis', label: 'Axis' },
      { role: 'plane', label: 'Plane' },
    ],
  },
  {
    id: 'dist-plane-plane',
    group: 'distance',
    label: 'Plane – Plane',
    hint: 'Distance between two near-parallel planes, measured from the center of the first.',
    slots: [
      { role: 'plane', label: 'From' },
      { role: 'plane', label: 'To' },
    ],
  },
  {
    id: 'angle-axis-axis',
    group: 'angle',
    label: 'Axis – Axis',
    hint: 'Angle between two axes (0–90°).',
    slots: [
      { role: 'axis', label: 'Axis A' },
      { role: 'axis', label: 'Axis B' },
    ],
  },
  {
    id: 'angle-axis-plane',
    group: 'angle',
    label: 'Axis – Plane',
    hint: 'Angle between an axis and a plane surface (0–90°).',
    slots: [
      { role: 'axis', label: 'Axis' },
      { role: 'plane', label: 'Plane' },
    ],
  },
  {
    id: 'angle-plane-plane',
    group: 'angle',
    label: 'Plane – Plane',
    hint: 'Angle between two plane surfaces via their outward normals (0–180°).',
    slots: [
      { role: 'plane', label: 'Plane A' },
      { role: 'plane', label: 'Plane B' },
    ],
  },
]

export function dimensionTypeInfo(id: string): DimensionTypeInfo {
  const info = DIMENSION_TYPES.find((t) => t.id === id)
  if (!info) throw new Error(`Unknown dimension type "${id}".`)
  return info
}

/** Whether the given selection (as roles, in pick order) could fill the
 *  type's slots — a sub-multiset test, since a half-built draft holds one. */
function rolesFit(info: DimensionTypeInfo, roles: readonly RefRole[]): boolean {
  const open = info.slots.map((s) => s.role)
  return roles.every((role) => {
    const i = open.indexOf(role)
    if (i < 0) return false
    open.splice(i, 1)
    return true
  })
}

/**
 * The dimension type a draft should be on, given what the user has actually
 * selected. Keeps the current type whenever the selection still fits it;
 * otherwise switches to one that takes the selection, staying in the current
 * group (distance/angle) where possible. A single off-role pick lands on the
 * role–role type of the group ("first select a plane" → Plane – Plane) as the
 * least committed guess — the second pick re-resolves against both roles, so
 * the guess never traps the user.
 */
export function resolveDimensionType(currentType: string, roles: readonly RefRole[]): string {
  const current = dimensionTypeInfo(currentType)
  if (rolesFit(current, roles)) return currentType
  const candidates = DIMENSION_TYPES.filter((t) => rolesFit(t, roles))
  if (candidates.length === 0) return currentType
  const pool = candidates.some((t) => t.group === current.group)
    ? candidates.filter((t) => t.group === current.group)
    : candidates
  const homogeneous = roles.length === 1 && pool.find((t) => t.slots.every((s) => s.role === roles[0]))
  return (homogeneous || pool[0]).id
}

/** Place the selected elements (in pick order) into the type's slots: each
 *  slot takes the first still-unplaced selection of its role. */
export function assignDimensionRefs(
  type: string,
  selected: readonly { id: number; role: RefRole }[],
): (number | null)[] {
  const used = new Set<number>()
  return dimensionTypeInfo(type).slots.map((slot) => {
    const i = selected.findIndex((sel, idx) => !used.has(idx) && sel.role === slot.role)
    if (i < 0) return null
    used.add(i)
    return selected[i].id
  })
}

/** A stored dimension: references elements by id, values are recomputed. */
export interface Dimension {
  id: number
  type: string
  name: string
  refs: number[]
  /** Only meaningful on point–point between two spheres. */
  anchor?: SphereAnchor
  /** Drawn in the viewport unless explicitly hidden (undefined = shown). */
  visible?: boolean
}

export interface DimensionValue {
  /** 'Center distance', 'Plane angle', … */
  label: string
  /** Formatted, e.g. "12.345 mm" — undefined when the dimension is invalid. */
  value?: string
  raw?: number
  /** Distance line to draw in the viewport; angles carry an arc instead. */
  segment?: [Vec3, Vec3]
  /** How to draw an angle: two rays from a vertex, with the reported angle
   *  between exactly these directions. */
  arc?: { vertex: Vec3; dirA: Vec3; dirB: Vec3 }
  /** The value is shown but deserves a caveat. */
  warning?: string
  /** No value can be given, and this is why. */
  invalid?: string
  /** Supporting numbers: ΔX/ΔY/ΔZ for point–point, the fold angle for
   *  near-parallel pairs. */
  detail?: string
}

/** Beyond this fold angle, "parallel" distances stop being reported. */
export const PARALLEL_MAX_DEG = 3
/** Beyond this fold angle, a parallel distance carries a warning. */
export const PARALLEL_WARN_DEG = 0.5
/** How far past the measured patch/section a perpendicular foot may land
 *  before the dimension warns that it left the measured surface. */
const EXTENT_MARGIN = 1.3

const mm = (v: number): string => `${v.toFixed(3)} mm`
const signedMm = (v: number): string => `${v >= 0 ? '+' : ''}${v.toFixed(3)} mm`
const deg = (v: number): string => `${v.toFixed(2)}°`

const invalid = (label: string, why: string): DimensionValue => ({ label, invalid: why })

function footOnPlane(plane: PlaneFit, p: Vec3): Vec3 {
  return addScaled(p, plane.normal, -dot(sub(p, plane.center), plane.normal))
}

/** Whether a point (already on/near the plane) lies over the measured patch,
 *  with some margin — the check that keeps a fitted plane finite. */
function overPatch(plane: PlaneFit, p: Vec3): boolean {
  const r = sub(p, plane.center)
  const margin = EXTENT_MARGIN
  return (
    Math.abs(dot(r, plane.basisU)) <= plane.extentU * margin &&
    Math.abs(dot(r, plane.basisV)) <= plane.extentV * margin
  )
}

function deltaDetail(a: Vec3, b: Vec3): string {
  const d = sub(b, a)
  const f = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(3)}`
  return `ΔX ${f(d[0])} · ΔY ${f(d[1])} · ΔZ ${f(d[2])} mm`
}

/**
 * Compute a dimension's value from the already-resolved geometries of its
 * references, in slot order. Pure — returns invalid results rather than
 * throwing, so a broken reference never takes the panel down.
 */
export function evaluateDimension(
  type: string,
  fits: FitData[],
  anchor?: SphereAnchor,
): DimensionValue {
  switch (type) {
    case 'dist-point-point': {
      const a = refPoint(fits[0])
      const b = refPoint(fits[1])
      if (!a || !b) return invalid('Distance', 'A reference is not a point.')
      const centerDist = len(sub(b, a))
      const detail = deltaDetail(a, b)

      const bothSpheres = fits[0].kind === 'sphere' && fits[1].kind === 'sphere'
      if (bothSpheres && anchor && anchor !== 'center') {
        const rA = (fits[0] as { radius: number }).radius
        const rB = (fits[1] as { radius: number }).radius
        const u = normalize(sub(b, a))
        if (!u) return invalid('Distance', 'The two centers coincide.')
        if (anchor === 'gap') {
          return {
            label: 'Surface gap',
            value: mm(centerDist - rA - rB),
            raw: centerDist - rA - rB,
            segment: [addScaled(a, u, rA), addScaled(b, u, -rB)],
            detail,
            warning:
              centerDist - rA - rB < 0 ? 'The fitted spheres overlap — the gap is negative.' : undefined,
          }
        }
        return {
          label: 'Outer span',
          value: mm(centerDist + rA + rB),
          raw: centerDist + rA + rB,
          segment: [addScaled(a, u, -rA), addScaled(b, u, rB)],
          detail,
        }
      }
      return {
        label: 'Center distance',
        value: mm(centerDist),
        raw: centerDist,
        segment: [a, b],
        detail,
      }
    }

    case 'dist-point-axis': {
      const p = refPoint(fits[0])
      const axis = refAxis(fits[1])
      if (!p || !axis) return invalid('Distance to axis', 'A reference is missing.')
      const foot = footOnLine(p, axis.origin, axis.dir)
      const t = paramOnLine(p, axis.origin, axis.dir)
      return {
        label: 'Distance to axis',
        value: mm(len(sub(p, foot))),
        raw: len(sub(p, foot)),
        segment: [p, foot],
        warning:
          Math.abs(t) > axis.halfLength * EXTENT_MARGIN
            ? 'The perpendicular foot lies beyond the measured section of the axis.'
            : undefined,
      }
    }

    case 'dist-point-plane': {
      const p = refPoint(fits[0])
      const plane = refPlane(fits[1])
      if (!p || !plane) return invalid('Distance to plane', 'A reference is missing.')
      const d = dot(sub(p, plane.center), plane.normal)
      const foot = footOnPlane(plane, p)
      return {
        label: 'Distance to plane',
        value: signedMm(d),
        raw: d,
        segment: [p, foot],
        detail: 'Signed along the plane normal: + is outside the surface.',
        warning: overPatch(plane, foot)
          ? undefined
          : 'The projection falls outside the measured plane patch.',
      }
    }

    case 'dist-axis-axis': {
      const a = refAxis(fits[0])
      const b = refAxis(fits[1])
      if (!a || !b) return invalid('Axis distance', 'A reference is missing.')
      const fold = acuteAngle(a.dir, b.dir)
      const detail = `Axes ${deg(fold)} apart`

      if (fold <= PARALLEL_MAX_DEG) {
        // Near-parallel: measured from the middle of axis A, which is stable
        // however slight the residual skew is.
        const foot = footOnLine(a.origin, b.origin, b.dir)
        const t = paramOnLine(a.origin, b.origin, b.dir)
        const warnings: string[] = []
        if (fold > PARALLEL_WARN_DEG)
          warnings.push(`The axes are ${deg(fold)} off parallel — the value depends on where along the axes it is taken.`)
        if (Math.abs(t) > b.halfLength * EXTENT_MARGIN)
          warnings.push('Measured beyond the fitted section of the second axis.')
        return {
          label: 'Axis distance',
          value: mm(len(sub(a.origin, foot))),
          raw: len(sub(a.origin, foot)),
          segment: [a.origin, foot],
          detail,
          warning: warnings.length ? warnings.join(' ') : undefined,
        }
      }

      // Clearly skew: the shortest distance between the lines — but only
      // while the closest approach happens on the measured sections, so an
      // extrapolated crossing far off the part is not reported as real.
      const c = closestBetweenLines(a.origin, a.dir, b.origin, b.dir)
      if (
        Math.abs(c.t1) > a.halfLength * EXTENT_MARGIN ||
        Math.abs(c.t2) > b.halfLength * EXTENT_MARGIN
      ) {
        return invalid(
          'Axis distance',
          `The axes are ${deg(fold)} apart and their closest approach lies outside the measured sections.`,
        )
      }
      return {
        label: 'Axis distance',
        value: mm(len(sub(c.a, c.b))),
        raw: len(sub(c.a, c.b)),
        segment: [c.a, c.b],
        detail,
        warning: `The axes are ${deg(fold)} apart — this is the distance at their closest approach.`,
      }
    }

    case 'dist-axis-plane': {
      const axis = refAxis(fits[0])
      const plane = refPlane(fits[1])
      if (!axis || !plane) return invalid('Axis to plane', 'A reference is missing.')
      const tilt = 90 - acuteAngle(axis.dir, plane.normal)
      if (tilt > PARALLEL_MAX_DEG) {
        return invalid(
          'Axis to plane',
          `The axis is ${deg(tilt)} off parallel to the plane — there is no single distance. Use an angle dimension instead.`,
        )
      }
      const d = dot(sub(axis.origin, plane.center), plane.normal)
      const foot = footOnPlane(plane, axis.origin)
      const warnings: string[] = []
      if (tilt > PARALLEL_WARN_DEG)
        warnings.push(
          `The axis is ${deg(tilt)} off parallel — measured at the middle of its fitted section.`,
        )
      if (!overPatch(plane, foot))
        warnings.push('The projection falls outside the measured plane patch.')
      return {
        label: 'Axis to plane',
        value: signedMm(d),
        raw: d,
        segment: [axis.origin, foot],
        warning: warnings.length ? warnings.join(' ') : undefined,
      }
    }

    case 'dist-plane-plane': {
      const a = refPlane(fits[0])
      const b = refPlane(fits[1])
      if (!a || !b) return invalid('Plane distance', 'A reference is missing.')
      const fold = acuteAngle(a.normal, b.normal)
      if (fold > PARALLEL_MAX_DEG) {
        return invalid(
          'Plane distance',
          `The planes are ${deg(fold)} apart — a distance between non-parallel planes has no meaning. Use an angle dimension instead.`,
        )
      }
      const d = Math.abs(dot(sub(a.center, b.center), b.normal))
      const foot = footOnPlane(b, a.center)
      const warnings: string[] = []
      if (fold > PARALLEL_WARN_DEG)
        warnings.push(
          `The planes are ${deg(fold)} off parallel — the value depends on which plane is measured from.`,
        )
      if (!overPatch(b, foot))
        warnings.push(
          'The measured patches do not overlap — the distance is taken at the center of the first plane.',
        )
      return {
        label: 'Plane distance',
        value: mm(d),
        raw: d,
        segment: [a.center, foot],
        detail: `Planes ${deg(fold)} off parallel`,
        warning: warnings.length ? warnings.join(' ') : undefined,
      }
    }

    case 'angle-axis-axis': {
      const a = refAxis(fits[0])
      const b = refAxis(fits[1])
      if (!a || !b) return invalid('Axis angle', 'A reference is missing.')
      const v = acuteAngle(a.dir, b.dir)
      // Hinge the arc at the closest approach, with B's direction flipped
      // onto A's side so the drawn opening is the reported acute angle.
      const c = closestBetweenLines(a.origin, a.dir, b.origin, b.dir)
      const dirB = dot(a.dir, b.dir) < 0 ? scale(b.dir, -1) : b.dir
      return {
        label: 'Axis angle',
        value: deg(v),
        raw: v,
        arc: { vertex: mid(c.a, c.b), dirA: a.dir, dirB },
      }
    }

    case 'angle-axis-plane': {
      const axis = refAxis(fits[0])
      const plane = refPlane(fits[1])
      if (!axis || !plane) return invalid('Axis – plane angle', 'A reference is missing.')
      const v = 90 - acuteAngle(axis.dir, plane.normal)
      // Vertex where the axis pierces the plane (or under the axis middle
      // when it runs parallel); the second ray is the axis laid into the
      // plane, so the arc opens by exactly the surface angle.
      const denom = dot(axis.dir, plane.normal)
      const vertex =
        Math.abs(denom) > 0.1
          ? addScaled(axis.origin, axis.dir, dot(sub(plane.center, axis.origin), plane.normal) / denom)
          : addScaled(
              axis.origin,
              plane.normal,
              -dot(sub(axis.origin, plane.center), plane.normal),
            )
      const dirA = denom < 0 ? scale(axis.dir, -1) : axis.dir
      const inPlane = normalize(addScaled(dirA, plane.normal, -dot(dirA, plane.normal)))
      return {
        label: 'Axis – plane angle',
        value: deg(v),
        raw: v,
        arc: { vertex, dirA, dirB: inPlane ?? plane.basisU },
      }
    }

    case 'angle-plane-plane': {
      const a = refPlane(fits[0])
      const b = refPlane(fits[1])
      if (!a || !b) return invalid('Plane angle', 'A reference is missing.')
      // Fitted normals point out of the material, so the full 0–180° angle
      // is meaningful: opposing faces read 180°, a square corner 90°.
      const v = angleBetween(a.normal, b.normal)
      // Hinge the arc on the planes' intersection line, drawing the two
      // outward normals from it — the angle between them is the value. For
      // (anti-)parallel planes there is no hinge; use the midpoint instead.
      const hinge = cross(a.normal, b.normal)
      let vertex = mid(a.center, b.center)
      if (len(hinge) > 1e-6) {
        const da = dot(a.normal, a.center)
        const db = dot(b.normal, b.center)
        const h2 = dot(hinge, hinge)
        const p = scale(
          add(scale(cross(b.normal, hinge), da), scale(cross(hinge, a.normal), db)),
          1 / h2,
        )
        vertex = footOnLine(vertex, p, normalize(hinge)!)
      }
      return {
        label: 'Plane angle',
        value: deg(v),
        raw: v,
        detail: v > 90 ? `Supplement ${deg(180 - v)}` : undefined,
        arc: { vertex, dirA: a.normal, dirB: b.normal },
      }
    }

    default:
      return invalid('Dimension', `Unknown dimension type "${type}".`)
  }
}

/** The slice of an element a dimension needs to resolve and label itself. */
export interface NamedGeometry {
  id: number
  name: string
  fit?: FitData
}

export interface EvaluatedDimension {
  dim: Dimension
  /** "Sphere 1 → Plane 2" */
  title: string
  value: DimensionValue
}

/** Resolve every dimension against the current elements. A dimension whose
 *  reference lost its geometry (a construction gone degenerate) reads as
 *  invalid rather than disappearing. */
export function evaluateDimensions(
  dims: readonly Dimension[],
  elements: readonly NamedGeometry[],
): EvaluatedDimension[] {
  return dims.map((dim) => {
    const els = dim.refs.map((id) => elements.find((e) => e.id === id))
    const title = els.map((e) => e?.name ?? '?').join(' → ')
    const fits = els.map((e) => e?.fit)
    const value = fits.every((f): f is FitData => f !== undefined)
      ? evaluateDimension(dim.type, fits, dim.anchor)
      : {
          label: dimensionTypeInfo(dim.type).label,
          invalid: 'A referenced element is unavailable.',
        }
    return { dim, title, value }
  })
}
