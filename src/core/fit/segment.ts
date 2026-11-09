// SPDX-License-Identifier: AGPL-3.0-only
// Flat regions on the scan: what one grown plane holds, and every flat face
// found at once.
//
// A plane fit from a click answers its fit; planeRegionReport adds the
// region it grew — how much surface, where, how far its normals stray — and
// whether that region is two surfaces rather than one (see splitTwoPlanes;
// a cylinder's region, splitTwoCylinders).
//
// segmentPlanes grows regions over the whole scan, or the part of it inside
// a box, the way a person would click face after face: from the flattest
// place nobody has claimed yet, a vertex joining while it lies inside the
// noise band of the region's plane and its normal agrees with the plane's.
// The plane is refitted from running sums as the region grows, so a region
// of any size costs one pass over its vertices. Each vertex goes to one
// region at most; regions too small or too rough are given back, and their
// vertices may join a later one but never seed one. Regions meet across the
// rounding of the edge between them, which no plane claims, so their
// neighbours are found by letting each region spread a few rings into the
// unclaimed vertices round it and seeing which fronts meet. A round surface
// comes out as strips that read as facets; each region says whether it is
// such a strip, each edge whether it is smooth, and the strips of one
// surface are joined into runs (see growRuns).

import type { Cylinder, MeshGraph, Plane, Vec3 } from '../types'
import { localNoise } from '../geometry/scanQa'
import { cylinderResidual, fitCylinderOnAxis, refineCylinderGeometric, splitTwoCylinders } from './cylinder'
import { fitHeight } from './heightSurface'
import { normalizeOrZ, orthoBasis, rmsOver, symmetricEigen3 } from './linalg'
import { PointGrid } from '../geometry/pointGrid'
import { planeResidual, splitTwoPlanes } from './plane'

const DEG = Math.PI / 180

/** Each vertex's share of the scan's surface: a third of every triangle it
 *  is a corner of. Kept per graph — the triangles never change under it, and
 *  a rigid alignment leaves their areas as they are. A cloud's points each
 *  stand for the patch around them (see cloudAreas). */
const areaCache = new WeakMap<MeshGraph, Float32Array>()

/** A cloud's points have no triangles, so each stands for the patch of
 *  surface around it. The disc out to the k-th nearest neighbour holds k
 *  points, so a point's share is pi r^2 / k — with r^2 taken midway between
 *  the k-th and the (k+1)-th neighbour's, which is unbiased on scattered
 *  points and does not swing with how a regular grid's rings fall. Unlike a
 *  fixed spacing^2 it follows the density: a Poisson-sampled or half-dense
 *  cloud still sums to its true area. A point on the rim of the cloud sees
 *  its neighbours on one side only, so its disc is half empty and the share
 *  too large; the widest angular gap among its neighbours, seen along its
 *  normal, scales it back. Reach is capped at 3 spacings so a stray point is
 *  not given the area of the gap to the cloud; a point with no neighbour in
 *  reach gets spacing^2. */
const CLOUD_AREA_K = 8
function cloudAreas(g: MeshGraph, out: Float32Array): void {
  const n = g.vertexCount
  if (n === 0) return
  const p = g.positions
  const nrm = g.normals
  const spacing = g.spacing ?? g.bboxDiag / Math.cbrt(n)
  const reach = 3 * spacing
  const grid = new PointGrid(p, reach)
  const near = new Int32Array(CLOUD_AREA_K + 1)
  const angles: number[] = []
  const d2 = (v: number, w: number) => (p[w * 3] - p[v * 3]) ** 2 + (p[w * 3 + 1] - p[v * 3 + 1]) ** 2 + (p[w * 3 + 2] - p[v * 3 + 2]) ** 2
  for (let v = 0; v < n; v++) {
    const m = grid.kNearest(v, CLOUD_AREA_K + 1, reach, near)
    if (m === 0) {
      out[v] = spacing * spacing
      continue
    }
    let area: number
    if (m > CLOUD_AREA_K) area = (Math.PI * (d2(v, near[CLOUD_AREA_K - 1]) + d2(v, near[CLOUD_AREA_K]))) / (2 * (CLOUD_AREA_K + 0.5))
    else area = (Math.PI * d2(v, near[m - 1])) / m
    // The widest empty wedge around the point, in its tangent plane.
    const [[ux, uy, uz], [wx, wy, wz]] = orthoBasis([nrm[v * 3], nrm[v * 3 + 1], nrm[v * 3 + 2]])
    angles.length = 0
    const take = Math.min(m, CLOUD_AREA_K)
    for (let i = 0; i < take; i++) {
      const q = near[i] * 3
      const dx = p[q] - p[v * 3], dy = p[q + 1] - p[v * 3 + 1], dz = p[q + 2] - p[v * 3 + 2]
      angles.push(Math.atan2(dx * wx + dy * wy + dz * wz, dx * ux + dy * uy + dz * uz))
    }
    if (angles.length >= 2) {
      angles.sort((x, y) => x - y)
      let gap = angles[0] + 2 * Math.PI - angles[angles.length - 1]
      for (let i = 1; i < angles.length; i++) gap = Math.max(gap, angles[i] - angles[i - 1])
      area /= 1 + Math.max(0, gap - (2 * Math.PI) / 3) / (Math.PI / 3)
    }
    out[v] = area
  }
}

export function vertexAreas(g: MeshGraph): Float32Array {
  const kept = areaCache.get(g)
  if (kept) return kept
  const { positions: p, indices } = g
  const out = new Float32Array(g.vertexCount)
  if (g.triangleCount === 0) {
    cloudAreas(g, out)
    areaCache.set(g, out)
    return out
  }
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2]
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2]
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx
    const third = Math.sqrt(cx * cx + cy * cy + cz * cz) / 6
    out[indices[t]] += third
    out[indices[t + 1]] += third
    out[indices[t + 2]] += third
  }
  areaCache.set(g, out)
  return out
}

// ---- What a grown region holds ----------------------------------------------

export interface SecondSurface {
  /** The region's points on it, and their share of the region. */
  count: number
  share: number
  centroid: Vec3
  min: Vec3
  max: Vec3
  /** Between the two planes, degrees. */
  angleDeg: number
  /** How far the second one's centroid lies off the first plane, along the
   *  normal the region is reported with, mm. */
  offset: number
  /** RMS off the nearer of two planes, and off the one, mm. */
  rmsTwo: number
  rmsOne: number
  /** How far apart the two planes lie over most of the region, mm. */
  parted: number
}

export interface PlaneRegionReport {
  vertices: number
  /** mm²: the region's share of the scan's surface. */
  area: number
  min: Vec3
  max: Vec3
  /** The angle 95 % of the region's vertex normals lie within of the
   *  plane's normal, degrees. Only with a normal to measure from. */
  normalSpreadDeg?: number
  /** The region seen as two planes: the one the seed is not on. */
  second?: SecondSurface
  /** A cylinder's region seen as two cylinders: the one the seed is not
   *  on. Only with the cylinder given. */
  secondCylinder?: SecondCylinder
  /** A cylinder's region whose wall tapers, once or twice. */
  taper?: WallTaper
  /** The share of the rectangle the region spans in its plane that it
   *  fills: a face fills most of it, the crown of a bead or a round running
   *  across a part a sliver. Only with a normal to measure from. */
  fill?: number
  /** How curved the region is: the sagitta of a quadric height fitted over
   *  it in the plane's frame — how far the quadric's curved part rises and
   *  falls across the region's points, mm — and the RMS the quadric leaves,
   *  mm (the noise, and relief no quadric follows). Only with a normal to
   *  measure from. See looksLikeCrown. */
  curve?: { sagitta: number; sigma: number }
  /** Where a bore's axis meets the scan at an end of its wall — see
   *  closedAlong. Only with the cylinder given, and a bore. */
  closed?: BoreClosed
}

export interface BoreClosed {
  /** Where the axis, cast from the middle of the wall toward one end, meets
   *  the scan, and where it leaves it again (when it does), mm along the
   *  fitted axis from the fit's centre. */
  from: number
  to?: number
  /** The point it meets the scan at. */
  at: Vec3
}

export interface SecondCylinder {
  /** The region's points on it, and their share of the region. */
  count: number
  share: number
  centroid: Vec3
  min: Vec3
  max: Vec3
  /** Where its points lie along the fitted axis, from the fit's centre, mm. */
  band: [number, number]
  /** Between the two cylinders' axes, degrees. */
  angleDeg: number
  /** The radius of the one the seed is on, and of the second, mm. */
  radius: number
  radiusSecond: number
  /** How far each part's normals lean off square to the fitted axis, RMS,
   *  degrees: the seed's part, then the second. */
  leanDeg: [number, number]
  /** RMS off the nearer of two cylinders, and off the one, mm. */
  rmsTwo: number
  rmsOne: number
}

