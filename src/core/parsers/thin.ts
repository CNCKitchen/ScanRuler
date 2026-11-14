// SPDX-License-Identifier: AGPL-3.0-only
// A cloud too large for the tab, thinned evenly while it is read: every
// n-th point, n a fraction, so exactly the target count is kept and the
// arrays are allocated at that size, never at the file's. Scanners write a
// cloud scan line by scan line, so points in file order lie close together
// and a stride through them thins the surface evenly — and it needs no
// second pass and no memory besides the points kept, which a voxel grid over
// a cloud of a hundred million points would.

/** Above this many points a cloud is offered thinned before it opens: 28
 *  million opened in a 4.6 GB tab, 56 million took one down. */
export const CLOUD_POINT_BUDGET = 30_000_000

/** Picks `target` of `total` items spread evenly, asked in order. */
export class Thinning {
  private acc = 0
  /** How many are kept in all. */
  readonly kept: number

  constructor(private readonly total: number, private readonly target: number) {
    this.kept = target > 0 && target < total ? target : total
  }

  /** Whether the next item is kept; asked once for each item, in order. */
  keep(): boolean {
    if (this.kept === this.total) return true
    // Bresenham: target out of every total, spread evenly, exactly target.
    this.acc += this.target
    if (this.acc >= this.total) {
      this.acc -= this.total
      return true
    }
    return false
  }
}

/** How a cloud file is read: thinned to at most `maxPoints` points, and
 *  `chunk` bytes at a time (tests read in tiny pieces to cross boundaries). */
export interface CloudReadOptions {
  maxPoints?: number
  chunk?: number
}

/** A target as given: a positive whole number of points, or none. */
export function thinTarget(maxPoints: number | undefined): number | undefined {
  return maxPoints !== undefined && Number.isSafeInteger(maxPoints) && maxPoints > 0 ? maxPoints : undefined
}

/** What the person is asked before a cloud this large is opened. */
export function thinQuestion(name: string, points: number, exact: boolean, target = CLOUD_POINT_BUDGET): string {
  const n = points.toLocaleString('en-US')
  return `${name} holds ${exact ? '' : 'about '}${n} points — more than a browser tab holds well (${target.toLocaleString('en-US')}). OK thins it evenly to ${target.toLocaleString('en-US')} points as it is read; Cancel opens all ${n}, which may take the tab down.`
}
