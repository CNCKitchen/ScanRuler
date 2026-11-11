// SPDX-License-Identifier: AGPL-3.0-only
// Auto Constrain: a plane or a cylinder fitted to a region of the scan, held
// to what the part already has.
//
// A free fit of a wall comes out a fifth of a degree off square to the floor
// beside it, and a part closed out of such surfaces has no right angle in
// it: every face a hair trapezoid, every dimension in the drawing a number
// with decimals nobody designed. The part was designed square. So a fit that
// lands within a tilt tolerance of parallel or square to a reference — the
// part's coordinate planes, a measured plane or cylinder, a surface fitted
// before it — is fitted again with that direction held, and one that lands
// within a distance of a reference plane, or of a reference axis, is put on
// it. What is held is said in the report, with how far the free fit was
// from it, and the operator can force a relation or forbid them all.
//
// Everything here is about a direction — a plane's normal, a cylinder's
// axis — against reference directions: a reference plane's normal, a
// reference axis's own. `along` holds the direction to the reference's,
// `across` holds it square to it. In the part's words a plane `along` a
// plane is parallel to it and `across` it perpendicular; a cylinder `along`
// a plane's normal stands square on the plane, and so on (relationWords).

import { fitCylinderOnAxis, refineCylinderGeometric } from '../../../src/core/fit/cylinder'
import { orthoBasis, symmetricEigen3 } from '../../../src/core/fit/linalg'
import type { Cylinder, Vec3 } from '../../../src/core/types'
import { addScaled, cross, dot, len, normalize, scale, sub } from '../../../src/core/vec'

/** Within this of parallel or square, a fit is taken to be meant so. */
export const TILT_TOLERANCE_DEG = 0.5
/** Within this of a reference plane or axis, a parallel fit is put on it. */
export const COINCIDENCE_MM = 1

/** Something a fit can be held to. The key names it in a saved feature:
 *  `datum:xy`, `element:12`, `surface:7`. */
export type ConstrainRef =
  | { key: string; kind: 'plane'; name: string; origin: Vec3; normal: Vec3 }
  | { key: string; kind: 'axis'; name: string; origin: Vec3; dir: Vec3 }

/** `along`: the fit's direction is the reference's. `across`: square to it.
 *  `on`: along, and on the reference itself — coincident planes, a common
 *  axis. */
export type Relation = 'along' | 'across' | 'on'

export type ConstrainMode =
  /** Hold what the free fit lands within the tolerances of. */
  | { mode: 'auto' }
  /** The free fit, whatever it is near. */
  | { mode: 'free' }
  /** This relation to this reference, however far the free fit is from it. */
  | { mode: 'force'; relation: Relation; ref: string }

export interface FoundRelation {
  relation: Relation
  ref: string
  name: string
  refKind: 'plane' | 'axis'
  /** How far the free fit's direction was from the relation, degrees. */
  tiltDeg: number
  /** For `on`: how far the free fit lay from the reference, millimetres. */
  shiftMm?: number
}

export interface ConstrainedPlane {
  origin: Vec3
  normal: Vec3
  /** RMS of the points' distances to the plane as held, and as freely fitted
   *  — what holding it cost. */
  rms: number
  rmsFree: number
  max: number
  relations: FoundRelation[]
}

export interface ConstrainedCylinder {
  origin: Vec3
  axis: Vec3
  radius: number
  rms: number
  rmsFree: number
  max: number
  relations: FoundRelation[]
}

const DEG = 180 / Math.PI
const refDir = (r: ConstrainRef): Vec3 => (r.kind === 'plane' ? r.normal : r.dir)
/** The angle between two lines, 0…90°, whichever way their vectors point. */
const lineAngleDeg = (a: Vec3, b: Vec3) => Math.acos(Math.min(1, Math.abs(dot(a, b)))) * DEG
/** `d`, turned to point the way `like` does. */
const facing = (d: Vec3, like: Vec3): Vec3 => (dot(d, like) < 0 ? scale(d, -1) : d)

