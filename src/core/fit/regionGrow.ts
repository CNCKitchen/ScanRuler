// SPDX-License-Identifier: AGPL-3.0-only
import type { Cone, Cylinder, MeshGraph, Plane, Sphere } from '../types'
import { acquireStamps } from '../geometry/scratch'
import { coneNormalAlign, coneResidual, fitConeClipped } from './cone'
import { cylinderResidual, fitCylinderClipped } from './cylinder'
import { fitPlaneClipped, planeResidual } from './plane'
import { fitSphereClipped } from './sphere'

/** Vertices whose fit uses a strided subsample beyond this size; the region
 *  itself is still complete, only the per-round solve is capped. */
const FIT_SUBSAMPLE = 60_000

const COS_SPHERE_MAX = Math.cos((38 * Math.PI) / 180)
const COS_CYLINDER_MAX = Math.cos((32 * Math.PI) / 180)
const COS_CONE_MAX = Math.cos((32 * Math.PI) / 180)
const COS_PLANE_MAX = Math.cos((25 * Math.PI) / 180)

/** A rim ring is peeled while its normals turn away from the model by at
 *  least this multiple of the surface's own noise tilt (the median over the
 *  region) — twice the noise is a surface starting to curve away, not noise. */
const PEEL_TILT_FACTOR = 2
/** …and by at least this much in absolute terms, so a perfectly tessellated
 *  mesh (noise tilt zero) does not peel on rounding error. */
const PEEL_TILT_FLOOR = (0.5 * Math.PI) / 180
/** Rings peeled at most — the rounding of a scanned edge is a couple of
 *  vertex rings wide; anything beyond is not an edge. */
const MAX_PEEL_RINGS = 6

/** Collect up to `limit` vertices connected to the seeds — no membership
 *  criterion, plain surface BFS. Used to gather the RANSAC patch. */
export function collectPatch(g: MeshGraph, seeds: ArrayLike<number>, limit: number): Uint32Array {
  const { stamp, gen } = acquireStamps(g, g.vertexCount)
  const queue: number[] = []
  for (let i = 0; i < seeds.length; i++) {
    const s = seeds[i]
    if (stamp[s] !== gen) {
      stamp[s] = gen
      queue.push(s)
    }
  }
  let head = 0
  while (head < queue.length && queue.length < limit) {
    const v = queue[head++]
    const end = g.adjOffsets[v + 1]
    for (let e = g.adjOffsets[v]; e < end; e++) {
      const nb = g.adjList[e]
      if (stamp[nb] === gen) continue
      stamp[nb] = gen
      queue.push(nb)
      if (queue.length >= limit) break
    }
  }
  return Uint32Array.from(queue)
}

/** What one geometry needs to contribute to the shared growing loop. */
interface GrowSpec<T> {
  /** Smallest |cos| between a vertex normal and the model's surface normal
   *  that still counts as the same surface. */
  cosMax: number
  /** Half-width of the acceptance band around the surface. */
  band: (m: T, sigma: number) => number
  /** Distance of a vertex from the model surface; NaN where undefined. */
  residual: (m: T, x: number, y: number, z: number) => number
  /** |cos| between the vertex normal and the model's surface normal there. */
  align: (m: T, x: number, y: number, z: number, nx: number, ny: number, nz: number) => number
  refit: (
    positions: Float32Array,
    idx: Uint32Array,
    m: T,
  ) => { model: T; sigma: number } | null
}

export interface GrowResult<T> {
  region: Uint32Array
  model: T
  sigma: number
}

/** Peel the transition off the rim of a grown region: a scan rounds every
 *  edge over a few vertex rings, and the growing test lets the first of them
 *  in — their distance is still inside the band and their normals still
 *  within the coarse angle that has to tolerate scan noise. Those rings sit
 *  systematically off the surface (into the part on a rounded edge, out of
 *  it at a burr or a bore's flared mouth) and their normals turn away from
 *  the model far more than the noise on the surface proper does. So the rim
 *  ring goes while its median tilt exceeds the region's median tilt by
 *  `PEEL_TILT_FACTOR`, ring by ring, until a ring looks like the interior.
 *  Never below half the grown region, so a small face is not eaten from the
 *  outside in. `stamp[v] === gen` marks membership on the way in and is
 *  cleared for what is peeled; returns the vertices that stay. */
