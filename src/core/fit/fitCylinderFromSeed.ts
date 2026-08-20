// SPDX-License-Identifier: AGPL-3.0-only
import type { Cylinder, CylinderFit, FitSettings, MeshGraph, Vec3 } from '../types'
import { axisFromNormals, fitCylinderClipped, fitCylinderOnAxis, ransacCylinder } from './cylinder'
import { FitError } from './errors'
import { axialExtents } from './extents'
import { collectPatch, growCylinderRegion } from './regionGrow'
import { requireSelection } from './selection'

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

    const { coverage, minT, maxT } = axialExtents(g.positions, grown.region, c)
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
      formError: fin.span,
      region: grown.region,
    }
  }
  throw new FitError(
    "Couldn't fit a cylinder at this point — try clicking on a clearly curved part of the cylindrical surface.",
  )
}

/** Best-fit cylinder on a hand-painted selection. The axis still has to be
 *  guessed before the five-parameter fit can be refined: the normal-covariance
 *  axis is the cheap and accurate answer for a clean selection, and a robust
 *  LMedS estimate takes over when the marked surface is noisy enough that the
 *  normals alone cannot pin the direction down. */
export function fitCylinderOnSelection(
  g: MeshGraph,
  selection: Uint32Array,
  settings: FitSettings,
): CylinderFit & { region: Uint32Array } {
  requireSelection(selection, 'cylindrical surface')

  const axis = axisFromNormals(g.normals, selection)
  let init: Cylinder | null = axis ? fitCylinderOnAxis(g.positions, selection, axis) : null
  if (!init) init = ransacCylinder(g.positions, g.normals, selection, { seed: 0x5eed })?.cylinder ?? null
  if (!init) {
    throw new FitError(
      "Couldn't find an axis in the marked surface — it curves too little to be told from a plane. Mark more of the way around the cylinder.",
    )
  }

  const fin = fitCylinderClipped(g.positions, selection, init, settings.sigma)
  if (!fin || !Number.isFinite(fin.cylinder.r) || fin.cylinder.r <= 0) {
    throw new FitError("Couldn't fit a cylinder to the marked surface.")
  }
  const c = fin.cylinder
  const { coverage, minT, maxT } = axialExtents(g.positions, selection, c)
  const length = maxT - minT
  if (!(length > 0)) throw new FitError("Couldn't measure the length of the marked surface.")
  const mid = (minT + maxT) / 2
  return {
    kind: 'cylinder',
    center: [c.px + mid * c.ax, c.py + mid * c.ay, c.pz + mid * c.az],
    axis: [c.ax, c.ay, c.az],
    radius: c.r,
    length,
    coverage,
    sigma: fin.sigma,
    usedPoints: fin.used.length,
    regionSize: selection.length,
    formError: fin.span,
    region: selection,
  }
}
