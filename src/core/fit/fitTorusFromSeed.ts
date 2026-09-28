// SPDX-License-Identifier: AGPL-3.0-only
import type { FitSettings, MeshGraph, Torus, TorusFitOutput } from '../types'
import { FitError } from './errors'
import { collectPatch, growTorusRegion } from './regionGrow'
import { requireSelection } from './selection'
import { canonicalTorus, fitTorusClipped, ransacTorus, torusCoverage, torusNormalAlign, torusResidual } from './torus'

export { FitError }

/** The fit as an element: the axis pointing with the region's normals, the
 *  coverage read off the used points. */
function output(g: MeshGraph, t: Torus, fin: { sigma: number; span: number; min: number; max: number; used: Uint32Array }, region: Uint32Array): TorusFitOutput {
  const torus = canonicalTorus(t, g.normals, fin.used)
  const cover = torusCoverage(torus, g.positions, fin.used)
  return {
    kind: 'torus',
    center: [torus.cx, torus.cy, torus.cz],
    axis: [torus.ax, torus.ay, torus.az],
    majorRadius: torus.R,
    minorRadius: torus.r,
    tubeCoverage: cover.tubeDeg,
    spineCoverage: cover.spineDeg,
    sigma: fin.sigma,
    usedPoints: fin.used.length,
    regionSize: region.length,
    formError: fin.span,
    residualMin: fin.min,
    residualMax: fin.max,
    region,
  }
}

/** A torus whose tube is wider than its spine is a spindle, whose two
 *  sheets cross; a scan of a round never is one. */
function plausible(t: Torus, g: MeshGraph): boolean {
  return Number.isFinite(t.R) && Number.isFinite(t.r) && t.r > 0 && t.R > t.r * 0.999 && t.R < 0.8 * g.bboxDiag && t.r < 0.5 * g.bboxDiag
}

/** Whether the clicked vertices lie on the torus and face with it. */
function onIt(g: MeshGraph, seeds: number[], t: Torus, sigma: number): boolean {
  const band = Math.max(3 * sigma, 0.02 * t.r)
  for (const v of seeds) {
    const j = v * 3
    const x = g.positions[j], y = g.positions[j + 1], z = g.positions[j + 2]
    if (Math.abs(torusResidual(t, x, y, z)) > band) return false
    if (torusNormalAlign(t, x, y, z, g.normals[j], g.normals[j + 1], g.normals[j + 2]) < SEED_COS_MAX) return false
  }
  return true
}

/** The seed's normal may lean this far from the tube's — a scan's normals
 *  scatter, and the grow allows the same. */
const SEED_COS_MAX = Math.cos((32 * Math.PI) / 180)

/** Full auto-fit pipeline from a single click on a round: a local patch,
 *  the robust torus estimate on it, model-guided growing across the whole
 *  round, the clipped best fit. The patch grows when the local
 *  neighbourhood is too small or too flat to place the spine. */
export function fitTorusFromSeed(g: MeshGraph, seeds: number[], settings: FitSettings): TorusFitOutput {
  for (const patchSize of [1500, 6000, 24000]) {
    const patch = collectPatch(g, seeds, patchSize)
    if (patch.length < 30) break
    const cand = ransacTorus(g.positions, g.normals, patch, { seed: (seeds[0] ?? 1) + patchSize })
    if (!cand || !plausible(cand.torus, g)) continue
    const grown = growTorusRegion(g, seeds, cand.torus, cand.sigma, cand.inliers.length)
    if (!grown || grown.region.length < 60) continue
    const fin = fitTorusClipped(g.positions, grown.region, settings.sigma, grown.model)
    if (!fin || !plausible(fin.torus, g)) continue
    // Noisier than a few percent of the tube radius it is not the round
    // the click was on — a flat, a cylinder, a corner.
    if (fin.sigma > 0.05 * fin.torus.r) continue
    // And the click itself has to lie on it, facing the way the tube faces
    // there: a click on the flat beside a round finds the round in its
    // patch and a torus that leans on the flat's first rows, which the
    // residual alone lets through — the flat's own normal does not.
    if (!onIt(g, seeds, fin.torus, fin.sigma)) continue
    return output(g, fin.torus, fin, grown.region)
  }
  throw new FitError("Couldn't fit a torus at this point — try clicking on the middle of a round or a bend.")
}

/** Best-fit torus on a hand-painted selection: the marked points as given,
 *  the robust estimate on them for a start, then the clipped fit. */
export function fitTorusOnSelection(g: MeshGraph, selection: Uint32Array, settings: FitSettings): TorusFitOutput {
  requireSelection(selection, 'round')
  const cand = ransacTorus(g.positions, g.normals, selection, { seed: selection[0] ?? 1 })
  const fin = cand ? fitTorusClipped(g.positions, selection, settings.sigma, cand.torus) : null
  if (!fin || !plausible(fin.torus, g)) {
    throw new FitError("Couldn't fit a torus to the marked surface — it has to curve two ways, like a fillet's round or a bend. Mark more of it.")
  }
  return output(g, fin.torus, fin, selection)
}
