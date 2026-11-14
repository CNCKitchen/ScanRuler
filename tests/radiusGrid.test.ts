// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { RadiusGrid } from '../src/core/geometry/radiusGrid'
import { PointGrid } from '../src/core/geometry/pointGrid'
import { buildPointGraph } from '../src/core/geometry/buildPointGraph'

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

/** A surface in a big, mostly empty box, sampled at random and stored in no
 *  order: a 200 mm sheet at about 1 point a mm², a 1 mm patch on it 400
 *  times denser, and a few points 2 m off that make the box. What a
 *  synthetic cloud, or a shuffled scan, looks like to a neighbour search. */
function unevenCloud(): Float32Array {
  const r = rng(7)
  const p: number[] = []
  for (let i = 0; i < 40_000; i++) p.push(200 * r(), 200 * r(), 0.05 * r())
  for (let i = 0; i < 4_000; i++) p.push(100 + 0.1 * r(), 100 + 0.1 * r(), 0.05 * r())
  p.push(2000, 2000, 2000, -2000, 2000, -2000, 2000, -2000, 0)
  return Float32Array.from(p)
}

describe('RadiusGrid', () => {
  it('answers each point as PointGrid.kNearest does, on cells the size of the radius', () => {
    const pos = unevenCloud()
    const n = pos.length / 3
    const radius = 2.5
    const grid = new RadiusGrid(pos, radius)
    const dense = new PointGrid(pos, radius)
    // The dense grid cannot have cells this small over a box this big.
    expect(dense.cell).toBeGreaterThan(20 * radius)
    expect(grid.cell).toBeCloseTo(radius, 6)
    const k = 12
    const out = new Int32Array(n * k)
    const count = new Uint8Array(n)
    grid.allKNearest(k, out, count)
    const row = new Int32Array(k)
    for (let i = 0; i < n; i++) {
      const c = dense.kNearest(i, k, radius, row)
      expect(count[i]).toBe(c)
      for (let q = 0; q < c; q++) if (out[i * k + q] !== row[q]) expect([i, q, out[i * k + q]]).toEqual([i, q, row[q]])
    }
  })

  it('tests a bounded number of candidates however uneven the cloud', () => {
    const pos = unevenCloud()
    const n = pos.length / 3
    const radius = 2.5
    const grid = new RadiusGrid(pos, radius)
    grid.allKNearest(12, new Int32Array(n * 12), new Uint8Array(n))
    // The work is the points in the cells about each ball, a small multiple
    // of the points in the balls themselves, not of the cells' size.
    const dense = new PointGrid(pos, radius)
    const within: number[] = []
    let inBalls = 0
    for (let i = 0; i < n; i++) {
      dense.withinRadius(pos[3 * i], pos[3 * i + 1], pos[3 * i + 2], radius, within)
      inBalls += within.length
    }
    expect(grid.scanned).toBeLessThan(4 * inBalls)
  })

  it('a cloud with no extent or a single point answers without throwing', () => {
    for (const pos of [new Float32Array([1, 2, 3]), new Float32Array([1, 2, 3, 1, 2, 3, 1, 2, 3.5]), new Float32Array(0)]) {
      const n = pos.length / 3
      const out = new Int32Array(n * 4)
      const count = new Uint8Array(n)
      new RadiusGrid(pos, 1).allKNearest(4, out, count)
      for (let i = 0; i < n; i++) expect(count[i]).toBeLessThanOrEqual(n - 1)
    }
  })
})

describe('buildPointGraph on an uneven, unordered cloud', () => {
  it('links each point to its 12 nearest within 2.5 spacings, as before', () => {
    const pos = unevenCloud()
    const n = pos.length / 3
    const normals = new Float32Array(3 * n)
    for (let i = 0; i < n; i++) normals[3 * i + 2] = 1
    const g = buildPointGraph({ kind: 'cloud', positions: pos, normals })
    const radius = 2.5 * g.spacing
    const dense = new PointGrid(g.positions, radius)
    const row = new Int32Array(12)
    // The union of both directions.
    const want: Set<number>[] = Array.from({ length: g.vertexCount }, () => new Set<number>())
    for (let i = 0; i < g.vertexCount; i++) {
      const c = dense.kNearest(i, 12, radius, row)
      for (let q = 0; q < c; q++) { want[i].add(row[q]); want[row[q]].add(i) }
    }
    for (let i = 0; i < g.vertexCount; i++) {
      const got = Array.from(g.adjList.subarray(g.adjOffsets[i], g.adjOffsets[i + 1]))
      expect(got.length).toBe(want[i].size)
      for (const j of got) expect(want[i].has(j)).toBe(true)
    }
  })
})
