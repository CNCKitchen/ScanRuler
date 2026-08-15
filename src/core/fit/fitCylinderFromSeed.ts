// SPDX-License-Identifier: AGPL-3.0-only
import type { CylinderFit, FitSettings, MeshGraph, Vec3 } from '../types'
import { fitCylinderClipped, ransacCylinder } from './cylinder'
import { FitError } from './errors'
import { orthoBasis } from './linalg'
import { collectPatch, growCylinderRegion } from './regionGrow'

/** Angles beyond which the coverage estimate stops sampling — plenty to
 *  resolve the widest gap in any real scan. */
const COVERAGE_SAMPLES = 20_000

/** How much of the way around the axis the fitted patch reaches, in degrees,
 *  plus the axial extent of the patch. A scan only ever sees part of a
 *  cylinder; both numbers say how much of one this fit actually rests on.
 *  Coverage is 360° minus the widest empty gap, which — unlike counting
 *  occupied bins — does not shrink just because the mesh is coarse. */
function extents(
  positions: Float32Array,
  region: Uint32Array,
  c: { px: number; py: number; pz: number; ax: number; ay: number; az: number },
): { coverage: number; minT: number; maxT: number } {
  const [u, v] = orthoBasis([c.ax, c.ay, c.az])
  let minT = Infinity
  let maxT = -Infinity

  const step = Math.max(1, Math.ceil(region.length / COVERAGE_SAMPLES))
  const angles: number[] = []
  for (let i = 0; i < region.length; i++) {
    const j = region[i] * 3
    const qx = positions[j] - c.px
    const qy = positions[j + 1] - c.py
    const qz = positions[j + 2] - c.pz
    const t = qx * c.ax + qy * c.ay + qz * c.az
    if (t < minT) minT = t
    if (t > maxT) maxT = t
    if (i % step === 0) {
      const wu = qx * u[0] + qy * u[1] + qz * u[2]
      const wv = qx * v[0] + qy * v[1] + qz * v[2]
      angles.push(Math.atan2(wv, wu))
    }
  }
  if (angles.length < 2) return { coverage: 0, minT, maxT }

  angles.sort((a, b) => a - b)
  let widest = angles[0] + 2 * Math.PI - angles[angles.length - 1]
  for (let i = 1; i < angles.length; i++) {
    const gap = angles[i] - angles[i - 1]
    if (gap > widest) widest = gap
  }
  const coverage = Math.max(0, 360 - (widest * 180) / Math.PI)
  return { coverage, minT, maxT }
}

/** Full auto-fit pipeline from a single user click:
 *  1. BFS a local patch around the seed,
 *  2. robust LMedS cylinder estimate on the patch (normal-covariance axis plus
 *     two-point-with-normals candidates),
 *  3. model-guided region growing across the whole cylindrical surface,
 *  4. final Gaussian best-fit with the user's "used points" sigma preset.
 *  Retried with a larger patch when the local neighborhood is too small or too
 *  flat to pin the axis down. */
export function fitCylinderFromSeed(
  g: MeshGraph,
  seeds: number[],
  settings: FitSettings,
): CylinderFit & { region: Uint32Array } {
  for (const patchSize of [1500, 6000, 24000]) {
    const patch = collectPatch(g, seeds, patchSize)
    if (patch.length < 30) break

    const cand = ransacCylinder(g.positions, g.normals, patch, {
      seed: (seeds[0] ?? 1) + patchSize,
    })
    if (!cand) continue

    const grown = growCylinderRegion(g, seeds, cand.cylinder, cand.sigma, cand.inliers.length)
    if (!grown) continue
    if (grown.region.length < 60) continue

    const fin = fitCylinderClipped(g.positions, grown.region, grown.model, settings.sigma)
    if (!fin) continue
    const c = fin.cylinder
    if (!Number.isFinite(c.r) || c.r <= 0) continue
    // Out of scale with the model, or noisier than 3% of the radius: this was
    // a flat patch or a junk region, not a cylinder.
    if (c.r > 0.8 * g.bboxDiag) continue
    if (fin.sigma > 0.03 * c.r) continue

    const { coverage, minT, maxT } = extents(g.positions, grown.region, c)
    const length = maxT - minT
    // Under ~30° of arc the circle through the points is barely curved, so
    // the radius and the axis position are guesses.
    if (!(coverage >= 29) || !(length > 0)) continue

    const axis: Vec3 = [c.ax, c.ay, c.az]
    const mid = (minT + maxT) / 2
    return {
      kind: 'cylinder',
      center: [c.px + mid * c.ax, c.py + mid * c.ay, c.pz + mid * c.az],
      axis,
      radius: c.r,
      length,
      coverage,
      sigma: fin.sigma,
      usedPoints: fin.used.length,
      regionSize: grown.region.length,
      region: grown.region,
    }
  }
  throw new FitError(
    "Couldn't fit a cylinder at this point — try clicking on a clearly curved part of the cylindrical surface.",
  )
}
