// SPDX-License-Identifier: AGPL-3.0-only
// Snap-to-edge for manual picking: the nearest detected edge point to a
// click. A uniform grid over the chain points, built once per detection —
// queries then touch only the cells a search radius can reach, which is what
// keeps a million-point scan snapping at pointer rates.

import type { EdgeChains } from './edges'
import type { Vec2 } from './types'

const CELL = 32

export class EdgeIndex {
  private cells = new Map<number, number[]>()
  private points: Float32Array

  constructor(chains: EdgeChains) {
    this.points = chains.points
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
    return best < 0 ? null : [this.points[best * 2], this.points[best * 2 + 1]]
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
