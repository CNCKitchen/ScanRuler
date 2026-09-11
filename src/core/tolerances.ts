// SPDX-License-Identifier: AGPL-3.0-only
//
// GD&T tolerances — the second family of dimensions (see dimensions.ts). A
// form tolerance asks how far one element's surface strays from its ideal
// shape; an orientation or a location tolerance asks how the element stands
// to a datum. Every value is the width — or, about an axis, the diameter —
// of the narrowest tolerance zone that would still hold the feature: the
// number a feature control frame is compared against.
//
// What the feature *is* follows ISO 1101. A plane is its measured surface,
// so a plane's parallelism is read off the scan points its fit rests on and
// includes the face's own flatness. A cylinder, a cone or a line is its axis,
// the derived feature, taken as the fitted straight line over the fitted
// length. A sphere or a circle stands by its centre. Form tolerances read the
// peak-to-peak residual the fit already carries.

import type { DimensionTypeInfo, DimensionValue } from './dimensions'
import type { ElementKind, FitData, PlaneFit, Vec3 } from './types'
import { EXTENT_MARGIN, refAxis, refPoint, type AxisRef } from './elements/refs'
import { orthoBasis } from './fit/linalg'
import {
  acuteAngle,
  addScaled,
  cross,
  dot,
  footOnLine,
  len,
  normalize,
  paramOnLine,
  scale,
  sub,
} from './vec'

export const TOLERANCE_TYPES: readonly DimensionTypeInfo[] = [
  {
    id: 'form-flatness',
    family: 'tolerance',
    group: 'form',
    label: 'Flatness',
    stem: 'Flatness',
    unit: 'mm',
    hint: 'How far the measured face strays from a perfect plane: the peak-to-peak deviation of its points.',
    slots: [{ roles: ['plane'], label: 'Plane' }],
  },
  {
    id: 'form-cylindricity',
    family: 'tolerance',
    group: 'form',
    label: 'Cylindricity',
    stem: 'Cylindricity',
    unit: 'mm',
    hint: 'How far the measured wall strays from a perfect cylinder, peak to peak.',
    slots: [{ roles: ['axis'], kinds: ['cylinder'], label: 'Cylinder' }],
  },
  {
    id: 'form-circularity',
    family: 'tolerance',
    group: 'form',
    label: 'Circularity',
    stem: 'Circularity',
    unit: 'mm',
    hint: 'How far the picked points stray from a perfect circle, radially, peak to peak.',
    slots: [{ roles: ['point'], kinds: ['circle'], label: 'Circle' }],
  },
  {
    id: 'form-sphericity',
    family: 'tolerance',
    group: 'form',
    label: 'Sphericity',
    stem: 'Sphericity',
    unit: 'mm',
    hint: 'How far the measured surface strays from a perfect sphere, peak to peak.',
    slots: [{ roles: ['point'], kinds: ['sphere'], label: 'Sphere' }],
  },
  {
    id: 'orient-parallelism',
    family: 'tolerance',
    group: 'orientation',
    label: 'Parallelism',
    stem: 'Parallelism',
    unit: 'mm',
    hint: 'The width of the narrowest zone parallel to the datum that holds the feature — a face by its measured surface, a cylinder by its axis.',
    slots: [
      { roles: ['plane', 'axis'], label: 'Feature' },
      { roles: ['plane', 'axis'], label: 'Datum' },
    ],
  },
  {
    id: 'orient-perpendicularity',
    family: 'tolerance',
    group: 'orientation',
    label: 'Perpendicularity',
    stem: 'Perpendicularity',
    unit: 'mm',
    hint: 'The width of the narrowest zone square to the datum that holds the feature — a face by its measured surface, a cylinder by its axis.',
    slots: [
      { roles: ['plane', 'axis'], label: 'Feature' },
      { roles: ['plane', 'axis'], label: 'Datum' },
    ],
  },
  {
    id: 'orient-angularity',
    family: 'tolerance',
    group: 'orientation',
    label: 'Angularity',
    stem: 'Angularity',
    unit: 'mm',
    hint: 'The width of the narrowest zone at the basic angle to the datum that holds the feature — a face by its measured surface, a cylinder by its axis.',
    slots: [
      { roles: ['plane', 'axis'], label: 'Feature' },
      { roles: ['plane', 'axis'], label: 'Datum' },
    ],
  },
  {
    id: 'loc-coaxiality',
    family: 'tolerance',
    group: 'location',
    label: 'Coaxiality',
    stem: 'Coaxiality',
    unit: 'mm',
    hint: 'The diameter of the narrowest zone about the datum axis that holds the feature axis — or, for a sphere or a circle, its centre: twice the furthest it strays.',
    slots: [
      {
        roles: ['axis', 'point'],
        kinds: ['cylinder', 'cone', 'line', 'sphere', 'circle'],
        label: 'Feature',
      },
      { roles: ['axis'], label: 'Datum axis' },
    ],
  },
]