function peelTransition(
  g: MeshGraph,
  stamp: Int32Array,
  gen: number,
  queue: number[],
  alignAt: (v: number) => number,
): number[] {
  const n = queue.length
  if (n < 60) return queue
  const all = new Float32Array(n)
  for (let i = 0; i < n; i++) all[i] = alignAt(queue[i])
  all.sort()
  // The largest |cos| is the smallest tilt: the median of one is the median
  // of the other.
  const noiseTilt = Math.acos(Math.min(1, all[n >> 1]))
  const limit = Math.cos(Math.max(PEEL_TILT_FACTOR * noiseTilt, noiseTilt + PEEL_TILT_FLOOR))
  const keepAtLeast = Math.max(60, n >> 1)

  let ring: number[] = []
  for (let i = 0; i < n; i++) {
    const v = queue[i]
    const end = g.adjOffsets[v + 1]
    for (let e = g.adjOffsets[v]; e < end; e++) {
      if (stamp[g.adjList[e]] !== gen) {
        ring.push(v)
        break
      }
    }
  }

  let remaining = n
  for (let k = 0; k < MAX_PEEL_RINGS && ring.length > 0; k++) {
    if (remaining - ring.length < keepAtLeast) break
    const ringAlign = new Float32Array(ring.length)
    for (let i = 0; i < ring.length; i++) ringAlign[i] = alignAt(ring[i])
    ringAlign.sort()
    if (ringAlign[ring.length >> 1] >= limit) break

    // gen is positive, so neither 0 nor -gen ever reads as a member.
    for (const v of ring) stamp[v] = 0
    remaining -= ring.length
    const next: number[] = []
    for (const v of ring) {
      const end = g.adjOffsets[v + 1]
      for (let e = g.adjOffsets[v]; e < end; e++) {
        const nb = g.adjList[e]
        if (stamp[nb] === gen) {
          stamp[nb] = -gen
          next.push(nb)
        }
      }
    }
    for (const v of next) stamp[v] = gen
    ring = next
  }

  if (remaining === n) return queue
  const kept: number[] = []
  for (let i = 0; i < n; i++) if (stamp[queue[i]] === gen) kept.push(queue[i])
  return kept
}

/** Grow the element's surface region from the seed while the model is refit
 *  every round. Membership needs BOTH a distance inside the current noise band
 *  AND a surface normal agreeing with the model's — the normal test is what
 *  stops the region from leaking across an edge onto a neighbouring face, or
 *  onto the connecting rod at a sphere's neck. The BFS restarts from the seed
 *  each round with the improved model, capped at 3× the previous region size
 *  so a bad early model cannot flood the whole mesh before the fit corrects
 *  it. What the finished region holds of the edges' rounding is peeled off
 *  its rim at the end (see `peelTransition`) — after the growing, not inside
 *  it, so the band that decides where a surface ends stays the one tuned
 *  against GOM's selections and is not tightened by its own trimming. */
function growRegion<T>(
  g: MeshGraph,
  seeds: ArrayLike<number>,
  init: T,
  initSigma: number,
  initCount: number,
  spec: GrowSpec<T>,
): GrowResult<T> | null {
  const { positions, normals } = g
  let model = init
  let sigma = Math.max(initSigma, 1e-6)
  let prev = Math.max(initCount, 50)
  /** The last round's region as grown, with the stamps that mark it. */
  let last: { queue: number[]; stamp: Int32Array; gen: number; hitCap: boolean } | null = null

  for (let round = 0; round < 30; round++) {
    const band = spec.band(model, sigma)
    const cap = Math.max(6000, prev * 3)
    const { stamp, gen } = acquireStamps(g, g.vertexCount)
    const queue: number[] = []
    let hitCap = false

    for (let i = 0; i < seeds.length; i++) {
      const seed = seeds[i]
      if (stamp[seed] !== gen) {
        stamp[seed] = gen
        queue.push(seed)
      }
    }

    let head = 0
    outer: while (head < queue.length) {
      const v = queue[head++]
      const end = g.adjOffsets[v + 1]
      for (let e = g.adjOffsets[v]; e < end; e++) {
        const nb = g.adjList[e]
        if (stamp[nb] === gen) continue
        const j = nb * 3
        const x = positions[j], y = positions[j + 1], z = positions[j + 2]
        const res = spec.residual(model, x, y, z)
        // NaN (undefined residual) fails this test, as it should.
        if (!(Math.abs(res) <= band)) continue
        if (spec.align(model, x, y, z, normals[j], normals[j + 1], normals[j + 2]) < spec.cosMax) {
          continue
        }
        stamp[nb] = gen
        queue.push(nb)
        if (queue.length >= cap) {
          hitCap = true
          break outer
        }
      }
    }

    const region = Uint32Array.from(queue)
    if (region.length < 10) return null

    let fitIdx: Uint32Array = region
    if (region.length > FIT_SUBSAMPLE) {
      const stride = region.length / FIT_SUBSAMPLE
      fitIdx = new Uint32Array(FIT_SUBSAMPLE)
      for (let i = 0; i < FIT_SUBSAMPLE; i++) fitIdx[i] = region[Math.floor(i * stride)]
    }
    const fit = spec.refit(positions, fitIdx, model)
    if (!fit) return null

    const growth = Math.abs(region.length - prev)
    model = fit.model
    sigma = Math.max(fit.sigma, 1e-6)
    last = { queue, stamp, gen, hitCap }
    if (!hitCap && round >= 3 && growth <= Math.max(3, 0.002 * prev)) break
    prev = region.length
  }

  if (!last) return null
  // A capped region stops mid-surface; its rim is the BFS front, not an
  // edge, so there is nothing to peel.
  const m = model
  const alignAt = (v: number): number => {
    const j = v * 3
    return spec.align(m, positions[j], positions[j + 1], positions[j + 2], normals[j], normals[j + 1], normals[j + 2])
  }
  const kept = last.hitCap ? last.queue : peelTransition(g, last.stamp, last.gen, last.queue, alignAt)
  return { region: Uint32Array.from(kept), model, sigma }
}