export interface ConePart {
  /** Where its points lie along the axis, from the fit's centre, mm. */
  band: [number, number]
  /** The wall's taper off the axis, degrees: of a single taper, positive
   *  where it widens along the axis; of two, where it widens toward the
   *  other part. */
  draftDeg: number
  min: Vec3
  max: Vec3
}

/** A cylinder's region whose wall does not stand square to the part's axis. */
export interface WallTaper {
  /** The axis it was read along: the nearest of the world's where the fit
   *  lies close to one, as a fit on part of a turn leans to take up the
   *  taper, else the fit's own. */
  axis: Vec3
  /** The one taper, or the two in order along the axis. */
  parts: [ConePart] | [ConePart, ConePart]
  /** Where two parts meet: on the axis, and the mean radius there. */
  parting?: { t: number; at: Vec3; radius: number }
  /** Two parts tapering the same way from the parting: a double cone, as a
   *  casting drafted both ways from its parting line has. */
  double: boolean
}

/** The least taper that counts as one, degrees: a machined bore's mean lean
 *  stays well under it, a cast wall's well over. */
const TAPER_DEG = 0.5
/** How much the two parts' leans have to differ to be two, degrees. */
const TAPER_STEP_DEG = 1
/** How far the fit's axis may lie off a world axis, degrees, for that to be
 *  the axis meant. */
const TAPER_AXIS_DEG = 10
/** The bins the lean is read in along the axis, and the least share of them a
 *  part takes: a round at an end is not a second cone. */
const TAPER_BINS = 64
const TAPER_LEAST_SHARE = 0.25
/** The parts of a turn a lean is checked in: a cone leans the same way all
 *  round, two cylinders at an angle one way on one side and the other on the
 *  other. A part of a turn holding under the share is not read. */
const TAPER_SECTORS = 6
const TAPER_SECTOR_SHARE = 0.05

/** A cylinder's region read as how far its wall's normals lean along the
 *  part's axis, band by band: one lean is a cone, two a wall with a break in
 *  its draft — a double cone where it widens or narrows both ways from the
 *  break. By the normals, as a cylinder fitted on part of a turn takes up a
 *  taper by tilting: its radius then shows no trend, its normals still do.
 *  Read between the 10th and 90th percentile along the axis, so the rounds at
 *  the ends do not count. Null where the wall stands square, leans differently
 *  round the turn, or the region is too small to say. */
export function wallTaper(p: Float32Array, nrm: Float32Array, region: Uint32Array, center: Vec3, axis: Vec3): WallTaper | null {
  const al = Math.hypot(axis[0], axis[1], axis[2])
  if (!(al > 0) || region.length < 4 * TAPER_BINS) return null
  const fitted: Vec3 = [axis[0] / al, axis[1] / al, axis[2] / al]
  const main = [0, 1, 2].reduce((m, k) => (Math.abs(fitted[k]) > Math.abs(fitted[m]) ? k : m), 0)
  const a: Vec3 = [0, 0, 0]
  if (Math.abs(fitted[main]) >= Math.cos(TAPER_AXIS_DEG * DEG)) a[main] = fitted[main] > 0 ? 1 : -1
  else a.splice(0, 3, ...fitted)
  const ts = new Float64Array(region.length)
  const leans = new Float64Array(region.length)
  const rs = new Float64Array(region.length)
  // Whether the normals face away from the axis (a boss) or toward it (a bore).
  let facing = 0
  for (let i = 0; i < region.length; i++) {
    const j = region[i] * 3
    const x = p[j] - center[0], y = p[j + 1] - center[1], z = p[j + 2] - center[2]
    const t = x * a[0] + y * a[1] + z * a[2]
    const ux = x - t * a[0], uy = y - t * a[1], uz = z - t * a[2]
    ts[i] = t
    rs[i] = Math.hypot(ux, uy, uz)
    leans[i] = Math.asin(Math.max(-1, Math.min(1, nrm[j] * a[0] + nrm[j + 1] * a[1] + nrm[j + 2] * a[2]))) / DEG
    facing += nrm[j] * ux + nrm[j + 1] * uy + nrm[j + 2] * uz
  }
  const sorted = Float64Array.from(ts).sort()
  const t0 = sorted[Math.floor(0.1 * sorted.length)]
  const t1 = sorted[Math.floor(0.9 * sorted.length)]
  if (!(t1 > t0)) return null
  const [e1, e2] = orthoBasis(a)
  const binT = (t1 - t0) / TAPER_BINS
  const size = TAPER_BINS + 1
  const n = new Float64Array(size), sum = new Float64Array(size), sq = new Float64Array(size)
  for (let i = 0; i < ts.length; i++) {
    if (ts[i] < t0 || ts[i] > t1) continue
    const k = Math.min(TAPER_BINS - 1, Math.floor((ts[i] - t0) / binT)) + 1
    n[k]++
    sum[k] += leans[i]
    sq[k] += leans[i] * leans[i]
  }
  for (const c of [n, sum, sq]) for (let k = 1; k < size; k++) c[k] += c[k - 1]
  if (n[TAPER_BINS] === 0) return null
  const mean = (lo: number, hi: number) => (n[hi] > n[lo] ? (sum[hi] - sum[lo]) / (n[hi] - n[lo]) : 0)
  const left = (lo: number, hi: number) => {
    const c = n[hi] - n[lo]
    return c > 0 ? sq[hi] - sq[lo] - (sum[hi] - sum[lo]) ** 2 / c : 0
  }
  const least = Math.ceil(TAPER_LEAST_SHARE * TAPER_BINS)
  let at = -1, atLeft = Infinity
  for (let k = least; k <= TAPER_BINS - least; k++) {
    const ee = left(0, k) + left(k, TAPER_BINS)
    if (ee < atLeft) {
      atLeft = ee
      at = k
    }
  }
  // A lean along +a on a wall facing away from the axis narrows it along +a;
  // on one facing the axis it widens it.
  const widens = (lean: number) => (facing >= 0 ? -lean : lean)
  /** Whether the points between two heights lean as `lean` all round. */
  const allRound = (lo: number, hi: number, lean: number) => {
    const count = new Float64Array(TAPER_SECTORS), total = new Float64Array(TAPER_SECTORS)
    let all = 0
    for (let i = 0; i < ts.length; i++) {
      if (ts[i] < lo || ts[i] > hi) continue
      const j = region[i] * 3
      const x = p[j] - center[0], y = p[j + 1] - center[1], z = p[j + 2] - center[2]
      const q = Math.atan2(x * e2[0] + y * e2[1] + z * e2[2], x * e1[0] + y * e1[1] + z * e1[2])
      const k = Math.min(TAPER_SECTORS - 1, Math.floor(((q + Math.PI) / (2 * Math.PI)) * TAPER_SECTORS))
      count[k]++
      total[k] += leans[i]
      all++
    }
    for (let k = 0; k < TAPER_SECTORS; k++) if (count[k] >= TAPER_SECTOR_SHARE * all && (total[k] / count[k]) * lean <= 0) return false
    return true
  }
  const boxOf = (lo: number, hi: number) => {
    const min: Vec3 = [Infinity, Infinity, Infinity]
    const max: Vec3 = [-Infinity, -Infinity, -Infinity]
    for (let i = 0; i < ts.length; i++) {
      if (ts[i] < lo || ts[i] > hi) continue
      const j = region[i] * 3
      for (let k = 0; k < 3; k++) {
        const v = p[j + k]
        if (v < min[k]) min[k] = v
        if (v > max[k]) max[k] = v
      }
    }
    return { min, max }
  }
  if (at >= 0) {
    const low = widens(mean(0, at)), high = widens(mean(at, TAPER_BINS))
    const t = t0 + at * binT
    const round = (lo: number, hi: number, lean: number) => Math.abs(lean) < TAPER_DEG || allRound(lo, hi, lean)
    if (Math.abs(low - high) >= TAPER_STEP_DEG && Math.max(Math.abs(low), Math.abs(high)) >= TAPER_DEG) {
      if (!round(t0, t, mean(0, at)) || !round(t, t1, mean(at, TAPER_BINS))) return null
      // Widening toward the other part: the lower one along the axis, the
      // upper one against it.
      const double = Math.min(Math.abs(low), Math.abs(high)) >= TAPER_DEG && low > 0 === -high > 0
      let rr = 0, rc = 0
      for (let i = 0; i < ts.length; i++) {
        if (Math.abs(ts[i] - t) > binT) continue
        rr += rs[i]
        rc++
      }
      return {
        axis: a,
        parts: [
          { band: [t0, t], draftDeg: low, ...boxOf(t0, t) },
          { band: [t, t1], draftDeg: -high, ...boxOf(t, t1) },
        ],
        parting: { t, at: [center[0] + t * a[0], center[1] + t * a[1], center[2] + t * a[2]], radius: rc > 0 ? rr / rc : 0 },
        double,
      }
    }
  }
  const lean = mean(0, TAPER_BINS)
  const all = widens(lean)
  if (Math.abs(all) < TAPER_DEG || !allRound(t0, t1, lean)) return null
  return { axis: a, parts: [{ band: [t0, t1], draftDeg: all, ...boxOf(t0, t1) }], double: false }
}