/** What a relation is called for a plane or a cylinder against a reference
 *  plane or axis — the words the box and the report use. */
export function relationWords(shape: 'plane' | 'cylinder', relation: Relation, refKind: 'plane' | 'axis'): string {
  if (shape === 'plane') {
    if (refKind === 'plane') return relation === 'on' ? 'Coincident with' : relation === 'along' ? 'Parallel to' : 'Perpendicular to'
    return relation === 'across' ? 'Parallel to' : 'Perpendicular to'
  }
  if (refKind === 'plane') return relation === 'across' ? 'Parallel to' : 'Perpendicular to'
  return relation === 'on' ? 'Coaxial with' : relation === 'along' ? 'Parallel to' : 'Perpendicular to'
}

/** The relations a shape can have to a reference, for the dropdown. */
export function relationsFor(shape: 'plane' | 'cylinder', refKind: 'plane' | 'axis'): Relation[] {
  if (shape === 'plane') return refKind === 'plane' ? ['along', 'across', 'on'] : ['along', 'across']
  return refKind === 'axis' ? ['along', 'across', 'on'] : ['along', 'across']
}

interface Moments {
  n: number
  mean: Vec3
  /** The covariance's six numbers, row-major upper triangle, not divided. */
  cov: [number, number, number, number, number, number]
}

function momentsOf(points: Float32Array): Moments {
  const n = points.length / 3
  let mx = 0, my = 0, mz = 0
  for (let i = 0; i < points.length; i += 3) {
    mx += points[i]
    my += points[i + 1]
    mz += points[i + 2]
  }
  mx /= n
  my /= n
  mz /= n
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0
  for (let i = 0; i < points.length; i += 3) {
    const x = points[i] - mx, y = points[i + 1] - my, z = points[i + 2] - mz
    xx += x * x
    xy += x * y
    xz += x * z
    yy += y * y
    yz += y * z
    zz += z * z
  }
  return { n, mean: [mx, my, mz], cov: [xx, xy, xz, yy, yz, zz] }
}

/** vᵀ C v for the covariance. */
function spread(m: Moments, v: Vec3): number {
  const [xx, xy, xz, yy, yz, zz] = m.cov
  return v[0] * (xx * v[0] + xy * v[1] + xz * v[2]) + v[1] * (xy * v[0] + yy * v[1] + yz * v[2]) + v[2] * (xz * v[0] + yz * v[1] + zz * v[2])
}

/** The direction the points scatter least along among those square to `r`:
 *  the least-squares plane normal with that one condition on it. The
 *  covariance cut down to the two directions square to `r`, and the smaller
 *  eigenvector of that 2 × 2. */
function leastSpreadAcross(m: Moments, r: Vec3): Vec3 {
  const [u, v] = orthoBasis(r)
  const a = spread(m, u)
  const c = spread(m, v)
  const [xx, xy, xz, yy, yz, zz] = m.cov
  const b = u[0] * (xx * v[0] + xy * v[1] + xz * v[2]) + u[1] * (xy * v[0] + yy * v[1] + yz * v[2]) + u[2] * (xz * v[0] + yz * v[1] + zz * v[2])
  // The smaller eigenvalue of [[a, b], [b, c]] and its vector.
  const low = (a + c) / 2 - Math.hypot((a - c) / 2, b)
  const e: [number, number] = Math.abs(b) > 1e-300 ? [b, low - a] : a <= c ? [1, 0] : [0, 1]
  const l = Math.hypot(e[0], e[1])
  return [(u[0] * e[0] + v[0] * e[1]) / l, (u[1] * e[0] + v[1] * e[1]) / l, (u[2] * e[0] + v[2] * e[1]) / l]
}

/** A direction held by what it is near. `across` with one reference leaves
 *  a turn about it free, which `solveAcross` spends on the points; with two
 *  that are not the same direction nothing is left, and it is their cross
 *  product. `same` are the references the held direction is the direction
 *  of, the one it was held to first — the ones the fit may lie *on*. Null:
 *  nothing holds it. */
