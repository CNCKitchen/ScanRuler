// SPDX-License-Identifier: AGPL-3.0-only
import type { ElementKind, FitData, PlaneFit, Vec3 } from './types'
import {
  EXTENT_MARGIN,
  refAxis,
  refPlane,
  refPoint,
  roleOf,
  slotTakes,
  type SlotRoles,
} from './elements/refs'
import { hasDiameter } from './elements/assumed'
import { TOLERANCE_TYPES, evaluateTolerance, type ToleranceOptions } from './tolerances'
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
 *
 * Two families share the machinery. A *dimension* reads a number off the
 * part — a distance, an angle, a diameter. A *tolerance* checks a GD&T
 * characteristic — how flat a face is, how parallel it lies to a datum — and
 * is evaluated in core/tolerances. Both are drafted, listed, drawn, saved and
 * reported the same way; the family only decides which editor a type is
 * offered in, and keeps a viewport click from carrying a draft across.
 */

export type DimensionFamily = 'dimension' | 'tolerance'

export type DimensionGroup =
  | 'distance'
  | 'angle'
  | 'size'
  | 'form'
  | 'orientation'
  | 'location'

/** How a point–point distance between two spheres is anchored. */
export type SphereAnchor = 'center' | 'gap' | 'span'

/** The unit a type's value is in, which is also how a limit on it reads. */
export type DimensionUnit = 'mm' | '°'

export interface DimensionTypeInfo {
  id: string
  family: DimensionFamily
  group: DimensionGroup
  label: string
  /** What a new one is called: "Distance 3", "Flatness 1". */
  stem: string
  unit: DimensionUnit
  /** What the value means, for the creation UI. */
  hint: string
  slots: (SlotRoles & { label: string })[]
}

/** The name-counter key of a type: one counter per stem, so a renamed type
 *  still numbers on from where its kind left off. Lower-cased because the
 *  first two counters were saved under the group names. */
export const stemKey = (info: DimensionTypeInfo): string => info.stem.toLowerCase()