/** A region a cylinder was fitted on, as two cylinders — see
 *  splitTwoCylinders — reported along the fit's axis: the part the seed is
 *  not on (the smaller without a seed). Null when it is one surface. */
export function secondCylinder(
  g: MeshGraph,
  region: Uint32Array,
  fit: { center: Vec3; axis: Vec3; radius: number; seed?: number },
): SecondCylinder | null {
  const { positions: p, normals: nrm } = g
  const al = Math.hypot(fit.axis[0], fit.axis[1], fit.axis[2])
  if (!(al > 0) || !(fit.radius > 0)) return null
  const a: Vec3 = [fit.axis[0] / al, fit.axis[1] / al, fit.axis[2] / al]
  const one: Cylinder = { px: fit.center[0], py: fit.center[1], pz: fit.center[2], ax: a[0], ay: a[1], az: a[2], r: fit.radius }
  const split = splitTwoCylinders(p, nrm, region, one)
  if (!split) return null
  let first = 0
  if (fit.seed !== undefined && fit.seed < g.vertexCount) {
    const j = fit.seed * 3
    const r0 = Math.abs(cylinderResidual(split.cylinders[0], p[j], p[j + 1], p[j + 2]))
    const r1 = Math.abs(cylinderResidual(split.cylinders[1], p[j], p[j + 1], p[j + 2]))
    if (r1 < r0) first = 1
  }
  const second = 1 - first
  const leanOf = (members: Uint32Array) => {
    let ss = 0
    for (let i = 0; i < members.length; i++) {
      const j = region[members[i]] * 3
      const s = nrm[j] * a[0] + nrm[j + 1] * a[1] + nrm[j + 2] * a[2]
      ss += Math.asin(Math.max(-1, Math.min(1, s))) ** 2
    }
    return members.length ? Math.sqrt(ss / members.length) / DEG : 0
  }
  const members = split.members[second]
  const c: Vec3 = [0, 0, 0]
  const lo: Vec3 = [Infinity, Infinity, Infinity]
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity]
  let t0 = Infinity, t1 = -Infinity
  for (let i = 0; i < members.length; i++) {
    const j = region[members[i]] * 3
    for (let k = 0; k < 3; k++) {
      const x = p[j + k]
      c[k] += x / members.length
      if (x < lo[k]) lo[k] = x
      if (x > hi[k]) hi[k] = x
    }
    const t = (p[j] - fit.center[0]) * a[0] + (p[j + 1] - fit.center[1]) * a[1] + (p[j + 2] - fit.center[2]) * a[2]
    if (t < t0) t0 = t
    if (t > t1) t1 = t
  }
  const A = split.cylinders[first]
  const B = split.cylinders[second]
  return {
    count: members.length,
    share: members.length / region.length,
    centroid: c,
    min: lo,
    max: hi,
    band: [t0, t1],
    angleDeg: Math.acos(Math.min(1, Math.abs(A.ax * B.ax + A.ay * B.ay + A.az * B.az))) / DEG,
    radius: A.r,
    radiusSecond: B.r,
    leanDeg: [leanOf(split.members[first]), leanOf(members)],
    rmsTwo: split.rmsTwo,
    rmsOne: split.rmsOne,
  }
}

/** How many of a region's points its quadric is fitted on, at most. */
const CURVE_SAMPLE = 4000

/** A region's quadric h = a + b·u + c·v + d·u² + e·u·v + f·v² over the
 *  plane's frame (origin at the points' centroid): the sagitta of its
 *  curved part across the points — the spread of d·u² + e·u·v + f·v² over
 *  them, which for a strip of a round of radius R and width w is w²/8R —
 *  and the RMS it leaves. Null for too few points. */
function curveOf(p: Float32Array, region: Uint32Array, normal: Vec3, basisU: Vec3, basisV: Vec3, sample = CURVE_SAMPLE): { sagitta: number; sigma: number } | null {
  const step = Math.max(1, Math.ceil(region.length / sample))
  const n = Math.floor((region.length - 1) / step) + 1
  if (n < 12) return null
  const packed = new Float64Array(n * 3)
  const origin: Vec3 = [0, 0, 0]
  for (let i = 0; i < n; i++) {
    const j = region[i * step] * 3
    for (let k = 0; k < 3; k++) {
      packed[i * 3 + k] = p[j + k]
      origin[k] += p[j + k] / n
    }
  }
  const quadric = fitHeight(packed, { origin, basisU, basisV, normal }, 'quadric')
  if (!quadric) return null
  const { d, e, f } = quadric.coefficients
  let lo = Infinity
  let hi = -Infinity
  for (let i = 0; i < n; i++) {
    const x = packed[i * 3] - origin[0], y = packed[i * 3 + 1] - origin[1], z = packed[i * 3 + 2] - origin[2]
    const u = x * basisU[0] + y * basisU[1] + z * basisU[2]
    const v = x * basisV[0] + y * basisV[1] + z * basisV[2]
    const q = d * u * u + e * u * v + f * v * v
    if (q < lo) lo = q
    if (q > hi) hi = q
  }
  return { sagitta: hi - lo, sigma: quadric.rms }
}

/** A plane's region whose normals spread wider than this, degrees, or that
 *  fills less of the rectangle it spans than this share, may be no face:
 *  the crown of a bead or a round grows a ring or a strip of points whose
 *  normals turn across it. */
export const PLANE_SPREAD_DEG = 10
export const PLANE_FILL = 0.15
/** How many times the RMS a quadric leaves its curved part has to rise
 *  across the region for the region to count as curved. */
const CURVED_SIGMAS = 3

/** Whether a plane's region looks like the crown of a bead or a round, not
 *  a face: a sliver of the rectangle it spans, or its normals spread wide
 *  and the region curved — a quadric over it rising more across it than
 *  three times what the quadric leaves. A spread alone does not tell: a
 *  flat face with relief on it (lettering, a label) spreads its normals as
 *  wide, and no quadric follows relief, so its sagitta stays within what is
 *  left. The RMS left, not the plane's own: on a round the curve is the
 *  plane's RMS, and its sagitta always about 3.4 times that. */
export function looksLikeCrown(r: Pick<PlaneRegionReport, 'normalSpreadDeg' | 'fill' | 'curve'>): boolean {
  if ((r.fill ?? 1) < PLANE_FILL) return true
  if (!((r.normalSpreadDeg ?? 0) > PLANE_SPREAD_DEG)) return false
  return r.curve ? r.curve.sagitta > CURVED_SIGMAS * r.curve.sigma : true
}

/** What a grown region holds: its area and box, and — given the plane's
 *  normal — how far its normals stray from it and whether its points lie on
 *  two surfaces. `seed`, a vertex the region was grown from, says which of
 *  the two is the one meant; without it the smaller is the second. */
