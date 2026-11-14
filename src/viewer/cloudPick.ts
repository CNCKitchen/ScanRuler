// SPDX-License-Identifier: AGPL-3.0-only
// Picking on a point cloud: the point nearest the eye within a radius of the
// ray (PointGrid.nearestToRay), on the kept side of every clip plane. The
// hit reads like a mesh's — three corners that are all the one vertex, all
// the weight on the first, and faceIndex -1 for there is no triangle.
// Everything is in the frame the grid and the ray are given in.

import type * as THREE from 'three'
import type { PointGrid } from '../core/geometry/pointGrid'
import type { PickHit } from './SceneManager'

/** How far behind a plane a point may lie and still count as on it. */
const ON_PLANE = 1e-6
/** Clipped candidates stepped over before giving up. */
const MAX_RETRIES = 64

export function pickCloud(
  grid: PointGrid,
  normals: Float32Array,
  ray: THREE.Ray,
  radius: number,
  clip: readonly THREE.Plane[],
): PickHit | null {
  const { origin: o, direction: d } = ray
  const len = d.length()
  if (!(len > 0)) return null
  const ux = d.x / len, uy = d.y / len, uz = d.z / len
  const positions = grid.positions
  const keptAt = (x: number, y: number, z: number) =>
    clip.every((p) => p.normal.x * x + p.normal.y * y + p.normal.z * z + p.constant >= -ON_PLANE)
  const near: number[] = []
  let start = 0 // distance along the ray already ruled out
  for (let tries = 0; tries <= MAX_RETRIES; tries++) {
    // The front of what the ray passes close to ...
    const front = grid.nearestToRay(o.x + ux * start, o.y + uy * start, o.z + uz * start, ux, uy, uz, radius, Infinity)
    if (front < 0) return null
    const fx = positions[3 * front], fy = positions[3 * front + 1], fz = positions[3 * front + 2]
    const tFront = (fx - o.x) * ux + (fy - o.y) * uy + (fz - o.z) * uz
    if (!keptAt(fx, fy, fz)) {
      // Cut away: step past it along the ray and look again.
      start = Math.max(start, tFront) + radius * 1e-6 + 1e-12
      continue
    }
    // ... and of the points around it at that depth, the one the ray passes
    // closest to — on a plane facing the eye every point is at the same
    // depth, and the first found would be anywhere in the radius.
    grid.withinRadius(fx, fy, fz, radius, near)
    let best = front, bestD2 = Infinity
    for (const j of near) {
      const x = positions[3 * j], y = positions[3 * j + 1], z = positions[3 * j + 2]
      const wx = x - o.x, wy = y - o.y, wz = z - o.z
      const t = wx * ux + wy * uy + wz * uz
      if (t < start || t > tFront + radius) continue
      const d2 = wx * wx + wy * wy + wz * wz - t * t
      if (d2 > radius * radius || d2 >= bestD2 || !keptAt(x, y, z)) continue
      best = j
      bestD2 = d2
    }
    const i = best
    let nx = normals[3 * i], ny = normals[3 * i + 1], nz = normals[3 * i + 2]
    const nl = Math.hypot(nx, ny, nz)
    if (nl > 0) { nx /= nl; ny /= nl; nz /= nl } else { nx = 0; ny = 0; nz = 1 }
    return {
      vertices: [i, i, i],
      weights: [1, 0, 0],
      faceIndex: -1,
      point: [positions[3 * i], positions[3 * i + 1], positions[3 * i + 2]],
      normal: [nx, ny, nz],
      clientX: 0,
      clientY: 0,
      ctrlKey: false,
    }
  }
  return null
}
