// SPDX-License-Identifier: AGPL-3.0-only
// A static k-d tree over a point cloud, for nearest-point queries from far
// off the cloud. A uniform grid (pointGrid.ts) answers a query near the
// points in a few cells, but one tens of millimetres away has to open every
// empty cell between, and at a fine scan's spacing that is millions of cells
// a query — what an alignment that starts a part 30 mm off asks for every
// sample. Here each node keeps the tight box of its points, so a query far
// off is pruned by its real distance to them and costs a descent, wherever
// it starts.
//
// The tree is implicit: one permutation of the point indices, each node the
// range [lo, hi) of it, split at the middle by a median partition along the
// longest side of the node's box. Node ids are heap-numbered (children
// 2i+1, 2i+2), so only each node's box is stored. Points that are not
// finite are left out. Queries allocate nothing, which also means they
// share scratch state: not re-entrant.

/** Most points in a leaf. */
const LEAF = 12
/** Held between radius queries, so the caller's array is not. */
const NO_POINTS: number[] = []

export class PointKdTree {
  private readonly pos: Float32Array
  /** Finite point indices, permuted into tree order. */
  private readonly perm: Int32Array
  /** Six floats a node: min x y z, max x y z, of the points under it. */
  private readonly box: Float32Array
  // Query state, held here so a query allocates nothing.
  private qx = 0
  private qy = 0
  private qz = 0
  private k = 0
  private count = 0
  private maxD2 = 0
  private sIdx = new Int32Array(16)
  private sD2 = new Float64Array(16)
  private radiusOut: number[] = NO_POINTS

  constructor(positions: Float32Array) {
    this.pos = positions
    const total = Math.floor(positions.length / 3)
    let n = 0
    for (let i = 0; i < total; i++) if (Number.isFinite(positions[3 * i] + positions[3 * i + 1] + positions[3 * i + 2])) n++
    const perm = (this.perm = new Int32Array(n))
    for (let i = 0, w = 0; i < total; i++) if (Number.isFinite(positions[3 * i] + positions[3 * i + 1] + positions[3 * i + 2])) perm[w++] = i
    // Halving to a leaf takes `depth` levels; heap ids then stay below 2^(depth+1).
    let depth = 0
    while (Math.ceil(n / 2 ** depth) > LEAF) depth++
    this.box = new Float32Array(6 * 2 ** (depth + 1))
    if (n > 0) this.build(0, 0, n)
  }

  private build(node: number, lo: number, hi: number): void {
    const { pos, perm, box } = this
    let x0 = Infinity, y0 = Infinity, z0 = Infinity
    let x1 = -Infinity, y1 = -Infinity, z1 = -Infinity
    for (let s = lo; s < hi; s++) {
      const j = 3 * perm[s]
      const x = pos[j], y = pos[j + 1], z = pos[j + 2]
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
      if (z < z0) z0 = z
      if (z > z1) z1 = z
    }
    const b = 6 * node
    box[b] = x0; box[b + 1] = y0; box[b + 2] = z0
    box[b + 3] = x1; box[b + 4] = y1; box[b + 5] = z1
    if (hi - lo <= LEAF) return
    const ex = x1 - x0, ey = y1 - y0, ez = z1 - z0
    const axis = ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2
    const mid = (lo + hi) >> 1
    this.select(lo, hi - 1, mid, axis)
    this.build(2 * node + 1, lo, mid)
    this.build(2 * node + 2, mid, hi)
  }

  /** Partition perm[lo..hi] so perm[m] holds the point that sorts there on `axis` (Hoare quickselect). */
  private select(lo: number, hi: number, m: number, axis: number): void {
    const { pos, perm } = this
    while (hi > lo) {
      const a = pos[3 * perm[lo] + axis], b = pos[3 * perm[(lo + hi) >> 1] + axis], c = pos[3 * perm[hi] + axis]
      const pivot = a < b ? (b < c ? b : a < c ? c : a) : a < c ? a : b < c ? c : b
      let i = lo, j = hi
      while (i <= j) {
        while (pos[3 * perm[i] + axis] < pivot) i++
        while (pos[3 * perm[j] + axis] > pivot) j--
        if (i <= j) {
          const t = perm[i]; perm[i] = perm[j]; perm[j] = t
          i++; j--
        }
      }
      if (m <= j) hi = j
      else if (m >= i) lo = i
      else return
    }
  }