export function planeRegionReport(
  g: MeshGraph,
  region: Uint32Array,
  plane?: { normal: Vec3; seed?: number },
  cylinder?: { center: Vec3; axis: Vec3; radius: number; seed?: number },
): PlaneRegionReport {
  const { positions: p, normals: nrm } = g
  const areas = vertexAreas(g)
  const min: Vec3 = [Infinity, Infinity, Infinity]
  const max: Vec3 = [-Infinity, -Infinity, -Infinity]
  let area = 0
  for (let i = 0; i < region.length; i++) {
    const v = region[i]
    area += areas[v]
    for (let k = 0; k < 3; k++) {
      const x = p[v * 3 + k]
      if (x < min[k]) min[k] = x
      if (x > max[k]) max[k] = x
    }
  }
  const out: PlaneRegionReport = { vertices: region.length, area, min, max }
  if (cylinder && region.length > 0) {
    const second = secondCylinder(g, region, cylinder)
    if (second) out.secondCylinder = second
    const taper = wallTaper(p, nrm, region, cylinder.center, cylinder.axis)
    if (taper) out.taper = taper
    const closed = closedAlong(g, region, cylinder)
    if (closed) out.closed = closed
  }
  if (!plane || region.length === 0) return out

  const [nx, ny, nz] = plane.normal
  const tilt = new Float32Array(region.length)
  for (let i = 0; i < region.length; i++) {
    const j = region[i] * 3
    tilt[i] = Math.acos(Math.min(1, Math.abs(nrm[j] * nx + nrm[j + 1] * ny + nrm[j + 2] * nz)))
  }
  tilt.sort()
  out.normalSpreadDeg = tilt[Math.min(tilt.length - 1, Math.floor(0.95 * tilt.length))] / DEG
  // The rectangle is the region's own, along its longest run in the plane,
  // so a strip lying across the plane's axes still fills its rectangle.
  const [e1, e2] = orthoBasis([nx, ny, nz])
  const pu = new Float64Array(region.length)
  const pw = new Float64Array(region.length)
  let su = 0, sw = 0
  for (let i = 0; i < region.length; i++) {
    const j = region[i] * 3
    pu[i] = p[j] * e1[0] + p[j + 1] * e1[1] + p[j + 2] * e1[2]
    pw[i] = p[j] * e2[0] + p[j + 1] * e2[1] + p[j + 2] * e2[2]
    su += pu[i]
    sw += pw[i]
  }
  su /= region.length
  sw /= region.length
  let cuu = 0, cuw = 0, cww = 0
  for (let i = 0; i < region.length; i++) {
    const du = pu[i] - su, dw = pw[i] - sw
    cuu += du * du
    cuw += du * dw
    cww += dw * dw
  }
  const turn = 0.5 * Math.atan2(2 * cuw, cuu - cww)
  const cs = Math.cos(turn), sn = Math.sin(turn)
  let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity
  for (let i = 0; i < region.length; i++) {
    const x = pu[i] * cs + pw[i] * sn
    const y = -pu[i] * sn + pw[i] * cs
    if (x < a0) a0 = x
    if (x > a1) a1 = x
    if (y < b0) b0 = y
    if (y > b1) b1 = y
  }
  const spanned = (a1 - a0) * (b1 - b0)
  if (spanned > 0) out.fill = Math.min(1, area / spanned)
  const curve = curveOf(p, region, [nx, ny, nz], e1, e2)
  if (curve) out.curve = curve

  const split = splitTwoPlanes(p, nrm, region)
  if (!split) return out

  // The part the seed lies on is the surface meant; the other is the second.
  let first = 0
  if (plane.seed !== undefined && plane.seed < g.vertexCount) {
    const j = plane.seed * 3
    const r0 = Math.abs(planeResidual(split.planes[0], p[j], p[j + 1], p[j + 2]))
    const r1 = Math.abs(planeResidual(split.planes[1], p[j], p[j + 1], p[j + 2]))
    if (r1 < r0) first = 1
  }
  const second = 1 - first
  const members = split.members[second]
  const c: Vec3 = [0, 0, 0]
  const lo: Vec3 = [Infinity, Infinity, Infinity]
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < members.length; i++) {
    const j = region[members[i]] * 3
    for (let k = 0; k < 3; k++) {
      const x = p[j + k]
      c[k] += x / members.length
      if (x < lo[k]) lo[k] = x
      if (x > hi[k]) hi[k] = x
    }
  }
  const a = split.planes[first]
  const b = split.planes[second]
  // Measured along the reported normal, so "above" is out of the part.
  const along = a.nx * nx + a.ny * ny + a.nz * nz >= 0 ? 1 : -1
  out.second = {
    count: members.length,
    share: members.length / region.length,
    centroid: c,
    min: lo,
    max: hi,
    angleDeg: Math.acos(Math.min(1, Math.abs(a.nx * b.nx + a.ny * b.ny + a.nz * b.nz))) / DEG,
    offset: along * planeResidual(a, c[0], c[1], c[2]),
    rmsTwo: split.rmsTwo,
    rmsOne: split.rmsOne,
    parted: split.parted,
  }
  return out
}

// ---- A bore closed at an end -------------------------------------------------

/** A cap counts as closing the bore when the axis meets it within this many
 *  radii past the end of the wall — the wall's own rounding into it is
 *  peeled off the region, so the region stops a little short. */
const CLOSED_REACH_OF_R = 1

/** A cloud has no triangles for the axis to cross, so a floor or cap is read
 *  from its points: those within one spacing of the axis line whose normals
 *  lie along it (the bore's own wall lies a radius off). The points of one
 *  surface are not at one t on a rough scan, so those within a spacing of
 *  each other along the axis count as one crossing, at their mean. */
function crossingsOfPoints(g: MeshGraph, pu: Float32Array, pv: Float32Array, pt: Float32Array, a: Vec3, hits: number[]): void {
  const spacing = g.spacing ?? g.bboxDiag / Math.cbrt(g.vertexCount)
  const n = g.normals
  const near: number[] = []
  for (let k = 0; k < g.vertexCount; k++) {
    if (Math.hypot(pu[k], pv[k]) > spacing) continue
    if (Math.abs(n[k * 3] * a[0] + n[k * 3 + 1] * a[1] + n[k * 3 + 2] * a[2]) < 0.5) continue
    near.push(pt[k])
  }
  near.sort((x, y) => x - y)
  let sum = 0
  let count = 0
  let last = -Infinity
  for (const t of near) {
    if (count > 0 && t - last > spacing) {
      hits.push(sum / count)
      sum = 0
      count = 0
    }
    sum += t
    count++
    last = t
  }
  if (count > 0) hits.push(sum / count)
}

/**
 * Whether a bore is closed at an end, read by casting its axis from the
 * middle of the wall toward each end: on the axis inside a bore there is
 * only air, so the first triangle the axis meets lies at or past an end — a
 * floor, a cap, or the skin a scan wrapped across a hole it did not see
 * through. One that lies within CLOSED_REACH_OF_R radii of the wall's end
 * closes the bore there; the next one along says where the material that
 * closes it ends. When both ends are closed, the one nearer its wall's end.
 * Null for a shaft (the region's normals face away from the axis) or a bore
 * open at both ends.
 */
export function closedAlong(g: MeshGraph, region: Uint32Array, fit: { center: Vec3; axis: Vec3; radius: number }): BoreClosed | null {
  const { positions: p, normals: n, indices } = g
  const al = Math.hypot(fit.axis[0], fit.axis[1], fit.axis[2])
  if (!(al > 0) || !(fit.radius > 0) || region.length === 0) return null
  const a: Vec3 = [fit.axis[0] / al, fit.axis[1] / al, fit.axis[2] / al]
  const [cx, cy, cz] = fit.center
  // A bore: its wall's normals face the axis.
  let toward = 0
  let seen = 0
  let t0 = Infinity
  let t1 = -Infinity
  for (let i = 0; i < region.length; i++) {
    const j = region[i] * 3
    const qx = p[j] - cx, qy = p[j + 1] - cy, qz = p[j + 2] - cz
    const t = qx * a[0] + qy * a[1] + qz * a[2]
    if (t < t0) t0 = t
    if (t > t1) t1 = t
    const dot = (qx - t * a[0]) * n[j] + (qy - t * a[1]) * n[j + 1] + (qz - t * a[2]) * n[j + 2]
    seen++
    if (dot < 0) toward++
  }
  if (toward < 0.6 * seen) return null

  // Every place the axis line crosses the scan, as t along it: a triangle
  // is crossed when the axis lies inside it seen down the axis.
  const [u, v] = orthoBasis(a)
  const count = g.vertexCount
  const pu = new Float32Array(count)
  const pv = new Float32Array(count)
  const pt = new Float32Array(count)
  for (let k = 0; k < count; k++) {
    const j = k * 3
    const qx = p[j] - cx, qy = p[j + 1] - cy, qz = p[j + 2] - cz
    pu[k] = qx * u[0] + qy * u[1] + qz * u[2]
    pv[k] = qx * v[0] + qy * v[1] + qz * v[2]
    pt[k] = qx * a[0] + qy * a[1] + qz * a[2]
  }
  const hits: number[] = []
  if (g.triangleCount === 0) crossingsOfPoints(g, pu, pv, pt, a, hits)
  for (let f = 0; f + 2 < indices.length; f += 3) {
    const i0 = indices[f], i1 = indices[f + 1], i2 = indices[f + 2]
    const u0 = pu[i0], u1 = pu[i1], u2 = pu[i2]
    if ((u0 > 0 && u1 > 0 && u2 > 0) || (u0 < 0 && u1 < 0 && u2 < 0)) continue
    const v0 = pv[i0], v1 = pv[i1], v2 = pv[i2]
    if ((v0 > 0 && v1 > 0 && v2 > 0) || (v0 < 0 && v1 < 0 && v2 < 0)) continue
    // The origin's barycentric weights in the triangle seen down the axis.
    const d = (u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0)
    if (!(Math.abs(d) > 1e-18)) continue
    const w1 = ((0 - u0) * (v2 - v0) - (u2 - u0) * (0 - v0)) / d
    const w2 = ((u1 - u0) * (0 - v0) - (0 - u0) * (v1 - v0)) / d
    const w0 = 1 - w1 - w2
    if (w0 < 0 || w1 < 0 || w2 < 0) continue
    hits.push(w0 * pt[i0] + w1 * pt[i1] + w2 * pt[i2])
  }
  hits.sort((x, y) => x - y)

  const mid = (t0 + t1) / 2
  const reach = CLOSED_REACH_OF_R * fit.radius
  const at = (t: number): Vec3 => [cx + t * a[0], cy + t * a[1], cz + t * a[2]]
  /** The first crossing past the middle one way, the next after it, and how
   *  far past the wall's end the first lies. */
  const end = (sign: 1 | -1) => {
    const ahead = sign > 0 ? hits.filter((t) => t > mid) : hits.filter((t) => t < mid).reverse()
    if (!ahead.length) return null
    const from = ahead[0]
    const past = sign * (from - (sign > 0 ? t1 : t0))
    if (past > reach) return null
    const to = ahead.find((t) => sign * (t - from) > 1e-4)
    return { past, closed: { from, ...(to !== undefined ? { to } : {}), at: at(from) } as BoreClosed }
  }
  const up = end(1)
  const down = end(-1)
  const best = up && down ? (up.past <= down.past ? up : down) : up ?? down
  return best ? best.closed : null
}

