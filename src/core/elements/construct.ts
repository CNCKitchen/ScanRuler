// SPDX-License-Identifier: AGPL-3.0-only
// Every way an element is created, as the creation UI offers them — fitted to
// the scan, picked on it, or constructed from other elements and typed-in
// numbers — and the geometry of the constructed ones. A construction keeps
// only its references and parameters and is evaluated again whenever a source
// changes; even a number found on the scan, a centroid or a symmetry plane,
// is carried as a parameter, so the element rebuilds, moves and saves exactly
// like one typed in by hand.

import type { CircleFit, ElementKind, FitData, LineFit, PlaneFit, PointFit, Vec3 } from '../types'
import {
  acuteAngle,
  add,
  addScaled,
  cross,
  dot,
  footOnLine,
  len,
  mid,
  normalize,
  scale,
  sub,
} from '../vec'
import { orthoBasis } from '../fit/linalg'
import { fmtLen, type DisplayUnits } from '../units'
import type { RefRole } from './refs'
import { refAxis, refPlane, refPoint, type AxisRef } from './refs'

/** A degenerate construction — the message is written for the user. */
export class ConstructionError extends Error {}

export interface SlotSpec {
  role: RefRole
  label: string
  /** Narrows the slot beyond its role to specific element kinds — an
   *  intersection with a cylinder needs the cylinder itself, not any axis. */
  kinds?: readonly ElementKind[]
}

export interface ParamSpec {
  key: string
  label: string
  /** A length: held in millimetres, typed and shown in the display units. */
  unit?: 'mm' // units-ok: an id, the field writes unitWord
  /** Not offered for typing: the number is found from the scan and carried
   *  in the params so the element rebuilds, moves and saves like any typed
   *  one — a centroid, a symmetry plane. */
  hidden?: boolean
  /** What the field holds when the method is chosen; empty without. */
  initial?: number
}

const found = (p: ParamSpec): ParamSpec => ({ ...p, hidden: true })

/** One way of creating an element. `fit` and `pick` run the existing
 *  click-on-the-scan flow; `construct` builds geometry from other elements
 *  and/or typed-in numbers, evaluated by evaluateConstruction below. */
export interface CreationMethod {
  id: string
  kind: ElementKind
  mode: 'fit' | 'pick' | 'construct'
  label: string
  hint: string
  slots: SlotSpec[]
  params: ParamSpec[]
  /** Picks needed before a pick-mode method has a result — one for a point,
   *  three for a circle. Further picks refine rather than replace. */
  minPicks?: number
  /** A construction that searches the scan and can be confined to a surface
   *  marked by hand — the same brush a fit is confined with. */
  surface?: boolean
}

/** Whether a method's draft can take a hand-marked surface: every fit, and
 *  the constructions that search the scan. */
export function takesSurface(m: CreationMethod): boolean {
  return m.mode === 'fit' || m.surface === true
}

const XYZ: ParamSpec[] = [
  { key: 'x', label: 'X', unit: 'mm' }, // units-ok: an id
  { key: 'y', label: 'Y', unit: 'mm' }, // units-ok: an id
  { key: 'z', label: 'Z', unit: 'mm' }, // units-ok: an id
]

