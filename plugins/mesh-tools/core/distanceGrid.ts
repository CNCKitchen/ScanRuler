// SPDX-License-Identifier: AGPL-3.0-only
// Distance on a grid, Felzenszwalb & Huttenlocher's way: the squared
// distance from every grid point to the nearest one seeded, exact on the
// grid, one axis at a time — a line of the grid is the lower envelope of
// the parabolas rooted at its points. Shell's hollow reads the part's depth
// with the plain transform; Wrap with the one that also says which seed is
// nearest, so the distance it gives is to a point of the surface itself, not
// to a grid point beside it.

/** A distance the transform has not reached, in squared cells. */
export const FAR = 1e20

/** A grid's origin moved off the part's own corner by these shares of a
 *  cell — a different one on each axis, so no column runs exactly through a
 *  vertex or along an edge of a mesh drawn on round numbers, a face's
 *  diagonal included: with the same share on X and Y, the columns on the
 *  grid's own diagonal run along it. */
export const JITTER = [0.381966, 0.2763932, 0.145898] as const

/**
 * The squared distance, in cells, from every grid point to the nearest one
 * at zero — in place, one axis at a time.
 */
export function distanceTransform(field: Float32Array, nx: number, ny: number, nz: number): void {
  const n = Math.max(nx, ny, nz)
  const f = new Float64Array(n)
  const d = new Float64Array(n)
  const v = new Int32Array(n)
  const z = new Float64Array(n + 1)
  const line = (start: number, stride: number, count: number) => {
    let any = false
    for (let q = 0; q < count; q++) {
      f[q] = field[start + q * stride]
      if (f[q] < FAR) any = true
    }
    if (!any) return
    transform1d(f, count, d, v, z)
    for (let q = 0; q < count; q++) field[start + q * stride] = d[q]
  }
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) line(nx * (j + ny * k), 1, nx)
  for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) line(i + nx * ny * k, nx, ny)
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) line(i + nx * j, nx * ny, nz)
}

/** One line of the transform: the lower envelope of the parabolas rooted at
 *  each point's value. */
function transform1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0
  v[0] = 0
  z[0] = -Infinity
  z[1] = Infinity
  for (let q = 1; q < n; q++) {
    if (f[q] >= FAR) continue
    if (f[v[k]] >= FAR) {
      // Only far points so far: this one starts the envelope.
      v[0] = q
      k = 0
      z[0] = -Infinity
      z[1] = Infinity
      continue
    }
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
    while (s <= z[k]) {
      k--
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
    }
    k++
    v[k] = q
    z[k] = s
    z[k + 1] = Infinity
  }
  k = 0
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++
    const r = q - v[k]
    d[q] = f[v[k]] >= FAR ? FAR : r * r + f[v[k]]
  }
}

/** The scratch one box's feature transform runs in, sized for boxes up to
 *  `n` points a side — kept and used again box after box. */
export interface FeatureScratch {
  n: number
  f: Float64Array
  s: Int32Array
  v: Int32Array
  z: Float64Array
  /** Which lines of the second and third pass hold anything. */
  occY: Uint8Array
  occZ: Uint8Array
  /** And which lines along X do, once all three passes are done. */
  occOut: Uint8Array
}

export function featureScratch(n: number): FeatureScratch {
  return {
    n,
    f: new Float64Array(n),
    s: new Int32Array(n),
    v: new Int32Array(n),
    z: new Float64Array(n + 1),
    occY: new Uint8Array(n * n),
    occZ: new Uint8Array(n * n),
    occOut: new Uint8Array(n * n),
  }
}

/**
 * The feature transform of a cubic box `n` points a side, in place: every
 * point's `f` becomes min over the seeds q of |p − q|² + f(q), squared cells,
 * and its `src` the src of the seed that gives it — so the caller measures
 * the distance to the very surface point that seed stands for, not to the
 * grid point. Only what lies within `limit` squared cells is worked out:
 * anything further comes back FAR with src −1, and the lines that hold
 * nothing within reach are never touched — the work goes with the band
 * round the surface, not with the box. `occX` marks the X lines (j + n·k)
 * that hold a seed; the caller sets it while seeding.
 */
export function featureTransform(f: Float32Array, src: Int32Array, n: number, limit: number, occX: Uint8Array, scratch: FeatureScratch): void {
  const { occY, occZ, occOut } = scratch
  occY.fill(0, 0, n * n)
  occZ.fill(0, 0, n * n)
  occOut.fill(0, 0, n * n)
  const reach = Math.floor(Math.sqrt(limit))
  const plane = n * n
  // Along X: lines (j, k), marking the Y lines (i, k) they reach.
  for (let k = 0; k < n; k++) {
    for (let j = 0; j < n; j++) {
      if (!occX[j + n * k]) continue
      line(f, src, n * (j + n * k), 1, n, limit, reach, scratch, occY, n * k, 1)
    }
  }
  // Along Y: lines (i, k), marking the Z lines (i, j).
  for (let k = 0; k < n; k++) {
    for (let i = 0; i < n; i++) {
      if (!occY[i + n * k]) continue
      line(f, src, i + plane * k, n, n, limit, reach, scratch, occZ, i, n)
    }
  }
  // Along Z: lines (i, j), marking the X lines (j, k) that hold anything.
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      if (!occZ[i + n * j]) continue
      line(f, src, i + n * j, plane, n, limit, reach, scratch, occOut, j, n)
    }
  }
}

/** One line of the feature transform: the envelope over the line's finite
 *  points, written back only as far as `reach` from them. Every point left
 *  within the limit, at place q on the line, sets `mark[markAt + q ·
 *  markStride]`. */
function line(
  field: Float32Array,
  src: Int32Array,
  start: number,
  stride: number,
  count: number,
  limit: number,
  reach: number,
  { f, s, v, z }: FeatureScratch,
  mark: Uint8Array | null,
  markAt: number,
  markStride: number,
): void {
  let lo = -1
  let hi = -1
  for (let q = 0, at = start; q < count; q++, at += stride) {
    const x = field[at]
    f[q] = x
    s[q] = src[at]
    if (x < FAR) {
      if (lo < 0) lo = q
      hi = q
    }
  }
  if (lo < 0) return
  let k = 0
  v[0] = lo
  z[0] = -Infinity
  z[1] = Infinity
  for (let q = lo + 1; q <= hi; q++) {
    const fq = f[q]
    if (fq >= FAR) continue
    const qq = fq + q * q
    let vk = v[k]
    let sx = (qq - (f[vk] + vk * vk)) / (2 * (q - vk))
    while (sx <= z[k]) {
      k--
      vk = v[k]
      sx = (qq - (f[vk] + vk * vk)) / (2 * (q - vk))
    }
    k++
    v[k] = q
    z[k] = sx
    z[k + 1] = Infinity
  }
  const a = Math.max(0, lo - reach)
  const b = Math.min(count - 1, hi + reach)
  k = 0
  for (let q = a, at = start + a * stride; q <= b; q++, at += stride) {
    while (z[k + 1] < q) k++
    const vk = v[k]
    const r = q - vk
    const d = r * r + f[vk]
    if (d <= limit) {
      field[at] = d
      src[at] = s[vk]
      if (mark) mark[markAt + q * markStride] = 1
    } else {
      field[at] = FAR
      src[at] = -1
    }
  }
}