// ---- Every flat face at once -------------------------------------------------

export interface SegmentOptions {
  /** Only the scan inside this box. */
  box?: { min: Vec3; max: Vec3 }
  /** Regions smaller than this are given back, mm². */
  minArea: number
  /** A region rougher than this off its plane is not flat, mm. */
  maxRms: number
  /** How far a vertex normal may lean off the region's plane and join. */
  maxDeg: number
}

export interface SegmentedPlane {
  /** Out of the part, by a vote of the region's vertex normals. */
  normal: Vec3
  /** The region's centroid, on its plane. */
  point: Vec3
  /** RMS of the region's points off its plane, mm. */
  sigma: number
  area: number
  min: Vec3
  max: Vec3
  count: number
  /** The regions it meets, by id (1 is the largest), with the angle between
   *  the two planes' outward normals, and whether the two are one smooth
   *  surface across the edge — see SMOOTH_OWN. */
  neighbours: { id: number; deg: number; smooth: boolean }[]
  /** A quadric over the region (see curveOf): its sagitta and the RMS it
   *  leaves, mm. Null for too few points. */
  curve: { sagitta: number; sigma: number } | null
  /** A strip of a curved surface, not a face: see isCurved. */
  curved: boolean
  /** The curved run it is part of, by index in Segmentation.runs. */
  run?: number
}

/** Curved regions joined across smooth edges into the one surface they are
 *  strips of — see growRuns. */
export interface CurvedRun {
  /** Its regions by id, the largest first. */
  regions: number[]
  area: number
  /** The angles of the smooth edges joining its regions, degrees. */
  joins: [number, number]
  /** Its regions' planes' σ, the least and the most, and the RMS their
   *  quadrics leave, pooled, mm. */
  planeSigma: [number, number]
  sigma: number
  /** The direction its vertex normals lie square to, and how far they lean
   *  off square to it (RMS, degrees): only when they lie within ALONG_DEG —
   *  a profile extruded along it. */
  along?: { direction: Vec3; leanDeg: number }
  /** The best cylinder on the axis its normals give, and whether it is the
   *  run's surface (its σ within CYLINDER_OWN × sigma). */
  cylinder?: { point: Vec3; axis: Vec3; radius: number; sigma: number; holds: boolean }
  /** What one surface the run holds as: a profile extruded along `along`,
   *  one cylinder, or neither. */
  kind: 'extruded' | 'cylinder' | 'freeform'
}

export interface Segmentation {
  /** The largest first; region k is id k + 1. */
  regions: SegmentedPlane[]
  /** Every region's vertices one after the other, region k's from
   *  offsets[k] to offsets[k + 1]. */
  vertices: Uint32Array
  offsets: Uint32Array
  /** Vertices looked at (inside the box), and how many the regions hold. */
  considered: number
  claimed: number
  /** The scan's noise: the median scatter off a plane over each sampled
   *  vertex's two rings (see localNoise), mm. */
  noise: number
  /** The curved runs, the largest first. */
  runs: CurvedRun[]
}

/** The points a region starts from: the seed and its nearest neighbours that
 *  face its way. Fewer than the least, and the place is too ragged to seed. */
const PATCH = 30
const PATCH_LEAST = 12
/** A region holds this many vertices at least. */
const REGION_LEAST = 20
/** The band a vertex joins inside, in the region's own σ… */
const BAND_SIGMAS = 3.5
/** …and never wider than this many times maxRms, so a region cannot widen
 *  its way across a shallow crease, nor round a curve until it is rougher
 *  than maxRms and given back whole. */
const BAND_MAX_RMS = 2
/** The plane is refitted when the region has grown by this factor. */
const REFIT_GROWTH = 1.25
/** How many rings round its rim a region spreads to meet its neighbours. */
const MEET_RINGS = 6
/** Edges two regions' fronts meet across, at least, to be neighbours. */
const MEET_EDGES = 3
/** Seeds are ordered by flatness in this many steps. */
const SEED_BUCKETS = 4096

/** Running sums over a region's points, about a fixed origin near them so
 *  the squares keep their precision far from the world's origin. */
class Moments {
  n = 0
  private s = new Float64Array(9)
  constructor(private ox: number, private oy: number, private oz: number) {}
  add(x: number, y: number, z: number): void {
    const a = x - this.ox, b = y - this.oy, c = z - this.oz
    const s = this.s
    this.n++
    s[0] += a
    s[1] += b
    s[2] += c
    s[3] += a * a
    s[4] += a * b
    s[5] += a * c
    s[6] += b * b
    s[7] += b * c
    s[8] += c * c
  }
  /** The best plane through the points so far, its normal turned towards
   *  `toward`, with their RMS off it; null while they lie on a line. */
  plane(toward: Vec3): { plane: Plane; centroid: Vec3; sigma: number } | null {
    const n = this.n
    if (n < 3) return null
    const s = this.s
    const mx = s[0] / n, my = s[1] / n, mz = s[2] / n
    const cxx = s[3] / n - mx * mx, cxy = s[4] / n - mx * my, cxz = s[5] / n - mx * mz
    const cyy = s[6] / n - my * my, cyz = s[7] / n - my * mz, czz = s[8] / n - mz * mz
    const { values, vectors } = symmetricEigen3([cxx, cxy, cxz, cxy, cyy, cyz, cxz, cyz, czz])
    if (!(values[1] > 1e-12 * Math.max(values[2], 1e-30))) return null
    let [nx, ny, nz] = vectors[0]
    if (nx * toward[0] + ny * toward[1] + nz * toward[2] < 0) {
      nx = -nx
      ny = -ny
      nz = -nz
    }
    const centroid: Vec3 = [mx + this.ox, my + this.oy, mz + this.oz]
    return {
      plane: { nx, ny, nz, d: nx * centroid[0] + ny * centroid[1] + nz * centroid[2] },
      centroid,
      sigma: Math.sqrt(Math.max(0, values[0])),
    }
  }
}

/** Grow planar regions over the scan, the largest first — see the top of
 *  the file. */