export const CREATION_METHODS: readonly CreationMethod[] = [
  // ---- Point ---------------------------------------------------------------
  {
    id: 'pick',
    kind: 'point',
    mode: 'pick',
    label: 'Pick on scan',
    hint: 'Click the point on the scan you want to measure to.',
    slots: [],
    params: [],
  },
  {
    id: 'point-coords',
    kind: 'point',
    mode: 'construct',
    label: 'From coordinates',
    hint: 'A fixed reference point, e.g. a datum from the drawing.',
    slots: [],
    params: XYZ,
  },
  {
    id: 'point-centroid',
    kind: 'point',
    mode: 'construct',
    label: 'Centroid of the scan',
    hint: 'The centre of the volume the scan encloses, read off the mesh the moment this is chosen. An open scan gets the centre of its surface instead, and says so; a marked surface gets the centre of the marking.',
    slots: [],
    params: XYZ.map(found),
    surface: true,
  },
  {
    id: 'point-midpoint',
    kind: 'point',
    mode: 'construct',
    label: 'Midpoint of two points',
    hint: 'Halfway between two points or sphere centers.',
    slots: [
      { role: 'point', label: 'Point A' },
      { role: 'point', label: 'Point B' },
    ],
    params: [],
  },
  {
    id: 'point-line-plane',
    kind: 'point',
    mode: 'construct',
    label: 'Line–plane intersection',
    hint: 'Where a line or cylinder axis pierces a plane.',
    slots: [
      { role: 'axis', label: 'Line or cylinder' },
      { role: 'plane', label: 'Plane' },
    ],
    params: [],
  },
  {
    id: 'point-center',
    kind: 'point',
    mode: 'construct',
    label: 'Centre of a feature',
    hint: 'The centre of a sphere or a circle, or of a torus’s ring, as a point of its own.',
    slots: [{ role: 'point', label: 'Sphere, circle or torus', kinds: ['sphere', 'circle', 'torus'] }],
    params: [],
  },
  {
    id: 'point-three-planes',
    kind: 'point',
    mode: 'construct',
    label: 'Three-plane intersection',
    hint: 'The corner where three planes meet — two faces and the floor, say.',
    slots: [
      { role: 'plane', label: 'Plane A' },
      { role: 'plane', label: 'Plane B' },
      { role: 'plane', label: 'Plane C' },
    ],
    params: [],
  },
  {
    id: 'point-line-line',
    kind: 'point',
    mode: 'construct',
    label: 'Line–line intersection',
    hint: 'Where two lines or axes cross. Measured lines never meet exactly: they are taken to cross at the middle of their nearest approach as long as they pass no further apart than Max gap, and refused past it — two skew lines have no intersection.',
    slots: [
      { role: 'axis', label: 'Line or axis A' },
      { role: 'axis', label: 'Line or axis B' },
    ],
    params: [{ key: 'gap', label: 'Max gap', unit: 'mm', initial: 0.1 }], // units-ok: an id
  },
  {
    id: 'point-project',
    kind: 'point',
    mode: 'construct',
    label: 'Projected onto a plane',
    hint: 'A point, or the centre of a sphere, circle or torus, dropped square onto a plane.',
    slots: [
      { role: 'point', label: 'Point' },
      { role: 'plane', label: 'Onto plane' },
    ],
    params: [],
  },
  // ---- Line ----------------------------------------------------------------
  {
    id: 'line-two-points',
    kind: 'line',
    mode: 'construct',
    label: 'Through two points',
    hint: 'The line through two points or sphere centers.',
    slots: [
      { role: 'point', label: 'Point A' },
      { role: 'point', label: 'Point B' },
    ],
    params: [],
  },
  {
    id: 'line-axis',
    kind: 'line',
    mode: 'construct',
    label: 'Axis of a feature',
    hint: 'The axis of a cylinder, a cone or a torus, or a circle’s normal through its centre, as a line of its own.',
    slots: [{ role: 'axis', label: 'Cylinder, cone, torus or circle' }],
    params: [],
  },
  {
    id: 'line-plane-plane',
    kind: 'line',
    mode: 'construct',
    label: 'Plane–plane intersection',
    hint: 'The edge line where two planes meet.',
    slots: [
      { role: 'plane', label: 'Plane A' },
      { role: 'plane', label: 'Plane B' },
    ],
    params: [],
  },
  {
    id: 'line-plane-point',
    kind: 'line',
    mode: 'construct',
    label: 'Square to a plane through a point',
    hint: 'The line through a point along a plane’s normal — the plumb line from a feature to its datum.',
    slots: [
      { role: 'plane', label: 'Plane' },
      { role: 'point', label: 'Through point' },
    ],
    params: [],
  },
  {
    id: 'line-project',
    kind: 'line',
    mode: 'construct',
    label: 'Projected onto a plane',
    hint: 'A line or a feature’s axis laid square onto a plane — a bore’s axis on its datum face, to measure where it runs in that face.',
    slots: [
      { role: 'axis', label: 'Line or axis' },
      { role: 'plane', label: 'Onto plane' },
    ],
    params: [],
  },
  {
    id: 'line-coords',
    kind: 'line',
    mode: 'construct',
    label: 'From coordinates',
    hint: 'A fixed reference line: its direction, a point on it and the length drawn.',
    slots: [],
    params: [
      { key: 'dx', label: 'Direction X' },
      { key: 'dy', label: 'Direction Y' },
      { key: 'dz', label: 'Direction Z' },
      ...XYZ.map((p) => ({ ...p, key: 'p' + p.key, label: 'Point ' + p.label })),
      { key: 'length', label: 'Length', unit: 'mm' }, // units-ok: an id
    ],
  },
  // ---- Plane ---------------------------------------------------------------
  {
    id: 'fit',
    kind: 'plane',
    mode: 'fit',
    label: 'Fit to scan',
    hint: 'Click a point on the flat surface in the 3D view.',
    slots: [],
    params: [],
  },
  {
    id: 'plane-three-points',
    kind: 'plane',
    mode: 'construct',
    label: 'Through three points',
    hint: 'The plane spanned by three points or sphere centers.',
    slots: [
      { role: 'point', label: 'Point A' },
      { role: 'point', label: 'Point B' },
      { role: 'point', label: 'Point C' },
    ],
    params: [],
  },
  {
    id: 'plane-offset',
    kind: 'plane',
    mode: 'construct',
    label: 'Offset from plane',
    hint: 'A parallel plane, shifted along the source normal.',
    slots: [{ role: 'plane', label: 'Plane' }],
    params: [{ key: 'offset', label: 'Offset', unit: 'mm' }], // units-ok: an id
  },
  {
    id: 'plane-midplane',
    kind: 'plane',
    mode: 'construct',
    label: 'Midplane of two planes',
    hint: 'The symmetry plane between two (near-parallel) planes.',
    slots: [
      { role: 'plane', label: 'Plane A' },
      { role: 'plane', label: 'Plane B' },
    ],
    params: [],
  },
  {
    id: 'plane-offset-point',
    kind: 'plane',
    mode: 'construct',
    label: 'Parallel through a point',
    hint: 'A plane parallel to another, through a point or a feature’s centre instead of at a typed offset.',
    slots: [
      { role: 'plane', label: 'Parallel to' },
      { role: 'point', label: 'Through point' },
    ],
    params: [],
  },
  {
    id: 'plane-line-point',
    kind: 'plane',
    mode: 'construct',
    label: 'Normal to a line through a point',
    hint: 'The plane square to a line or an axis, through a point — a cross-section of a shaft at a feature. The point’s foot on the line lies in it too, so it is also the plane along the line at that place.',
    slots: [
      { role: 'axis', label: 'Line or axis' },
      { role: 'point', label: 'Through point' },
    ],
    params: [],
  },
  {
    id: 'plane-angle',
    kind: 'plane',
    mode: 'construct',
    label: 'At an angle about an axis',
    hint: 'A plane containing a line or an axis, turned about it by an angle. At 0° it lies as near parallel to the zero-angle plane as the axis allows — the plane itself when the axis lies in it — and the angle turns right-handed about the axis.',
    slots: [
      { role: 'axis', label: 'Rotation axis' },
      { role: 'plane', label: 'Zero-angle plane' },
    ],
    params: [{ key: 'angle', label: 'Angle (°)', initial: 0 }],
  },
  {
    id: 'plane-line-plane',
    kind: 'plane',
    mode: 'construct',
    label: 'Square to a plane through a line',
    hint: 'The plane that contains a line or an axis and stands square to another plane.',
    slots: [
      { role: 'axis', label: 'Line it contains' },
      { role: 'plane', label: 'Square to plane' },
    ],
    params: [],
  },
  {
    id: 'plane-two-lines',
    kind: 'plane',
    mode: 'construct',
    label: 'Through two lines',
    hint: 'The plane containing two lines or axes that cross or run parallel. Measured lines never cross exactly: they are taken to as long as they pass no further apart than Max gap, and refused past it — two skew lines lie in no one plane.',
    slots: [
      { role: 'axis', label: 'Line or axis A' },
      { role: 'axis', label: 'Line or axis B' },
    ],
    params: [{ key: 'gap', label: 'Max gap', unit: 'mm', initial: 0.1 }], // units-ok: an id
  },
  {
    id: 'plane-tangent-sphere',
    kind: 'plane',
    mode: 'construct',
    label: 'Tangent to a sphere',
    hint: 'The plane touching a sphere on the side facing a point.',
    slots: [
      { role: 'point', label: 'Sphere', kinds: ['sphere'] },
      { role: 'point', label: 'Toward point' },
    ],
    params: [],
  },
  {
    id: 'plane-tangent-cylinder',
    kind: 'plane',
    mode: 'construct',
    label: 'Tangent to a cylinder',
    hint: 'The plane touching a cylinder along its length, on the side facing a point — the flat a shaft would rest on.',
    slots: [
      { role: 'axis', label: 'Cylinder', kinds: ['cylinder'] },
      { role: 'point', label: 'Toward point' },
    ],
    params: [],
  },
  {
    id: 'plane-coords',
    kind: 'plane',
    mode: 'construct',
    label: 'From coordinates',
    hint: 'A fixed datum plane: a normal direction and a point it passes through.',
    slots: [],
    params: [
      { key: 'nx', label: 'Normal X' },
      { key: 'ny', label: 'Normal Y' },
      { key: 'nz', label: 'Normal Z' },
      ...XYZ.map((p) => ({ ...p, key: 'p' + p.key, label: 'Point ' + p.label })),
    ],
  },
  {
    id: 'plane-symmetry',
    kind: 'plane',
    mode: 'construct',
    label: 'Symmetry plane of the scan',
    hint: 'The mirror plane the part matches itself across, found by reflecting the scan and fitting the reflection back onto it — from the best of the three principal planes, or from a plane you choose as the seed. Mark the surface by hand to keep a fixture or a broken patch out of the search.',
    slots: [],
    params: [
      found({ key: 'nx', label: 'Normal X' }),
      found({ key: 'ny', label: 'Normal Y' }),
      found({ key: 'nz', label: 'Normal Z' }),
      ...XYZ.map((p) => found({ ...p, key: 'p' + p.key, label: 'Point ' + p.label })),
      found({ key: 'rms', label: 'Mirror RMS', unit: 'mm' }), // units-ok: an id
      found({ key: 'matched', label: 'Matched samples' }),
      found({ key: 'sampled', label: 'Samples' }),
    ],
    surface: true,
  },
  // ---- Sphere / Cylinder / Cone --------------------------------------------
  {
    id: 'fit',
    kind: 'sphere',
    mode: 'fit',
    label: 'Fit to scan',
    hint: 'Click a point on the sphere in the 3D view.',
    slots: [],
    params: [],
  },
  {
    id: 'fit',
    kind: 'cylinder',
    mode: 'fit',
    label: 'Fit to scan',
    hint: 'Click a point on the cylindrical surface in the 3D view.',
    slots: [],
    params: [],
  },
  {
    id: 'fit',
    kind: 'cone',
    mode: 'fit',
    label: 'Fit to scan',
    hint: 'Click a point on the tapered surface in the 3D view.',
    slots: [],
    params: [],
  },
  {
    id: 'fit',
    kind: 'torus',
    mode: 'fit',
    label: 'Fit to scan',
    hint: 'Click a point on the middle of a round — a fillet, a bend, an O-ring seat — in the 3D view.',
    slots: [],
    params: [],
  },
  // ---- Circle ----------------------------------------------------------------
  {
    id: 'circle-points',
    kind: 'circle',
    mode: 'pick',
    label: 'Through picked points (3+)',
    hint: 'Click three or more points around the feature — a hole rim, a boss edge. More points refine the fit.',
    slots: [],
    params: [],
    minPicks: 3,
  },
  {
    id: 'circle-plane-cylinder',
    kind: 'circle',
    mode: 'construct',
    label: 'Plane–cylinder intersection',
    hint: "The circle where a cylinder crosses a plane — a bore's rim, a boss at its base.",
    slots: [
      { role: 'plane', label: 'Plane' },
      { role: 'axis', label: 'Cylinder', kinds: ['cylinder'] },
    ],
    params: [],
  },
  {
    id: 'circle-plane-sphere',
    kind: 'circle',
    mode: 'construct',
    label: 'Plane–sphere intersection',
    hint: 'The circle where a sphere crosses a plane.',
    slots: [
      { role: 'plane', label: 'Plane' },
      { role: 'point', label: 'Sphere', kinds: ['sphere'] },
    ],
    params: [],
  },
  {
    id: 'circle-coords',
    kind: 'circle',
    mode: 'construct',
    label: 'From coordinates',
    hint: 'A fixed reference circle: its diameter, the normal of its plane and its center.',
    slots: [],
    params: [
      { key: 'd', label: 'Diameter', unit: 'mm' }, // units-ok: an id
      { key: 'nx', label: 'Normal X' },
      { key: 'ny', label: 'Normal Y' },
      { key: 'nz', label: 'Normal Z' },
      ...XYZ.map((p) => ({ ...p, key: 'c' + p.key, label: 'Center ' + p.label })),
    ],
  },
]

