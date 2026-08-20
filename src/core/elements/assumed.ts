// SPDX-License-Identifier: AGPL-3.0-only
// The diameter a measured feature is assumed to have been designed at: a hole
// that measures Ø 5.98 mm was almost certainly drawn at Ø 6.
//
// Like an extension, an assumed dimension is never folded into the fit — the
// fit stays the measurement, with its sigma and its form error, and the
// assumed value is carried beside it. It is applied in exactly one place: the
// STEP export, and only when the export is asked for assumed dimensions, so
// CAD can receive the part as designed while every readout in the tool keeps
// reporting what was actually measured.
//
// The sphere, the cylinder and the circle are the kinds that carry one — the
// three whose defining size is a diameter. A plane's patch size is where it
// was measured (and is the extension's business), and a point has no size.

import type { CircleFit, CylinderFit, FitData, SphereFit } from '../types'

/** Which diameters the STEP export writes: the fitted ones, or the assumed
 *  design values entered beside them. */
export type StepDimensions = 'measured' | 'assumed'

/** The kinds whose defining size is a diameter — the ones an assumed
 *  dimension exists for. */
export type SizedFit = SphereFit | CylinderFit | CircleFit

export function hasDiameter(fit: FitData | undefined): fit is SizedFit {
  return (
    fit !== undefined && (fit.kind === 'sphere' || fit.kind === 'cylinder' || fit.kind === 'circle')
  )
}

export function measuredDiameter(fit: SizedFit): number {
  return 2 * fit.radius
}

/** The steps a designed dimension tends to sit on, coarsest first — the 1-2-5
 *  series across the millimetre decades. */
const DESIGN_STEPS = [100, 50, 20, 10, 5, 2, 1, 0.5, 0.2, 0.1, 0.05, 0.02, 0.01]

/** How far a suggested value may sit from the measurement and still be
 *  credible as the designed one: scan noise plus a little manufacturing error.
 *  Absolute for small features, proportional once the part is large enough
 *  for shrinkage to matter. */
function snapTolerance(measured: number): number {
  return Math.max(0.15, 0.002 * measured)
}

/** The design value a measurement most plausibly came from: the coarsest
 *  round number within tolerance of it — 5.98 suggests 6, 12.43 suggests
 *  12.5, and a measurement near nothing round is simply itself. This is what
 *  the assumed-dimension field is prefilled with. */
export function suggestedAssumed(measured: number): number {
  const tol = snapTolerance(measured)
  for (const step of DESIGN_STEPS) {
    const snapped = roundMm(Math.round(measured / step) * step)
    if (snapped > 0 && Math.abs(snapped - measured) <= tol) return snapped
  }
  return roundMm(measured)
}

/** Beyond this an entered value is more likely a slip of the keyboard than a
 *  design decision: half a millimetre, or 5% once features are large. */
function typoLimit(measured: number): number {
  return Math.max(0.5, 0.05 * measured)
}

/** The sanity check on a typed-in assumed dimension: null when the value is
 *  believable, otherwise one sentence saying how far off it is. */
export function assumedWarning(measured: number, assumed: number): string | null {
  if (!Number.isFinite(assumed) || assumed <= 0) return null
  const off = Math.abs(assumed - measured)
  if (off <= typoLimit(measured)) return null
  return `Assumed Ø ${fmt(assumed)} mm is ${fmt(off)} mm away from the measured Ø ${fmt(
    measured,
  )} mm — check for a typo.`
}

/** The geometry an assumed-dimension export writes: the same center, axis and
 *  normal the fit measured, with the designed diameter in place of the
 *  measured one. Anything without an assumed value passes through untouched. */
export function applyAssumed(fit: FitData, assumed: number | undefined): FitData {
  if (assumed === undefined || !hasDiameter(fit)) return fit
  if (!Number.isFinite(assumed) || assumed <= 0) return fit
  const radius = assumed / 2
  return radius === fit.radius ? fit : { ...fit, radius }
}

/** Three decimals is a micrometre — and keeps step multiples free of
 *  floating-point dust (0.2 × 39 is not quite 7.8). */
function roundMm(v: number): number {
  return Math.round(v * 1000) / 1000
}

function fmt(v: number): string {
  return v.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
}
