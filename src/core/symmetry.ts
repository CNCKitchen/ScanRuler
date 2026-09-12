// SPDX-License-Identifier: AGPL-3.0-only
// The mirror plane a part matches itself across.
//
// Reverse engineering models one half of a symmetric part and mirrors it,
// so the plane it is mirrored about has to be found from the scan to a
// precision no hand-picked plane reaches. The search here is mirror
// registration: reflect a thinned sample of the scan through a candidate
// plane, fit the reflection back onto the scan with the same point-to-plane
// ICP the deviation workspace uses, and read the plane off the result. Every
// sample x and its registered mirror image y are a pair the true plane
// bisects — the plane's normal is the direction the pairs run in, and its
// point is where their midpoints lie — so one pass turns a rough candidate
// into a good one, and a few passes settle it.
//
// A scan is never complete: where it has a hole, the mirror image of the
// surface opposite lands on nothing and finds surface only far away, and a
// fixture or a stamped number on one side has no counterpart at all. Those
// pairs are left out the way ICP leaves them out — anything further from
// the scan than three times the median distance is not a mirror image — so
// they neither steer the plane nor inflate the residual; they show up as
// samples that did not match.
//
// Without a seed the candidates are the scan's three principal planes: for a
// mirror-symmetric cloud the mirror normal is always one of the principal
// axes, since reflecting the cloud onto itself leaves its scatter unchanged.
// A seed plane — a midplane of two faces, a fitted face — replaces them when
// the part's detail makes the principal choice ambiguous.
//
// What comes back is a plane and how symmetric the part is about it: the
// RMS distance of the matched mirrored samples from the scan, with no rigid
// fudge left in, so an asymmetric part reports a large one instead of a
// plane that looks authoritative.

import { icp, sampleScan, type ScanSamples } from './deviation/icp'
import { principalFrame } from './deviation/prealign'
import { identityRigid, rigidApply } from './deviation/rigid'
import { emptyHit, type NominalSurface } from './deviation/surface'
import type { Vec3 } from './types'
import { dot, normalize } from './vec'

export interface SeedPlane {
  normal: Vec3
  point: Vec3
}

export interface SymmetryPlane {
  normal: Vec3
  point: Vec3
  /** RMS distance of the matched mirrored samples from the scan, in mm —
   *  zero for a perfectly symmetric part, and the σ the plane reports. */
  rms: number
  /** How many samples found their mirror image on the scan, of how many. */
  matched: number
  sampled: number
  /** Which candidate won: the index of the principal plane, or −1 for a
   *  given seed. */
  candidate: number
}

export interface SymmetryOptions {
  /** Samples of the scan the search runs on. */
  samples?: number
  /** Confine the samples to these vertices — a surface marked by hand, so a
   *  fixture or a broken patch takes no part. The surface the mirror images
   *  are matched against is the caller's to confine the same way. */
  vertices?: Uint32Array
  /** Reflect-register-bisect passes per candidate. */
  rounds?: number
  onProgress?: (text: string) => void
}

/** Beyond this multiple of the median distance a mirrored sample has found
 *  no mirror image — the same cut ICP applies to its pairs. */
const REJECT_MEDIAN_FACTOR = 3

/** The samples reflected through the plane, normals included: a normal is a
 *  vector, and a reflection turns it the same way. */
function reflect(s: ScanSamples, n: Vec3, p: Vec3): ScanSamples {
  const xyz = new Float64Array(s.xyz.length)
  const normals = s.normals ? new Float64Array(s.normals.length) : null
  const pn = dot(p, n)
  for (let i = 0; i < s.count; i++) {
    const j = i * 3
    const d = 2 * (s.xyz[j] * n[0] + s.xyz[j + 1] * n[1] + s.xyz[j + 2] * n[2] - pn)
    xyz[j] = s.xyz[j] - d * n[0]
    xyz[j + 1] = s.xyz[j + 1] - d * n[1]
    xyz[j + 2] = s.xyz[j + 2] - d * n[2]
    if (normals && s.normals) {
      const e = 2 * (s.normals[j] * n[0] + s.normals[j + 1] * n[1] + s.normals[j + 2] * n[2])
      normals[j] = s.normals[j] - e * n[0]
      normals[j + 1] = s.normals[j + 1] - e * n[1]
      normals[j + 2] = s.normals[j + 2] - e * n[2]
    }
  }
  return { xyz, normals, count: s.count }
}