export function methodsForKind(kind: ElementKind): CreationMethod[] {
  return CREATION_METHODS.filter((m) => m.kind === kind)
}

export function creationMethod(kind: ElementKind, id: string): CreationMethod {
  const m = CREATION_METHODS.find((c) => c.kind === kind && c.id === id)
  if (!m) throw new Error(`Unknown creation method "${id}" for ${kind}.`)
  return m
}

/** Zero residual block for picked/constructed geometry. */
const NO_FIT_STATS = { sigma: 0, usedPoints: 0, regionSize: 0 }

/** A plane through `center` facing `normal`, drawn at a share of the
 *  part's size since nothing was measured to give it extents. */
function planeAt(center: Vec3, normal: Vec3, fallbackSize: number) {
  const [basisU, basisV] = orthoBasis(normal)
  const extent = Math.max(fallbackSize * 0.3, 1)
  return {
    kind: 'plane' as const,
    center,
    normal,
    basisU,
    basisV,
    extentU: extent,
    extentV: extent,
  }
}

const need = <T>(v: T | null, what: string): T => {
  if (v === null) throw new ConstructionError(`Missing ${what}.`)
  return v
}

function pointOf(fit: FitData, label: string): Vec3 {
  return need(refPoint(fit), `a point from ${label}`)
}

