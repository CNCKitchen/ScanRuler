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
import { refAxis, refPlane, refPoint } from './refs'

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
    label: 'Cylinder axis',
    hint: "A cylinder's axis as a standalone line element.",
    slots: [{ role: 'axis', label: 'Cylinder' }],
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