function holdDirection(
  free: Vec3,
  refs: readonly ConstrainRef[],
  mode: ConstrainMode,
  solveAcross: (r: Vec3) => Vec3,
): { dir: Vec3; relations: FoundRelation[]; same: ConstrainRef[] } | null {
  if (mode.mode === 'free') return null
  const found = (relation: Relation, r: ConstrainRef, tiltDeg: number): FoundRelation => ({ relation, ref: r.key, name: r.name, refKind: r.kind, tiltDeg })
  if (mode.mode === 'force') {
    const r = refs.find((x) => x.key === mode.ref)
    if (!r) return null
    const d = refDir(r)
    if (mode.relation === 'across') return { dir: facing(solveAcross(d), free), relations: [found('across', r, Math.abs(90 - lineAngleDeg(free, d)))], same: [] }
    return { dir: facing(d, free), relations: [found(mode.relation, r, lineAngleDeg(free, d))], same: [r] }
  }
  // The nearest reference the fit runs along, within the tolerance. Of two
  // as near as each other the one that stands first: the part's own planes
  // before the measured elements before the surfaces fitted earlier, which
  // were held to those in their turn — "parallel to the XY plane" says more
  // than "parallel to Surface 7", which is parallel to the XY plane.
  let best: ConstrainRef | null = null
  let bestTilt = Infinity
  for (const r of refs) {
    const tilt = lineAngleDeg(free, refDir(r))
    if (tilt <= TILT_TOLERANCE_DEG && tilt < bestTilt - 1e-9) {
      best = r
      bestTilt = tilt
    }
  }
  if (best) {
    const dir = refDir(best)
    const same = [best, ...refs.filter((r) => r !== best && lineAngleDeg(refDir(r), dir) < 1e-6)]
    return { dir: facing(dir, free), relations: [found('along', best, bestTilt)], same }
  }
  // Else the references it stands square to: the nearest, and one more that
  // is not the same direction again — two walls of a box hold a third.
  const square = refs
    .map((r) => ({ r, tilt: Math.abs(90 - lineAngleDeg(free, refDir(r))) }))
    .filter((x) => x.tilt <= TILT_TOLERANCE_DEG)
    .sort((a, b) => a.tilt - b.tilt)
  if (square.length === 0) return null
  const first = square[0]
  const second = square.find((x) => lineAngleDeg(refDir(x.r), refDir(first.r)) > 5)
  if (second) {
    const both = normalize(cross(refDir(first.r), refDir(second.r)))
    // Two references a degree off square to each other can leave their
    // cross product further from the fit than either tolerance meant.
    if (both && lineAngleDeg(both, free) <= 2 * TILT_TOLERANCE_DEG) return { dir: facing(both, free), relations: [found('across', first.r, first.tilt), found('across', second.r, second.tilt)], same: [] }
  }
  return { dir: facing(solveAcross(refDir(first.r)), free), relations: [found('across', first.r, first.tilt)], same: [] }
}

function planeResiduals(points: Float32Array, origin: Vec3, normal: Vec3): { rms: number; max: number } {
  let sum = 0
  let max = 0
  for (let i = 0; i < points.length; i += 3) {
    const d = (points[i] - origin[0]) * normal[0] + (points[i + 1] - origin[1]) * normal[1] + (points[i + 2] - origin[2]) * normal[2]
    sum += d * d
    if (Math.abs(d) > max) max = Math.abs(d)
  }
  return { rms: Math.sqrt(sum / (points.length / 3)), max }
}

/** A plane through the points — xyz packed — held to the references as the
 *  mode says. The free fit is the total-least-squares plane; with the normal
 *  held, the best plane is the one through the centroid (the mean offset),
 *  and a plane within COINCIDENCE_MM of a parallel reference plane is that
 *  plane. Null: too few points, or all in a line. */
