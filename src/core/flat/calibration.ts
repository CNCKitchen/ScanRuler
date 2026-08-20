// SPDX-License-Identifier: AGPL-3.0-only
// Turning a reference on the scanner glass into pixels per millimetre. The
// file's own metadata is only nominal — scanner transports are off by real
// fractions of a percent, and differently along the two axes — so the scale
// worth trusting is measured: two picks across a known distance, or a circle
// of known diameter (a gauge pin, a coin) picked around its edge.
//
// Everything here works in image pixels and stays pure; the store owns what
// the current scale is and where it came from.

import { fitCircle2d } from '../fit/circle2d'
import { FitError } from '../fit/errors'
import type { PixelsPerMm } from './image'
import type { Vec2 } from './types'

/** How many times longer the dominant axis component must be before a
 *  two-point reference may calibrate a single axis. At 10:1 the whole length
 *  attributed to that axis is off by under 0.5%% of the cross-axis error. */
const AXIS_DOMINANCE = 10

/**
 * Pixels per millimetre from two picked points a known distance apart.
 *
 * Isotropic (splitAxes off): one factor for both axes, from the full length.
 * Per-axis (splitAxes on): the reference must run along one image axis —
 * scanner error is per-axis, so a diagonal cannot say which axis it measured.
 * The measured factor lands on the dominant axis; the other keeps its current
 * value (or adopts the same factor when there is none yet to keep).
 */
export function distanceCalibration(
  a: Vec2,
  b: Vec2,
  trueMm: number,
  opts: { current: PixelsPerMm | null; splitAxes: boolean },
): PixelsPerMm {
  if (!(trueMm > 0)) throw new FitError('The true distance must be a positive length in mm.')
  const dx = Math.abs(b[0] - a[0])
  const dy = Math.abs(b[1] - a[1])
  const lengthPx = Math.hypot(dx, dy)
  if (!(lengthPx > 1)) throw new FitError('The two points coincide — pick the two ends of the reference.')
  const f = lengthPx / trueMm

  if (!opts.splitAxes) return { x: f, y: f }
  if (dx >= AXIS_DOMINANCE * dy) return { x: f, y: opts.current?.y ?? f }
  if (dy >= AXIS_DOMINANCE * dx) return { x: opts.current?.x ?? f, y: f }
  throw new FitError(
    'To calibrate one axis, the reference must run along it — this one is diagonal. Align the reference with an image edge, or calibrate both axes together.',
  )
}

/**
 * Pixels per millimetre from three or more points around a circle of known
 * diameter. One factor for both axes: the circle is fitted in raw pixels, so
 * an anisotropic scale would need an ellipse fit — calibrate per axis with
 * two-point references instead when that matters.
 */
export function diameterCalibration(picks: readonly Vec2[], trueMm: number): PixelsPerMm {
  if (!(trueMm > 0)) throw new FitError('The true diameter must be a positive length in mm.')
  if (picks.length < 3) throw new FitError('A circle needs at least three points around its edge.')
  const pu = new Float64Array(picks.length)
  const pv = new Float64Array(picks.length)
  for (let i = 0; i < picks.length; i++) {
    pu[i] = picks[i][0]
    pv[i] = picks[i][1]
  }
  const fit = fitCircle2d(pu, pv)
  if (!fit) throw new FitError("Couldn't fit a circle through these points.")
  const f = (2 * fit.r) / trueMm
  if (!(f > 0)) throw new FitError("Couldn't fit a circle through these points.")
  return { x: f, y: f }
}

/** ~dpi for a px/mm factor, for display next to the numbers the file claims. */
export function toDpi(pxPerMm: number): number {
  return pxPerMm * 25.4
}
