// SPDX-License-Identifier: AGPL-3.0-only
import type { FitSettings, MeshGraph, SphereFitOutput } from '../types'
import { FitError } from './errors'
import { collectPatch, growSphereRegion } from './regionGrow'
import { ransacSphere } from './ransac'
import { requireSelection } from './selection'
import { fitSphereClipped } from './sphere'

export { FitError }

/** Full auto-fit pipeline from a single user click:
 *  1. BFS a local patch around the seed,
 *  2. robust RANSAC/LMedS sphere estimate on the patch,
 *  3. model-guided region growing across the whole sphere surface,
 *  4. final Gaussian best-fit with the user's "used points" sigma preset.
 *  Retried with a larger patch when the local neighborhood is too small or
 *  too flat to pin the sphere down. */
export function fitSphereFromSeed(
  g: MeshGraph,
  seeds: number[],
  settings: FitSettings,
): SphereFitOutput {
  for (const patchSize of [1500, 6000, 24000]) {
    const patch = collectPatch(g, seeds, patchSize)
    if (patch.length < 30) break

    const cand = ransacSphere(g.positions, patch, { seed: (seeds[0] ?? 1) + patchSize })
    if (!cand) continue

    const grown = growSphereRegion(g, seeds, cand.sphere, cand.sigma, cand.inliers.length)
    if (!grown) continue
    if (grown.region.length < 60) continue

    const fin = fitSphereClipped(g.positions, grown.region, settings.sigma)
    if (!fin) continue
    const { sphere } = fin
    if (!Number.isFinite(sphere.r) || sphere.r <= 0) continue
    // A "sphere" larger than the model or noisier than 3% of its radius is a
    // misfit (flat area, rod, junk region) — try a larger patch or fail.
    if (sphere.r > 0.8 * g.bboxDiag) continue
    if (fin.sigma > 0.03 * sphere.r) continue

    return {
      kind: 'sphere',
      center: [sphere.cx, sphere.cy, sphere.cz],
      radius: sphere.r,
      sigma: fin.sigma,
      usedPoints: fin.used.length,
      regionSize: grown.region.length,
      region: grown.region,
    }
  }
  throw new FitError("Couldn't fit a sphere at this point — try clicking nearer the middle of a sphere.")
}

/** Best-fit sphere on a hand-painted selection — the marked points as given,
 *  with the user's outlier cut-off and nothing else in the way. */
export function fitSphereOnSelection(
  g: MeshGraph,
  selection: Uint32Array,
  settings: FitSettings,
): SphereFitOutput {
  requireSelection(selection, 'sphere')
  const fin = fitSphereClipped(g.positions, selection, settings.sigma)
  if (!fin || !Number.isFinite(fin.sphere.r) || fin.sphere.r <= 0) {
    throw new FitError(
      "Couldn't fit a sphere to the marked surface — it curves too little to place a centre. Mark more of the ball.",
    )
  }
  const { sphere } = fin
  return {
    kind: 'sphere',
    center: [sphere.cx, sphere.cy, sphere.cz],
    radius: sphere.r,
    sigma: fin.sigma,
    usedPoints: fin.used.length,
    regionSize: selection.length,
    region: selection,
  }
}
