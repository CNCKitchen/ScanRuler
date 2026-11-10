// SPDX-License-Identifier: AGPL-3.0-only
// Densify (issue 42): a CAD tessellation's long triangles cut down to an
// edge length — every new point on the facet it came from, the mesh as
// closed as it was, the volume unchanged — and a mesh with nothing too long
// left as it is.

import { describe, expect, it } from 'vitest'
import { densifyMesh } from '../core/densify'

/** A box from the origin to `size`, 12 triangles wound outward: the
 *  sparsest a CAD export makes. */
function box(size: [number, number, number]): { positions: Float32Array; indices: Uint32Array } {
  const [x, y, z] = size
  const positions = Float32Array.from([0, 0, 0, x, 0, 0, x, y, 0, 0, y, 0, 0, 0, z, x, 0, z, x, y, z, 0, y, z])
  const indices = Uint32Array.from([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7])
  return { positions, indices }
}

/** Every edge of the triangles, and how often each way round. */
function edgeUse(indices: Uint32Array): Map<string, number> {
  const use = new Map<string, number>()
  for (let t = 0; t < indices.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const key = `${indices[t + k]}>${indices[t + ((k + 1) % 3)]}`
      use.set(key, (use.get(key) ?? 0) + 1)
    }
  }
  return use
}

function volume(p: Float32Array, idx: Uint32Array): number {
  let six = 0
  for (let t = 0; t < idx.length; t += 3) {
    const [a, b, c] = [idx[t] * 3, idx[t + 1] * 3, idx[t + 2] * 3]
    six += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])
  }
  return six / 6
}

/** The area of the triangles, summed in doubles. */
function area(p: Float32Array, idx: Uint32Array): number {
  let sum = 0
  for (let t = 0; t < idx.length; t += 3) {
    const [a, b, c] = [idx[t] * 3, idx[t + 1] * 3, idx[t + 2] * 3]
    const u = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]]
    const v = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]]
    sum += Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2
  }
  return sum
}

describe('densify', () => {
  it('cuts a box of long triangles until no edge is longer than asked, closed and of the same volume', () => {
    const { positions, indices } = box([60, 40, 6])
    const d = densifyMesh(positions, indices, 8, 1)
    expect(d.report.longest).toBeLessThanOrEqual(1 + 1e-9)
    expect(d.report.trianglesBefore).toBe(12)
    expect(d.report.triangles).toBe(d.indices.length / 3)
    expect(d.report.added).toBe(d.positions.length / 3 - 8)
    // Every directed edge once, and its reverse once: closed, no T-junction.
    const use = edgeUse(d.indices)
    for (const [key, n] of use) {
      const [a, b] = key.split('>')
      expect(n, key).toBe(1)
      expect(use.get(`${b}>${a}`), key).toBe(1)
    }
    expect(volume(d.positions, d.indices)).toBeCloseTo(60 * 40 * 6, 6)
    // The old vertices kept, numbered as they were; the new on the box's faces.
    expect(Array.from(d.vertexMap)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    for (let i = 0; i < 8 * 3; i++) expect(d.positions[i]).toBe(positions[i])
    for (let v = 8; v < d.positions.length / 3; v++) {
      const [x, y, z] = [d.positions[v * 3], d.positions[v * 3 + 1], d.positions[v * 3 + 2]]
      const onFace = [x, 60 - x, y, 40 - y, z, 6 - z].some((s) => Math.abs(s) < 1e-5)
      expect(onFace, `${x} ${y} ${z}`).toBe(true)
    }
  })

  it('keeps a mesh closed whose vertices are numbered past 2^21', () => {
    // An edge keyed as lower · 2^32 + higher is no longer an exact double
    // past vertex 2,097,152: two edges shared a key, the second got the
    // first's middle, and the mesh came out cracked.
    const from = 3_000_000
    const { positions: corners, indices: local } = box([20, 12, 8])
    const positions = new Float32Array((from + 8) * 3)
    positions.set(corners, from * 3)
    const indices = local.map((i) => i + from)
    const d = densifyMesh(positions, indices, from + 8, 1.5)
    expect(d.report.longest).toBeLessThanOrEqual(1.5 + 1e-9)
    expect(d.report.added).toBeGreaterThan(100)
    const use = edgeUse(d.indices)
    let unpaired = 0
    for (const [key, n] of use) {
      const [a, b] = key.split('>')
      if (n !== 1 || use.get(`${b}>${a}`) !== 1) unpaired++
    }
    expect(unpaired).toBe(0)
    const before = 2 * (20 * 12 + 20 * 8 + 12 * 8)
    expect(area(positions, indices)).toBeCloseTo(before, 6)
    expect(area(d.positions, d.indices)).toBeCloseTo(before, 6)
  })

  it('leaves a mesh with no edge too long as it is', () => {
    const { positions, indices } = box([1, 1, 1])
    const d = densifyMesh(positions, indices, 8, 5)
    expect(d.report.added).toBe(0)
    expect(Array.from(d.indices)).toEqual(Array.from(indices))
  })

  it('refuses a length that would make too many triangles, and one of nothing', () => {
    const { positions, indices } = box([1000, 1000, 1000])
    expect(() => densifyMesh(positions, indices, 8, 0.01)).toThrow(/longer maximum edge/)
    expect(() => densifyMesh(positions, indices, 8, 0)).toThrow(/above zero/)
  })
})
