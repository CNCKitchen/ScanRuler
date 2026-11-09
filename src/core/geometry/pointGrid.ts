// SPDX-License-Identifier: AGPL-3.0-only
/** Uniform voxel grid over a point cloud: one counting-sorted Int32Array of
 *  point indices plus per-cell start offsets. Queries reuse internal scratch
 *  buffers, so nearest / kNearest / nearestToRay allocate nothing per call
 *  (a scratch grows only when a larger k is requested). Not re-entrant. */
export class PointGrid {
  /** Edge length actually used; larger than requested if the request would
   *  make more than ~4 cells per point. */
  readonly cell: number
  private readonly pos: Float32Array
  private readonly n: number
  private readonly minX: number
  private readonly minY: number
  private readonly minZ: number
  private readonly nx: number
  private readonly ny: number
  private readonly nz: number
  private readonly starts: Int32Array
  private readonly items: Int32Array
  private sIdx = new Int32Array(16)
  private sD2 = new Float64Array(16)

  /** The positions the grid indexes (not copied). */
  get positions(): Float32Array {
    return this.pos
  }

  constructor(positions: Float32Array, cell: number) {
    const total = Math.floor(positions.length / 3)
    this.pos = positions
    let x0 = Infinity, y0 = Infinity, z0 = Infinity
    let x1 = -Infinity, y1 = -Infinity, z1 = -Infinity
    let n = 0 // finite points only; the rest get no cell and are never returned
    for (let i = 0; i < total; i++) {
      const x = positions[3 * i], y = positions[3 * i + 1], z = positions[3 * i + 2]
      if (!Number.isFinite(x + y + z)) continue
      n++
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
      if (z < z0) z0 = z
      if (z > z1) z1 = z
    }
    this.n = n
    if (n === 0) { x0 = y0 = z0 = x1 = y1 = z1 = 0 }
    this.minX = x0; this.minY = y0; this.minZ = z0
    const ex = x1 - x0, ey = y1 - y0, ez = z1 - z0
    const limit = Math.max(1024, 4 * n)
    let c = cell > 0 && Number.isFinite(cell) ? cell : Math.max(ex, ey, ez, 1e-9)
    let nx = 1, ny = 1, nz = 1
    for (;;) {
      nx = Math.floor(ex / c) + 1
      ny = Math.floor(ey / c) + 1
      nz = Math.floor(ez / c) + 1
      if (nx * ny * nz <= limit) break
      c *= 1.5
    }
    this.cell = c; this.nx = nx; this.ny = ny; this.nz = nz

    const nCells = nx * ny * nz
    const starts = (this.starts = new Int32Array(nCells + 1))
    const cellOf = new Int32Array(total)
    for (let i = 0; i < total; i++) {
      if (!Number.isFinite(positions[3 * i] + positions[3 * i + 1] + positions[3 * i + 2])) { cellOf[i] = -1; continue }
      const id = this.cx(positions[3 * i]) + nx * (this.cy(positions[3 * i + 1]) + ny * this.cz(positions[3 * i + 2]))
      cellOf[i] = id
      starts[id + 1]++
    }
    for (let k = 0; k < nCells; k++) starts[k + 1] += starts[k]
    const fill = starts.slice(0, nCells)
    const items = (this.items = new Int32Array(n))
    for (let i = 0; i < total; i++) if (cellOf[i] >= 0) items[fill[cellOf[i]]++] = i
  }

  private cx(x: number): number {
    const i = Math.floor((x - this.minX) / this.cell)
    return i < 0 ? 0 : i >= this.nx ? this.nx - 1 : i
  }
  private cy(y: number): number {
    const i = Math.floor((y - this.minY) / this.cell)
    return i < 0 ? 0 : i >= this.ny ? this.ny - 1 : i
  }
  private cz(z: number): number {
    const i = Math.floor((z - this.minZ) / this.cell)
    return i < 0 ? 0 : i >= this.nz ? this.nz - 1 : i
  }

  /** Insert the cell's points into the sorted scratch (sIdx/sD2, capacity k).
   *  Returns the new count. */
  private scanCell(id: number, x: number, y: number, z: number, k: number, maxD2: number, exclude: number, count: number): number {
    const { pos, starts, items, sIdx, sD2 } = this
    for (let s = starts[id], e = starts[id + 1]; s < e; s++) {
      const j = items[s]
      if (j === exclude) continue
      const dx = pos[3 * j] - x, dy = pos[3 * j + 1] - y, dz = pos[3 * j + 2] - z
      const d = dx * dx + dy * dy + dz * dz
      if (d > maxD2) continue
      if (count === k && d >= sD2[k - 1]) continue
      let p = count < k ? count++ : k - 1
      while (p > 0 && sD2[p - 1] > d) { sD2[p] = sD2[p - 1]; sIdx[p] = sIdx[p - 1]; p-- }
      sD2[p] = d; sIdx[p] = j
    }
    return count
  }

