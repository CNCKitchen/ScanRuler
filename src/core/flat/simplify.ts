// SPDX-License-Identifier: AGPL-3.0-only
// Thinning an edge chain for a CAD sketch: Ramer–Douglas–Peucker over a run
// of points, keeping every point the polyline would otherwise stray from by
// more than the tolerance and dropping the rest. A subpixel chain has a point
// per pixel along an edge; a sketch wants a handful along a straight run and
// just enough round a curve — and the tolerance says exactly how much
// "enough" is, in the units the points are in. Iterative rather than
// recursive, because a chain round a large part is a hundred thousand points
// long, and a straight one is settled in a single pass.

/**
 * The points of `points[from … to)` (x,y pairs, flattened) worth keeping so
 * that the polyline through them lies within `tolerance` of every point
 * dropped. Returns point indices, ascending; the two ends always stay. A
 * tolerance of zero keeps everything.
 */
export function simplifyRun(
  points: ArrayLike<number>,
  from: number,
  to: number,
  tolerance: number,
): number[] {
  const n = to - from
  if (n <= 0) return []
  const all = () => Array.from({ length: n }, (_, i) => from + i)
  if (n <= 2 || !(tolerance > 0)) return all()

  const keep = new Uint8Array(n)
  keep[0] = 1
  keep[n - 1] = 1
  // Pairs of indices (relative to `from`) whose chord is still to be judged.
  const stack: number[] = [0, n - 1]
  while (stack.length) {
    const b = stack.pop()!
    const a = stack.pop()!
    if (b - a < 2) continue
    const ax = points[(from + a) * 2]
    const ay = points[(from + a) * 2 + 1]
    const dx = points[(from + b) * 2] - ax
    const dy = points[(from + b) * 2 + 1] - ay
    const len = Math.hypot(dx, dy)
    let worst = -1
    let worstD = tolerance
    for (let i = a + 1; i < b; i++) {
      const px = points[(from + i) * 2] - ax
      const py = points[(from + i) * 2 + 1] - ay
      // Distance to the chord — or, when the ends coincide (a loop's two
      // ends, say), to the shared end point.
      const d = len > 1e-12 ? Math.abs(px * dy - py * dx) / len : Math.hypot(px, py)
      if (d > worstD) {
        worstD = d
        worst = i
      }
    }
    if (worst >= 0) {
      keep[worst] = 1
      stack.push(a, worst, worst, b)
    }
  }
  const out: number[] = []
  for (let i = 0; i < n; i++) if (keep[i]) out.push(from + i)
  return out
}