/** Two planes are "parallel" for construction purposes below this angle. */
const INTERSECT_MIN_ANGLE = 0.2

/** How far a cylinder may lean against a plane before their intersection stops
 *  being reported as a circle. It is an ellipse the moment there is any tilt at
 *  all, but below this the major axis is within 0.4 % of the radius — inside
 *  the noise of any fit — while past it the "circle" would be a lie. */
const SECTION_MAX_TILT = 5

/** `p` dropped square onto the plane. */
function ontoPlane(p: Vec3, pl: PlaneFit): Vec3 {
  return addScaled(p, pl.normal, -dot(sub(p, pl.center), pl.normal))
}

/** `v` turned by `angle` radians about the unit `axis`, right-handed
 *  (Rodrigues). */
function rotateAbout(v: Vec3, axis: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return add(add(scale(v, c), scale(cross(axis, v), s)), scale(axis, dot(axis, v) * (1 - c)))
}

/** A plane containing `axis`, facing `normal`, drawn about the point on the
 *  axis nearest `near` and long enough to show the axis's measured length. */
function planeThroughAxis(axis: AxisRef, normal: Vec3, near: Vec3, fallbackSize: number): PlaneFit {
  const center = footOnLine(near, axis.origin, axis.dir)
  const extent = Math.max(fallbackSize * 0.3, 1)
  return {
    kind: 'plane',
    center,
    normal,
    basisU: axis.dir,
    basisV: cross(normal, axis.dir),
    extentU: Math.max(axis.halfLength, extent),
    extentV: extent,
    ...NO_FIT_STATS,
  }
}

/** Where two lines or axes come nearest: the point on each, and the axes,
 *  or `parallel` when they run side by side. Refused, saying so, when they
 *  pass further apart than `maxGap` — two skew lines have no intersection,
 *  and the middle of their nearest approach is not one to put in its place
 *  unasked. */
function nearestApproach(
  fa: FitData,
  fb: FitData,
  maxGap: number,
): { a: AxisRef; b: AxisRef; onA: Vec3; onB: Vec3 } | { parallel: true; a: AxisRef; b: AxisRef } {
  const a = need(refAxis(fa), 'line or axis A')
  const b = need(refAxis(fb), 'line or axis B')
  if (acuteAngle(a.dir, b.dir) < INTERSECT_MIN_ANGLE) return { parallel: true, a, b }
  if (!(maxGap >= 0)) throw new ConstructionError('Enter the largest gap the two lines may pass apart and still be taken to cross.')
  const w = sub(a.origin, b.origin)
  const ab = dot(a.dir, b.dir)
  const d = dot(a.dir, w)
  const e = dot(b.dir, w)
  const denom = 1 - ab * ab
  const onA = addScaled(a.origin, a.dir, (ab * e - d) / denom)
  const onB = addScaled(b.origin, b.dir, (e - ab * d) / denom)
  if (len(sub(onA, onB)) > maxGap)
    throw new ConstructionError('The lines are skew: at their nearest they pass further apart than Max gap, so they do not cross. Raise Max gap to take the middle of that nearest approach, or check the two references.')
  return { a, b, onA, onB }
}

/**
 * Build the geometry of a constructed element from its already-resolved
 * source geometries and numeric parameters.
 *
 * `fallbackSize` is a model-scale length (the scan's bounding radius) used to
 * give elements with no inherent extent — coordinate planes and points typed
 * in by hand — something sensible to draw.
 *
 * Throws ConstructionError with a user-facing message on degenerate input.
 */
