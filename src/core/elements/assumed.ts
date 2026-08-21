// SPDX-License-Identifier: AGPL-3.0-only
// The diameter a measured feature is assumed to have been designed at: a hole
// that measures Ø 5.98 mm was almost certainly drawn at Ø 6.
//
// Like an extension, an assumed dimension is never folded into the fit — the
// fit stays the measurement, with its sigma and its form error, and the
// assumed value is carried beside it. It is applied in exactly one place: the
// STEP export, where an element that was given one goes out at it and every
// other element goes out as measured, so CAD can receive the part as designed
// while every readout in the tool keeps reporting what was actually measured.
//
// Nothing is ever suggested: the field starts empty, and only a value the
// user typed counts as assumed. A guess at the design value would travel
// into CAD as if it had been decided, and a wrong one is worse than none.
//
// The sphere, the cylinder and the circle are the kinds that carry one — the
// three whose defining size is a diameter. A plane's patch size is where it
// was measured (and is the extension's business), and a point has no size.

import type { CircleFit, CylinderFit, FitData, SphereFit } from '../types'

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

function fmt(v: number): string {
  return v.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
}
