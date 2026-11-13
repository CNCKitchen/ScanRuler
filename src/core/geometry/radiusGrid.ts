// SPDX-License-Identifier: AGPL-3.0-only
/** Every point's k nearest neighbours within a fixed radius, on a hashed
 *  voxel grid of only the occupied cells.
 *
 *  PointGrid keeps a dense array of cells capped at a few a point, which a
 *  scanned surface in a big, mostly empty box only meets with cells several
 *  radii wide: each query then tests a slab of surface many times the size of
 *  its ball. Here the cell stays the radius, so a point's ball touches its
 *  own cell and the next one an axis at most.
 *
 *  The order of the work matters as much as the amount. A randomly sampled
 *  cloud (a synthetic one, or a scan whose points were shuffled) lists
 *  neighbours far apart in the file, so answering in file order misses the
 *  cache on nearly every read. The cells are numbered in space order, their
 *  points' coordinates copied into that order, and the queries answered cell
 *  by cell, each cell's neighbours looked up once for all of its points.
 *
 *  Answers are exact and the same as PointGrid.kNearest's for the radius:
 *  nearest first, the lower index on a tie. */
export class RadiusGrid {
  /** The radius every answer is within. */
  readonly radius: number
  /** Edge length of a cell: just over the radius, so a ball reaches no
   *  further than the neighbouring cells, unless the cell coordinates would
   *  not fit a double exactly. */
  readonly cell: number
  /** Points distance-tested by allKNearest: a measure of the work done. */
  scanned = 0
  private readonly minX: number
  private readonly minY: number
  private readonly minZ: number
  private readonly nx: number
  private readonly ny: number
  private readonly nz: number
  private readonly mask: number
  /** Hash slot -> cell, or -1. */
  private readonly table: Int32Array
  /** Cell -> its key, ix + nx * (iy + ny * iz), ascending. */
  private readonly keys: Float64Array
  private readonly starts: Int32Array
  private readonly items: Int32Array
  /** The points' coordinates in cell order, beside items. */
  private readonly sorted: Float32Array

  constructor(positions: Float32Array, radius: number) {
    const total = Math.floor(positions.length / 3)
    let x0 = Infinity, y0 = Infinity, z0 = Infinity
    let x1 = -Infinity, y1 = -Infinity, z1 = -Infinity
    let n = 0
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
    if (n === 0) { x0 = y0 = z0 = x1 = y1 = z1 = 0 }
    this.minX = x0; this.minY = y0; this.minZ = z0
    const ex = x1 - x0, ey = y1 - y0, ez = z1 - z0
    this.radius = radius >= 0 && Number.isFinite(radius) ? radius : 0
    // The margin keeps a point two cells over beyond the radius whatever the
    // rounding of the cell arithmetic.
    let c = this.radius > 0 ? this.radius * (1 + 1e-9) : Math.max(ex, ey, ez, 1e-9)
    let nx = 1, ny = 1, nz = 1
    for (;;) {
      nx = Math.floor(ex / c) + 1
      ny = Math.floor(ey / c) + 1
      nz = Math.floor(ez / c) + 1
      if (nx * ny * nz <= 2 ** 52) break
      c *= 1.5
    }
    this.cell = c; this.nx = nx; this.ny = ny; this.nz = nz

    let size = 16
    while (size < 2 * n) size <<= 1
    const table = (this.table = new Int32Array(size).fill(-1))
    this.mask = size - 1
    // First pass: number the cells as they turn up.
    let found = new Float64Array(Math.max(16, n >> 3))
    let cells = 0
    const cellOf = new Int32Array(total)
    for (let i = 0; i < total; i++) {
      const x = positions[3 * i], y = positions[3 * i + 1], z = positions[3 * i + 2]
      if (!Number.isFinite(x + y + z)) { cellOf[i] = -1; continue }
      const key = this.keyOf(this.ci(x, x0, nx), this.ci(y, y0, ny), this.ci(z, z0, nz))
      let slot = this.slotOf(key)
      for (;;) {
        const k = table[slot]
        if (k < 0) {
          if (cells === found.length) {
            const grown = new Float64Array(2 * cells)
            grown.set(found)
            found = grown
          }
          found[cells] = key
          table[slot] = cells
          cellOf[i] = cells++
          break
        }
        if (found[k] === key) { cellOf[i] = k; break }
        slot = (slot + 1) & this.mask
      }
    }
    // Then renumber them in key order, so cells near in space are near in
    // memory too.
    const keys = (this.keys = found.slice(0, cells).sort())
    table.fill(-1)
    for (let k = 0; k < cells; k++) {
      let slot = this.slotOf(keys[k])
      while (table[slot] >= 0) slot = (slot + 1) & this.mask
      table[slot] = k
    }
    const renumber = new Int32Array(cells)
    for (let k = 0; k < cells; k++) renumber[k] = this.find(found[k])
    const starts = (this.starts = new Int32Array(cells + 1))
    for (let i = 0; i < total; i++) {
      if (cellOf[i] < 0) continue
      cellOf[i] = renumber[cellOf[i]]
      starts[cellOf[i] + 1]++
    }
    for (let k = 0; k < cells; k++) starts[k + 1] += starts[k]
    const fill = starts.slice(0, cells)
    const items = (this.items = new Int32Array(n))
    for (let i = 0; i < total; i++) if (cellOf[i] >= 0) items[fill[cellOf[i]]++] = i
    const sorted = (this.sorted = new Float32Array(3 * n))
    for (let s = 0; s < n; s++) {
      const j = items[s]
      sorted[3 * s] = positions[3 * j]; sorted[3 * s + 1] = positions[3 * j + 1]; sorted[3 * s + 2] = positions[3 * j + 2]
    }
  }