/** Distance of every point to the scan, Infinity where none lies within
 *  `reach`. */
function distances(surface: NominalSurface, xyz: Float64Array, count: number, reach: number): Float64Array {
  const out = new Float64Array(count)
  const hit = emptyHit()
  for (let i = 0; i < count; i++) {
    const j = i * 3
    out[i] = surface.closest(xyz[j], xyz[j + 1], xyz[j + 2], hit, reach) ? hit.distance : Infinity
  }
  return out
}

/** The distance a mirrored sample may have to the scan and still count as
 *  having found its mirror image: three medians, over the samples that
 *  found any surface at all. Zero when none did. */
function matchThreshold(d: Float64Array): number {
  const finite = Array.from(d).filter((v) => Number.isFinite(v))
  if (finite.length === 0) return 0
  finite.sort((a, b) => a - b)
  const median = finite[finite.length >> 1]
  // A floor keeps a noiseless test mesh from rejecting everything as its
  // median goes to zero.
  return Math.max(REJECT_MEDIAN_FACTOR * median, 1e-6)
}

/** The plane bisecting every kept sample and its registered mirror image:
 *  the normal along the pairs, the point at their midpoints. A pair is taken
 *  the way round that agrees with the current normal, so the two sides of
 *  the part do not cancel. Null when too few pairs are kept or they have no
 *  common direction. */
function bisector(
  x: Float64Array,
  y: Float64Array,
  keep: (i: number) => boolean,
  count: number,
  current: Vec3,
): SeedPlane | null {
  let sx = 0, sy = 0, sz = 0
  let mx = 0, my = 0, mz = 0
  let kept = 0
  for (let i = 0; i < count; i++) {
    if (!keep(i)) continue
    const j = i * 3
    const dx = y[j] - x[j]
    const dy = y[j + 1] - x[j + 1]
    const dz = y[j + 2] - x[j + 2]
    const s = dx * current[0] + dy * current[1] + dz * current[2] < 0 ? -1 : 1
    sx += s * dx
    sy += s * dy
    sz += s * dz
    mx += (x[j] + y[j]) / 2
    my += (x[j + 1] + y[j + 1]) / 2
    mz += (x[j + 2] + y[j + 2]) / 2
    kept++
  }
  if (kept < 20) return null
  const normal = normalize([sx, sy, sz])
  if (!normal) return null
  return { normal, point: [mx / kept, my / kept, mz / kept] }
}

/** How symmetric the part is about a plane, with nothing else moved: the
 *  matched mirrored samples' distances to the scan. `rms` over the matched
 *  ones, `capped` over all of them with every unmatched sample charged the
 *  full reach — the number the candidates are judged by, so a plane that
 *  mirrors half the part into thin air cannot win on the other half. */
function residual(
  surface: NominalSurface,
  samples: ScanSamples,
  n: Vec3,
  p: Vec3,
  reach: number,
): { rms: number; matched: number; capped: number } {
  const mirrored = reflect(samples, n, p)
  const d = distances(surface, mirrored.xyz, mirrored.count, reach)
  const thr = matchThreshold(d)
  let sumSq = 0
  let matched = 0
  for (let i = 0; i < mirrored.count; i++) {
    if (d[i] <= thr) {
      sumSq += d[i] * d[i]
      matched++
    }
  }
  const unmatched = mirrored.count - matched
  return {
    rms: matched ? Math.sqrt(sumSq / matched) : Infinity,
    matched,
    capped: Math.sqrt((sumSq + unmatched * reach * reach) / Math.max(1, mirrored.count)),
  }
}

/**
 * Find the plane the scan is mirror-symmetric about.
 *
 * @param surface  The scan itself, prepared for closest-point queries.
 * @param positions The scan's vertices, in the same frame.
 * @param normals   Their outward normals — they steer the registration away
 *                  from the far wall of a thin part.
 * @param seed      A plane to start from, or null for the principal planes.
 */
