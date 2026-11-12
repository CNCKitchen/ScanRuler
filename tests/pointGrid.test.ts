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
    // The best of three runs: a machine busy with other work slows a run,
    // never speeds one, so the fastest is the one that tells the grid's cost.
    let ms = Infinity
    for (let run = 0; run < 3 && ms >= 2000; run++) {
      const t0 = performance.now()
      const g = new PointGrid(p, 2.5)
      const out = new Int32Array(12)
      let total = 0
      const r = rng(3)
      for (let q = 0; q < 10_000; q++) total += g.kNearest(Math.floor(r() * N), 12, 5, out)
      ms = Math.min(ms, performance.now() - t0)
      expect(total).toBeGreaterThan(10_000 * 8)
    }
    expect(ms).toBeLessThan(2000)
  })

  it('more than 16 neighbours grow the scratch and still equal brute force', () => {
    const out = new Int32Array(40)
    for (const i of [0, 77, 4321]) {
      const c = grid.kNearest(i, 40, Infinity, out)
      const all = Array.from({ length: n }, (_, j) => j).filter((j) => j !== i)
      all.sort((a, b) => d2(pos, a, pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]) - d2(pos, b, pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]) || a - b)
      expect(c).toBe(40)
      expect(Array.from(out)).toEqual(all.slice(0, 40))
    }
    // And a smaller k after still answers right from the grown scratch.
    expect(grid.kNearest(0, 3, Infinity, out)).toBe(3)
  })

  it('a maxDist of 0 finds only a point at the very spot', () => {
    const p = new Float32Array([0, 0, 0, 1, 0, 0, 1, 0, 0, 2, 0, 0])
    const g = new PointGrid(p, 1)
    const out = new Int32Array(4)
    expect(g.nearest(0.1, 0, 0, 0)).toBe(-1)
    expect(g.nearest(1, 0, 0, 0)).toBe(1)
    expect(g.kNearest(1, 4, 0, out)).toBe(1)
    expect(out[0]).toBe(2)
    expect(g.kNearestTo(2, 0, 0, 4, 0, out)).toBe(1)
    expect(g.kNearest(0, 4, 0, out)).toBe(0)
  })

  it('points at one distance come out in index order, whatever the cell layout', () => {
    // Thirty points exactly 3 from the origin — (3,0,0) and (2,2,1) with
    // their signs and orders — spread over several cells, given shuffled.
    const tied: number[][] = []
    for (const [a, b, c] of [[3, 0, 0], [2, 2, 1]])
      for (const [x, y, z] of [[a, b, c], [a, c, b], [b, a, c], [b, c, a], [c, a, b], [c, b, a]])
        for (const sx of [1, -1]) for (const sy of [1, -1]) for (const sz of [1, -1]) tied.push([sx * x, sy * y, sz * z])
    const unique = [...new Map(tied.map((v) => [v.join(','), v])).values()]
    const shuffled = unique.map((v, i) => [(i * 7919) % 101, v] as const).sort((a, b) => a[0] - b[0]).map(([, v]) => v)
    expect(shuffled).toHaveLength(30)
    const p = Float32Array.from([0, 0, 0, ...shuffled.flat()])
    for (const cell of [0.7, 1.3, 3, 9]) {
      const g = new PointGrid(p, cell)
      const out = new Int32Array(4)
      expect(g.kNearest(0, 4, Infinity, out)).toBe(4)
      expect(Array.from(out)).toEqual([1, 2, 3, 4])
      expect(g.kNearestTo(0, 0, 0, 1, Infinity, out)).toBe(1)
      expect(out[0]).toBe(0)
      // Two points at one distance along the ray: the lower index.
      const twin = new PointGrid(Float32Array.from([5, 0.5, 0, 5, -0.5, 0, 9, 0, 0]), cell)
      expect(twin.nearestToRay(0, 0, 0, 1, 0, 0, 1, 20)).toBe(0)
      const swapped = new PointGrid(Float32Array.from([9, 0, 0, 5, -0.5, 0, 5, 0.5, 0]), cell)
      expect(swapped.nearestToRay(0, 0, 0, 1, 0, 0, 1, 20)).toBe(1)
    }
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

  it('nearestToRay with a radius many cells wide equals brute force, along the axes too', () => {
    const r = rng(43)
    const fine = new PointGrid(pos, 2) // radius 9..15 -> m = 5..8 cells
    for (let q = 0; q < 40; q++) {
      const o = [r() * 140 - 20, r() * 140 - 20, r() * 140 - 20]
      const dv = q % 4 === 0 ? [1, 0, 0] : q % 4 === 1 ? [0, -1, 0] : [r() - 0.5, r() - 0.5, r() - 0.5]
      const len = Math.hypot(dv[0], dv[1], dv[2])
      const rad = 9 + r() * 6
      let best = -1, bt = Infinity
      for (let j = 0; j < n; j++) {
        const wx = pos[3 * j] - o[0], wy = pos[3 * j + 1] - o[1], wz = pos[3 * j + 2] - o[2]
        const t = (wx * dv[0] + wy * dv[1] + wz * dv[2]) / len
        if (t < 0 || t > 300) continue
        if (wx * wx + wy * wy + wz * wz - t * t <= rad * rad && t < bt) { bt = t; best = j }
      }
      expect(fine.nearestToRay(o[0], o[1], o[2], dv[0], dv[1], dv[2], rad, 300)).toBe(best)
    }
  })

  it('nearestToRay rejects degenerate rays promptly', () => {
    expect(grid.nearestToRay(NaN, 0, 0, 1, 0, 0, 1, Infinity)).toBe(-1)
    expect(grid.nearestToRay(Infinity, 0, 0, 1, 0, 0, 1, Infinity)).toBe(-1)
    expect(grid.nearestToRay(0, -Infinity, 0, 1, 0, 0, 1, 10)).toBe(-1)
    expect(grid.nearestToRay(0, 0, 0, NaN, 0, 0, 1, 10)).toBe(-1)
    expect(grid.nearestToRay(0, 0, 0, Infinity, 0, 0, 1, 10)).toBe(-1)
    expect(grid.nearestToRay(0, 0, 0, 0, 0, 0, 1, 10)).toBe(-1)
    expect(grid.nearestToRay(0, 0, 0, 1, 0, 0, 1, NaN)).toBe(-1)
    expect(grid.nearestToRay(0, 0, 0, 1, 0, 0, 1, -1)).toBe(-1)
    expect(grid.nearestToRay(0, 0, 0, 1, 0, 0, NaN, 10)).toBe(-1)
    expect(grid.nearestToRay(0, 0, 0, 1, 0, 0, -1, 10)).toBe(-1)
    // An infinite radius takes every point ahead: the one least far along the ray.
    for (const [o, dv] of [[[-5, 50, 50], [1, 0, 0]], [[50, 120, 30], [0.2, -1, 0.3]]] as const) {
      let best = -1, bt = Infinity
      const len = Math.hypot(dv[0], dv[1], dv[2])
      for (let j = 0; j < n; j++) {
        const t = ((pos[3 * j] - o[0]) * dv[0] + (pos[3 * j + 1] - o[1]) * dv[1] + (pos[3 * j + 2] - o[2]) * dv[2]) / len
        if (t >= 0 && t < bt) { bt = t; best = j }
      }
      expect(grid.nearestToRay(o[0], o[1], o[2], dv[0], dv[1], dv[2], Infinity, 1e9)).toBe(best)
    }
    // maxT = Infinity still works
    const p = new Float32Array([5, 0, 0])
    expect(new PointGrid(p, 1).nearestToRay(0, 0, 0, 1, 0, 0, 0.5, Infinity)).toBe(0)
  })

  it('kNearest and nearestToRay on a cloud with non-finite points equal brute force over finite points', () => {
    const p = randomCloud(1000, 50, 61)
    for (const j of [5, 50, 500]) p[3 * j + (j % 3)] = j === 50 ? Infinity : NaN
    const bad = new Set([5, 50, 500])
    const g = new PointGrid(p, 4)
    const r = rng(8)
    const out = new Int32Array(12)
    for (let q = 0; q < 30; q++) {
      const i = Math.floor(r() * 1000)
      if (bad.has(i)) continue
      const all: number[] = []
      for (let j = 0; j < 1000; j++) if (j !== i && !bad.has(j) && d2(p, j, p[3 * i], p[3 * i + 1], p[3 * i + 2]) <= 64) all.push(j)
      all.sort((a, b) => d2(p, a, p[3 * i], p[3 * i + 1], p[3 * i + 2]) - d2(p, b, p[3 * i], p[3 * i + 1], p[3 * i + 2]))
      const c = g.kNearest(i, 12, 8, out)
      expect(Array.from(out.subarray(0, c))).toEqual(all.slice(0, 12))
      const o = [r() * 60 - 5, r() * 60 - 5, r() * 60 - 5], dv = [r() - 0.5, r() - 0.5, r() - 0.5]
      const len = Math.hypot(dv[0], dv[1], dv[2])
      let best = -1, bt = Infinity
      for (let j = 0; j < 1000; j++) {
        if (bad.has(j)) continue
        const wx = p[3 * j] - o[0], wy = p[3 * j + 1] - o[1], wz = p[3 * j + 2] - o[2]
        const t = (wx * dv[0] + wy * dv[1] + wz * dv[2]) / len
        if (t < 0 || t > 200) continue
        if (wx * wx + wy * wy + wz * wz - t * t <= 4 && t < bt) { bt = t; best = j }
      }
      expect(g.nearestToRay(o[0], o[1], o[2], dv[0], dv[1], dv[2], 2, 200)).toBe(best)
    }
  })
  it('kNearestTo: the k nearest to an arbitrary point, nearest first, as brute force', () => {
    const p = randomCloud(3000, 50, 7)
    const g = new PointGrid(p, 2)
    const r = rng(8)
    const out = new Int32Array(12)
    for (let q = 0; q < 200; q++) {
      const x = r() * 60 - 5, y = r() * 60 - 5, z = r() * 60 - 5
      const maxDist = q % 2 ? Infinity : 4
      const c = g.kNearestTo(x, y, z, 12, maxDist, out)
      const brute = Array.from({ length: 3000 }, (_, i) => i)
        .filter((i) => d2(p, i, x, y, z) <= maxDist * maxDist)
        .sort((a, b) => d2(p, a, x, y, z) - d2(p, b, x, y, z))
        .slice(0, 12)
      expect(c).toBe(brute.length)
      for (let a = 0; a < c; a++) expect(d2(p, out[a], x, y, z)).toBeCloseTo(d2(p, brute[a], x, y, z), 9)
    }
    expect(g.kNearestTo(NaN, 0, 0, 12, Infinity, out)).toBe(0)
  })
})
