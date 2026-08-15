// SPDX-License-Identifier: AGPL-3.0-only
import type { ElementKind, FitData, LineFit, PlaneFit, PointFit, Vec3 } from '../types'
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
import type { RefRole } from './refs'
import { refAxis, refPlane, refPoint } from './refs'

/** A degenerate construction — the message is written for the user. */
export class ConstructionError extends Error {}

export interface SlotSpec {
  role: RefRole
  label: string
}

export interface ParamSpec {
  key: string
  label: string
  unit?: 'mm'
}

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
}

const XYZ: ParamSpec[] = [
  { key: 'x', label: 'X', unit: 'mm' },
  { key: 'y', label: 'Y', unit: 'mm' },
  { key: 'z', label: 'Z', unit: 'mm' },
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
    params: [{ key: 'offset', label: 'Offset', unit: 'mm' }],
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
  // ---- Sphere / Cylinder ---------------------------------------------------
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

const need = <T>(v: T | null, what: string): T => {
  if (v === null) throw new ConstructionError(`Missing ${what}.`)
  return v
}

function pointOf(fit: FitData, label: string): Vec3 {
  return need(refPoint(fit), `a point from ${label}`)
}

/** Two planes are "parallel" for construction purposes below this angle. */
const INTERSECT_MIN_ANGLE = 0.2

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
    case 'point-coords': {
      const [x, y, z] = params
      if (![x, y, z].every(Number.isFinite))
        throw new ConstructionError('Enter all three coordinates.')
      return { kind: 'point', center: [x, y, z], ...NO_FIT_STATS } satisfies PointFit
    }

    case 'point-midpoint': {
      const a = pointOf(refs[0], 'point A')
      const b = pointOf(refs[1], 'point B')
      return { kind: 'point', center: mid(a, b), ...NO_FIT_STATS } satisfies PointFit
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
      // Opposing faces have opposing normals; align B to A so the average
      // means something either way.
      const nb: Vec3 = dot(pa.normal, pb.normal) < 0 ? scale(pb.normal, -1) : pb.normal
      const normal = normalize(add(pa.normal, nb))
      if (!normal)
        throw new ConstructionError('The planes are perpendicular — no midplane between them.')
      const center = mid(pa.center, pb.center)
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
      const [basisU, basisV] = orthoBasis(normal)
      const extent = Math.max(fallbackSize * 0.3, 1)
      return {
        kind: 'plane',
        center: [px, py, pz],
        normal,
        basisU,
        basisV,
        extentU: extent,
        extentV: extent,
        ...NO_FIT_STATS,
      } satisfies PlaneFit
    }

    default:
      throw new ConstructionError(`Unknown construction "${method}".`)
  }
}

/** "Midpoint of Sphere 1 and Point 2" — for the panel and the text report. */
export function describeConstruction(
  method: string,
  refNames: string[],
  params: number[],
): string {
  const [a, b, c] = refNames
  switch (method) {
    case 'point-coords':
      return `at (${params.map((v) => v.toFixed(3)).join(', ')})`
    case 'point-midpoint':
      return `midpoint of ${a} and ${b}`
    case 'line-two-points':
      return `through ${a} and ${b}`
    case 'line-axis':
      return `axis of ${a}`
    case 'line-plane-plane':
      return `intersection of ${a} and ${b}`
    case 'plane-three-points':
      return `through ${a}, ${b} and ${c}`
    case 'plane-offset':
      return `${params[0]?.toFixed(3)} mm offset from ${a}`
    case 'plane-midplane':
      return `midplane of ${a} and ${b}`
    case 'plane-coords':
      return `normal (${params.slice(0, 3).map((v) => v.toFixed(3)).join(', ')}) through (${params
        .slice(3)
        .map((v) => v.toFixed(3))
        .join(', ')})`
    default:
      return method
  }
}
