// SPDX-License-Identifier: AGPL-3.0-only
// Snap-to-edge for manual picking: the nearest detected edge point to a
// click. A uniform grid over the chain points, built once per detection —
// queries then touch only the cells a search radius can reach, which is what
// keeps a million-point scan snapping at pointer rates.

import type { EdgeChains } from './edges'
import { flatRefPoint } from './refs'
import type { FlatFit, Vec2 } from './types'
import { distToSegment2 } from './vec2'

const CELL = 32

export class EdgeIndex {
  private cells = new Map<number, number[]>()
  private points: Float32Array
  private offsets: Uint32Array

  constructor(chains: EdgeChains) {
    this.points = chains.points
    this.offsets = chains.offsets
    const count = chains.points.length / 2
    for (let i = 0; i < count; i++) {
      const key = this.keyOf(chains.points[i * 2], chains.points[i * 2 + 1])
      const cell = this.cells.get(key)
      if (cell) cell.push(i)
      else this.cells.set(key, [i])
    }
  }

  private keyOf(x: number, y: number): number {
    // Cells are keyed on a 2^16 grid stride — beyond any real scan width.
    return Math.floor(y / CELL) * 65536 + Math.floor(x / CELL)
  }

  /** The nearest edge point within `maxDist` of (x, y), or null. All in image
   *  pixels. */
  nearest(x: number, y: number, maxDist: number): Vec2 | null {
    const best = this.nearestIndex(x, y, maxDist)
    return best < 0 ? null : [this.points[best * 2], this.points[best * 2 + 1]]
  }

  /** Every point of the chain the nearest edge point within `maxDist`
   *  belongs to — what a click on an edge selects — or null when no edge is
   *  within reach. */
  chainNear(x: number, y: number, maxDist: number): Vec2[] | null {
    return this.chainHit(x, y, maxDist)?.chain ?? null
  }

  /** The chain under a click, and where on it the click landed: the index
   *  of the nearest edge point within the chain — the seed a fit grows
   *  along the chain from. Null when no edge is within reach. */
  chainHit(x: number, y: number, maxDist: number): { chain: Vec2[]; index: number } | null {
    const i = this.nearestIndex(x, y, maxDist)
    if (i < 0) return null
    const c = this.chainOfPoint(i)
    const chain: Vec2[] = []
    for (let k = this.offsets[c]; k < this.offsets[c + 1]; k++) {
      chain.push([this.points[k * 2], this.points[k * 2 + 1]])
    }
    return { chain, index: i - this.offsets[c] }
  }

  /** The nearest edge point within `maxDist`, with the chain that holds it —
   *  by its number in the detection — and how far it is: what a pick that
   *  snapped landed on, or how far a click that missed fell short. */
  nearestOnChain(x: number, y: number, maxDist: number): { at: Vec2; chain: number; distance: number } | null {
    const i = this.nearestIndex(x, y, maxDist)
    if (i < 0) return null
    const at: Vec2 = [this.points[i * 2], this.points[i * 2 + 1]]
    return { at, chain: this.chainOfPoint(i), distance: Math.hypot(at[0] - x, at[1] - y) }
  }

  /** Chains are laid out in order, so the one holding point i is the last
   *  offset at or before it. */
  private chainOfPoint(i: number): number {
    let lo = 0
    let hi = this.offsets.length - 2
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (this.offsets[mid] <= i) lo = mid
      else hi = mid - 1
    }
    return lo
  }

  private nearestIndex(x: number, y: number, maxDist: number): number {
    const c0x = Math.floor((x - maxDist) / CELL)
    const c1x = Math.floor((x + maxDist) / CELL)
    const c0y = Math.floor((y - maxDist) / CELL)
    const c1y = Math.floor((y + maxDist) / CELL)
    let best = -1
    let bestSq = maxDist * maxDist
    for (let cy = c0y; cy <= c1y; cy++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        const cell = this.cells.get(cy * 65536 + cx)
        if (!cell) continue
        for (const i of cell) {
          const dx = this.points[i * 2] - x
          const dy = this.points[i * 2 + 1] - y
          const d = dx * dx + dy * dy
          if (d <= bestSq) {
            bestSq = d
            best = i
          }
        }
      }
    }
    return best
  }

  /** Every edge point inside the axis-aligned box, in image pixels — what an
   *  edge-fit tool collects from a dragged region. */
  inBox(x0: number, y0: number, x1: number, y1: number): Vec2[] {
    const lox = Math.min(x0, x1)
    const hix = Math.max(x0, x1)
    const loy = Math.min(y0, y1)
    const hiy = Math.max(y0, y1)
    const out: Vec2[] = []
    for (let cy = Math.floor(loy / CELL); cy <= Math.floor(hiy / CELL); cy++) {
      for (let cx = Math.floor(lox / CELL); cx <= Math.floor(hix / CELL); cx++) {
        const cell = this.cells.get(cy * 65536 + cx)
        if (!cell) continue
        for (const i of cell) {
          const px = this.points[i * 2]
          const py = this.points[i * 2 + 1]
          if (px >= lox && px <= hix && py >= loy && py <= hiy) out.push([px, py])
        }
      }
    }
    return out
  }
}