export function constrainPlane(points: Float32Array, refs: readonly ConstrainRef[], mode: ConstrainMode): ConstrainedPlane | null {
  if (points.length < 9) return null
  const m = momentsOf(points)
  const eigen = symmetricEigen3([m.cov[0], m.cov[1], m.cov[2], m.cov[1], m.cov[3], m.cov[4], m.cov[2], m.cov[4], m.cov[5]])
  // Ascending: the first vector is the normal. A line of points has two
  // directions of no spread and no plane.
  if (!(eigen.values[1] > 1e-12 * Math.max(eigen.values[2], 1e-300))) return null
  const freeNormal = eigen.vectors[0]
  const rmsFree = planeResiduals(points, m.mean, freeNormal).rms
  const held = holdDirection(freeNormal, refs, mode, (r) => leastSpreadAcross(m, r))
  if (!held) return { origin: m.mean, normal: freeNormal, rms: rmsFree, rmsFree, max: planeResiduals(points, m.mean, freeNormal).max, relations: [] }
  let origin = m.mean
  const relations = held.relations
  // On the first parallel reference plane it lies within reach of — which
  // need not be the one that gave the direction: the floor is parallel to
  // the XY plane, and coincident with the step measured beside it.
  const forced = mode.mode === 'force' && mode.relation === 'on'
  for (const r of held.same) {
    if (r.kind !== 'plane') continue
    const shift = dot(sub(m.mean, r.origin), held.dir)
    if (!forced && !(mode.mode === 'auto' && Math.abs(shift) <= COINCIDENCE_MM)) continue
    origin = sub(m.mean, scale(held.dir, shift))
    relations[0] = { relation: 'on', ref: r.key, name: r.name, refKind: r.kind, tiltDeg: lineAngleDeg(freeNormal, r.normal), shiftMm: Math.abs(shift) }
    break
  }
  return { origin, normal: held.dir, rmsFree, ...planeResiduals(points, origin, held.dir), relations }
}

function cylinderResiduals(points: Float32Array, c: Cylinder): { rms: number; max: number } {
  let sum = 0
  let max = 0
  for (let i = 0; i < points.length; i += 3) {
    const q: Vec3 = [points[i] - c.px, points[i + 1] - c.py, points[i + 2] - c.pz]
    const t = q[0] * c.ax + q[1] * c.ay + q[2] * c.az
    const d = Math.hypot(q[0] - t * c.ax, q[1] - t * c.ay, q[2] - t * c.az) - c.r
    sum += d * d
    if (Math.abs(d) > max) max = Math.abs(d)
  }
  return { rms: Math.sqrt(sum / (points.length / 3)), max }
}

/** The free cylinder through the points, with nothing but the points to
 *  start from: a patch of a cylinder has its axis near one of its three
 *  principal directions — the long way of a long patch, the middle one of a
 *  short wide one — so each is tried as the start of the geometric fit and
 *  the best kept. */
export function fitCylinderFree(points: Float32Array): Cylinder | null {
  if (points.length < 18) return null
  const m = momentsOf(points)
  const eigen = symmetricEigen3([m.cov[0], m.cov[1], m.cov[2], m.cov[1], m.cov[3], m.cov[4], m.cov[2], m.cov[4], m.cov[5]])
  const idx = new Uint32Array(points.length / 3)
  for (let i = 0; i < idx.length; i++) idx[i] = i
  let best: Cylinder | null = null
  let bestRms = Infinity
  for (const start of eigen.vectors) {
    const seeded = fitCylinderOnAxis(points, idx, start)
    if (!seeded) continue
    const c = refineCylinderGeometric(points, idx, seeded)
    if (!(c.r > 0) || !Number.isFinite(c.r)) continue
    const { rms } = cylinderResiduals(points, c)
    if (rms < bestRms) {
      best = c
      bestRms = rms
    }
  }
  return best
}

/** A cylinder through the points held to the references: the axis along a
 *  reference direction or square to it, fitted again with the axis fixed
 *  (the best circle in the plane square to it); an axis within
 *  COINCIDENCE_MM of a parallel reference axis is that axis, the radius the
 *  points' mean distance from it. */