const DIMENSIONS: readonly DimensionTypeInfo[] = [
  {
    id: 'dist-point-point',
    family: 'dimension',
    group: 'distance',
    label: 'Point – Point',
    stem: 'Distance',
    unit: 'mm',
    hint: 'Straight-line distance between two points or sphere centers.',
    slots: [
      { roles: ['point'], label: 'From' },
      { roles: ['point'], label: 'To' },
    ],
  },
  {
    id: 'dist-point-axis',
    family: 'dimension',
    group: 'distance',
    label: 'Point – Axis',
    stem: 'Distance',
    unit: 'mm',
    hint: 'Perpendicular distance from a point to a cylinder axis or line.',
    slots: [
      { roles: ['point'], label: 'Point' },
      { roles: ['axis'], label: 'Axis' },
    ],
  },
  {
    id: 'dist-point-plane',
    family: 'dimension',
    group: 'distance',
    label: 'Point – Plane',
    stem: 'Distance',
    unit: 'mm',
    hint: 'Perpendicular distance from a point to a plane, signed along the plane normal.',
    slots: [
      { roles: ['point'], label: 'Point' },
      { roles: ['plane'], label: 'Plane' },
    ],
  },
  {
    id: 'dist-axis-axis',
    family: 'dimension',
    group: 'distance',
    label: 'Axis – Axis',
    stem: 'Distance',
    unit: 'mm',
    hint: 'Distance between two near-parallel axes, or at the closest approach of skew axes.',
    slots: [
      { roles: ['axis'], label: 'Axis A' },
      { roles: ['axis'], label: 'Axis B' },
    ],
  },
  {
    id: 'dist-axis-plane',
    family: 'dimension',
    group: 'distance',
    label: 'Axis – Plane',
    stem: 'Distance',
    unit: 'mm',
    hint: 'Distance from the middle of an axis to a near-parallel plane, signed along the normal.',
    slots: [
      { roles: ['axis'], label: 'Axis' },
      { roles: ['plane'], label: 'Plane' },
    ],
  },
  {
    id: 'dist-plane-plane',
    family: 'dimension',
    group: 'distance',
    label: 'Plane – Plane',
    stem: 'Distance',
    unit: 'mm',
    hint: 'Distance between two near-parallel planes, measured from the center of the first.',
    slots: [
      { roles: ['plane'], label: 'From' },
      { roles: ['plane'], label: 'To' },
    ],
  },
  {
    id: 'angle-axis-axis',
    family: 'dimension',
    group: 'angle',
    label: 'Axis – Axis',
    stem: 'Angle',
    unit: '°',
    hint: 'Angle between two axes (0–90°).',
    slots: [
      { roles: ['axis'], label: 'Axis A' },
      { roles: ['axis'], label: 'Axis B' },
    ],
  },
  {
    id: 'angle-axis-plane',
    family: 'dimension',
    group: 'angle',
    label: 'Axis – Plane',
    stem: 'Angle',
    unit: '°',
    hint: 'Angle between an axis and a plane surface (0–90°).',
    slots: [
      { roles: ['axis'], label: 'Axis' },
      { roles: ['plane'], label: 'Plane' },
    ],
  },
  {
    id: 'angle-plane-plane',
    family: 'dimension',
    group: 'angle',
    label: 'Plane – Plane',
    stem: 'Angle',
    unit: '°',
    hint: 'Angle between two plane surfaces via their outward normals (0–180°).',
    slots: [
      { roles: ['plane'], label: 'Plane A' },
      { roles: ['plane'], label: 'Plane B' },
    ],
  },
  {
    id: 'size-diameter',
    family: 'dimension',
    group: 'size',
    label: 'Diameter',
    stem: 'Diameter',
    unit: 'mm',
    hint: 'The fitted diameter of a sphere, a cylinder or a circle — so a size can carry a nominal and a tolerance.',
    slots: [{ roles: ['point', 'axis'], kinds: ['sphere', 'cylinder', 'circle'], label: 'Feature' }],
  },
]

/** Every type of both families, dimensions first. The tolerance family
 *  lives in core/tolerances, which imports only types from here. */
export function dimensionTypes(): readonly DimensionTypeInfo[] {
  return [...DIMENSIONS, ...TOLERANCE_TYPES]
}

/** The dimension family's types alone — what the dimension editor offers. */
export const DIMENSION_TYPES: readonly DimensionTypeInfo[] = DIMENSIONS

export function dimensionTypeInfo(id: string): DimensionTypeInfo {
  const info = dimensionTypes().find((t) => t.id === id)
  if (!info) throw new Error(`Unknown dimension type "${id}".`)
  return info
}

/**
 * Fit a selection (element kinds, in pick order) into a type's slots: the
 * slot index each selection lands in, or null when there is no way to seat
 * them all. A sub-assignment test, since a half-built draft holds one.
 *
 * A kind can play more than one role — a circle is a point and an axis — so
 * this is a small matching rather than a multiset test. Each selection tries
 * the slots that take the role it plays by default first, so a circle clicked
 * into a Point – Axis draft is the point unless only the axis slot is open.
 */
function seatSelection(info: DimensionTypeInfo, kinds: readonly ElementKind[]): number[] | null {
  if (kinds.length > info.slots.length) return null
  const taken = new Array<boolean>(info.slots.length).fill(false)
  const seats: number[] = []
  const place = (i: number): boolean => {
    if (i === kinds.length) return true
    const kind = kinds[i]
    const preferred = roleOf(kind)
    const order = info.slots
      .map((slot, s) => ({ slot, s }))
      .filter(({ slot, s }) => !taken[s] && slotTakes(slot, kind))
      .sort((a, b) => Number(b.slot.roles.includes(preferred)) - Number(a.slot.roles.includes(preferred)))
    for (const { s } of order) {
      taken[s] = true
      seats[i] = s
      if (place(i + 1)) return true
      taken[s] = false
    }
    return false
  }
  return place(0) ? seats : null
}

