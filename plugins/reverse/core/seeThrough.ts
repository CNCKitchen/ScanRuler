// SPDX-License-Identifier: AGPL-3.0-only
// A thin sheet's outline as a sketch's fit reads it: the sheet seen square
// onto the sketch's plane, where a grid of rays meets the scan within a
// band of heights about it and where it sees through, the line between
// traced round (core outline.ts) — the sheet's edge and every hole punched
// in it, each loop a chain of slice points for the chain fitter. A cut
// parallel to a warped, embossed sheet follows its beads, not its holes;
// seen through, the holes are what is left.

import type { Vec2 } from '../../../src/core/flat/types'
import { type MaskGrid, maskLoops, smoothTrace } from '../../../src/core/geometry/outline'

/** A loop closing less than this many cells across, squared, is a speck
 *  of a ray that grazed an edge, not a hole: left out and counted. */
export const THROUGH_MIN_CELLS = 3

/** The loops of a see-through mask as chains: each traced loop evened out
 *  as the outline evens it (smoothTrace), closed back onto its first point
 *  as a section's loop is, the largest first; whether each is a hole in
 *  another, and how many specks were left out. */
export interface ThroughChains {
  chains: Vec2[][]
  holes: boolean[]
  skipped: number
}

export function maskChains(mask: Uint8Array, g: MaskGrid): ThroughChains {
  const loops = maskLoops(mask, g)
  const kept = loops.filter((l) => l.area >= (THROUGH_MIN_CELLS * g.cell) ** 2)
  return {
    chains: kept.map((l) => {
      const pts = smoothTrace(l.points)
      return [...pts, [pts[0][0], pts[0][1]]]
    }),
    holes: kept.map((l) => l.hole),
    skipped: loops.length - kept.length,
  }
}
