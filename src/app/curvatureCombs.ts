// SPDX-License-Identifier: AGPL-3.0-only
// What the curvature comb is drawn along, for the 2D sheet and the 3D view
// alike: the subject's own edges — a section's cut or an image's detected
// edges, smoothed; a shadow's outline, exact — and the arcs, circles and
// splines fitted on its sheet, exact. One reach for all of a sheet, taken
// from its edges, so a spline's teeth read against the scan's under it; the
// same runs and the same reach on the sheet and on the part.
//
// A section's edges are read once per cut and window and kept with the cut,
// which both views ask for: the 3D view on every edit of the sheet, the
// sheet on every redraw. An image's edges are kept the same way, with their
// scale.

import {
  chainCurvature,
  combReach,
  fitCurvature,
  runsDiagonal,
  type CombReach,
  type CurvatureReading,
  type CurvatureRun,
} from '../core/flat/curvature'
import type { EdgeChains } from '../core/flat/edges'
import type { PixelsPerMm } from '../core/flat/image'
import type { FlatFit } from '../core/flat/types'
import type { SectionFrame } from '../core/section/frame'
import { shadowFlatFits } from '../core/section/shadow'
import { projectCut, projectCutNormals, type SectionCut } from '../core/section/slice'
import { fmtLen, type DisplayUnits } from '../core/units'

/** The comb along a sheet's edges: a warm pink, apart from the edges' teal
 *  and from every element colour, so the line through the tips is never
 *  mistaken for the edge it stands on. */
export const EDGE_COMB_COLOR = '#f0568c'

export interface SheetComb {
  /** The subject's edges. */
  source: CurvatureRun[]
  /** The fitted curves on its sheet. */
  elements: CurvatureRun[]
  reach: CombReach
}

/** The sample step of an exact run, mm: as fine as a chain's at the window. */
const exactStep = (window: number) => Math.max(0.02, window / 8)

const frameKey = (f: SectionFrame) => [...f.origin, ...f.basisU, ...f.basisV].join(',')

const sectionRuns = new WeakMap<SectionCut, { key: string; runs: CurvatureRun[] }>()

/** A section's edges as comb runs, on its sheet: a cut read smoothed over
 *  `window`, with the side its material is on; a shadow's pieces exact. */
export function sectionSourceRuns(cut: SectionCut, frame: SectionFrame, window: number): CurvatureRun[] {
  const key = `${frameKey(frame)}|${window}`
  const held = sectionRuns.get(cut)
  if (held?.key === key) return held.runs
  const runs = cut.shadow
    ? fitCurvature(shadowFlatFits(cut.shadow), exactStep(window))
    : chainCurvature(projectCut(cut, frame), { window, normals: projectCutNormals(cut, frame) })
  sectionRuns.set(cut, { key, runs })
  return runs
}

const imageRuns = new WeakMap<EdgeChains, { key: string; runs: CurvatureRun[] }>()

/** An image's detected edges as comb runs, in the sheet's millimetres. */
export function imageSourceRuns(chains: EdgeChains, mmPerPx: PixelsPerMm, window: number): CurvatureRun[] {
  const key = `${mmPerPx.x},${mmPerPx.y}|${window}`
  const held = imageRuns.get(chains)
  if (held?.key === key) return held.runs
  const runs = chainCurvature(chains, { window, scale: mmPerPx })
  imageRuns.set(chains, { key, runs })
  return runs
}

/** The whole comb of a sheet: its edges' runs as given, its fitted curves',
 *  and the reach both are drawn at — taken from the edges, or from the
 *  curves on a sheet with none. */
export function sheetComb(source: CurvatureRun[], fits: readonly FlatFit[], window: number, scale: number): SheetComb {
  const elements = fitCurvature(fits, exactStep(window))
  const basis = source.length > 0 ? source : elements
  return { source, elements, reach: combReach(basis, runsDiagonal(basis), scale) }
}

/** A reading as the label under the cursor writes it: "R 4.82 mm, convex"
 *  — or "straight". */
export function formatCurvature(r: CurvatureReading, units: DisplayUnits): string {
  if (r.radius === null) return 'straight'
  const side = r.convex > 0 ? ', convex' : r.convex < 0 ? ', concave' : ''
  return `R ${fmtLen(r.radius, units, 2)}${side}${r.exact ? '' : ' (smoothed)'}`
}