  /** Shell search: up to k nearest into sIdx/sD2 (ascending), skipping
   *  `exclude` and anything with squared distance > maxD2. Returns count. */
  private search(x: number, y: number, z: number, k: number, maxD2: number, exclude: number): number {
    if (k <= 0 || this.n === 0 || !Number.isFinite(x + y + z)) return 0
    if (this.sIdx.length < k) {
      this.sIdx = new Int32Array(k)
      this.sD2 = new Float64Array(k)
    }
    const { nx, ny, nz, cell, sD2 } = this
    const cx = this.cx(x), cy = this.cy(y), cz = this.cz(z)
    let count = 0
    for (let r = 0; ; r++) {
      const xlo = Math.max(cx - r, 0), xhi = Math.min(cx + r, nx - 1)
      const ylo = Math.max(cy - r, 0), yhi = Math.min(cy + r, ny - 1)
      const zlo = Math.max(cz - r, 0), zhi = Math.min(cz + r, nz - 1)
      for (let iz = zlo; iz <= zhi; iz++) {
        const faceZ = iz === cz - r || iz === cz + r
        for (let iy = ylo; iy <= yhi; iy++) {
          const base = nx * (iy + ny * iz)
          if (faceZ || iy === cy - r || iy === cy + r) {
            for (let ix = xlo; ix <= xhi; ix++) count = this.scanCell(base + ix, x, y, z, k, maxD2, exclude, count)
          } else {
            // interior row: only the two x faces of the shell
            if (cx - r >= 0) count = this.scanCell(base + cx - r, x, y, z, k, maxD2, exclude, count)
            if (cx + r < nx) count = this.scanCell(base + cx + r, x, y, z, k, maxD2, exclude, count)
          }
        }
      }
      // lower bound on distance to any cell outside the searched cube
      let bound = Infinity
      if (cx - r > 0) bound = Math.min(bound, x - (this.minX + (cx - r) * cell))
      if (cx + r < nx - 1) bound = Math.min(bound, this.minX + (cx + r + 1) * cell - x)
      if (cy - r > 0) bound = Math.min(bound, y - (this.minY + (cy - r) * cell))
      if (cy + r < ny - 1) bound = Math.min(bound, this.minY + (cy + r + 1) * cell - y)
      if (cz - r > 0) bound = Math.min(bound, z - (this.minZ + (cz - r) * cell))
      if (cz + r < nz - 1) bound = Math.min(bound, this.minZ + (cz + r + 1) * cell - z)
      if (bound === Infinity) break
      const b2 = bound > 0 ? bound * bound : 0
      if (b2 > maxD2) break
      if (count === k && b2 >= sD2[k - 1]) break
    }
    return count
  }

  /** Index of the closest point within maxDist, or -1. */
  nearest(x: number, y: number, z: number, maxDist = Infinity): number {
    const c = this.search(x, y, z, 1, maxDist > 0 ? maxDist * maxDist : 0, -1)
    return c > 0 ? this.sIdx[0] : -1
  }

  /** Up to k neighbours of point i within maxDist, nearest first, excluding i.
   *  Returns how many were written to out. */
  kNearest(i: number, k: number, maxDist: number, out: Int32Array): number {
    const p = this.pos
    const c = this.search(p[3 * i], p[3 * i + 1], p[3 * i + 2], Math.min(k, out.length), maxDist > 0 ? maxDist * maxDist : 0, i)
    for (let a = 0; a < c; a++) out[a] = this.sIdx[a]
    return c
  }

  /** Every point within r of (x,y,z); `out` is cleared first. */
  withinRadius(x: number, y: number, z: number, r: number, out: number[]): void {
    out.length = 0
    if (this.n === 0 || !(r >= 0) || !Number.isFinite(x + y + z)) return
    const { pos, starts, items, nx, ny } = this
    const r2 = r * r
    const x0 = this.cx(x - r), x1 = this.cx(x + r)
    const y0 = this.cy(y - r), y1 = this.cy(y + r)
    const z0 = this.cz(z - r), z1 = this.cz(z + r)
    for (let iz = z0; iz <= z1; iz++)
      for (let iy = y0; iy <= y1; iy++) {
        const base = nx * (iy + ny * iz)
        for (let ix = x0; ix <= x1; ix++) {
          const id = base + ix
          for (let s = starts[id], e = starts[id + 1]; s < e; s++) {
            const j = items[s]
            const dx = pos[3 * j] - x, dy = pos[3 * j + 1] - y, dz = pos[3 * j + 2] - z
            if (dx * dx + dy * dy + dz * dz <= r2) out.push(j)
          }
        }
      }
  }

