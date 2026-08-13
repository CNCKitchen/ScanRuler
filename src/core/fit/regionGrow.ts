import type { MeshGraph, Sphere } from '../types'
import { acquireStamps } from '../geometry/scratch'
import { fitSphereClipped } from './sphere'

/** Vertices whose sphere fit uses a strided subsample beyond this size;
 *  the region itself is still complete, only the per-round solve is capped. */
const FIT_SUBSAMPLE = 60_000

const COS_NORMAL_MAX = Math.cos((38 * Math.PI) / 180)

export interface GrowResult {
  region: Uint32Array
  sphere: Sphere
  sigma: number
}

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

/** Grow the sphere's surface region from the seed while the sphere model is
 *  refit every round. Membership needs BOTH a radial distance inside the
 *  current noise band AND a surface normal aligned with the radial direction —
 *  the normal test is what stops the region from leaking onto the connecting
 *  rod or stand at the sphere's neck. The BFS restarts from the seed each
 *  round with the improved model, capped at 3× the previous region size so a
 *  bad early model cannot flood the whole mesh before the fit corrects it. */
export function growSphereRegion(
  g: MeshGraph,
  seeds: ArrayLike<number>,
  init: Sphere,
  initSigma: number,
  initCount: number,
): GrowResult | null {
  const { positions, normals } = g
  let s = init
  let sigma = Math.max(initSigma, 1e-6)
  let prev = Math.max(initCount, 50)
  let lastRegion: Uint32Array | null = null

  for (let round = 0; round < 30; round++) {
    const band = Math.max(3.5 * sigma, 0.004 * s.r)
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
        const dx = positions[j] - s.cx
        const dy = positions[j + 1] - s.cy
        const dz = positions[j + 2] - s.cz
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
        if (Math.abs(d - s.r) > band || d < 1e-12) continue
        const dot = (dx * normals[j] + dy * normals[j + 1] + dz * normals[j + 2]) / d
        if (Math.abs(dot) < COS_NORMAL_MAX) continue
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
    const fit = fitSphereClipped(positions, fitIdx, 3)
    if (!fit) return null

    const growth = Math.abs(region.length - prev)
    s = fit.sphere
    sigma = Math.max(fit.sigma, 1e-6)
    lastRegion = region
    if (!hitCap && round >= 3 && growth <= Math.max(3, 0.002 * prev)) break
    prev = region.length
  }

  if (!lastRegion) return null
  return { region: lastRegion, sphere: s, sigma }
}