  /** Squared distance from the query to a node's box. */
  private boxD2(node: number): number {
    const box = this.box
    const b = 6 * node
    const x = this.qx, y = this.qy, z = this.qz
    const dx = x < box[b] ? box[b] - x : x > box[b + 3] ? x - box[b + 3] : 0
    const dy = y < box[b + 1] ? box[b + 1] - y : y > box[b + 4] ? y - box[b + 4] : 0
    const dz = z < box[b + 2] ? box[b + 2] - z : z > box[b + 5] ? z - box[b + 5] : 0
    return dx * dx + dy * dy + dz * dz
  }

  /** The distance a node must come within to matter: the k-th best so far, or the bound. */
  private reach(): number {
    return this.count < this.k ? this.maxD2 : Math.min(this.maxD2, this.sD2[this.k - 1])
  }

  private visitK(node: number, lo: number, hi: number, nodeD2: number): void {
    if (nodeD2 > this.reach()) return
    if (hi - lo <= LEAF) {
      const { pos, perm, sIdx, sD2, k } = this
      for (let s = lo; s < hi; s++) {
        const j = perm[s]
        const dx = pos[3 * j] - this.qx, dy = pos[3 * j + 1] - this.qy, dz = pos[3 * j + 2] - this.qz
        const d = dx * dx + dy * dy + dz * dz
        if (d > this.maxD2) continue
        if (this.count === k && d >= sD2[k - 1]) continue
        let p = this.count < k ? this.count++ : k - 1
        while (p > 0 && sD2[p - 1] > d) { sD2[p] = sD2[p - 1]; sIdx[p] = sIdx[p - 1]; p-- }
        sD2[p] = d; sIdx[p] = j
      }
      return
    }
    const mid = (lo + hi) >> 1
    const l = 2 * node + 1, r = l + 1
    const dl = this.boxD2(l), dr = this.boxD2(r)
    if (dl <= dr) {
      this.visitK(l, lo, mid, dl)
      this.visitK(r, mid, hi, dr)
    } else {
      this.visitK(r, mid, hi, dr)
      this.visitK(l, lo, mid, dl)
    }
  }

  /** Up to k nearest into sIdx/sD2 (ascending) within maxDist; returns the count. */
  private search(x: number, y: number, z: number, k: number, maxDist: number): number {
    if (k <= 0 || this.perm.length === 0 || !Number.isFinite(x + y + z)) return 0
    if (this.sIdx.length < k) {
      this.sIdx = new Int32Array(k)
      this.sD2 = new Float64Array(k)
    }
    this.qx = x; this.qy = y; this.qz = z
    this.k = k
    this.count = 0
    this.maxD2 = maxDist > 0 ? maxDist * maxDist : 0
    this.visitK(0, 0, this.perm.length, this.boxD2(0))
    return this.count
  }

  /** Index of the closest point within maxDist, or -1. */
  nearest(x: number, y: number, z: number, maxDist = Infinity): number {
    return this.search(x, y, z, 1, maxDist) > 0 ? this.sIdx[0] : -1
  }

  /** Up to k points nearest (x,y,z) within maxDist, nearest first. Returns
   *  how many were written to out. */
  kNearestTo(x: number, y: number, z: number, k: number, maxDist: number, out: Int32Array): number {
    const c = this.search(x, y, z, Math.min(k, out.length), maxDist)
    for (let a = 0; a < c; a++) out[a] = this.sIdx[a]
    return c
  }

  private visitR(node: number, lo: number, hi: number): void {
    if (this.boxD2(node) > this.maxD2) return
    if (hi - lo <= LEAF) {
      const { pos, perm, radiusOut } = this
      for (let s = lo; s < hi; s++) {
        const j = perm[s]
        const dx = pos[3 * j] - this.qx, dy = pos[3 * j + 1] - this.qy, dz = pos[3 * j + 2] - this.qz
        if (dx * dx + dy * dy + dz * dz <= this.maxD2) radiusOut.push(j)
      }
      return
    }
    const mid = (lo + hi) >> 1
    this.visitR(2 * node + 1, lo, mid)
    this.visitR(2 * node + 2, mid, hi)
  }

  /** Every point within r of (x,y,z), in no particular order; `out` is cleared first. */
  withinRadius(x: number, y: number, z: number, r: number, out: number[]): void {
    out.length = 0
    if (this.perm.length === 0 || !(r >= 0) || !Number.isFinite(x + y + z)) return
    this.qx = x; this.qy = y; this.qz = z
    this.maxD2 = r * r
    this.radiusOut = out
    this.visitR(0, 0, this.perm.length)
    this.radiusOut = NO_POINTS
  }
}
