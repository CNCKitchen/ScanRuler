// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest'
import { PointGrid } from '../src/core/geometry/pointGrid'

function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function randomCloud(n: number, size: number, seed: number): Float32Array {
  const r = rng(seed)
  const p = new Float32Array(n * 3)
  for (let i = 0; i < p.length; i++) p[i] = r() * size
  return p
}

function d2(p: Float32Array, i: number, x: number, y: number, z: number): number {
  const dx = p[3 * i] - x, dy = p[3 * i + 1] - y, dz = p[3 * i + 2] - z
  return dx * dx + dy * dy + dz * dz
}

describe('PointGrid', () => {
  const n = 5000
  const pos = randomCloud(n, 100, 1)
  const grid = new PointGrid(pos, 6)

  it('kNearest equals brute force', () => {
    const r = rng(7)
    const out = new Int32Array(12)
    for (let q = 0; q < 50; q++) {
      const i = Math.floor(r() * n)
      const maxDist = 15
      const c = grid.kNearest(i, 12, maxDist, out)
      const all: number[] = []
      for (let j = 0; j < n; j++) if (j !== i && d2(pos, j, pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]) <= maxDist * maxDist) all.push(j)
      all.sort((a, b) => d2(pos, a, pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]) - d2(pos, b, pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]))
      const want = all.slice(0, 12)
      expect(c).toBe(want.length)
      expect(Array.from(out.subarray(0, c))).toEqual(want)
    }
  })

  it('kNearest without a tight maxDist matches brute force', () => {
    const out = new Int32Array(12)
    const c = grid.kNearest(3, 12, Infinity, out)
    const all = Array.from({ length: n }, (_, j) => j).filter((j) => j !== 3)
    all.sort((a, b) => d2(pos, a, pos[9], pos[10], pos[11]) - d2(pos, b, pos[9], pos[10], pos[11]))
    expect(c).toBe(12)
    expect(Array.from(out)).toEqual(all.slice(0, 12))
  })

  it('withinRadius equals brute force', () => {
    const r = rng(9)
    const out: number[] = []
    for (let q = 0; q < 30; q++) {
      const x = r() * 100, y = r() * 100, z = r() * 100, rad = 3 + r() * 12
      grid.withinRadius(x, y, z, rad, out)
      const want: number[] = []
      for (let j = 0; j < n; j++) if (d2(pos, j, x, y, z) <= rad * rad) want.push(j)
      expect(out.slice().sort((a, b) => a - b)).toEqual(want)
    }
  })

  it('nearest matches brute force, also from outside the cloud', () => {
    const r = rng(11)
    for (let q = 0; q < 40; q++) {
      const x = r() * 160 - 30, y = r() * 160 - 30, z = r() * 160 - 30
      let best = -1, bd = Infinity
      for (let j = 0; j < n; j++) { const d = d2(pos, j, x, y, z); if (d < bd) { bd = d; best = j } }
      expect(grid.nearest(x, y, z)).toBe(best)
    }
  })

  it('nearest returns -1 beyond maxDist', () => {
    expect(grid.nearest(1000, 1000, 1000, 5)).toBe(-1)
    expect(grid.nearest(pos[0], pos[1], pos[2], 0.001)).toBe(0)
  })

  it('isolated point has no neighbours', () => {
    const p = new Float32Array([0, 0, 0, 100, 100, 100, 101, 100, 100])
    const g = new PointGrid(p, 2)
    const out = new Int32Array(12)
    expect(g.kNearest(0, 12, 5, out)).toBe(0)
    expect(g.kNearest(1, 12, 5, out)).toBe(1)
    expect(out[0]).toBe(2)
  })

  it('nearestToRay finds the point closest to the ray within radius', () => {
    const p = new Float32Array([
      5, 0.2, 0, // hit, far
      2, 0.1, 0.1, // hit, near -> expected
      1, 3, 0, // off ray
      -1, 0, 0, // behind origin
      30, 0, 0, // beyond maxT
    ])
    const g = new PointGrid(p, 1.5)
    expect(g.nearestToRay(0, 0, 0, 3, 0, 0, 0.5, 20)).toBe(1) // unnormalised dir
    expect(g.nearestToRay(0, 0, 0, 1, 0, 0, 0.5, 1)).toBe(-1)
    expect(g.nearestToRay(0, 10, 0, 1, 0, 0, 0.5, 100)).toBe(-1)
  })

  it('nearestToRay equals brute force on a random cloud (oblique rays)', () => {
    const r = rng(21)
    for (let q = 0; q < 40; q++) {
      const o = [r() * 140 - 20, r() * 140 - 20, r() * 140 - 20]
      const dv = [r() - 0.5, r() - 0.5, r() - 0.5]
      const len = Math.hypot(dv[0], dv[1], dv[2])
      const rad = 1 + r() * 3, maxT = 50 + r() * 150
      let best = -1, bt = Infinity
      for (let j = 0; j < n; j++) {
        const wx = pos[3 * j] - o[0], wy = pos[3 * j + 1] - o[1], wz = pos[3 * j + 2] - o[2]
        const t = (wx * dv[0] + wy * dv[1] + wz * dv[2]) / len
        if (t < 0 || t > maxT) continue
        if (wx * wx + wy * wy + wz * wz - t * t <= rad * rad && t < bt) { bt = t; best = j }
      }
      expect(grid.nearestToRay(o[0], o[1], o[2], dv[0], dv[1], dv[2], rad, maxT)).toBe(best)
    }
  })

  it('handles a tiny cell by coarsening instead of exploding memory', () => {
    const g = new PointGrid(pos, 1e-6)
    expect(g.nearest(pos[0], pos[1], pos[2])).toBe(0)
  })

  it('1 M points: build + 10 000 kNearest(k=12) under 2 s', () => {
    const N = 1_000_000
    const p = randomCloud(N, 100, 5) // ~1 pt per unit^3 -> cell 2.5
    const t0 = performance.now()
    const g = new PointGrid(p, 2.5)
    const out = new Int32Array(12)
    let total = 0
    const r = rng(3)
    for (let q = 0; q < 10_000; q++) total += g.kNearest(Math.floor(r() * N), 12, 5, out)
    const ms = performance.now() - t0
    expect(total).toBeGreaterThan(10_000 * 8)
    expect(ms).toBeLessThan(2000)
  })

  it('ignores non-finite points', () => {
    const p = randomCloud(500, 50, 31)
    p[3 * 10] = NaN
    p[3 * 20 + 1] = Infinity
    p[3 * 30 + 2] = -Infinity
    const g = new PointGrid(p, 4)
    const bad = new Set([10, 20, 30])
    const r = rng(2)
    const out: number[] = []
    for (let q = 0; q < 20; q++) {
      const x = r() * 50, y = r() * 50, z = r() * 50
      let best = -1, bd = Infinity
      const want: number[] = []
      for (let j = 0; j < 500; j++) {
        if (bad.has(j)) continue
        const d = d2(p, j, x, y, z)
        if (d < bd) { bd = d; best = j }
        if (d <= 100) want.push(j)
      }
      expect(g.nearest(x, y, z)).toBe(best)
      g.withinRadius(x, y, z, 10, out)
      expect(out.slice().sort((a, b) => a - b)).toEqual(want)
    }
    const k = new Int32Array(12)
    expect(g.kNearest(10, 12, 10, k)).toBe(0)
  })

  it('an all-NaN cloud is an empty grid', () => {
    const g = new PointGrid(new Float32Array(9).fill(NaN), 1)
    const out: number[] = []
    g.withinRadius(0, 0, 0, 5, out)
    expect(out).toEqual([])
    expect(g.nearest(0, 0, 0)).toBe(-1)
    expect(g.kNearest(0, 12, 5, new Int32Array(12))).toBe(0)
    expect(g.nearestToRay(0, 0, 0, 1, 0, 0, 1, 10)).toBe(-1)
    expect(new PointGrid(new Float32Array(0), 1).nearest(0, 0, 0)).toBe(-1)
  })

  it('a negative maxDist finds nothing', () => {
    expect(grid.nearest(pos[0] + 0.5, pos[1], pos[2], -1)).toBe(-1) // treated as 0, not as a positive radius
    expect(grid.kNearest(0, 12, -1, new Int32Array(12))).toBe(0)
  })

  it('nearestToRay with radius larger than a cell equals brute force', () => {
    const r = rng(41)
    for (let q = 0; q < 30; q++) {
      const o = [r() * 140 - 20, r() * 140 - 20, r() * 140 - 20]
      const dv = [r() - 0.5, r() - 0.5, r() - 0.5]
      const len = Math.hypot(dv[0], dv[1], dv[2])
      const rad = 10 + r() * 8 // cell is 6 -> m = 2 or 3
      let best = -1, bt = Infinity
      for (let j = 0; j < n; j++) {
        const wx = pos[3 * j] - o[0], wy = pos[3 * j + 1] - o[1], wz = pos[3 * j + 2] - o[2]
        const t = (wx * dv[0] + wy * dv[1] + wz * dv[2]) / len
        if (t < 0 || t > 300) continue
        if (wx * wx + wy * wy + wz * wz - t * t <= rad * rad && t < bt) { bt = t; best = j }
      }
      expect(grid.nearestToRay(o[0], o[1], o[2], dv[0], dv[1], dv[2], rad, 300)).toBe(best)
    }
  })
})