/**
 * The type a draft should be on, given what the user has actually selected.
 * Keeps the current type whenever the selection still fits it; otherwise
 * switches to one that takes the selection, never leaving the current family
 * and staying in the current group where possible. A single off-role pick
 * lands on the type of the group whose every slot takes it ("first select a
 * plane" → Plane – Plane) as the least committed guess — the second pick
 * re-resolves against both, so the guess never traps the user.
 */
export function resolveDimensionType(currentType: string, kinds: readonly ElementKind[]): string {
  const current = dimensionTypeInfo(currentType)
  if (seatSelection(current, kinds)) return currentType
  const candidates = dimensionTypes().filter(
    (t) => t.family === current.family && seatSelection(t, kinds) !== null,
  )
  if (candidates.length === 0) return currentType
  const pool = candidates.some((t) => t.group === current.group)
    ? candidates.filter((t) => t.group === current.group)
    : candidates
  const homogeneous =
    kinds.length === 1 && pool.find((t) => t.slots.every((s) => slotTakes(s, kinds[0])))
  return (homogeneous || pool[0]).id
}

/** Whether some type of the family could seat the whole selection — what
 *  decides if one more pick joins the selection or replaces the last. */
export function selectionFits(family: DimensionFamily, kinds: readonly ElementKind[]): boolean {
  return dimensionTypes().some((t) => t.family === family && seatSelection(t, kinds) !== null)
}

/** Place the selected elements (in pick order) into the type's slots — the
 *  seating resolveDimensionType found room for. When the type cannot seat
 *  them all, each in turn takes the first open slot that takes it, and the
 *  rest are left out: a pick that fits nothing never unseats the others. */
export function assignDimensionRefs(
  type: string,
  selected: readonly { id: number; kind: ElementKind }[],
): (number | null)[] {
  const info = dimensionTypeInfo(type)
  const refs: (number | null)[] = info.slots.map(() => null)
  const seats = seatSelection(
    info,
    selected.map((s) => s.kind),
  )
  if (seats) {
    seats.forEach((s, i) => (refs[s] = selected[i].id))
    return refs
  }
  for (const sel of selected) {
    const s = info.slots.findIndex((slot, i) => refs[i] === null && slotTakes(slot, sel.kind))
    if (s >= 0) refs[s] = sel.id
  }
  return refs
}

/**
 * What a value is checked against, when the user typed one. A tolerance has
 * a ceiling: the zone may be this wide and no wider. A dimension has a
 * nominal with an allowance either side of it.
 */
export type Limit =
  | { kind: 'max'; max: number }
  | { kind: 'band'; nominal: number; plus: number; minus: number }

/** How a value stands to its limit — the numbers the row, the pin and the
 *  report all print. */
export interface Verdict {
  /** Signed: the value less the nominal, or less the ceiling. */
  deviation: number
  /** How far outside the allowed range, signed; zero while within. */
  over: number
  pass: boolean
  /** The allowance restated: "limit 0.050 mm", "nominal 12.000 mm +0.020 / −0.020". */
  allowance: string
  /** The deviation, signed: "Δ −0.019 mm". */
  delta: string
  /** Why it fails: "0.012 mm over the limit". Absent while it passes. */
  alarm?: string
}

const inUnit = (v: number, unit: DimensionUnit): string =>
  unit === '°' ? `${v.toFixed(2)}°` : `${v.toFixed(3)} mm`
const signedInUnit = (v: number, unit: DimensionUnit): string =>
  `${v >= 0 ? '+' : ''}${inUnit(v, unit)}`