export function segmentPlanes(g: MeshGraph, opts: SegmentOptions): Segmentation {
  const { positions: P, normals: N, adjOffsets, adjList, vertexCount: n } = g
  const cosMax = Math.cos(Math.min(89, Math.max(0.1, opts.maxDeg)) * DEG)
  const maxRms = Math.max(opts.maxRms, 1e-9)
  const bandFloor = Math.max(1e-5 * g.bboxDiag, 1e-7)
  const bandOf = (sigma: number) => Math.min(BAND_MAX_RMS * maxRms, Math.max(BAND_SIGMAS * sigma, bandFloor))
  const areas = vertexAreas(g)

  // Inside the box, or everywhere.
  let allowed: Uint8Array | null = null
  let considered = n
  if (opts.box) {
    const { min, max } = opts.box
    allowed = new Uint8Array(n)
    considered = 0
    for (let v = 0; v < n; v++) {
      const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2]
      if (x >= min[0] && x <= max[0] && y >= min[1] && y <= max[1] && z >= min[2] && z <= max[2]) {
        allowed[v] = 1
        considered++
      }
    }
  }
  const inside = (v: number) => !allowed || allowed[v] === 1

  // How much the normals turn round each vertex, smoothed over its ring:
  // the flattest places seed first.
  const turn = new Float32Array(n)
  for (let v = 0; v < n; v++) {
    const end = adjOffsets[v + 1]
    const deg = end - adjOffsets[v]
    if (deg === 0) {
      turn[v] = 1
      continue
    }
    let sum = 0
    for (let e = adjOffsets[v]; e < end; e++) {
      const w = adjList[e]
      sum += 1 - (N[v * 3] * N[w * 3] + N[v * 3 + 1] * N[w * 3 + 1] + N[v * 3 + 2] * N[w * 3 + 2])
    }
    turn[v] = sum / deg
  }
  const seedLimit = 1 - cosMax
  const keys = new Int32Array(n).fill(-1)
  const bucketCount = new Uint32Array(SEED_BUCKETS + 1)
  for (let v = 0; v < n; v++) {
    if (!inside(v)) continue
    let sum = turn[v]
    const end = adjOffsets[v + 1]
    for (let e = adjOffsets[v]; e < end; e++) sum += turn[adjList[e]]
    const rough = sum / (end - adjOffsets[v] + 1)
    if (!(rough <= seedLimit)) continue
    const key = Math.min(SEED_BUCKETS - 1, Math.floor(Math.sqrt(rough / seedLimit) * SEED_BUCKETS))
    keys[v] = key
    bucketCount[key + 1]++
  }
  for (let k = 0; k < SEED_BUCKETS; k++) bucketCount[k + 1] += bucketCount[k]
  const order = new Uint32Array(bucketCount[SEED_BUCKETS])
  const fill = bucketCount.slice(0, SEED_BUCKETS)
  for (let v = 0; v < n; v++) if (keys[v] >= 0) order[fill[keys[v]]++] = v

  const label = new Int32Array(n)
  const noSeed = new Uint8Array(n)
  interface Grown { id: number; members: number[]; normal: Vec3; point: Vec3; sigma: number; area: number }
  const kept: Grown[] = []
  let nextId = 1

  const giveBack = (members: number[]) => {
    for (const v of members) {
      label[v] = 0
      noSeed[v] = 1
    }
  }

  for (let o = 0; o < order.length; o++) {
    const s = order[o]
    if (label[s] !== 0 || noSeed[s]) continue
    const id = nextId++
    const sn: Vec3 = [N[s * 3], N[s * 3 + 1], N[s * 3 + 2]]

    // The patch it starts from.
    const members: number[] = [s]
    label[s] = id
    for (let head = 0; head < members.length && members.length < PATCH; head++) {
      const v = members[head]
      const end = adjOffsets[v + 1]
      for (let e = adjOffsets[v]; e < end && members.length < PATCH; e++) {
        const w = adjList[e]
        if (label[w] !== 0 || !inside(w)) continue
        if (N[w * 3] * sn[0] + N[w * 3 + 1] * sn[1] + N[w * 3 + 2] * sn[2] < cosMax) continue
        label[w] = id
        members.push(w)
      }
    }
    const m = new Moments(P[s * 3], P[s * 3 + 1], P[s * 3 + 2])
    for (const v of members) m.add(P[v * 3], P[v * 3 + 1], P[v * 3 + 2])
    let fit = members.length >= PATCH_LEAST ? m.plane(sn) : null
    if (!fit || fit.sigma > maxRms) {
      giveBack(members)
      continue
    }

    // The region, the plane refitted as it grows.
    let band = bandOf(fit.sigma)
    let fittedAt = members.length
    for (let head = 0; head < members.length; head++) {
      const v = members[head]
      const pl = fit.plane
      const end = adjOffsets[v + 1]
      for (let e = adjOffsets[v]; e < end; e++) {
        const w = adjList[e]
        if (label[w] !== 0 || !inside(w)) continue
        const j = w * 3
        if (N[j] * pl.nx + N[j + 1] * pl.ny + N[j + 2] * pl.nz < cosMax) continue
        if (!(Math.abs(planeResidual(pl, P[j], P[j + 1], P[j + 2])) <= band)) continue
        label[w] = id
        members.push(w)
        m.add(P[j], P[j + 1], P[j + 2])
      }
      if (members.length >= REFIT_GROWTH * fittedAt + 8) {
        const next = m.plane([pl.nx, pl.ny, pl.nz])
        if (next) {
          fit = next
          band = bandOf(fit.sigma)
        }
        fittedAt = members.length
      }
    }

    // The plane settled: what it took in early, under a plane that has
    // since turned, and that now lies off it goes back.
    const settled = m.plane([fit.plane.nx, fit.plane.ny, fit.plane.nz]) ?? fit
    const finalBand = bandOf(settled.sigma)
    const stay: number[] = []
    const off: number[] = []
    const fm = new Moments(P[s * 3], P[s * 3 + 1], P[s * 3 + 2])
    let area = 0
    let vote = 0
    for (const v of members) {
      const j = v * 3
      if (Math.abs(planeResidual(settled.plane, P[j], P[j + 1], P[j + 2])) <= finalBand) {
        stay.push(v)
        fm.add(P[j], P[j + 1], P[j + 2])
        area += areas[v]
        vote += N[j] * settled.plane.nx + N[j + 1] * settled.plane.ny + N[j + 2] * settled.plane.nz
      } else off.push(v)
    }
    giveBack(off)
    const final = fm.plane([settled.plane.nx, settled.plane.ny, settled.plane.nz])
    if (!final || stay.length < REGION_LEAST || area < opts.minArea || final.sigma > maxRms) {
      giveBack(stay)
      continue
    }
    const sign = vote >= 0 ? 1 : -1
    kept.push({
      id,
      members: stay,
      normal: [sign * final.plane.nx, sign * final.plane.ny, sign * final.plane.nz],
      point: final.centroid,
      sigma: final.sigma,
      area,
    })
  }

  // The largest first, numbered from 1 in that order.
  kept.sort((a, b) => b.area - a.area)
  const renumber = new Map<number, number>()
  kept.forEach((r, k) => renumber.set(r.id, k + 1))
  for (let v = 0; v < n; v++) if (label[v] !== 0) label[v] = renumber.get(label[v]) ?? 0

  // Each region spreads a few rings into the unclaimed vertices round it;
  // where two fronts meet, or two regions touch, they are neighbours.
  const owner = Int32Array.from(label)
  const ring = new Uint8Array(n)
  const front: number[] = []
  for (let v = 0; v < n; v++) if (owner[v] !== 0) front.push(v)
  const meets = new Map<number, number>()
  const meet = (a: number, b: number) => {
    const key = a < b ? a * 1e6 + b : b * 1e6 + a
    meets.set(key, (meets.get(key) ?? 0) + 1)
  }
  for (let head = 0; head < front.length; head++) {
    const v = front[head]
    if (ring[v] >= MEET_RINGS) continue
    const end = adjOffsets[v + 1]
    for (let e = adjOffsets[v]; e < end; e++) {
      const w = adjList[e]
      if (owner[w] !== 0 || !inside(w)) continue
      owner[w] = owner[v]
      ring[w] = ring[v] + 1
      front.push(w)
    }
  }
  for (let v = 0; v < n; v++) {
    const own = owner[v]
    if (own === 0) continue
    const end = adjOffsets[v + 1]
    for (let e = adjOffsets[v]; e < end; e++) {
      const w = adjList[e]
      if (w > v && owner[w] !== 0 && owner[w] !== own) meet(own, owner[w])
    }
  }

  const offsets = new Uint32Array(kept.length + 1)
  kept.forEach((r, k) => (offsets[k + 1] = offsets[k] + r.members.length))
  const vertices = new Uint32Array(offsets[kept.length])
  kept.forEach((r, k) => vertices.set(r.members, offsets[k]))
  const regions: SegmentedPlane[] = kept.map((r, i) => {
    const min: Vec3 = [Infinity, Infinity, Infinity]
    const max: Vec3 = [-Infinity, -Infinity, -Infinity]
    for (const v of r.members) {
      for (let k = 0; k < 3; k++) {
        const x = P[v * 3 + k]
        if (x < min[k]) min[k] = x
        if (x > max[k]) max[k] = x
      }
    }
    const [e1, e2] = orthoBasis(r.normal)
    const curve = curveOf(P, vertices.subarray(offsets[i], offsets[i + 1]), r.normal, e1, e2, CURVE_SAMPLE_SEGMENT)
    const region: SegmentedPlane = { normal: r.normal, point: r.point, sigma: r.sigma, area: r.area, min, max, count: r.members.length, neighbours: [], curve, curved: false }
    region.curved = isCurved(region)
    return region
  })

  const noise = localNoise(g, NOISE_SAMPLE).median
  const samples = regions.map((_, k) => strided(vertices.subarray(offsets[k], offsets[k + 1]), REGION_SAMPLE))

  for (const [key, edges] of meets) {
    if (edges < MEET_EDGES) continue
    const a = Math.floor(key / 1e6)
    const b = key - a * 1e6
    const ra = regions[a - 1], rb = regions[b - 1]
    const na = ra.normal, nb = rb.normal
    const deg = Math.acos(Math.max(-1, Math.min(1, na[0] * nb[0] + na[1] * nb[1] + na[2] * nb[2]))) / DEG
    const smooth = deg <= SMOOTH_DEG && smoothJoin(P, [ra, rb], [samples[a - 1], samples[b - 1]], noise)
    ra.neighbours.push({ id: b, deg, smooth })
    rb.neighbours.push({ id: a, deg, smooth })
  }
  for (const r of regions) r.neighbours.sort((x, y) => x.id - y.id)

  const runs = growRuns(g, regions, vertices, offsets, samples, noise)
  return { regions, vertices, offsets, considered, claimed: vertices.length, noise, runs }
}

