// SPDX-License-Identifier: AGPL-3.0-only
import type { Cone, ConeFit, FitBase, FitSettings, MeshGraph } from '../types'
import { coneAxisFromNormals, fitConeClipped, fitConeOnAxis, ransacCone } from './cone'
import { FitError } from './errors'
import { axialExtents } from './extents'
import { collectPatch, growConeRegion } from './regionGrow'
import { requireSelection } from './selection'

/** The fitted extent turned into the reported geometry: the axis point moves
 *  to the middle of the surface, and the radii at the middle and both ends are
 *  read off the taper. Null when the extent is degenerate or the surface sits
 *  on the wrong side of the apex. */
function coneReport(
  positions: Float32Array,
  region: Uint32Array,
  c: Cone,
): Omit<ConeFit, keyof FitBase | 'kind'> | null {
  const { coverage, minT, maxT } = axialExtents(positions, region, c)
  const length = maxT - minT
  if (!(length > 0)) return null
  const tan = Math.tan(c.phi)
  const mid = (minT + maxT) / 2
  const radius = c.r + mid * tan
  if (!(radius > 0) || !Number.isFinite(radius)) return null
  return {
    center: [c.px + mid * c.ax, c.py + mid * c.ay, c.pz + mid * c.az],
    axis: [c.ax, c.ay, c.az],
    halfAngle: (c.phi * 180) / Math.PI,
    radius,
    // The small end can graze the apex; a hair of numerical overshoot past it
    // is not a negative radius.
    radius1: Math.max(0, c.r + minT * tan),
    radius2: c.r + maxT * tan,
    length,
    coverage,
  }
}

/** Full auto-fit pipeline from a single user click — the cylinder's pipeline
 *  with the cone estimators plugged in:
 *  1. BFS a local patch around the seed,
 *  2. robust LMedS cone estimate on the patch (normal-plane axis plus
 *     three-point-with-normals candidates),
 *  3. model-guided region growing across the whole conical surface,
 *  4. final Gaussian best-fit with the user's "used points" sigma preset.
 *  Retried with a larger patch when the local neighborhood is too small or too
 *  flat to pin the axis down. */
export function fitConeFromSeed(
  g: MeshGraph,
  seeds: number[],
  settings: FitSettings,
): ConeFit & { region: Uint32Array } {
  for (const patchSize of [1500, 6000, 24000]) {
    const patch = collectPatch(g, seeds, patchSize)
    if (patch.length < 30) break

    const cand = ransacCone(g.positions, g.normals, patch, {
      seed: (seeds[0] ?? 1) + patchSize,
    })
    if (!cand) continue

    const grown = growConeRegion(g, seeds, cand.cone, cand.sigma, cand.inliers.length)
    if (!grown) continue
    if (grown.region.length < 60) continue

    const fin = fitConeClipped(g.positions, grown.region, grown.model, settings.sigma)
    if (!fin) continue
    const c = fin.cone
    if (!Number.isFinite(c.r) || c.r <= 0) continue
    // Steeper than ~83° is a face, not a taper — the plane tool's territory.
    if (!(Math.abs(c.phi) < 1.45)) continue

    const report = coneReport(g.positions, grown.region, c)
    if (!report) continue
    // Out of scale with the model, or noisier than 3% of the mid radius: this
    // was a flat patch or a junk region, not a cone.
    if (report.radius2 > 0.8 * g.bboxDiag) continue
    if (fin.sigma > 0.03 * report.radius) continue
    // Under ~30° of arc the circle through the points is barely curved, so
    // the radius and the axis position are guesses.
    if (!(report.coverage >= 29)) continue

    return {
      kind: 'cone',
      ...report,
      sigma: fin.sigma,
      usedPoints: fin.used.length,
      regionSize: grown.region.length,
      formError: fin.span,
      region: grown.region,
    }
  }
  throw new FitError(
    "Couldn't fit a cone at this point — try clicking in the middle of the tapered surface, away from its edges.",
  )
}

/** Best-fit cone on a hand-painted selection. The axis still has to be
 *  guessed before the six-parameter fit can be refined: the normal-plane axis
 *  is the cheap and accurate answer for a clean selection, and a robust LMedS
 *  estimate takes over when the marked surface is noisy enough that the
 *  normals alone cannot pin the direction down. */
export function fitConeOnSelection(
  g: MeshGraph,
  selection: Uint32Array,
  settings: FitSettings,
): ConeFit & { region: Uint32Array } {
  requireSelection(selection, 'conical surface')

  const axis = coneAxisFromNormals(g.normals, selection)
  let init: Cone | null = axis ? fitConeOnAxis(g.positions, selection, axis) : null
  if (!init) init = ransacCone(g.positions, g.normals, selection, { seed: 0x5eed })?.cone ?? null
  if (!init) {
    throw new FitError(
      "Couldn't find an axis in the marked surface — it curves too little to be told from a plane. Mark more of the way around the cone.",
    )
  }

  const fin = fitConeClipped(g.positions, selection, init, settings.sigma)
  if (!fin || !Number.isFinite(fin.cone.r) || fin.cone.r <= 0 || !(Math.abs(fin.cone.phi) < 1.45)) {
    throw new FitError("Couldn't fit a cone to the marked surface.")
  }
  const report = coneReport(g.positions, selection, fin.cone)
  if (!report) throw new FitError("Couldn't measure the extent of the marked surface.")
  return {
    kind: 'cone',
    ...report,
    sigma: fin.sigma,
    usedPoints: fin.used.length,
    regionSize: selection.length,
    formError: fin.span,
    region: selection,
  }
}
