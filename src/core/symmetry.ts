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
// The caller may add directions of its own — the part's face directions from
// core/autoAlign, which a lug or a missing patch does not turn the way it
// turns the principal axes. A seed plane — a midplane of two faces, a fitted
// face — replaces them all when the part's detail makes the choice ambiguous.
//
// Most of the work would go into the candidates that lose: a plane the part
// is not symmetric about never lets the registration settle, so it burns
// every iteration of every pass. The search therefore runs in two stages.
// Each candidate is first settled on a small sample with a loose registration
// — enough to bring a plane that is a few degrees out to within a fraction of
// one — and judged there; only the winner, and a runner-up that is close, go
// on to the full sample and the tight registration the reported plane needs.
// Once a pass has shown how far the mirror images really lie from the scan,
// the next one searches no further than a few times that, which is what
// keeps the facing-aware closest-point search — the expensive one — short.
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

/** The coordinate planes as seeds, beside the plane elements: on a part
 *  that was aligned first the mirror plane is usually one of them, and
 *  naming it settles which of several symmetries is meant. The ids are
 *  negative so they never meet an element's. */
export const BASE_PLANE_SEEDS: readonly { id: number; name: string; normal: Vec3 }[] = [
  { id: -1, name: 'XY plane', normal: [0, 0, 1] },
  { id: -2, name: 'YZ plane', normal: [1, 0, 0] },
  { id: -3, name: 'ZX plane', normal: [0, 1, 0] },
]

/** A coordinate plane as the seed of a search: the plane itself where it
 *  cuts through the part, and its parallel through the part's centre where
 *  it does not — a scan fresh from the scanner sits anywhere, and a mirror
 *  plane that misses the part mirrors it into thin air. */
export function baseSeedPlane(id: number, center: Vec3, size: number): (SeedPlane & { name: string }) | null {
  const base = BASE_PLANE_SEEDS.find((p) => p.id === id)
  if (!base) return null
  const off = dot(center, base.normal)
  const cuts = Math.abs(off) <= Math.max(size, 0) / 2
  return { name: base.name, normal: base.normal, point: cuts ? [0, 0, 0] : center }
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
  /** Which candidate won: 0–2 a principal plane, 3 and up one of the
   *  directions the caller added, −1 a given seed. */
  candidate: number
}

/** The mirror image may stand off the scan by this much, RMS, and the part
 *  still count as symmetric — the line Measure's symmetry plane calls a
 *  loose match beyond. A scan's own noise is a few hundredths. */
export const SYMMETRY_MAX_RMS_MM = 0.1

/** The share of the samples that must find their mirror image. A part
 *  symmetric in its body but for a hook or a boss still passes; a plane
 *  that mirrors half the part into thin air does not. */
export const SYMMETRY_MIN_MATCHED = 0.5

/** Whether a search's answer is a symmetry worth defaulting to. */
export function symmetryAccepted(r: Pick<SymmetryPlane, 'rms' | 'matched' | 'sampled'>): boolean {
  return Number.isFinite(r.rms) && r.rms <= SYMMETRY_MAX_RMS_MM && r.sampled > 0 && r.matched / r.sampled >= SYMMETRY_MIN_MATCHED
}

export interface SymmetryOptions {
  /** Samples of the scan the search runs on. */
  samples?: number
  /** Confine the samples to these vertices — a surface marked by hand, so a
   *  fixture or a broken patch takes no part. The surface the mirror images
   *  are matched against is the caller's to confine the same way. */
  vertices?: Uint32Array
  /** Reflect-register-bisect passes on the full sample. */
  rounds?: number
  /** Normals of further candidate planes, tried through the centroid beside
   *  the principal ones when no seed is given. One within a few degrees of a
   *  candidate already there is dropped. */
  directions?: Vec3[]
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

  // The small sample the candidates are settled and judged on first.
  const coarse = samples.count > 1200 ? sampleScan(pos, nrm, Math.max(600, Math.round(samples.count / 6))) : samples

  let candidates: SeedPlane[]
  if (seed) {
    const normal = normalize(seed.normal)
    if (!normal) throw new Error('The seed plane has no direction.')
    candidates = [{ normal, point: seed.point }]
  } else {
    const frame = principalFrame(samples.xyz)
    candidates = frame.axes.map((axis) => ({ normal: axis, point: frame.centroid }))
    const cosSame = Math.cos((3 * Math.PI) / 180)
    for (const d of opts.directions ?? []) {
      const normal = normalize(d)
      if (!normal || candidates.some((c) => Math.abs(dot(c.normal, normal)) > cosSame)) continue
      candidates.push({ normal, point: frame.centroid })
    }
  }

