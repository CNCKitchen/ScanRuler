// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { clusterIndices, MotionLatch, SlowMotion } from '../src/viewer/lod'

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

  it('keeps every triangle facing the way the scan faces', () => {
    // A rough plate facing +Z, its vertices jittered within their quads as a
    // scan's are. Clustering turned some triangles over, and the viewer drew
    // them as black specks while the view turned.
    const n = 200
    const g = grid(n)
    let seed = 7
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5
    for (let v = 0; v < g.positions.length / 3; v++) {
      g.positions[v * 3] += 0.45 * rand()
      g.positions[v * 3 + 1] += 0.45 * rand()
      g.positions[v * 3 + 2] = 0.3 * rand()
    }
    const cut = clusterIndices(g.positions, g.indices, 5000)!
    const p = g.positions
    let down = 0
    for (let t = 0; t < cut.length; t += 3) {
      const [a, b, c] = [cut[t], cut[t + 1], cut[t + 2]]
      const nz =
        (p[b * 3] - p[a * 3]) * (p[c * 3 + 1] - p[a * 3 + 1]) - (p[b * 3 + 1] - p[a * 3 + 1]) * (p[c * 3] - p[a * 3])
      if (nz < 0) down++
    }
    expect(down).toBe(0)
  })

  it('keeps a thin wall’s two skins apart', () => {
    // A sheet 0.3 thick: a top skin facing +Z and a bottom one facing −Z,
    // on a grid of cells wider than the sheet. A top triangle built on a
    // bottom vertex took its inward normal and drew black (the vent cover
    // scan, 2026-11-08).
    const n = 150
    const top = grid(n)
    const count = top.positions.length / 3
    const positions = new Float32Array(count * 6)
    const normals = new Float32Array(count * 6)
    let seed = 11
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5
    for (let v = 0; v < count; v++) {
      const x = top.positions[v * 3] + 0.3 * rand(), y = top.positions[v * 3 + 1] + 0.3 * rand()
      // Interleaved, so a cell meets the two skins in no set order.
      const [first, second] = v % 2 ? [v, count + v] : [count + v, v]
      positions.set([x, y, 0.15], first * 3)
      normals.set([0, 0, 1], first * 3)
      positions.set([x + 0.1 * rand(), y + 0.1 * rand(), -0.15], second * 3)
      normals.set([0, 0, -1], second * 3)
    }
    // Map the top grid's vertex v to its slot, and wind the bottom reversed.
    const slotTop = (v: number) => (v % 2 ? v : count + v)
    const slotBottom = (v: number) => (v % 2 ? count + v : v)
    const indices: number[] = []
    for (let t = 0; t < top.indices.length; t += 3) {
      const [a, b, c] = [top.indices[t], top.indices[t + 1], top.indices[t + 2]]
      indices.push(slotTop(a), slotTop(b), slotTop(c), slotBottom(a), slotBottom(c), slotBottom(b))
    }
    const cut = clusterIndices(positions, Uint32Array.from(indices), 6000, normals)!
    expect(cut.length / 3).toBeGreaterThan(2000)
    let mixed = 0
    for (let t = 0; t < cut.length; t += 3) {
      const z = [cut[t], cut[t + 1], cut[t + 2]].map((v) => normals[v * 3 + 2])
      if (!(z.every((v) => v > 0) || z.every((v) => v < 0))) mixed++
    }
    expect(mixed).toBe(0)
  })

  it('holds motion until the camera settles', () => {
    const latch = new MotionLatch(100)
    expect(latch.update([1, 0], 0)).toBe(false)
    expect(latch.update([2, 0], 10)).toBe(true)
    expect(latch.update([2, 0], 90)).toBe(true)
    expect(latch.update([2, 0], 111)).toBe(false)
  })

  it('wants the proxy only once the full scan turns slowly', () => {
    // 60 frames a second while turning: never.
    const quick = new SlowMotion(50)
    for (let i = 0; i < 100; i++) expect(quick.note(i * 16.7, true)).toBe(false)
    // 12 a second: after a dozen moving frames, and then for good.
    const slow = new SlowMotion(50)
    let t = 0
    const seen: boolean[] = []
    for (let i = 0; i < 20; i++) seen.push(slow.note((t += 83), true))
    expect(seen.slice(0, 12).every((v) => !v)).toBe(true)
    expect(seen[19]).toBe(true)
    expect(slow.note((t += 5), false)).toBe(true)
    slow.reset()
    expect(slow.note((t += 83), true)).toBe(false)
  })

  it('does not take a pause in a drag, or frames the view held still on, for slow ones', () => {
    const gate = new SlowMotion(50)
    let t = 0
    for (let round = 0; round < 10; round++) {
      // Two quick moving frames, then a long still stretch and a pause.
      gate.note((t += 16), true)
      gate.note((t += 16), true)
      gate.note((t += 200), false)
      expect(gate.note((t += 900), true)).toBe(false)
    }
  })
})
