// SPDX-License-Identifier: AGPL-3.0-only
import type { FitSettings, MeshGraph, Plane, PlaneFit, Vec3 } from '../types'
import { FitError } from './errors'
import { orthoBasis } from './linalg'
import { fitPlaneClipped, ransacPlane } from './plane'
import { collectPatch, growPlaneRegion } from './regionGrow'

/** In-plane rotations tried when boxing the patch in, over a quarter turn —
 *  past that the box repeats. */
const FRAME_STEPS = 45
const FRAME_SAMPLES = 4096

/** The tightest rectangle around the measured patch, in the plane itself, so
 *  the element is drawn as the piece of surface it was fitted to. The obvious
 *  choice — the patch's principal axes — is arbitrary for a square patch and
 *  then boxes it in diagonally, sticking well out past its real edges; the
 *  smallest-area frame is stable whatever the shape. */
function patchExtents(
  positions: Float32Array,
  region: Uint32Array,
  p: Plane,
): { center: Vec3; basisU: Vec3; basisV: Vec3; extentU: number; extentV: number } | null {
  const n = region.length
  let mx = 0, my = 0, mz = 0
  for (let i = 0; i < n; i++) {
    const j = region[i] * 3
    mx += positions[j]
    my += positions[j + 1]
    mz += positions[j + 2]
  }
  mx /= n
  my /= n
  mz /= n

  const [u0, v0] = orthoBasis([p.nx, p.ny, p.nz])
  const step = Math.max(1, Math.ceil(n / FRAME_SAMPLES))
  const sa: number[] = []
  const sb: number[] = []
  for (let i = 0; i < n; i += step) {
    const j = region[i] * 3
    const x = positions[j] - mx
    const y = positions[j + 1] - my
    const z = positions[j + 2] - mz
    sa.push(x * u0[0] + y * u0[1] + z * u0[2])
    sb.push(x * v0[0] + y * v0[1] + z * v0[2])
  }
  if (sa.length < 3) return null

  let bestArea = Infinity
  let bestAngle = 0
  for (let t = 0; t < FRAME_STEPS; t++) {
    const angle = (t / FRAME_STEPS) * (Math.PI / 2)
    const c = Math.cos(angle)
    const s = Math.sin(angle)
    let lo1 = Infinity, hi1 = -Infinity, lo2 = Infinity, hi2 = -Infinity
    for (let i = 0; i < sa.length; i++) {
      const q1 = sa[i] * c + sb[i] * s
      const q2 = -sa[i] * s + sb[i] * c
      if (q1 < lo1) lo1 = q1
      if (q1 > hi1) hi1 = q1
      if (q2 < lo2) lo2 = q2
      if (q2 > hi2) hi2 = q2
    }
    const area = (hi1 - lo1) * (hi2 - lo2)
    if (area < bestArea) {
      bestArea = area
      bestAngle = angle
    }
  }

  const ca = Math.cos(bestAngle)
  const sn = Math.sin(bestAngle)
  const basisU: Vec3 = [
    u0[0] * ca + v0[0] * sn,
    u0[1] * ca + v0[1] * sn,
    u0[2] * ca + v0[2] * sn,
  ]
  const basisV: Vec3 = [
    -u0[0] * sn + v0[0] * ca,
    -u0[1] * sn + v0[1] * ca,
    -u0[2] * sn + v0[2] * ca,
  ]

  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity
  for (let i = 0; i < n; i++) {
    const j = region[i] * 3
    const x = positions[j] - mx
    const y = positions[j + 1] - my
    const z = positions[j + 2] - mz
    const pu = x * basisU[0] + y * basisU[1] + z * basisU[2]
    const pv = x * basisV[0] + y * basisV[1] + z * basisV[2]
    if (pu < minU) minU = pu
    if (pu > maxU) maxU = pu
    if (pv < minV) minV = pv
    if (pv > maxV) maxV = pv
  }
  if (!Number.isFinite(minU) || !Number.isFinite(minV)) return null

  const cu = (minU + maxU) / 2
  const cv = (minV + maxV) / 2
  const cx = mx + cu * basisU[0] + cv * basisV[0]
  const cy = my + cu * basisU[1] + cv * basisV[1]
  const cz = mz + cu * basisU[2] + cv * basisV[2]
  // Pull the middle of the patch onto the fitted plane itself.
  const off = p.nx * cx + p.ny * cy + p.nz * cz - p.d
  return {
    center: [cx - off * p.nx, cy - off * p.ny, cz - off * p.nz],
    basisU,
    basisV,
    extentU: (maxU - minU) / 2,
    extentV: (maxV - minV) / 2,
  }
}

/** Orient the plane normal the way the surface faces, so the reported normal
 *  points out of the part rather than into it. */
function orientToSurface(p: Plane, normals: Float32Array, region: Uint32Array): Plane {
  let vote = 0
  for (let i = 0; i < region.length; i++) {
    const j = region[i] * 3
    vote += p.nx * normals[j] + p.ny * normals[j + 1] + p.nz * normals[j + 2]
  }
  if (vote >= 0) return p
  return { nx: -p.nx, ny: -p.ny, nz: -p.nz, d: -p.d }
}

/** Full auto-fit pipeline from a single user click:
 *  1. BFS a local patch around the seed,
 *  2. robust RANSAC/LMedS plane estimate on the patch,
 *  3. model-guided region growing across the whole flat surface,
 *  4. final Gaussian best-fit with the user's "used points" sigma preset.
 *  Retried with a larger patch when the local neighborhood is too small to
 *  separate the surface from its neighbours. */
export function fitPlaneFromSeed(
  g: MeshGraph,
  seeds: number[],
  settings: FitSettings,
): PlaneFit & { region: Uint32Array } {
  for (const patchSize of [1500, 6000, 24000]) {
    const patch = collectPatch(g, seeds, patchSize)
    if (patch.length < 30) break

    const cand = ransacPlane(g.positions, patch, { seed: (seeds[0] ?? 1) + patchSize })
    if (!cand) continue

    const grown = growPlaneRegion(g, seeds, cand.plane, cand.sigma, cand.inliers.length)
    if (!grown) continue
    if (grown.region.length < 60) continue

    const fin = fitPlaneClipped(g.positions, grown.region, settings.sigma)
    if (!fin) continue
    const plane = orientToSurface(fin.plane, g.normals, grown.region)
    const ext = patchExtents(g.positions, grown.region, plane)
    if (!ext) continue
    // A "plane" rougher than a tenth of its own size is a curved or broken
    // surface, not a flat one.
    if (!(fin.sigma < 0.1 * Math.max(ext.extentU, ext.extentV))) continue

    return {
      kind: 'plane',
      center: ext.center,
      normal: [plane.nx, plane.ny, plane.nz],
      basisU: ext.basisU,
      basisV: ext.basisV,
      extentU: ext.extentU,
      extentV: ext.extentV,
      sigma: fin.sigma,
      usedPoints: fin.used.length,
      regionSize: grown.region.length,
      region: grown.region,
    }
  }
  throw new FitError(
    "Couldn't fit a plane at this point — try clicking in the middle of a flat surface, away from edges.",
  )
}
