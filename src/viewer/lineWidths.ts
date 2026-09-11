// SPDX-License-Identifier: AGPL-3.0-only
// How heavy the fat lines are drawn, in screen pixels — the one place the
// defaults live, so the settings dialog, the preference store and the two
// scenes that draw them agree on what "as shipped" means.
//
// Two figures rather than one, because the lines sit on different things: a
// section's cut lies on a shaded surface and has to read over the shading, a
// fitted edge lies on a flatbed scan and has to be found over the photograph.
// Each scene scales every line it draws by the same factor, so the callouts
// and pin marks drawn beside the curves keep their proportion to them.

/** A section's cut on the part in 3D — the width the preview and the sheet's
 *  curves stand off from. */
export const SECTION_LINE_DEFAULT = 2.5

/** A fitted curve over a flatbed scan in 2D Measure. */
export const SHEET_LINE_DEFAULT = 4

/** The edge chains a 2D curve is fitted to — found in the scan, or cut by a
 *  section. A hair by default: they are the raw material, drawn under
 *  everything measured from them. */
export const EDGE_LINE_DEFAULT = 1

/** The range either slider runs over. Below one pixel a fat line is a
 *  flicker; above six it is a band hiding what it was drawn on. */
export const LINE_MIN = 1
export const LINE_MAX = 6
export const LINE_STEP = 0.5

/** Clamp a stored or typed width to the range, falling back to the default
 *  for anything that is not a number. */
export function clampLineWidth(value: unknown, fallback: number): number {
  // Nothing stored is the common case, and Number(null) is a perfectly
  // finite zero — which the clamp would turn into the thinnest line there is.
  if (value === null || value === undefined || value === '') return fallback
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(LINE_MAX, Math.max(LINE_MIN, Math.round(n / LINE_STEP) * LINE_STEP))
}
