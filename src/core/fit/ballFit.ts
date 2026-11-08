// SPDX-License-Identifier: AGPL-3.0-only
// The orthogonal-distance fit of a circle or a sphere — the centre and
// radius that make Σ(|pᵢ − c| − r)² least — by Levenberg–Marquardt, from an
// algebraic start. The fixed-point iteration c ← x̄ − r̄·ū it replaces
// creeps on a partial arc or cap: capped at 100 steps (150 for a sphere)
// it stopped far short, and a 30° arc of R10 read 9.84 (issue 34). This
// converges in a handful of steps, and stops when the step has.

import { choleskySolve, solveLinear } from './linalg'

/** A step under this share of the radius (or of 1, for a radius under 1)
 *  has converged. */
const STEP_TOLERANCE = 1e-12
/** Past this damping no step lowers the sum any more: where it stands is
 *  the least, to rounding. */
const MAX_DAMPING = 1e16
/** A guard against data no step settles on; convergence ends the fit long
 *  before it — a few steps, tens on the shortest arcs. */
const MAX_STEPS = 500

/**
 * The best ball in `dim` dimensions (2 for a circle, 3 for a sphere) through
 * `n` points packed in `coords` (x, y[, z] each), from `centre` and `r`. The
 * points are best given about their centroid. `centre` is the start and is
 * not written. Null when the fit runs off to no ball (no finite, positive
 * radius).
 */
export function refineBall(dim: 2 | 3, coords: Float64Array, centre: ArrayLike<number>, r: number): { centre: number[]; r: number } | null {
  const n = coords.length / dim
  const m = dim + 1
  const c = Array.from({ length: dim }, (_, k) => centre[k])
  const cost = (cc: ArrayLike<number>, rr: number) => {
    let s = 0
    for (let i = 0; i < n; i++) {
      let d2 = 0
      for (let k = 0; k < dim; k++) {
        const d = coords[i * dim + k] - cc[k]
        d2 += d * d
      }
      const e = Math.sqrt(d2) - rr
      s += e * e
    }
    return s
  }
  let sum = cost(c, r)
  let damping = 1e-3
  const jtj = new Float64Array(m * m)
  const g = new Float64Array(m)
  const u = new Float64Array(dim)
  for (let step = 0; step < MAX_STEPS; step++) {
    // Each residual eᵢ = |pᵢ − c| − r; its gradient (−uᵢ, −1), uᵢ the unit
    // vector from the centre to the point.
    jtj.fill(0)
    g.fill(0)
    for (let i = 0; i < n; i++) {
      let d2 = 0
      for (let k = 0; k < dim; k++) {
        u[k] = coords[i * dim + k] - c[k]
        d2 += u[k] * u[k]
      }
      const d = Math.sqrt(d2)
      if (d < 1e-12) continue
      for (let k = 0; k < dim; k++) u[k] /= d
      const e = d - r
      for (let a = 0; a < m; a++) {
        const ja = a < dim ? -u[a] : -1
        g[a] += ja * e
        for (let b = a; b < m; b++) jtj[a * m + b] += ja * (b < dim ? -u[b] : -1)
      }
    }
    for (let a = 0; a < m; a++) for (let b = 0; b < a; b++) jtj[a * m + b] = jtj[b * m + a]
    let moved = false
    while (damping <= MAX_DAMPING) {
      const a = jtj.slice()
      for (let k = 0; k < m; k++) a[k * m + k] += damping * Math.max(jtj[k * m + k], 1e-300)
      const rhs = g.map((x) => -x)
      const delta = choleskySolve(m, a, rhs, 0) ?? solveLinear(m, a.slice(), rhs.slice())
      if (!delta) {
        damping *= 10
        continue
      }
      const c2 = c.map((x, k) => x + delta[k])
      const r2 = r + delta[dim]
      const sum2 = cost(c2, r2)
      if (sum2 <= sum) {
        let size = 0
        for (let k = 0; k < m; k++) size += delta[k] * delta[k]
        for (let k = 0; k < dim; k++) c[k] = c2[k]
        r = r2
        sum = sum2
        damping = Math.max(damping / 10, 1e-12)
        moved = Math.sqrt(size) >= STEP_TOLERANCE * Math.max(1, Math.abs(r))
        break
      }
      damping *= 10
    }
    if (!moved) break
  }
  if (!c.every(Number.isFinite) || !Number.isFinite(r) || !(r > 0)) return null
  return { centre: c, r }
}