// ---- Curved strips, and the surface they are strips of -----------------------
//
// A plane grows round a curve until its points lie maxRms off it: on a round
// surface segmentPlanes cuts strips whose σ sits just under maxRms and whose
// neighbours meet at the few degrees one strip's band spans — the angle is
// the band's, not the part's. A quadric over such a strip leaves a fraction
// of the plane's σ; over two strips of one surface it leaves about what it
// leaves over each, while across a crease it leaves far more. Runs of such
// strips are grown, region by region, while their union stays one surface
// that says how to model it: a profile extruded along the one direction its
// normals lie square to, one cylinder, or a quadric (a patch of freeform).

/** Points a region's quadric is fitted on when segmenting, at most. */
const CURVE_SAMPLE_SEGMENT = 2000
/** Points of each region kept for the tests across its edges and runs. */
const REGION_SAMPLE = 1500
/** Points a run's union is tested on, at most. */
const RUN_SAMPLE = 4000
/** Vertices the scan's noise is read at. */
const NOISE_SAMPLE = 4000
/** A region is curved when its plane leaves this many times what its quadric
 *  leaves, and the quadric's sagitta is this many times that. */
const CURVED_PLANE_OVER = 2
const CURVED_SAGITTA_OVER = 4
/** Two neighbours are one smooth surface when one quadric over both leaves
 *  no more than this many times the larger of their own quadrics' σ, plus
 *  SMOOTH_NOISE times the scan's noise; only between planes within
 *  SMOOTH_DEG of each other. */
const SMOOTH_OWN = 1.5
const SMOOTH_NOISE = 2
export const SMOOTH_DEG = 35
/** A run's normals lie square to one direction when they lean off square to
 *  it by no more than this, RMS, and turn round it by at least this much. */
const ALONG_DEG = 3
/** A run is one cylinder when the best one leaves no more than this many
 *  times its regions' quadrics' σ, pooled. */
const CYLINDER_OWN = 3
/** Gauss–Newton steps the cylinder of a run is refined by. */
const CYLINDER_STEPS = 12

/** Whether a region is a strip of a curved surface: its plane leaves at least
 *  CURVED_PLANE_OVER × what its quadric leaves, and the quadric rises across
 *  it by CURVED_SAGITTA_OVER × that — not noise, nor relief no quadric
 *  follows. */
export function isCurved(r: Pick<SegmentedPlane, 'sigma' | 'curve'>): boolean {
  return !!r.curve && r.sigma >= CURVED_PLANE_OVER * r.curve.sigma && r.curve.sagitta >= CURVED_SAGITTA_OVER * r.curve.sigma
}

/** Every k-th of the vertices, n of them at most. */
function strided(vs: Uint32Array, n: number): Uint32Array {
  if (vs.length <= n) return vs
  const step = vs.length / n
  const out = new Uint32Array(n)
  for (let i = 0; i < n; i++) out[i] = vs[Math.floor(i * step)]
  return out
}

/** The RMS a quadric height over the points leaves, in the frame of the
 *  normal given — over them all, and over those from `from` on; Infinity
 *  when it cannot be fitted. */
function quadricSigma(p: Float32Array, vs: ArrayLike<number>, normal: Vec3, from = 0): { all: number; tail: number } {
  const n = vs.length
  if (n < 12) return { all: Infinity, tail: Infinity }
  const packed = new Float64Array(n * 3)
  const origin: Vec3 = [0, 0, 0]
  for (let i = 0; i < n; i++) {
    const j = vs[i] * 3
    for (let k = 0; k < 3; k++) {
      packed[i * 3 + k] = p[j + k]
      origin[k] += p[j + k] / n
    }
  }
  const [basisU, basisV] = orthoBasis(normal)
  const fit = fitHeight(packed, { origin, basisU, basisV, normal }, 'quadric')
  if (!fit) return { all: Infinity, tail: Infinity }
  if (from <= 0) return { all: fit.rms, tail: fit.rms }
  const { a, b, c, d, e, f } = fit.coefficients
  let ss = 0
  for (let i = from; i < n; i++) {
    const x = packed[i * 3] - origin[0], y = packed[i * 3 + 1] - origin[1], z = packed[i * 3 + 2] - origin[2]
    const u = x * basisU[0] + y * basisU[1] + z * basisU[2]
    const v = x * basisV[0] + y * basisV[1] + z * basisV[2]
    const h = x * normal[0] + y * normal[1] + z * normal[2]
    ss += (h - (a + b * u + c * v + d * u * u + e * u * v + f * v * v)) ** 2
  }
  return { all: fit.rms, tail: n > from ? Math.sqrt(ss / (n - from)) : 0 }
}

/** The normal halfway between the regions', by area. */
function meanNormal(rs: readonly Pick<SegmentedPlane, 'normal' | 'area'>[]): Vec3 {
  const m: Vec3 = [0, 0, 0]
  for (const r of rs) for (let k = 0; k < 3; k++) m[k] += r.normal[k] * r.area
  return normalizeOrZ(m)
}

/** What a region's own quadric leaves — its plane's σ when it has none. */
const ownSigma = (r: Pick<SegmentedPlane, 'sigma' | 'curve'>) => r.curve?.sigma ?? r.sigma

/** The most one quadric may leave over regions and they still be one smooth
 *  surface. */
const smoothLimit = (rs: readonly Pick<SegmentedPlane, 'sigma' | 'curve'>[], noise: number) =>
  SMOOTH_OWN * Math.max(...rs.map(ownSigma)) + SMOOTH_NOISE * noise

/** Whether two neighbours are one smooth surface across their edge: one
 *  quadric over both leaves about what each one's leaves. */
function smoothJoin(p: Float32Array, rs: [SegmentedPlane, SegmentedPlane], samples: [Uint32Array, Uint32Array], noise: number): boolean {
  const both = new Uint32Array(samples[0].length + samples[1].length)
  both.set(samples[0])
  both.set(samples[1], samples[0].length)
  return quadricSigma(p, both, meanNormal(rs)).all <= smoothLimit(rs, noise)
}

/** What a union of regions holds as one surface, by the three tests a run
 *  grows under. */
interface UnionTest {
  along: { direction: Vec3; leanDeg: number } | null
  cylinder: { point: Vec3; axis: Vec3; radius: number; sigma: number; holds: boolean } | null
  quadric: boolean
}

type Test = 'along' | 'cylinder' | 'quadric'

/**
 * Curved regions joined across smooth edges into runs, the largest region
 * first. A run takes a neighbour, the largest first, while the union stays
 * one surface by a test that has held all along — its normals square to one
 * direction within ALONG_DEG (the least eigenvector of Σ n nᵀ), one cylinder
 * on that axis within CYLINDER_OWN × the pooled quadric σ, or one quadric
 * within the smooth limit — so a chain of smooth joins cannot drift from one
 * surface onto another. A region that is not curved — a strip too narrow to
 * show its curve — joins only as a bridge: smooth to a curved region the run
 * does not hold yet, or to two it does, and no larger than the largest of
 * them, so a face between two rounds stays a face.
 */