export function judgeLimit(raw: number, limit: Limit, unit: DimensionUnit): Verdict {
  if (limit.kind === 'max') {
    const deviation = raw - limit.max
    const over = Math.max(0, deviation)
    return {
      deviation,
      over,
      pass: over === 0,
      allowance: `limit ${inUnit(limit.max, unit)}`,
      delta: `Δ ${signedInUnit(deviation, unit)}`,
      alarm: over > 0 ? `${inUnit(over, unit)} over the limit` : undefined,
    }
  }
  const hi = limit.nominal + limit.plus
  const lo = limit.nominal - limit.minus
  const deviation = raw - limit.nominal
  const over = raw > hi ? raw - hi : raw < lo ? raw - lo : 0
  return {
    deviation,
    over,
    pass: over === 0,
    allowance: `nominal ${inUnit(limit.nominal, unit)} +${inUnit(limit.plus, unit)} / −${inUnit(limit.minus, unit)}`,
    delta: `Δ ${signedInUnit(deviation, unit)}`,
    alarm:
      over > 0
        ? `${inUnit(over, unit)} over the upper limit`
        : over < 0
          ? `${inUnit(-over, unit)} under the lower limit`
          : undefined,
  }
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
  /** What the value is checked against, if the user typed one. */
  limit?: Limit
  /** The basic angle of an angularity, in degrees. */
  basic?: number
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
  /** Where a pin goes when there is no line or arc to hang it on: the feature
   *  the value is about. */
  anchor?: Vec3
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

export interface EvaluateOptions extends ToleranceOptions {
  /** How a point–point distance between two spheres is anchored. */
  anchor?: SphereAnchor
}

/**
 * Compute a dimension's value from the already-resolved geometries of its
 * references, in slot order. Pure — returns invalid results rather than
 * throwing, so a broken reference never takes the panel down. A tolerance
 * type is handed on to its own evaluator.
 */
export function evaluateDimension(
  type: string,
  fits: FitData[],
  opts: EvaluateOptions = {},
): DimensionValue {
  if (TOLERANCE_TYPES.some((t) => t.id === type)) return evaluateTolerance(type, fits, opts)
  const anchor = opts.anchor
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

    case 'size-diameter': {
      const f = fits[0]
      if (!hasDiameter(f)) return invalid('Diameter', 'The reference has no diameter.')
      return {
        label: 'Diameter',
        value: mm(2 * f.radius),
        raw: 2 * f.radius,
        anchor: f.center,
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
  /** How the value stands to its limit — when one was typed and there is a
   *  value to hold against it. */
  verdict?: Verdict
}

/** Where the scan points an element's fit rests on come from, packed x y z
 *  in the frame the elements are in — null for an element that has none. A
 *  tolerance on a plane's surface reads them; nothing else asks. */
export type SurfaceSource = (elementId: number) => Float32Array | null

/** Resolve every dimension against the current elements. A dimension whose
 *  reference lost its geometry (a construction gone degenerate) reads as
 *  invalid rather than disappearing. */
export function evaluateDimensions(
  dims: readonly Dimension[],
  elements: readonly NamedGeometry[],
  surfaces?: SurfaceSource,
): EvaluatedDimension[] {
  return dims.map((dim) => {
    const info = dimensionTypeInfo(dim.type)
    const els = dim.refs.map((id) => elements.find((e) => e.id === id))
    const title = els.map((e) => e?.name ?? '?').join(' → ')
    const fits = els.map((e) => e?.fit)
    const value = fits.every((f): f is FitData => f !== undefined)
      ? evaluateDimension(dim.type, fits, {
          anchor: dim.anchor,
          basic: dim.basic,
          surfaces:
            info.family === 'tolerance' && surfaces ? dim.refs.map((id) => surfaces(id)) : undefined,
        })
      : {
          label: info.label,
          invalid: 'A referenced element is unavailable.',
        }
    const verdict =
      dim.limit && value.raw !== undefined && !value.invalid
        ? judgeLimit(value.raw, dim.limit, info.unit)
        : undefined
    return { dim, title, value, verdict }
  })
}
