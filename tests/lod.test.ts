// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { clusterIndices, MotionLatch } from '../src/viewer/lod'

/** A flat grid of side `n` quads, two triangles each. */
function grid(n: number): { positions: Float32Array; indices: Uint32Array } {
  const positions = new Float32Array((n + 1) * (n + 1) * 3)
  for (let y = 0; y <= n; y++) for (let x = 0; x <= n; x++) positions.set([x, y, 0], (y * (n + 1) + x) * 3)
  const indices: number[] = []
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const a = y * (n + 1) + x
    indices.push(a, a + 1, a + n + 1, a + 1, a + n + 2, a + n + 1)
  }
  return { positions, indices: Uint32Array.from(indices) }
}

describe('level of detail', () => {
  it('leaves a small mesh alone', () => {
    const g = grid(10)
    expect(clusterIndices(g.positions, g.indices, 1000)).toBeNull()
  })

  it('cuts a big mesh to near the budget over its own vertices', () => {
    const g = grid(200)
    const cut = clusterIndices(g.positions, g.indices, 5000)!
    const tris = cut.length / 3
    expect(tris).toBeLessThan(g.indices.length / 3)
    expect(tris).toBeGreaterThan(2000)
    expect(tris).toBeLessThan(8000)
    const vertices = g.positions.length / 3
    for (let t = 0; t < cut.length; t += 3) {
      expect(cut[t] < vertices && cut[t] !== cut[t + 1] && cut[t + 1] !== cut[t + 2]).toBe(true)
    }
  })

  it('holds motion until the camera settles', () => {
    const latch = new MotionLatch(100)
    expect(latch.update([1, 0], 0)).toBe(false)
    expect(latch.update([2, 0], 10)).toBe(true)
    expect(latch.update([2, 0], 90)).toBe(true)
    expect(latch.update([2, 0], 111)).toBe(false)
  })
})