  /** Point within `radius` (perpendicular) of the ray with the smallest ray
   *  parameter t in [0, maxT], or -1. Direction need not be unit length. */
  nearestToRay(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, radius: number, maxT: number): number {
    const len = Math.hypot(dx, dy, dz)
    if (this.n === 0 || !(len > 0) || !Number.isFinite(len)) return -1
    if (!Number.isFinite(ox + oy + oz) || !(maxT >= 0) || !(radius >= 0)) return -1 // maxT = Infinity is allowed
    dx /= len; dy /= len; dz /= len
    const { cell, pos, starts, items, nx, ny, nz } = this
    const r2 = radius * radius
    if (radius / cell > Math.max(nx, ny, nz)) {
      // window would span the whole grid: scan every point (bounded, also for Infinity radius)
      let best = -1, bestT = Infinity
      for (let s = 0; s < this.items.length; s++) {
        const j = this.items[s]
        const wx = pos[3 * j] - ox, wy = pos[3 * j + 1] - oy, wz = pos[3 * j + 2] - oz
        const t = wx * dx + wy * dy + wz * dz
        if (t < 0 || t > maxT || t >= bestT) continue
        if (wx * wx + wy * wy + wz * wz - t * t <= r2) { best = j; bestT = t }
      }
      return best
    }
    const m = Math.max(1, Math.ceil(radius / cell)) // window half-width in cells
    const pad = m * cell
    // clip the ray to the grid box padded by m cells (virtual cells outside hold nothing)
    let t0 = 0, t1 = maxT
    const lox = this.minX - pad, loy = this.minY - pad, loz = this.minZ - pad
    const hix = this.minX + nx * cell + pad, hiy = this.minY + ny * cell + pad, hiz = this.minZ + nz * cell + pad
    if (dx === 0) { if (ox < lox || ox > hix) return -1 }
    else {
      const a = (lox - ox) / dx, b = (hix - ox) / dx
      t0 = Math.max(t0, Math.min(a, b)); t1 = Math.min(t1, Math.max(a, b))
    }
    if (dy === 0) { if (oy < loy || oy > hiy) return -1 }
    else {
      const a = (loy - oy) / dy, b = (hiy - oy) / dy
      t0 = Math.max(t0, Math.min(a, b)); t1 = Math.min(t1, Math.max(a, b))
    }
    if (dz === 0) { if (oz < loz || oz > hiz) return -1 }
    else {
      const a = (loz - oz) / dz, b = (hiz - oz) / dz
      t0 = Math.max(t0, Math.min(a, b)); t1 = Math.min(t1, Math.max(a, b))
    }
    if (t0 > t1) return -1
    let ix = Math.floor((ox + dx * t0 - this.minX) / cell)
    let iy = Math.floor((oy + dy * t0 - this.minY) / cell)
    let iz = Math.floor((oz + dz * t0 - this.minZ) / cell)
    const sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1
    const tdx = dx !== 0 ? cell / Math.abs(dx) : Infinity
    const tdy = dy !== 0 ? cell / Math.abs(dy) : Infinity
    const tdz = dz !== 0 ? cell / Math.abs(dz) : Infinity
    let tmx = dx !== 0 ? (this.minX + (dx > 0 ? ix + 1 : ix) * cell - ox) / dx : Infinity
    let tmy = dy !== 0 ? (this.minY + (dy > 0 ? iy + 1 : iy) * cell - oy) / dy : Infinity
    let tmz = dz !== 0 ? (this.minZ + (dz > 0 ? iz + 1 : iz) * cell - oz) / dz : Infinity
    let best = -1, bestT = Infinity
    for (;;) {
      const xa = Math.max(ix - m, 0), xb = Math.min(ix + m, nx - 1)
      const ya = Math.max(iy - m, 0), yb = Math.min(iy + m, ny - 1)
      const za = Math.max(iz - m, 0), zb = Math.min(iz + m, nz - 1)
      for (let z = za; z <= zb; z++)
        for (let y = ya; y <= yb; y++) {
          const base = nx * (y + ny * z)
          for (let x = xa; x <= xb; x++) {
            const id = base + x
            for (let s = starts[id], e = starts[id + 1]; s < e; s++) {
              const j = items[s]
              const wx = pos[3 * j] - ox, wy = pos[3 * j + 1] - oy, wz = pos[3 * j + 2] - oz
              const t = wx * dx + wy * dy + wz * dz
              if (t < 0 || t > maxT || t >= bestT) continue
              if (wx * wx + wy * wy + wz * wz - t * t <= r2) { best = j; bestT = t }
            }
          }
        }
      const next = Math.min(tmx, tmy, tmz)
      if (next > bestT || next > t1) break
      if (tmx === next) { ix += sx; tmx += tdx }
      else if (tmy === next) { iy += sy; tmy += tdy }
      else { iz += sz; tmz += tdz }
    }
    return best
  }
}
