// SPDX-License-Identifier: AGPL-3.0-only
// The k-d tree behind CloudSurface: the same answers as brute force, and
// bounded queries from far off the cloud that stay fast.
import { describe, expect, it } from 'vitest'
import { PointKdTree } from '../src/core/geometry/pointKdTree'

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

/** Random points in a cube of `size`, with some NaN / Infinity rows and duplicates. */
function messyCloud(n: number, size: number, seed: number): Float32Array {
  const r = rng(seed)
  const p = new Float32Array(n * 3)
  for (let i = 0; i < p.length; i++) p[i] = r() * size
  for (let i = 0; i < n; i += 97) p[3 * i + (i % 3)] = i % 2 ? NaN : Infinity
  for (let i = 5; i < n; i += 131) p.copyWithin(3 * i, 3 * (i - 1), 3 * i) // duplicates
  return p
}

function d2(p: Float32Array, i: number, x: number, y: number, z: number): number {
  const dx = p[3 * i] - x, dy = p[3 * i + 1] - y, dz = p[3 * i + 2] - z
  return dx * dx + dy * dy + dz * dz
}

function finite(p: Float32Array, i: number): boolean {
  return Number.isFinite(p[3 * i] + p[3 * i + 1] + p[3 * i + 2])
}

function brute(p: Float32Array, x: number, y: number, z: number, maxDist: number): number[] {
  const n = p.length / 3
  const out: number[] = []
  for (let i = 0; i < n; i++) if (finite(p, i) && d2(p, i, x, y, z) <= maxDist * maxDist) out.push(i)
  return out.sort((a, b) => d2(p, a, x, y, z) - d2(p, b, x, y, z))
}

describe('PointKdTree', () => {
  const n = 4000
  const p = messyCloud(n, 50, 3)
  const tree = new PointKdTree(p)
  const r = rng(9)
  const queries: [number, number, number][] = []
  for (let q = 0; q < 150; q++) queries.push([r() * 60 - 5, r() * 60 - 5, r() * 60 - 5])
  for (let q = 0; q < 20; q++) queries.push([r() * 400 - 200, r() * 400 - 200, 300 + r() * 100]) // far outside

  it('nearest equals brute force, bounded and not', () => {
    for (const [x, y, z] of queries) {
      for (const maxDist of [Infinity, 3]) {
        const want = brute(p, x, y, z, maxDist)
        const got = tree.nearest(x, y, z, maxDist)
        if (want.length === 0) expect(got).toBe(-1)
        else expect(d2(p, got, x, y, z)).toBe(d2(p, want[0], x, y, z))
      }
    }
  })

  it('kNearestTo equals brute force, nearest first', () => {
    const out = new Int32Array(12)
    for (const [x, y, z] of queries) {
      for (const maxDist of [Infinity, 4]) {
        const want = brute(p, x, y, z, maxDist).slice(0, 12)
        const c = tree.kNearestTo(x, y, z, 12, maxDist, out)
        expect(c).toBe(want.length)
        for (let a = 0; a < c; a++) expect(d2(p, out[a], x, y, z)).toBe(d2(p, want[a], x, y, z))
      }
    }
    expect(tree.kNearestTo(3, 3, 3, 5, Infinity, new Int32Array(3))).toBe(3)
  })

  it('withinRadius equals brute force', () => {
    const out: number[] = [7, 7]
    for (const [x, y, z] of queries) {
      tree.withinRadius(x, y, z, 5, out)
      expect([...out].sort((a, b) => a - b)).toEqual(brute(p, x, y, z, 5).sort((a, b) => a - b))
    }
  })

  it('never returns a non-finite point; non-finite queries find nothing', () => {
    const out = new Int32Array(12)
    for (const [x, y, z] of queries) {
      const c = tree.kNearestTo(x, y, z, 12, Infinity, out)
      for (let a = 0; a < c; a++) expect(finite(p, out[a])).toBe(true)
    }
    expect(tree.nearest(NaN, 0, 0)).toBe(-1)
    expect(tree.kNearestTo(0, Infinity, 0, 12, Infinity, out)).toBe(0)
    const around: number[] = []
    tree.withinRadius(0, 0, NaN, 10, around)
    expect(around).toEqual([])
  })

  it('an empty or all-NaN cloud answers nothing', () => {
    for (const q of [new Float32Array(0), new Float32Array([NaN, 0, 0, 1, Infinity, 2])]) {
      const t = new PointKdTree(q)
      expect(t.nearest(0, 0, 0)).toBe(-1)
      expect(t.kNearestTo(0, 0, 0, 4, Infinity, new Int32Array(4))).toBe(0)
    }
  })

  it('1 M points: 25 000 bounded nearest queries 30 mm off a 200 mm plane in under 1 s', () => {
    const side = 1001 // 0.2 spacing over 200
    const plane = new Float32Array(side * side * 3)
    for (let i = 0; i < side; i++)
      for (let j = 0; j < side; j++) {
        const k = 3 * (i * side + j)
        plane[k] = -100 + i * 0.2
        plane[k + 1] = -100 + j * 0.2
      }
    const t = new PointKdTree(plane)
    const rr = rng(4)
    let found = 0
    const t0 = performance.now()
    for (let q = 0; q < 25_000; q++) {
      if (t.nearest(rr() * 200 - 100, rr() * 200 - 100, 30, 40) >= 0) found++
    }
    const ms = performance.now() - t0
    expect(found).toBe(25_000)
    expect(ms).toBeLessThan(1000)
  })
})