  /** Passes of reflect, register, bisect from a starting plane. `fine` is
   *  the full sample and the tight registration; without it, the quick look. */
  const out = new Float64Array(3)
  const settle = (s: ScanSamples, start: SeedPlane, passes: number, fine: boolean, say: (pass: number) => string): SeedPlane => {
    let n = start.normal
    let p = start.point
    let search = reach
    const moved = new Float64Array(s.count * 3)
    for (let pass = 0; pass < passes; pass++) {
      opts.onProgress?.(say(pass))
      const mirrored = reflect(s, n, p)
      const res = icp(surface, mirrored, identityRigid(), {
        maxIterations: fine ? 40 : 15,
        rejectMedianFactor: REJECT_MEDIAN_FACTOR,
        minNormalDot: 0.5,
        facingSearch: true,
        maxPairDistance: search,
        tolerance: diag * (fine ? 1e-7 : 1e-5),
      })
      // A mirror image that finds almost no surface is not a symmetry, and
      // a plane read off it would be noise.
      if (res.matched < 0.2 * s.count) break
      for (let i = 0; i < s.count; i++) {
        const j = i * 3
        rigidApply(res.transform, mirrored.xyz[j], mirrored.xyz[j + 1], mirrored.xyz[j + 2], out)
        moved[j] = out[0]
        moved[j + 1] = out[1]
        moved[j + 2] = out[2]
      }
      // Only the samples whose registered mirror image actually lies on the
      // scan say where the plane is.
      const d = distances(surface, moved, s.count, search)
      const thr = matchThreshold(d)
      const next = bisector(s.xyz, moved, (i) => d[i] <= thr, s.count, n)
      if (!next) break
      const turned = Math.acos(Math.min(1, Math.abs(dot(next.normal, n))))
      const shifted = Math.abs(
        dot([next.point[0] - p[0], next.point[1] - p[1], next.point[2] - p[2]], next.normal),
      )
      n = next.normal
      p = next.point
      // What matched lay within `thr`; the next pass has no business further
      // out than a few times that.
      search = Math.min(reach, Math.max(diag * 0.01, 4 * thr))
      if (fine ? turned < 1e-7 && shifted < 1e-6 : turned < 1e-4 && shifted < diag * 1e-5) break
    }
    return { normal: n, point: p }
  }

  // Stage one: every candidate on the small sample, judged where it settles.
  const COARSE_PASSES = 3
  let field = candidates.map((cand, ci) => ({ plane: cand, ci, capped: 0 }))
  if (coarse !== samples) {
    for (const c of field) {
      c.plane = settle(coarse, c.plane, COARSE_PASSES, false, (pass) =>
        seed
          ? `Finding the symmetry plane — a first look, pass ${pass + 1}…`
          : `Finding the symmetry plane — trying plane ${c.ci + 1} of ${candidates.length}…`,
      )
      c.capped = residual(surface, coarse, c.plane.normal, c.plane.point, reach).capped
    }
    // The winner goes on, and a runner-up too close to call on so few points.
    field.sort((a, b) => a.capped - b.capped)
    field = field.filter((c, i) => i === 0 || (i === 1 && c.capped <= 1.25 * field[0].capped))
  }

  // Stage two: the full sample and the tight registration.
  let best: (SymmetryPlane & { capped: number }) | null = null
  for (const c of field) {
    const { normal: n, point: p } = settle(samples, c.plane, rounds, true, (pass) => `Finding the symmetry plane — refining, pass ${pass + 1}…`)
    const r = residual(surface, samples, n, p, reach)
    if (!best || r.capped < best.capped) {
      best = {
        normal: n,
        point: p,
        rms: r.rms,
        matched: r.matched,
        sampled: samples.count,
        candidate: seed ? -1 : c.ci,
        capped: r.capped,
      }
    }
  }
  if (!best) throw new Error('No symmetry plane could be found.')
  const { capped: _capped, ...plane } = best as SymmetryPlane & { capped: number }
  return plane
}