export function constrainCylinder(points: Float32Array, refs: readonly ConstrainRef[], mode: ConstrainMode): ConstrainedCylinder | null {
  const free = fitCylinderFree(points)
  if (!free) return null
  const freeAxis: Vec3 = [free.ax, free.ay, free.az]
  const freeRes = cylinderResiduals(points, free)
  const middle = (c: Cylinder): Vec3 => {
    // The point of the axis beside the middle of the points.
    const m = momentsOf(points).mean
    const t = (m[0] - c.px) * c.ax + (m[1] - c.py) * c.ay + (m[2] - c.pz) * c.az
    return [c.px + t * c.ax, c.py + t * c.ay, c.pz + t * c.az]
  }
  // Square to a reference with a turn left free: the free axis laid into
  // the plane square to it. The fit on that axis settles the rest.
  const held = holdDirection(freeAxis, refs, mode, (r) => normalize(sub(freeAxis, scale(r, dot(freeAxis, r)))) ?? freeAxis)
  if (!held) return { origin: middle(free), axis: freeAxis, radius: free.r, rms: freeRes.rms, rmsFree: freeRes.rms, max: freeRes.max, relations: [] }
  const idx = new Uint32Array(points.length / 3)
  for (let i = 0; i < idx.length; i++) idx[i] = i
  let c = fitCylinderOnAxis(points, idx, held.dir)
  if (!c) return null
  const relations = held.relations
  const forced = mode.mode === 'force' && mode.relation === 'on'
  for (const r of held.same) {
    if (r.kind !== 'axis') continue
    const off = sub([c.px, c.py, c.pz], r.origin)
    const apart = len(sub(off, scale(held.dir, dot(off, held.dir))))
    if (forced || (mode.mode === 'auto' && apart <= COINCIDENCE_MM)) {
      const o = r.origin
      let sum = 0
      for (let i = 0; i < points.length; i += 3) {
        const q: Vec3 = [points[i] - o[0], points[i + 1] - o[1], points[i + 2] - o[2]]
        const t = dot(q, held.dir)
        sum += Math.hypot(q[0] - t * held.dir[0], q[1] - t * held.dir[1], q[2] - t * held.dir[2])
      }
      c = { px: o[0], py: o[1], pz: o[2], ax: held.dir[0], ay: held.dir[1], az: held.dir[2], r: sum / (points.length / 3) }
      relations[0] = { relation: 'on', ref: r.key, name: r.name, refKind: r.kind, tiltDeg: lineAngleDeg(freeAxis, r.dir), shiftMm: apart }
      break
    }
  }
  return { origin: middle(c), axis: held.dir, radius: c.r, rmsFree: freeRes.rms, ...cylinderResiduals(points, c), relations }
}

/** The rectangle of a fitted plane that is drawn and sewn: round the points
 *  as they fall on the plane, its sides along the way the region runs, grown
 *  by `expandPct` of each extent — a surface is trimmed against its
 *  neighbours and has to reach them. */
