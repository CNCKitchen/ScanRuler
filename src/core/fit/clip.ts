// SPDX-License-Identifier: AGPL-3.0-only

export interface ClippedRefit<M> {
  model: M
  /** RMS of the residuals over the used points. */
  sigma: number
  /** Peak-to-peak residual over the used points — the GD&T form deviation
   *  (flatness, cylindricity, sphericity) of the surface the fit kept. */
  span: number
  used: Uint32Array
}

/** Gaussian best-fit with GOM-style "used points" clipping, shared by the
 *  plane, sphere and cylinder fits: fit, discard residuals beyond k·sigma,
 *  refit, until the point set is stable. k = 0 means use all points.
 *
 *  `fit` returning null (a degenerate model) ends the loop with the last good
 *  round's result. Non-finite residuals — a point sitting on a cylinder's
 *  axis, say — are left out of sigma and dropped by the clip. */
export function clippedRefit<M>(
  positions: Float32Array,
  idx: Uint32Array | ArrayLike<number>,
  k: number,
  fit: (used: Uint32Array) => M | null,
  residual: (model: M, x: number, y: number, z: number) => number,
): ClippedRefit<M> | null {
  let used: Uint32Array = idx instanceof Uint32Array ? idx : Uint32Array.from(idx as ArrayLike<number>)
  let result: ClippedRefit<M> | null = null

  for (let iter = 0; iter < 12; iter++) {
    const model = fit(used)
    if (model === null) return result

    let sumSq = 0
    let m = 0
    let lo = Infinity
    let hi = -Infinity
    const res = new Float64Array(used.length)
    for (let i = 0; i < used.length; i++) {
      const j = used[i] * 3
      const e = residual(model, positions[j], positions[j + 1], positions[j + 2])
      res[i] = e
      if (!Number.isFinite(e)) continue
      sumSq += e * e
      if (e < lo) lo = e
      if (e > hi) hi = e
      m++
    }
    if (m === 0) return result
    const sigma = Math.sqrt(sumSq / m)
    result = { model, sigma, span: hi - lo, used }

    if (k <= 0 || sigma < 1e-9) return result
    const thr = k * sigma
    let keep = 0
    for (let i = 0; i < used.length; i++) if (Math.abs(res[i]) <= thr) keep++
    if (keep === used.length || keep < 10) return result

    const next = new Uint32Array(keep)
    let w = 0
    for (let i = 0; i < used.length; i++) if (Math.abs(res[i]) <= thr) next[w++] = used[i]
    used = next
  }
  return result
}