  private ci(v: number, lo: number, m: number): number {
    const i = Math.floor((v - lo) / this.cell)
    return i < 0 ? 0 : i >= m ? m - 1 : i
  }

  private keyOf(ix: number, iy: number, iz: number): number {
    return ix + this.nx * (iy + this.ny * iz)
  }

  private slotOf(key: number): number {
    // Neighbouring cells must not land in neighbouring slots: a full mix of
    // both halves of the key.
    let h = Math.imul((key / 4294967296) >>> 0, 0x9e3779b1) ^ (key >>> 0)
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b)
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
    return (h ^ (h >>> 16)) & this.mask
  }

  private find(key: number): number {
    const { table, keys, mask } = this
    let slot = this.slotOf(key)
    for (;;) {
      const k = table[slot]
      if (k < 0 || keys[k] === key) return k
      slot = (slot + 1) & mask
    }
  }

  /** For every point i, up to k neighbours within the radius, nearest first,
   *  into out[i * k ...], and how many into count[i]. Points with a
   *  non-finite coordinate get none. */
  allKNearest(k: number, out: Int32Array, count: Uint8Array): void {
    const { starts, items, sorted, keys, nx, ny, nz, minX, minY, minZ } = this
    const r = this.radius
    const maxD2 = r * r
    const sIdx = new Int32Array(Math.max(k, 1))
    const sD2 = new Float64Array(Math.max(k, 1))
    // The 27 cells about the current one: their ids (-1 when empty or off
    // the grid) at (dx + 1) + 3 (dy + 1) + 9 (dz + 1).
    const near = new Int32Array(27)
    let scanned = 0
    count.fill(0)
    if (k <= 0) return
    for (let c = 0; c < keys.length; c++) {
      const key = keys[c]
      const iz = Math.floor(key / (nx * ny))
      const rest = key - iz * nx * ny
      const iy = Math.floor(rest / nx)
      const ix = rest - iy * nx
      for (let dz = -1; dz <= 1; dz++)
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const jx = ix + dx, jy = iy + dy, jz = iz + dz
            near[dx + 1 + 3 * (dy + 1) + 9 * (dz + 1)] =
              jx < 0 || jy < 0 || jz < 0 || jx >= nx || jy >= ny || jz >= nz ? -1 : dx === 0 && dy === 0 && dz === 0 ? c : this.find(this.keyOf(jx, jy, jz))
          }
      for (let s = starts[c], e = starts[c + 1]; s < e; s++) {
        const i = items[s]
        const x = sorted[3 * s], y = sorted[3 * s + 1], z = sorted[3 * s + 2]
        // Which of the three cells an axis the ball reaches.
        const xa = this.ci(x - r, minX, nx) < ix ? 0 : 1, xb = this.ci(x + r, minX, nx) > ix ? 2 : 1
        const ya = this.ci(y - r, minY, ny) < iy ? 0 : 1, yb = this.ci(y + r, minY, ny) > iy ? 2 : 1
        const za = this.ci(z - r, minZ, nz) < iz ? 0 : 1, zb = this.ci(z + r, minZ, nz) > iz ? 2 : 1
        let m = 0
        for (let a = za; a <= zb; a++)
          for (let b = ya; b <= yb; b++)
            for (let d = xa; d <= xb; d++) {
              const id = near[d + 3 * b + 9 * a]
              if (id < 0) continue
              const t0 = starts[id], t1 = starts[id + 1]
              scanned += t1 - t0
              for (let t = t0; t < t1; t++) {
                if (t === s) continue
                const ddx = sorted[3 * t] - x, ddy = sorted[3 * t + 1] - y, ddz = sorted[3 * t + 2] - z
                const dd = ddx * ddx + ddy * ddy + ddz * ddz
                if (dd > maxD2) continue
                const j = items[t]
                if (m === k && (dd > sD2[k - 1] || (dd === sD2[k - 1] && j > sIdx[k - 1]))) continue
                let q = m < k ? m++ : k - 1
                while (q > 0 && (sD2[q - 1] > dd || (sD2[q - 1] === dd && sIdx[q - 1] > j))) { sD2[q] = sD2[q - 1]; sIdx[q] = sIdx[q - 1]; q-- }
                sD2[q] = dd; sIdx[q] = j
              }
            }
        count[i] = m
        for (let q = 0; q < m; q++) out[i * k + q] = sIdx[q]
      }
    }
    this.scanned += scanned
  }
}