export interface ToleranceOptions {
  /** The basic angle of an angularity, in degrees. */
  basic?: number
  /** Per slot: the scan points the element's fit rests on, packed x y z in
   *  the frame the elements are in — or null where there are none. Only a
   *  plane feature reads them. */
  surfaces?: readonly (Float32Array | null)[]
}

const DEG = Math.PI / 180
/** Under this much arc a fitted axis is only weakly placed — the same
 *  threshold the element panel warns at. */
const WEAK_ARC_DEG = 90

const mm = (v: number): string => `${v.toFixed(3)} mm`
const deg = (v: number): string => `${v.toFixed(3)}°`
const invalid = (label: string, why: string): DimensionValue => ({ label, invalid: why })

/** Rodrigues: `v` turned by `angle` about the unit axis `k`. */
function rotate(v: Vec3, k: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  const kv = cross(k, v)
  const kd = dot(k, v) * (1 - c)
  return [
    v[0] * c + kv[0] * s + k[0] * kd,
    v[1] * c + kv[1] * s + k[1] * kd,
    v[2] * c + kv[2] * s + k[2] * kd,
  ]
}

/** The spread of a point set along a direction: max minus min projection. */
function extentAlong(points: Float32Array, u: Vec3): number {
  let lo = Infinity
  let hi = -Infinity
  for (let i = 0; i + 2 < points.length; i += 3) {
    const d = points[i] * u[0] + points[i + 1] * u[1] + points[i + 2] * u[2]
    if (d < lo) lo = d
    if (d > hi) hi = d
  }
  return hi > lo ? hi - lo : 0
}

/** The spread of a plane's drawn patch along a direction — its four corners. */
function extentOfPatch(plane: PlaneFit, u: Vec3): number {
  return 2 * (Math.abs(dot(plane.basisU, u)) * plane.extentU + Math.abs(dot(plane.basisV, u)) * plane.extentV)
}

function axisEnds(axis: AxisRef): [Vec3, Vec3] {
  return [
    addScaled(axis.origin, axis.dir, -axis.halfLength),
    addScaled(axis.origin, axis.dir, axis.halfLength),
  ]
}

/** The arc warning for a fitted axis that rests on too little wall. */
function weakArc(fit: FitData, what: string): string | undefined {
  if ((fit.kind === 'cylinder' || fit.kind === 'cone') && fit.coverage < WEAK_ARC_DEG)
    return `The ${what} rests on only ${Math.round(fit.coverage)}° of arc, so its axis is weakly placed.`
  return undefined
}

const FORM_KIND: Record<string, ElementKind> = {
  Flatness: 'plane',
  Cylindricity: 'cylinder',
  Circularity: 'circle',
  Sphericity: 'sphere',
}

function formValue(label: string, fit: FitData | undefined): DimensionValue {
  if (!fit) return invalid(label, 'A reference is missing.')
  if (fit.kind !== FORM_KIND[label])
    return invalid(label, `${label} is a property of a ${FORM_KIND[label]}.`)
  if (fit.formError === undefined)
    return invalid(
      label,
      'The element carries no form error: it was constructed, not measured on the scan.',
    )
  return {
    label,
    value: mm(fit.formError),
    raw: fit.formError,
    anchor: fit.center,
    detail: `Peak to peak about the best fit · ${fit.usedPoints.toLocaleString('en-US')} points`,
  }
}

/** A toleranced feature or a datum, reduced to the direction the zone is
 *  built from: a plane's normal, or an axis. */
type Oriented =
  | { kind: 'plane'; dir: Vec3; plane: PlaneFit }
  | { kind: 'axis'; dir: Vec3; axis: AxisRef }

function orientedOf(fit: FitData | undefined): Oriented | null {
  if (!fit) return null
  if (fit.kind === 'plane') return { kind: 'plane', dir: fit.normal, plane: fit }
  const axis = refAxis(fit)
  return axis ? { kind: 'axis', dir: axis.dir, axis } : null
}

/**
 * Parallelism, perpendicularity and angularity are one measurement at three
 * basic angles: 0°, 90°, or the one typed. From the datum's direction and
 * the basic angle comes the ideal direction the feature should have; the
 * zone is bounded by two planes normal to it (a plane feature) or containing
 * it (an axis feature), and the value is how far the feature spreads across
 * that zone. The angle is unsigned, as on a drawing: the feature's direction
 * is folded onto the datum's side first, so a face at 150° reads as one at
 * 30°, and the ideal is turned from the datum *towards* the feature.
 */