export function evaluateConstruction(
  method: string,
  refs: FitData[],
  params: number[],
  fallbackSize: number,
): FitData {
  switch (method) {
    case 'point-coords':
    case 'point-centroid': {
      const [x, y, z] = params
      if (![x, y, z].every(Number.isFinite))
        throw new ConstructionError(
          method === 'point-centroid' ? 'The centroid has not been measured yet.' : 'Enter all three coordinates.',
        )
      return { kind: 'point', center: [x, y, z], ...NO_FIT_STATS } satisfies PointFit
    }

    case 'point-midpoint': {
      const a = pointOf(refs[0], 'point A')
      const b = pointOf(refs[1], 'point B')
      return { kind: 'point', center: mid(a, b), ...NO_FIT_STATS } satisfies PointFit
    }

    case 'point-line-plane': {
      const axis = need(refAxis(refs[0]), 'a line or cylinder axis')
      const pl = need(refPlane(refs[1]), 'the plane')
      // Both are taken as unbounded, as everywhere else here — the pierce point
      // is allowed to sit beyond the measured section of either.
      if (90 - acuteAngle(axis.dir, pl.normal) < INTERSECT_MIN_ANGLE)
        throw new ConstructionError('The line runs parallel to the plane — they never meet.')
      const t = dot(sub(pl.center, axis.origin), pl.normal) / dot(axis.dir, pl.normal)
      return {
        kind: 'point',
        center: addScaled(axis.origin, axis.dir, t),
        ...NO_FIT_STATS,
      } satisfies PointFit
    }

    case 'line-two-points': {
      const a = pointOf(refs[0], 'point A')
      const b = pointOf(refs[1], 'point B')
      const dir = normalize(sub(b, a))
      if (!dir) throw new ConstructionError('The two points coincide — no line direction.')
      return {
        kind: 'line',
        center: mid(a, b),
        dir,
        length: len(sub(b, a)),
        ...NO_FIT_STATS,
      } satisfies LineFit
    }

    case 'line-axis': {
      const axis = need(refAxis(refs[0]), 'an axis from the cylinder')
      return {
        kind: 'line',
        center: axis.origin,
        dir: axis.dir,
        length: Math.max(axis.halfLength * 2, fallbackSize * 0.1),
        ...NO_FIT_STATS,
      } satisfies LineFit
    }

    case 'line-plane-plane': {
      const pa = need(refPlane(refs[0]), 'plane A')
      const pb = need(refPlane(refs[1]), 'plane B')
      if (acuteAngle(pa.normal, pb.normal) < INTERSECT_MIN_ANGLE)
        throw new ConstructionError('The planes are parallel — they have no intersection line.')
      const dirRaw = cross(pa.normal, pb.normal)
      const dir = normalize(dirRaw)!
      // A point on both planes: p = (da·(nb×d) + db·(d×na)) / |d|²
      const da = dot(pa.normal, pa.center)
      const db = dot(pb.normal, pb.center)
      const d2 = dot(dirRaw, dirRaw)
      const p = scale(add(scale(cross(pb.normal, dirRaw), da), scale(cross(dirRaw, pa.normal), db)), 1 / d2)
      // Anchor the drawn segment near the measured patches, not at the
      // algebraic point, which can sit anywhere along the line.
      const anchor = footOnLine(mid(pa.center, pb.center), p, dir)
      const length = Math.max(
        Math.max(pa.extentU, pa.extentV, pb.extentU, pb.extentV) * 2,
        fallbackSize * 0.05,
      )
      return { kind: 'line', center: anchor, dir, length, ...NO_FIT_STATS } satisfies LineFit
    }

    case 'plane-three-points': {
      const a = pointOf(refs[0], 'point A')
      const b = pointOf(refs[1], 'point B')
      const c = pointOf(refs[2], 'point C')
      const ab = sub(b, a)
      const ac = sub(c, a)
      const nRaw = cross(ab, ac)
      const span = Math.max(len(ab), len(ac))
      if (span < 1e-9 || len(nRaw) < 1e-6 * span * span)
        throw new ConstructionError('The three points are collinear — they do not span a plane.')
      const normal = normalize(nRaw)!
      const center: Vec3 = [
        (a[0] + b[0] + c[0]) / 3,
        (a[1] + b[1] + c[1]) / 3,
        (a[2] + b[2] + c[2]) / 3,
      ]
      const basisU = normalize(ab)!
      const basisV = cross(normal, basisU)
      let eu = 0
      let ev = 0
      for (const p of [a, b, c]) {
        const r = sub(p, center)
        eu = Math.max(eu, Math.abs(dot(r, basisU)))
        ev = Math.max(ev, Math.abs(dot(r, basisV)))
      }
      const pad = Math.max(eu, ev) * 0.15
      return {
        kind: 'plane',
        center,
        normal,
        basisU,
        basisV,
        extentU: eu + pad,
        extentV: ev + pad,
        ...NO_FIT_STATS,
      } satisfies PlaneFit
    }

    case 'plane-offset': {
      const p = need(refPlane(refs[0]), 'the source plane')
      const [offset] = params
      if (!Number.isFinite(offset)) throw new ConstructionError('Enter the offset distance.')
      return {
        ...p,
        ...NO_FIT_STATS,
        center: addScaled(p.center, p.normal, offset),
      } satisfies PlaneFit
    }

    case 'plane-midplane': {
      const pa = need(refPlane(refs[0]), 'plane A')
      const pb = need(refPlane(refs[1]), 'plane B')
      // At a right angle the two bisecting planes are equally valid, and the
      // sign alignment below would pick one of them arbitrarily — refuse.
      if (90 - acuteAngle(pa.normal, pb.normal) < INTERSECT_MIN_ANGLE)
        throw new ConstructionError('The planes are perpendicular — no midplane between them.')
      // Opposing faces have opposing normals; align B to A so the average
      // means something either way.
      const nb: Vec3 = dot(pa.normal, pb.normal) < 0 ? scale(pb.normal, -1) : pb.normal
      // The plane every point of which lies as far from A as from B, on
      // opposite sides: na·(x − ca) + nb·(x − cb) = 0. Its centre is the
      // midpoint of the patch centres brought onto it — that midpoint itself
      // lies on it only when the planes are parallel (issue 34).
      const sum = add(pa.normal, nb)
      const normal = normalize(sum)!
      const m = mid(pa.center, pb.center)
      const off = (dot(sum, m) - dot(pa.normal, pa.center) - dot(nb, pb.center)) / Math.hypot(...sum)
      const center = addScaled(m, normal, -off)
      const u = normalize(addScaled(pa.basisU, normal, -dot(pa.basisU, normal)))
      const basisU = u ?? orthoBasis(normal)[0]
      const basisV = cross(normal, basisU)
      return {
        kind: 'plane',
        center,
        normal,
        basisU,
        basisV,
        extentU: Math.max(pa.extentU, pb.extentU),
        extentV: Math.max(pa.extentV, pb.extentV),
        ...NO_FIT_STATS,
      } satisfies PlaneFit
    }

    case 'point-center': {
      return { kind: 'point', center: pointOf(refs[0], 'the feature'), ...NO_FIT_STATS } satisfies PointFit
    }

    case 'point-three-planes': {
      const [a, b, c] = [0, 1, 2].map((i) => need(refPlane(refs[i]), `plane ${'ABC'[i]}`))
      for (const [x, y, nx, ny] of [[a, b, 'A', 'B'], [a, c, 'A', 'C'], [b, c, 'B', 'C']] as const) {
        if (acuteAngle(x.normal, y.normal) < INTERSECT_MIN_ANGLE)
          throw new ConstructionError(`Planes ${nx} and ${ny} are parallel — the three meet in no point.`)
      }
      const bc = cross(b.normal, c.normal)
      const det = dot(a.normal, bc)
      // Each pair crosses, but all three may share one line: then they meet
      // along it, not at a point.
      if (Math.abs(det) < Math.sin((INTERSECT_MIN_ANGLE * Math.PI) / 180))
        throw new ConstructionError('The three planes share a line — they meet along it, not at a point.')
      const [da, db, dc] = [a, b, c].map((q) => dot(q.normal, q.center))
      const center = scale(add(add(scale(bc, da), scale(cross(c.normal, a.normal), db)), scale(cross(a.normal, b.normal), dc)), 1 / det)
      return { kind: 'point', center, ...NO_FIT_STATS } satisfies PointFit
    }

    case 'point-line-line': {
      const near = nearestApproach(refs[0], refs[1], params[0])
      if ('parallel' in near) throw new ConstructionError('The lines run parallel — they never cross.')
      return { kind: 'point', center: mid(near.onA, near.onB), ...NO_FIT_STATS } satisfies PointFit
    }

    case 'point-project': {
      const point = pointOf(refs[0], 'the point')
      const pl = need(refPlane(refs[1]), 'the plane')
      return { kind: 'point', center: ontoPlane(point, pl), ...NO_FIT_STATS } satisfies PointFit
    }

    case 'line-plane-point': {
      const pl = need(refPlane(refs[0]), 'the plane')
      const point = pointOf(refs[1], 'the point')
      const foot = ontoPlane(point, pl)
      // Drawn from the point down to the plane, and a little past both.
      const span = len(sub(point, foot))
      return {
        kind: 'line',
        center: mid(point, foot),
        dir: pl.normal,
        length: Math.max(span * 1.2, fallbackSize * 0.1),
        ...NO_FIT_STATS,
      } satisfies LineFit
    }

    case 'line-project': {
      const axis = need(refAxis(refs[0]), 'a line or an axis')
      const pl = need(refPlane(refs[1]), 'the plane')
      const along = sub(axis.dir, scale(pl.normal, dot(axis.dir, pl.normal)))
      if (len(along) < Math.sin((INTERSECT_MIN_ANGLE * Math.PI) / 180))
        throw new ConstructionError('The line stands square to the plane — it projects to a single point: Line–plane intersection gives that point.')
      return {
        kind: 'line',
        center: ontoPlane(axis.origin, pl),
        dir: normalize(along)!,
        length: Math.max(axis.halfLength * 2 * len(along), fallbackSize * 0.1),
        ...NO_FIT_STATS,
      } satisfies LineFit
    }

    case 'line-coords': {
      const [dx, dy, dz, px, py, pz, length] = params
      if (![dx, dy, dz, px, py, pz].every(Number.isFinite))
        throw new ConstructionError('Enter the direction and a point on the line.')
      const dir = normalize([dx, dy, dz])
      if (!dir) throw new ConstructionError('The direction must not be zero.')
      return {
        kind: 'line',
        center: [px, py, pz],
        dir,
        length: Number.isFinite(length) && length > 0 ? length : fallbackSize * 0.3,
        ...NO_FIT_STATS,
      } satisfies LineFit
    }

    case 'plane-offset-point': {
      const pl = need(refPlane(refs[0]), 'the plane')
      const point = pointOf(refs[1], 'the point')
      // The source's patch, slid along its normal to the point.
      return {
        ...pl,
        ...NO_FIT_STATS,
        center: addScaled(pl.center, pl.normal, dot(sub(point, pl.center), pl.normal)),
      } satisfies PlaneFit
    }

    case 'plane-line-point': {
      const axis = need(refAxis(refs[0]), 'a line or an axis')
      const point = pointOf(refs[1], 'the point')
      return { ...planeAt(point, axis.dir, fallbackSize), ...NO_FIT_STATS } satisfies PlaneFit
    }

    case 'plane-angle': {
      const axis = need(refAxis(refs[0]), 'the rotation axis')
      const pl = need(refPlane(refs[1]), 'the zero-angle plane')
      const [deg] = params
      if (!Number.isFinite(deg)) throw new ConstructionError('Enter the angle.')
      // At 0°: the plane through the axis whose normal is the zero plane's,
      // less its part along the axis — the zero plane itself when the axis
      // lies in it. Undefined when the axis stands square to that plane.
      const zero = normalize(sub(pl.normal, scale(axis.dir, dot(pl.normal, axis.dir))))
      if (!zero || acuteAngle(axis.dir, pl.normal) < INTERSECT_MIN_ANGLE)
        throw new ConstructionError('The axis stands square to the zero-angle plane — every plane through it is square to that plane, so none is at 0°. Pick a plane the axis does not pierce square.')
      return planeThroughAxis(axis, rotateAbout(zero, axis.dir, (deg * Math.PI) / 180), pl.center, fallbackSize)
    }

    case 'plane-line-plane': {
      const axis = need(refAxis(refs[0]), 'the line')
      const pl = need(refPlane(refs[1]), 'the plane')
      const normal = normalize(cross(axis.dir, pl.normal))
      if (!normal || acuteAngle(axis.dir, pl.normal) < INTERSECT_MIN_ANGLE)
        throw new ConstructionError('The line stands square to the plane — every plane through it is square to the plane. At an angle about an axis picks one.')
      return planeThroughAxis(axis, normal, pl.center, fallbackSize)
    }

    case 'plane-two-lines': {
      const near = nearestApproach(refs[0], refs[1], params[0])
      if ('parallel' in near) {
        // Parallel lines span the plane between them, unless they are one.
        const across = sub(near.b.origin, near.a.origin)
        const off = sub(across, scale(near.a.dir, dot(across, near.a.dir)))
        const normal = normalize(cross(near.a.dir, off))
        if (!normal || len(off) < 1e-6 * Math.max(1, fallbackSize))
          throw new ConstructionError('The two lines are one — they do not fix a plane.')
        return planeThroughAxis(near.a, normal, mid(near.a.origin, near.b.origin), fallbackSize)
      }
      const normal = normalize(cross(near.a.dir, near.b.dir))!
      return planeThroughAxis({ ...near.a, origin: mid(near.onA, near.onB) }, normal, mid(near.onA, near.onB), fallbackSize)
    }

    case 'plane-tangent-sphere': {
      const sphere = refs[0]
      if (sphere.kind !== 'sphere') throw new ConstructionError('Missing the sphere.')
      const toward = normalize(sub(pointOf(refs[1], 'the point'), sphere.center))
      if (!toward) throw new ConstructionError('The point is the sphere’s centre — it faces no side.')
      return {
        ...planeAt(addScaled(sphere.center, toward, sphere.radius), toward, Math.max(fallbackSize, sphere.radius * 2)),
        ...NO_FIT_STATS,
      } satisfies PlaneFit
    }

    case 'plane-tangent-cylinder': {
      const cyl = refs[0]
      if (cyl.kind !== 'cylinder') throw new ConstructionError('Missing the cylinder.')
      const point = pointOf(refs[1], 'the point')
      const foot = footOnLine(point, cyl.center, cyl.axis)
      const toward = normalize(sub(point, foot))
      if (!toward) throw new ConstructionError('The point lies on the cylinder’s axis — it faces no side.')
      const axis = { origin: addScaled(cyl.center, toward, cyl.radius), dir: cyl.axis, halfLength: cyl.length / 2 }
      return planeThroughAxis(axis, toward, addScaled(foot, toward, cyl.radius), fallbackSize)
    }

    case 'plane-coords': {
      const [nx, ny, nz, px, py, pz] = params
      if (![nx, ny, nz, px, py, pz].every(Number.isFinite))
        throw new ConstructionError('Enter the normal direction and a point on the plane.')
      const normal = normalize([nx, ny, nz])
      if (!normal) throw new ConstructionError('The normal direction must not be zero.')
      return {
        ...planeAt([px, py, pz], normal, fallbackSize),
        ...NO_FIT_STATS,
      } satisfies PlaneFit
    }

    case 'plane-symmetry': {
      const [nx, ny, nz, px, py, pz, rms, matched, sampled] = params
      if (![nx, ny, nz, px, py, pz].every(Number.isFinite))
        throw new ConstructionError('Find the symmetry plane first.')
      const normal = normalize([nx, ny, nz])
      if (!normal) throw new ConstructionError('The symmetry plane has no direction.')
      return {
        ...planeAt([px, py, pz], normal, fallbackSize),
        // The mirror registration's residual stands where a fit's sigma
        // does: how far the part is from symmetric about this plane, over
        // the samples that found their mirror image on the scan.
        sigma: Number.isFinite(rms) ? rms : 0,
        usedPoints: Number.isFinite(matched) ? matched : 0,
        regionSize: Number.isFinite(sampled) ? sampled : 0,
      } satisfies PlaneFit
    }

    case 'circle-plane-cylinder': {
      const pl = need(refPlane(refs[0]), 'the plane')
      const cyl = refs[1]
      if (cyl.kind !== 'cylinder')
        throw new ConstructionError('The second reference must be a cylinder.')
      const tilt = acuteAngle(cyl.axis, pl.normal)
      if (90 - tilt < INTERSECT_MIN_ANGLE)
        throw new ConstructionError('The cylinder runs parallel to the plane — they never meet.')
      if (tilt > SECTION_MAX_TILT)
        throw new ConstructionError(
          `The cylinder leans ${tilt.toFixed(1)}° against the plane — the section is an ellipse, not a circle.`,
        )
      const t = dot(sub(pl.center, cyl.center), pl.normal) / dot(cyl.axis, pl.normal)
      return {
        kind: 'circle',
        center: addScaled(cyl.center, cyl.axis, t),
        normal: pl.normal,
        radius: cyl.radius,
        ...NO_FIT_STATS,
      } satisfies CircleFit
    }

    case 'circle-plane-sphere': {
      const pl = need(refPlane(refs[0]), 'the plane')
      const sph = refs[1]
      if (sph.kind !== 'sphere')
        throw new ConstructionError('The second reference must be a sphere.')
      const d = dot(sub(sph.center, pl.center), pl.normal)
      if (Math.abs(d) >= sph.radius) {
        throw new ConstructionError(
          Math.abs(d) - sph.radius < sph.radius * 1e-6
            ? 'The plane only touches the sphere — the circle would have no size.'
            : 'The plane misses the sphere — there is no intersection.',
        )
      }
      return {
        kind: 'circle',
        center: addScaled(sph.center, pl.normal, -d),
        normal: pl.normal,
        radius: Math.sqrt(sph.radius * sph.radius - d * d),
        ...NO_FIT_STATS,
      } satisfies CircleFit
    }

    case 'circle-coords': {
      const [d, nx, ny, nz, cx, cy, cz] = params
      if (![d, nx, ny, nz, cx, cy, cz].every(Number.isFinite))
        throw new ConstructionError('Enter the diameter, the normal direction and the center.')
      if (!(d > 0)) throw new ConstructionError('The diameter must be positive.')
      const normal = normalize([nx, ny, nz])
      if (!normal) throw new ConstructionError('The normal direction must not be zero.')
      return {
        kind: 'circle',
        center: [cx, cy, cz],
        normal,
        radius: d / 2,
        ...NO_FIT_STATS,
      } satisfies CircleFit
    }

    default:
      throw new ConstructionError(`Unknown construction "${method}".`)
  }
}

