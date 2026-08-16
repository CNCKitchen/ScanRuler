// SPDX-License-Identifier: AGPL-3.0-only
// The hand-painted counterpart of the seed-and-grow pipeline: the user has
// already marked which surface belongs to the element, so these fits take the
// selection exactly as given — no local patch, no RANSAC hunt for the right
// surface, no region growing that could leak somewhere else or stop short.
// Everything downstream (the clipped Gaussian best fit, the reported sigma)
// stays the same, so a painted element and an auto-fitted one are the same
// measurement.

import { FitError } from './errors'

/** Below this a fit has nothing to work with — a handful of points can be
 *  matched exactly by almost any surface. */
export const MIN_SELECTED = 20

export function requireSelection(selection: Uint32Array, noun: string): void {
  if (selection.length < MIN_SELECTED) {
    throw new FitError(
      `Paint more of the ${noun} — a fit needs at least ${MIN_SELECTED} marked points, and this selection has ${selection.length}.`,
    )
  }
}