/** What the stage knows about a click besides where it landed. */
export interface PickMeta {
  shift?: boolean
  ctrl?: boolean
  /** Alt held — inverts the snap setting for this one pick. */
  alt: boolean
  /** Document units per screen pixel: how far zoomed in the sheet is. */
  unitsPerScreenPx: number
}

/** A hand-sized snap radius in image pixels: what looks like "that edge" on
 *  screen, however far zoomed in or out the sheet is right now. `pxPerUnit`
 *  is image pixels per document unit along X. */
export function snapRadiusPx(meta: Pick<PickMeta, 'unitsPerScreenPx'>, pxPerUnit: number): number {
  return 10 * meta.unitsPerScreenPx * pxPerUnit
}

/** The pick as the measurement wants it: on the nearest detected edge when
 *  snapping is wanted, where the hand put it otherwise. `snap` is the
 *  setting in force; Alt inverts it for this one pick either way. */
export function snapPick(
  px: Vec2,
  index: EdgeIndex | null,
  radiusPx: number,
  snap: boolean,
  alt: boolean,
): Vec2 {
  if (snap === alt || !index) return px
  return index.nearest(px[0], px[1], radiusPx) ?? px
}

/** The centre nearest `at` within `reach` — of a circle or an arc, or a
 *  point element — or null; all in document units. What a pick snaps to
 *  ahead of an edge: a bolt circle is picked through the holes' centres,
 *  and a datum's origin put on a bore's. */
export function nearestCenter(at: Vec2, fits: Iterable<FlatFit>, reach: number): Vec2 | null {
  let best: Vec2 | null = null
  let bestSq = reach * reach
  for (const fit of fits) {
    const c = flatRefPoint(fit)
    if (!c) continue
    const d = (c[0] - at[0]) ** 2 + (c[1] - at[1]) ** 2
    if (d <= bestSq) {
      bestSq = d
      best = c
    }
  }
  return best
}

/** How far `at` lies from a fit, as a click on the sheet is judged: from a
 *  point, from a line's drawn segment, and from a circle or an arc either
 *  at its rim or at its centre — a hole is taken by a click on its edge or
 *  on the cross in the middle. A spline is never clicked into a reference. */
export function distanceToFit(fit: FlatFit, at: Vec2): number {
  switch (fit.kind) {
    case 'point':
      return Math.hypot(at[0] - fit.at[0], at[1] - fit.at[1])
    case 'line': {
      const h = fit.length / 2
      const a: Vec2 = [fit.center[0] - fit.dir[0] * h, fit.center[1] - fit.dir[1] * h]
      const b: Vec2 = [fit.center[0] + fit.dir[0] * h, fit.center[1] + fit.dir[1] * h]
      return distToSegment2(at, a, b)
    }
    case 'circle':
    case 'arc': {
      const d = Math.hypot(at[0] - fit.center[0], at[1] - fit.center[1])
      let onRim = true
      if (fit.kind === 'arc') {
        const turn = 2 * Math.PI
        const from = Math.atan2(at[1] - fit.center[1], at[0] - fit.center[0]) - fit.start
        onRim = ((from % turn) + turn) % turn <= fit.sweep
      }
      return Math.min(d, onRim ? Math.abs(d - fit.radius) : Infinity)
    }
    case 'spline':
      return Infinity
  }
}

/** The element a click at `at` lands on — the nearest within `reach`, all
 *  in document units, among those `takes` allows — or null. */
export function elementNear<T extends { fit: FlatFit | null }>(
  at: Vec2,
  elements: readonly T[],
  reach: number,
  takes: (el: T) => boolean = () => true,
): T | null {
  let best: T | null = null
  let bestD = reach
  for (const el of elements) {
    if (!el.fit || !takes(el)) continue
    const d = distanceToFit(el.fit, at)
    if (d <= bestD) {
      bestD = d
      best = el
    }
  }
  return best
}

/** Edge points thinned to a sane count before they join a draft — a long
 *  edge at 1200 dpi is tens of thousands, and a fit needs nowhere near. */
export function thinEdgePoints(points: Vec2[], cap = 4000): Vec2[] {
  return points.length > cap
    ? points.filter((_, i) => i % Math.ceil(points.length / cap) === 0)
    : points
}