function growRuns(g: MeshGraph, regions: SegmentedPlane[], vertices: Uint32Array, offsets: Uint32Array, samples: Uint32Array[], noise: number): CurvedRun[] {
  const { positions: P, normals: N } = g
  // Each region's Σ n nᵀ over all its vertices, by the six entries.
  const moments = regions.map((_, k) => {
    const m = new Float64Array(6)
    for (let i = offsets[k]; i < offsets[k + 1]; i++) {
      const j = vertices[i] * 3
      const x = N[j], y = N[j + 1], z = N[j + 2]
      m[0] += x * x
      m[1] += x * y
      m[2] += x * z
      m[3] += y * y
      m[4] += y * z
      m[5] += z * z
    }
    return m
  })
  const smoothOf = regions.map((r) => r.neighbours.filter((n) => n.smooth).map((n) => n.id - 1))
  const inRun = new Int32Array(regions.length).fill(-1)
  const sinAlong = Math.sin(ALONG_DEG * DEG)

  // The union of the members and the regions to add, by each test that
  // still holds — over the whole, and over what is added alone, so a small
  // region well off the surface cannot hide in a large run's RMS.
  const test = (members: number[], add: number[], live: ReadonlySet<Test>): UnionTest => {
    const every = [...members, ...add]
    const rs = every.map((k) => regions[k])
    let along: UnionTest['along'] = null
    let axis: Vec3 | null = null
    if (live.has('along') || live.has('cylinder')) {
      const m = new Float64Array(6)
      let count = 0
      for (const k of every) {
        for (let e = 0; e < 6; e++) m[e] += moments[k][e]
        count += regions[k].count
      }
      const { values, vectors } = symmetricEigen3([m[0], m[1], m[2], m[1], m[3], m[4], m[2], m[4], m[5]])
      const lean = Math.sqrt(Math.max(0, values[0]) / count)
      const turn = Math.sqrt(Math.max(0, values[1]) / count)
      if (turn >= sinAlong) {
        axis = vectors[0]
        // How far the added regions' normals lean off square to it.
        const [x, y, z] = axis
        let ss = 0, n = 0
        for (const k of add) {
          const q = moments[k]
          ss += x * x * q[0] + 2 * x * y * q[1] + 2 * x * z * q[2] + y * y * q[3] + 2 * y * z * q[4] + z * z * q[5]
          n += regions[k].count
        }
        if (lean <= sinAlong && (!n || Math.sqrt(Math.max(0, ss) / n) <= sinAlong)) along = { direction: axis, leanDeg: Math.asin(lean) / DEG }
      }
    }
    // The union's points, each region's share by its vertices, the added
    // regions' last.
    const total = rs.reduce((s, r) => s + r.count, 0)
    const parts = every.map((k) => strided(samples[k], Math.max(12, Math.round((RUN_SAMPLE * regions[k].count) / total))))
    const union = new Uint32Array(parts.reduce((s, x) => s + x.length, 0))
    let at = 0
    let from = 0
    parts.forEach((x, i) => {
      if (i === members.length) from = at
      union.set(x, at)
      at += x.length
    })
    if (!add.length) from = union.length
    const tail = union.subarray(from)
    let cylinder: UnionTest['cylinder'] = null
    if (live.has('cylinder') && axis) {
      const start = fitCylinderOnAxis(P, union, axis)
      if (start) {
        const c = refineCylinderGeometric(P, union, start, CYLINDER_STEPS)
        const off = (x: number, y: number, z: number) => cylinderResidual(c, x, y, z)
        const sigma = rmsOver(P, union, off)
        const limit = CYLINDER_OWN * Math.sqrt(rs.reduce((s, r) => s + r.count * ownSigma(r) ** 2, 0) / total)
        if (Number.isFinite(sigma) && c.r > 0 && c.r < CYLINDER_MAX_OF_DIAG * g.bboxDiag)
          cylinder = { point: [c.px, c.py, c.pz], axis: [c.ax, c.ay, c.az], radius: c.r, sigma, holds: sigma <= limit && (!tail.length || rmsOver(P, tail, off) <= limit) }
      }
    }
    let quadric = false
    if (live.has('quadric')) {
      const q = quadricSigma(P, union, meanNormal(rs), from)
      const limit = smoothLimit(rs, noise)
      quadric = q.all <= limit && q.tail <= limit
    }
    return { along, cylinder, quadric }
  }
  const holding = (t: UnionTest): Set<Test> => {
    const out = new Set<Test>()
    if (t.along) out.add('along')
    if (t.cylinder?.holds) out.add('cylinder')
    if (t.quadric) out.add('quadric')
    return out
  }

  const order = regions.map((_, k) => k).filter((k) => regions[k].curved).sort((a, b) => regions[b].area - regions[a].area)
  const grown: number[][] = []
  for (const seed of order) {
    if (inRun[seed] >= 0) continue
    const id = grown.length
    const members = [seed]
    const mine = new Set([seed])
    let live = new Set<Test>(['along', 'cylinder', 'quadric'])
    const tried = new Set<number>()
    const free = (k: number) => inRun[k] < 0 && !mine.has(k)
    for (;;) {
      // The neighbours across smooth edges not tried yet, the largest first.
      const next = new Set<number>()
      for (const k of members) for (const w of smoothOf[k]) if (free(w) && !tried.has(w)) next.add(w)
      if (!next.size) break
      const c = [...next].sort((a, b) => regions[b].area - regions[a].area)[0]
      tried.add(c)
      // What joins with it: itself, when curved; a bridge, with the curved
      // region beyond it.
      const tries: number[][] = []
      if (regions[c].curved) tries.push([c])
      else {
        const inside = smoothOf[c].filter((w) => mine.has(w))
        if (inside.length >= 2 && regions[c].area <= Math.max(...inside.map((w) => regions[w].area))) tries.push([c])
        const largest = Math.max(...inside.map((w) => regions[w].area))
        for (const d of smoothOf[c].filter((w) => free(w) && regions[w].curved).sort((a, b) => regions[b].area - regions[a].area))
          if (regions[c].area <= Math.max(largest, regions[d].area)) tries.push([c, d])
      }
      for (const add of tries.slice(0, BRIDGE_TRIES)) {
        const t = test(members, add, live)
        const holds = holding(t)
        const kept = new Set([...live].filter((x) => holds.has(x)))
        if (!kept.size) continue
        for (const k of add) {
          members.push(k)
          mine.add(k)
          tried.add(k)
        }
        live = kept
        break
      }
    }
    if (members.length < 2) continue
    for (const k of members) inRun[k] = id
    grown.push(members)
  }

  const all = new Set<Test>(['along', 'cylinder', 'quadric'])
  const runs = grown.map((members) => {
    const rs = members.map((k) => regions[k])
    const total = rs.reduce((s, r) => s + r.count, 0)
    let lo = Infinity, hi = -Infinity
    for (const k of members)
      for (const n of regions[k].neighbours)
        if (n.smooth && inRun[n.id - 1] === inRun[k]) {
          lo = Math.min(lo, n.deg)
          hi = Math.max(hi, n.deg)
        }
    // What the whole run holds as, by every test — the cylinder too when it
    // fails, so an extruded run says how far one arc is from its profile.
    const { along, cylinder } = test(members, [], all)
    const run: CurvedRun = {
      regions: [...members].sort((a, b) => a - b).map((k) => k + 1),
      area: rs.reduce((s, r) => s + r.area, 0),
      joins: [lo, hi],
      planeSigma: [Math.min(...rs.map((r) => r.sigma)), Math.max(...rs.map((r) => r.sigma))],
      sigma: Math.sqrt(rs.reduce((s, r) => s + r.count * ownSigma(r) ** 2, 0) / total),
      ...(along ? { along: { direction: upright(along.direction), leanDeg: along.leanDeg } } : {}),
      ...(cylinder ? { cylinder: { ...cylinder, axis: upright(cylinder.axis) } } : {}),
      kind: cylinder?.holds ? 'cylinder' : along ? 'extruded' : 'freeform',
    }
    return run
  })
  const byArea = runs.map((_, i) => i).sort((a, b) => runs[b].area - runs[a].area)
  const sorted = byArea.map((i) => runs[i])
  byArea.forEach((i, rank) => {
    for (const id of runs[i].regions) regions[id - 1].run = rank
  })
  return sorted
}

/** A cylinder whose radius passes this many times the scan's diagonal is a
 *  plane, as far as a run goes. */
const CYLINDER_MAX_OF_DIAG = 5
/** How many ways a region that is not curved is tried as a bridge. */
const BRIDGE_TRIES = 3

/** A direction turned so its largest component is positive. */
function upright(d: Vec3): Vec3 {
  const k = [0, 1, 2].reduce((a, b) => (Math.abs(d[b]) > Math.abs(d[a]) ? b : a), 0)
  return d[k] < 0 ? [-d[0], -d[1], -d[2]] : [d[0], d[1], d[2]]
}