/** "Midpoint of Sphere 1 and Point 2" — for the panel and the text report,
 *  its lengths in `units` (a position's coordinates bare). */
export function describeConstruction(
  method: string,
  refNames: string[],
  params: number[],
  units: DisplayUnits = 'mm',
): string {
  const [a, b, c] = refNames
  const bare = (v: number): string => fmtLen(v, units, 3, { bare: true })
  const at = (vs: number[]): string => `(${vs.map(bare).join(', ')})`
  switch (method) {
    case 'point-coords':
      return `at ${at(params)}`
    case 'point-centroid':
      return `centroid of the scan, at ${at(params)}`
    case 'point-midpoint':
      return `midpoint of ${a} and ${b}`
    case 'point-line-plane':
      return `where ${a} meets ${b}`
    case 'line-two-points':
      return `through ${a} and ${b}`
    case 'line-axis':
      return `axis of ${a}`
    case 'line-plane-plane':
      return `intersection of ${a} and ${b}`
    case 'plane-three-points':
      return `through ${a}, ${b} and ${c}`
    case 'plane-offset':
      return `${fmtLen(params[0], units, 3)} offset from ${a}`
    case 'plane-midplane':
      return `midplane of ${a} and ${b}`
    case 'point-center':
      return `centre of ${a}`
    case 'point-three-planes':
      return `where ${a}, ${b} and ${c} meet`
    case 'point-line-line':
      return `where ${a} crosses ${b}, within ${fmtLen(params[0], units, 3)}`
    case 'point-project':
    case 'line-project':
      return `${a} projected onto ${b}`
    case 'line-plane-point':
      return `square to ${a} through ${b}`
    case 'line-coords':
      return `direction (${params.slice(0, 3).map((v) => v.toFixed(3)).join(', ')}) through ${at(params.slice(3, 6))}`
    case 'plane-offset-point':
      return `parallel to ${a} through ${b}`
    case 'plane-line-point':
      return `square to ${a} through ${b}`
    case 'plane-angle':
      return `${params[0]}° about ${a} from ${b}`
    case 'plane-line-plane':
      return `through ${a}, square to ${b}`
    case 'plane-two-lines':
      return `through ${a} and ${b}`
    case 'plane-tangent-sphere':
    case 'plane-tangent-cylinder':
      return `tangent to ${a} toward ${b}`
    case 'plane-coords':
      return `normal (${params.slice(0, 3).map((v) => v.toFixed(3)).join(', ')}) through ${at(params.slice(3))}`
    case 'plane-symmetry': {
      const [, , , , , , rms, matched, sampled] = params
      const fit =
        Number.isFinite(rms) && Number.isFinite(matched)
          ? `, mirror image within ${fmtLen(rms, units, 4)} RMS over ${matched} of ${sampled} samples`
          : ''
      return `symmetry plane of the scan${fit}`
    }
    case 'circle-plane-cylinder':
    case 'circle-plane-sphere':
      return `where ${b} crosses ${a}`
    case 'circle-coords':
      return `Ø ${fmtLen(params[0], units, 3)}, normal (${params
        .slice(1, 4)
        .map((v) => v.toFixed(3))
        .join(', ')}) at ${at(params.slice(4))}`
    default:
      return method
  }
}