const SPHERE_SPEC: GrowSpec<Sphere> = {
  cosMax: COS_SPHERE_MAX,
  band: (s, sigma) => Math.max(3.5 * sigma, 0.004 * s.r),
  residual: (s, x, y, z) => {
    const d = Math.sqrt((x - s.cx) ** 2 + (y - s.cy) ** 2 + (z - s.cz) ** 2)
    return d < 1e-12 ? NaN : d - s.r
  },
  align: (s, x, y, z, nx, ny, nz) => {
    const dx = x - s.cx, dy = y - s.cy, dz = z - s.cz
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
    return Math.abs((dx * nx + dy * ny + dz * nz) / d)
  },
  refit: (positions, idx) => {
    const fit = fitSphereClipped(positions, idx, 3)
    return fit && { model: fit.sphere, sigma: fit.sigma }
  },
}

/** Grow the spherical surface around the seed. */
export function growSphereRegion(
  g: MeshGraph,
  seeds: ArrayLike<number>,
  init: Sphere,
  initSigma: number,
  initCount: number,
): GrowResult<Sphere> | null {
  return growRegion(g, seeds, init, initSigma, initCount, SPHERE_SPEC)
}

/** Grow the cylindrical surface around the seed. The region is free to run
 *  the full length of the cylinder — it is the radial band and the radial
 *  normal check that stop it at the end faces. */
export function growCylinderRegion(
  g: MeshGraph,
  seeds: ArrayLike<number>,
  init: Cylinder,
  initSigma: number,
  initCount: number,
): GrowResult<Cylinder> | null {
  return growRegion(g, seeds, init, initSigma, initCount, {
    cosMax: COS_CYLINDER_MAX,
    band: (c, sigma) => Math.max(3.5 * sigma, 0.004 * c.r),
    residual: (c, x, y, z) => cylinderResidual(c, x, y, z),
    align: (c, x, y, z, nx, ny, nz) => {
      const qx = x - c.px, qy = y - c.py, qz = z - c.pz
      const t = qx * c.ax + qy * c.ay + qz * c.az
      const wx = qx - t * c.ax, wy = qy - t * c.ay, wz = qz - t * c.az
      const rho = Math.sqrt(wx * wx + wy * wy + wz * wz)
      if (!(rho > 1e-12)) return 0
      return Math.abs((wx * nx + wy * ny + wz * nz) / rho)
    },
    refit: (positions, idx, c) => {
      const fit = fitCylinderClipped(positions, idx, c, 3)
      return fit && { model: fit.cylinder, sigma: fit.sigma }
    },
  })
}

/** Grow the conical surface around the seed. Same shape of spec as the
 *  cylinder's — the band floor hangs off the anchor radius, which sits at the
 *  clicked patch and so tracks the size of the surface actually under the
 *  region. */
export function growConeRegion(
  g: MeshGraph,
  seeds: ArrayLike<number>,
  init: Cone,
  initSigma: number,
  initCount: number,
): GrowResult<Cone> | null {
  return growRegion(g, seeds, init, initSigma, initCount, {
    cosMax: COS_CONE_MAX,
    band: (c, sigma) => Math.max(3.5 * sigma, 0.004 * c.r),
    residual: coneResidual,
    align: coneNormalAlign,
    refit: (positions, idx, c) => {
      const fit = fitConeClipped(positions, idx, c, 3)
      return fit && { model: fit.cone, sigma: fit.sigma }
    },
  })
}

/** Grow the flat surface around the seed. A plane has no size of its own, so
 *  the band floor is tied to the model's overall scale rather than a radius. */
export function growPlaneRegion(
  g: MeshGraph,
  seeds: ArrayLike<number>,
  init: Plane,
  initSigma: number,
  initCount: number,
): GrowResult<Plane> | null {
  const floor = 2e-4 * g.bboxDiag
  return growRegion(g, seeds, init, initSigma, initCount, {
    cosMax: COS_PLANE_MAX,
    band: (_p, sigma) => Math.max(3.5 * sigma, floor),
    residual: (p, x, y, z) => planeResidual(p, x, y, z),
    align: (p, _x, _y, _z, nx, ny, nz) => Math.abs(p.nx * nx + p.ny * ny + p.nz * nz),
    refit: (positions, idx) => {
      const fit = fitPlaneClipped(positions, idx, 3)
      return fit && { model: fit.plane, sigma: fit.sigma }
    },
  })
}
