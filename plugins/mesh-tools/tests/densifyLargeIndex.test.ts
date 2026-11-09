// SPDX-License-Identifier: AGPL-3.0-only
// Densify on a mesh past vertex 2²¹ (2,097,152), as a big scan or a densified
// CAD export soon is. The middle each long edge gets was found again by a key
// of lo · 2³² + hi, which past that vertex is no longer an exact double: two
// edges can share a key, and the second is given the first's middle — a point
// off its edge, a crack where the two triangles on it no longer meet. The box
// here is numbered from vertex 3,000,000 on; cut down, it has to stay closed
// (every edge used once each way round) with its area unchanged, as it does
// numbered from 0 (densify.test.ts).
import { describe, expect, it } from 'vitest'
import { densifyMesh } from '../core/densify'

const OFF = 3_000_000

function offsetBox(size: [number, number, number]): { positions: Float32Array; indices: Uint32Array; count: number } {
  const [x, y, z] = size
  const corners = [0, 0, 0, x, 0, 0, x, y, 0, 0, y, 0, 0, 0, z, x, 0, z, x, y, z, 0, y, z]
  const positions = new Float32Array((OFF + 8) * 3)
  positions.set(corners, OFF * 3)
  const box = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]
  return { positions, indices: Uint32Array.from(box, (v) => v + OFF), count: OFF + 8 }
}

function area(p: Float32Array, idx: Uint32Array): number {
  let s = 0
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2]
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2]
    s += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2
  }
  return s
}

describe('densify past vertex 2²¹', () => {
  it('keeps a box numbered from vertex 3,000,000 closed, its area unchanged', () => {
    const { positions, indices, count } = offsetBox([30, 20, 10])
    const d = densifyMesh(positions, indices, count, 1.5)
    expect(d.report.longest).toBeLessThanOrEqual(1.5 + 1e-9)
    const use = new Map<string, number>()
    for (let t = 0; t < d.indices.length; t += 3) {
      for (let k = 0; k < 3; k++) {
        const key = `${d.indices[t + k]}>${d.indices[t + ((k + 1) % 3)]}`
        use.set(key, (use.get(key) ?? 0) + 1)
      }
    }
    let unpaired = 0
    for (const [key, n] of use) {
      const [a, b] = key.split('>')
      if (n !== 1 || use.get(`${b}>${a}`) !== 1) unpaired++
    }
    expect(unpaired).toBe(0)
    expect(area(d.positions, d.indices)).toBeCloseTo(2 * (30 * 20 + 30 * 10 + 20 * 10), 6)
  })
})