export function findSymmetryPlane(
  surface: NominalSurface,
  positions: Float32Array,
  normals: Float32Array | null,
  seed: SeedPlane | null,
  opts: SymmetryOptions = {},
): SymmetryPlane {
  const rounds = opts.rounds ?? 5
  let pos = positions
  let nrm = normals
  if (opts.vertices && opts.vertices.length > 0) {
    const v = opts.vertices
    pos = new Float32Array(v.length * 3)
    nrm = normals ? new Float32Array(v.length * 3) : null
    for (let i = 0; i < v.length; i++) {
      const j = v[i] * 3
      pos[i * 3] = positions[j]
      pos[i * 3 + 1] = positions[j + 1]
      pos[i * 3 + 2] = positions[j + 2]
      if (nrm && normals) {
        nrm[i * 3] = normals[j]
        nrm[i * 3 + 1] = normals[j + 1]
        nrm[i * 3 + 2] = normals[j + 2]
      }
    }
  }
  const samples = sampleScan(pos, nrm, opts.samples ?? 4000)
  if (samples.count < 100) throw new Error('Too few points to look for a symmetry.')
  const diag = surface.bboxDiagonal
  const reach = diag * 0.1

  let candidates: SeedPlane[]
  if (seed) {
    const normal = normalize(seed.normal)
    if (!normal) throw new Error('The seed plane has no direction.')
    candidates = [{ normal, point: seed.point }]
  } else {
    const frame = principalFrame(samples.xyz)
    candidates = frame.axes.map((axis) => ({ normal: axis, point: frame.centroid }))
  }

  let best: (SymmetryPlane & { capped: number }) | null = null
  const moved = new Float64Array(samples.count * 3)
  const out = new Float64Array(3)
  candidates.forEach((cand, ci) => {
    let n = cand.normal
    let p = cand.point
    for (let round = 0; round < rounds; round++) {
      opts.onProgress?.(
        seed
          ? `Finding the symmetry plane — pass ${round + 1}…`
          : `Finding the symmetry plane — principal plane ${ci + 1} of ${candidates.length}, pass ${round + 1}…`,
      )
      const mirrored = reflect(samples, n, p)
      const res = icp(surface, mirrored, identityRigid(), {
        maxIterations: 40,
        rejectMedianFactor: REJECT_MEDIAN_FACTOR,
        minNormalDot: 0.5,
        facingSearch: true,
        maxPairDistance: reach,
        tolerance: diag * 1e-7,
      })
      // A mirror image that finds almost no surface is not a symmetry, and
      // a plane read off it would be noise.
      if (res.matched < 0.2 * samples.count) break
      for (let i = 0; i < samples.count; i++) {
        const j = i * 3
        rigidApply(res.transform, mirrored.xyz[j], mirrored.xyz[j + 1], mirrored.xyz[j + 2], out)
        moved[j] = out[0]
        moved[j + 1] = out[1]
        moved[j + 2] = out[2]
      }
      // Only the samples whose registered mirror image actually lies on the
      // scan say where the plane is.
      const d = distances(surface, moved, samples.count, reach)
      const thr = matchThreshold(d)
      const next = bisector(samples.xyz, moved, (i) => d[i] <= thr, samples.count, n)
      if (!next) break
      const turned = Math.acos(Math.min(1, Math.abs(dot(next.normal, n))))
      const shifted = Math.abs(
        dot([next.point[0] - p[0], next.point[1] - p[1], next.point[2] - p[2]], next.normal),
      )
      n = next.normal
      p = next.point
      if (turned < 1e-7 && shifted < 1e-6) break
    }
    const r = residual(surface, samples, n, p, reach)
    if (!best || r.capped < best.capped) {
      best = {
        normal: n,
        point: p,
        rms: r.rms,
        matched: r.matched,
        sampled: samples.count,
        candidate: seed ? -1 : ci,
        capped: r.capped,
      }
    }
  })
  if (!best) throw new Error('No symmetry plane could be found.')
  const { capped: _capped, ...plane } = best as SymmetryPlane & { capped: number }
  return plane
}