function orientation(
  label: string,
  basic: number,
  fits: readonly FitData[],
  surfaces: ToleranceOptions['surfaces'],
): DimensionValue {
  const feature = orientedOf(fits[0])
  const datum = orientedOf(fits[1])
  if (!feature || !datum) return invalid(label, 'A reference is missing.')

  const f = dot(feature.dir, datum.dir) < 0 ? scale(feature.dir, -1) : feature.dir
  // A plane against a plane, or an axis against an axis, sit at the basic
  // angle by their own directions; mixed pairs are a quarter turn off it —
  // an axis parallel to a plane is perpendicular to the plane's normal.
  const rho = (feature.kind === datum.kind ? basic : 90 - basic) * DEG
  const hinge = normalize(cross(datum.dir, f)) ?? orthoBasis(datum.dir)[0]
  const ideal = rotate(datum.dir, hinge, rho)
  // A plane spreads across its zone along the ideal normal; an axis across
  // the planes that contain the ideal line, so at right angles to it within
  // the plane it is tilted in.
  const zoneNormal = feature.kind === 'plane' ? ideal : cross(hinge, ideal)
  const off = acuteAngle(f, ideal)

  let raw: number
  const warnings: string[] = []
  if (feature.kind === 'plane') {
    const surface = surfaces?.[0]
    if (surface && surface.length >= 3) raw = extentAlong(surface, zoneNormal)
    else {
      raw = extentOfPatch(feature.plane, zoneNormal)
      warnings.push('Read off the corners of the drawn patch — the feature has no measured surface.')
    }
  } else {
    const [a, b] = axisEnds(feature.axis)
    raw = Math.abs(dot(sub(b, a), zoneNormal))
  }
  const weakFeature = weakArc(fits[0], 'feature')
  const weakDatum = weakArc(fits[1], 'datum')
  if (weakFeature) warnings.push(weakFeature)
  if (weakDatum) warnings.push(weakDatum)

  const detail =
    label === 'Parallelism'
      ? `${deg(off)} off parallel`
      : label === 'Perpendicularity'
        ? `${deg(off)} off square`
        : `${deg(off)} off the basic ${basic.toFixed(2)}°`
  return {
    label,
    value: mm(raw),
    raw,
    anchor: feature.kind === 'plane' ? feature.plane.center : feature.axis.origin,
    detail,
    warning: warnings.length ? warnings.join(' ') : undefined,
  }
}

/** Twice the furthest the feature strays from the datum axis: a sphere or a
 *  circle by its centre, anything with an axis by the two ends of its fitted
 *  length — a tilted axis strays most at an end. */
function coaxiality(fits: readonly FitData[]): DimensionValue {
  const feature = fits[0]
  const datum = fits[1] ? refAxis(fits[1]) : null
  if (!feature || !datum) return invalid('Coaxiality', 'A reference is missing.')
  const centre =
    feature.kind === 'sphere' || feature.kind === 'circle' || feature.kind === 'point'
      ? refPoint(feature)
      : null
  const axis = centre ? null : refAxis(feature)
  if (!centre && !axis) return invalid('Coaxiality', 'The feature has neither an axis nor a centre.')
  const label = centre ? 'Concentricity' : 'Coaxiality'
  const probes = centre ? [centre] : axisEnds(axis!)

  let worst = -1
  let at: Vec3 = probes[0]
  let beyond = false
  const offsets: number[] = []
  for (const p of probes) {
    const d = len(sub(p, footOnLine(p, datum.origin, datum.dir)))
    offsets.push(d)
    if (d > worst) {
      worst = d
      at = p
    }
    if (Math.abs(paramOnLine(p, datum.origin, datum.dir)) > datum.halfLength * EXTENT_MARGIN)
      beyond = true
  }
  const raw = 2 * worst
  const warnings: string[] = []
  if (beyond) warnings.push('The feature reaches beyond the measured section of the datum axis.')
  const weakFeature = weakArc(feature, 'feature')
  const weakDatum = weakArc(fits[1], 'datum')
  if (weakFeature) warnings.push(weakFeature)
  if (weakDatum) warnings.push(weakDatum)
  return {
    label,
    value: `Ø ${mm(raw)}`,
    raw,
    anchor: at,
    detail: centre
      ? `Centre ${mm(offsets[0])} off the datum axis`
      : `Axis ends ${mm(offsets[0])} and ${mm(offsets[1])} off the datum axis`,
    warning: warnings.length ? warnings.join(' ') : undefined,
  }
}

/** Evaluate a tolerance from the resolved geometries of its references, in
 *  slot order. Pure, like evaluateDimension: invalid rather than thrown. */
export function evaluateTolerance(
  type: string,
  fits: readonly FitData[],
  opts: ToleranceOptions = {},
): DimensionValue {
  switch (type) {
    case 'form-flatness':
      return formValue('Flatness', fits[0])
    case 'form-cylindricity':
      return formValue('Cylindricity', fits[0])
    case 'form-circularity':
      return formValue('Circularity', fits[0])
    case 'form-sphericity':
      return formValue('Sphericity', fits[0])
    case 'orient-parallelism':
      return orientation('Parallelism', 0, fits, opts.surfaces)
    case 'orient-perpendicularity':
      return orientation('Perpendicularity', 90, fits, opts.surfaces)
    case 'orient-angularity':
      if (opts.basic === undefined || !Number.isFinite(opts.basic))
        return invalid('Angularity', 'Type the basic angle the feature is drawn at.')
      return orientation('Angularity', opts.basic, fits, opts.surfaces)
    case 'loc-coaxiality':
      return coaxiality(fits)
    default:
      return invalid('Tolerance', `Unknown tolerance type "${type}".`)
  }
}
