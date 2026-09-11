// SPDX-License-Identifier: AGPL-3.0-only
// Thinning an edge chain: the ends stay, straight runs collapse, corners and
// curves keep what the tolerance demands.
import { describe, expect, it } from 'vitest'
import { simplifyRun } from '../src/core/flat/simplify'

describe('simplifyRun', () => {
  it('keeps the ends and drops a straight run that wobbles within the tolerance', () => {
    const pts = [0, 0, 1, 0.01, 2, -0.01, 3, 0.02, 4, 0]
    expect(simplifyRun(pts, 0, 5, 0.05)).toEqual([0, 4])
  })

  it('keeps everything at zero tolerance, and a run of two', () => {
    const pts = [0, 0, 1, 0.01, 2, -0.01]
    expect(simplifyRun(pts, 0, 3, 0)).toEqual([0, 1, 2])
    expect(simplifyRun(pts, 0, 2, 1)).toEqual([0, 1])
    expect(simplifyRun(pts, 0, 0, 1)).toEqual([])
  })

  it('keeps a corner', () => {
    const pts = [0, 0, 1, 0, 2, 0, 2, 1, 2, 2]
    expect(simplifyRun(pts, 0, 5, 0.1)).toEqual([0, 2, 4])
  })

  it('keeps just enough of a curve to stay within the tolerance', () => {
    const n = 360
    const pts: number[] = []
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 1.5
      pts.push(10 * Math.cos(a), 10 * Math.sin(a))
    }
    const tol = 0.05
    const kept = simplifyRun(pts, 0, n, tol)
    expect(kept[0]).toBe(0)
    expect(kept[kept.length - 1]).toBe(n - 1)
    // A chord across an arc of radius r stays within t of it when it spans
    // 2·√(2rt) — a couple of dozen segments round three quarters of a circle.
    expect(kept.length).toBeGreaterThan(20)
    expect(kept.length).toBeLessThan(60)
    // Every dropped point lies within the tolerance of the thinned polyline.
    for (let i = 0; i < n; i++) {
      let best = Infinity
      for (let k = 0; k + 1 < kept.length; k++) {
        const [ax, ay] = [pts[kept[k] * 2], pts[kept[k] * 2 + 1]]
        const [bx, by] = [pts[kept[k + 1] * 2], pts[kept[k + 1] * 2 + 1]]
        const dx = bx - ax
        const dy = by - ay
        const t = Math.max(0, Math.min(1, ((pts[i * 2] - ax) * dx + (pts[i * 2 + 1] - ay) * dy) / (dx * dx + dy * dy)))
        best = Math.min(best, Math.hypot(pts[i * 2] - ax - t * dx, pts[i * 2 + 1] - ay - t * dy))
      }
      expect(best).toBeLessThanOrEqual(tol + 1e-9)
    }
  })

  it('works on a run inside a larger array and answers with absolute indices', () => {
    const pts = [9, 9, 9, 9, 0, 0, 1, 0, 2, 0, 2, 1, 2, 2, 8, 8]
    expect(simplifyRun(pts, 2, 7, 0.1)).toEqual([2, 4, 6])
  })

  it('judges a loop whose ends coincide by the distance to the shared end', () => {
    const pts = [0, 0, 1, 0, 1, 1, 0, 1, 0, 0]
    expect(simplifyRun(pts, 0, 5, 0.1)).toEqual([0, 1, 2, 3, 4])
  })
})