export function planePatch(points: Float32Array, plane: { origin: Vec3; normal: Vec3 }, expandPct: number): {
  corner: Vec3; u: Vec3; v: Vec3; width: number; height: number; footprint: Vec3[]
} {
  const [u0, v0] = orthoBasis(plane.normal)
  // The region's long way within the plane: the larger eigenvector of the
  // points' 2 × 2 scatter there.
  let aa = 0, ab = 0, bb = 0, ma = 0, mb = 0
  const n = points.length / 3
  const at = (i: number, w: Vec3) => (points[i] - plane.origin[0]) * w[0] + (points[i + 1] - plane.origin[1]) * w[1] + (points[i + 2] - plane.origin[2]) * w[2]
  for (let i = 0; i < points.length; i += 3) {
    ma += at(i, u0)
    mb += at(i, v0)
  }
  ma /= n
  mb /= n
  for (let i = 0; i < points.length; i += 3) {
    const a = at(i, u0) - ma, b = at(i, v0) - mb
    aa += a * a
    ab += a * b
    bb += b * b
  }
  const turn = 0.5 * Math.atan2(2 * ab, aa - bb)
  const u: Vec3 = [u0[0] * Math.cos(turn) + v0[0] * Math.sin(turn), u0[1] * Math.cos(turn) + v0[1] * Math.sin(turn), u0[2] * Math.cos(turn) + v0[2] * Math.sin(turn)]
  const v = cross(plane.normal, u)
  const projected: [number, number][] = []
  let uLo = Infinity, uHi = -Infinity, vLo = Infinity, vHi = -Infinity
  for (let i = 0; i < points.length; i += 3) {
    const a = at(i, u), b = at(i, v)
    projected.push([a, b])
    if (a < uLo) uLo = a
    if (a > uHi) uHi = a
    if (b < vLo) vLo = b
    if (b > vHi) vHi = b
  }
  const gu = Math.max((uHi - uLo) * (expandPct / 100), 1e-3)
  const gv = Math.max((vHi - vLo) * (expandPct / 100), 1e-3)
  // Coverage on a fragment is measured over the marked points' envelope.
  // The displayed rectangle's corners can be far outside an oblique region.
  const footprint = planeHull(projected).map(([a, b]) => addScaled(addScaled(plane.origin, u, a), v, b))
  const corner = addScaled(addScaled(plane.origin, u, uLo - gu), v, vLo - gv)
  return { corner, u, v, width: uHi - uLo + 2 * gu, height: vHi - vLo + 2 * gv, footprint }
}

/** Convex hull of the marked region in the fitted plane. */
function planeHull(points: [number, number][]): [number, number][] {
  const side = (ordered: readonly [number, number][]) => {
    const hull: [number, number][] = []
    for (const p of ordered) {
      while (hull.length >= 2) {
        const [a, b] = [hull[hull.length - 2], hull[hull.length - 1]]
        if ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) > 1e-9) break
        hull.pop()
      }
      hull.push(p)
    }
    hull.pop()
    return hull
  }
  points.sort(([ax, ay], [bx, by]) => ax - bx || ay - by)
  return side(points).concat(side(points.reverse()))
}

/** The stretch of a fitted cylinder that is drawn: along the axis from
 *  `from` to `to` of `origin`, round it from the angle `start` through
 *  `sweep` (radians, about `axis` from `u` towards `v`) — where the points
 *  are, grown by `expandPct` each way. `full` when what is left open would
 *  be a sliver: the whole tube then. */
export function cylinderPatch(
  points: Float32Array,
  cylinder: { origin: Vec3; axis: Vec3; radius: number },
  expandPct: number,
): { from: number; to: number; u: Vec3; v: Vec3; start: number; sweep: number; full: boolean } {
  const [u, v] = orthoBasis(cylinder.axis)
  const o = cylinder.origin
  let lo = Infinity, hi = -Infinity
  const angles: number[] = []
  for (let i = 0; i < points.length; i += 3) {
    const q: Vec3 = [points[i] - o[0], points[i + 1] - o[1], points[i + 2] - o[2]]
    const t = dot(q, cylinder.axis)
    if (t < lo) lo = t
    if (t > hi) hi = t
    angles.push(Math.atan2(dot(q, v), dot(q, u)))
  }
  const grow = Math.max((hi - lo) * (expandPct / 100), 1e-3)
  // The points cover the turn but for their largest gap; the arc runs from
  // the gap's far side round to its near side.
  angles.sort((a, b) => a - b)
  let gap = angles[0] + 2 * Math.PI - angles[angles.length - 1]
  let start = angles[0]
  for (let i = 1; i < angles.length; i++) {
    if (angles[i] - angles[i - 1] > gap) {
      gap = angles[i] - angles[i - 1]
      start = angles[i]
    }
  }
  const covered = 2 * Math.PI - gap
  const more = covered * (expandPct / 100)
  const sweep = covered + 2 * more
  const full = sweep > 2 * Math.PI - (20 * Math.PI) / 180
  return { from: lo - grow, to: hi + grow, u, v, start: start - more, sweep: full ? 2 * Math.PI : sweep, full }
}
