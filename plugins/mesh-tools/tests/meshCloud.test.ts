// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { meshCloud } from '../core/meshCloud'
import { planeCloud, sphereCloud, type Cloud } from '../../../tests/cloudFixtures'

/** How many triangles share each edge, keyed by its two vertices. */
const edgeUses = (indices: Uint32Array): Map<string, number> => {
  const uses = new Map<string, number>()
  for (let t = 0; t < indices.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = indices[t + k]
      const b = indices[t + ((k + 1) % 3)]
      const key = a < b ? `${a},${b}` : `${b},${a}`
      uses.set(key, (uses.get(key) ?? 0) + 1)
    }
  }
  return uses
}

const signedVolume = (p: Float32Array, idx: Uint32Array): number => {
  let v = 0
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3
    v += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])
  }
  return v / 6
}

const filter = (c: Cloud, keep: (x: number, y: number, z: number) => boolean): Cloud => {
  const p: number[] = []
  const n: number[] = []
  for (let i = 0; i < c.positions.length; i += 3) {
    if (!keep(c.positions[i], c.positions[i + 1], c.positions[i + 2])) continue
    p.push(c.positions[i], c.positions[i + 1], c.positions[i + 2])
    n.push(c.normals[i], c.normals[i + 1], c.normals[i + 2])
  }
  return { positions: Float32Array.from(p), normals: Float32Array.from(n) }
}

describe('meshCloud', () => {
  it('meshes a sphere cloud into a closed skin on its radius, facing out', () => {
    const c = sphereCloud({ radius: 10, step: 0.3 })
    const m = meshCloud(c.positions, c.normals, 0.3)
    expect(m.indices.length).toBeGreaterThan(0)
    for (const uses of edgeUses(m.indices).values()) expect(uses).toBe(2)
    let sum = 0
    let worst = 0
    const n = m.positions.length / 3
    for (let i = 0; i < n; i++) {
      const off = Math.hypot(m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2]) - 10
      sum += off
      worst = Math.max(worst, Math.abs(off))
    }
    expect(Math.abs(sum / n)).toBeLessThan(0.05)
    expect(worst).toBeLessThan(0.2)
    expect(signedVolume(m.positions, m.indices)).toBeGreaterThan(0)
    expect(m.report.triangles).toBe(m.indices.length / 3)
  })

  it('keeps an open scan open: a hemisphere gets no cap', () => {
    const c = filter(sphereCloud({ radius: 10, step: 0.3 }), (_x, _y, z) => z > 0)
    const m = meshCloud(c.positions, c.normals, 0.3)
    expect([...edgeUses(m.indices).values()].some((u) => u === 1)).toBe(true)
    // No cap across the opening: nothing lies inside the rim near its plane,
    // and the rim runs on past the last points by no more than the trim.
    for (let i = 0; i < m.positions.length; i += 3) {
      const x = m.positions[i], y = m.positions[i + 1], z = m.positions[i + 2]
      if (z < 2) expect(Math.hypot(x, y)).toBeGreaterThan(9.5)
      expect(z).toBeGreaterThan(-1.5 * m.report.cell - 1e-3)
    }
  })

  it('meshes a flat patch into one open sheet on its plane', () => {
    const c = planeCloud({ size: 20, step: 0.3 })
    const m = meshCloud(c.positions, c.normals, 0.3)
    expect(m.indices.length).toBeGreaterThan(0)
    expect(m.report.pieces).toBe(1)
    for (let i = 2; i < m.positions.length; i += 3) expect(Math.abs(m.positions[i])).toBeLessThan(0.05)
  })

  it('refuses a grid past its budget before it is made, naming a cell that fits', () => {
    const c = sphereCloud({ radius: 10, step: 0.3 })
    expect(() => meshCloud(c.positions, c.normals, 0.3, { maxCells: 1000 })).toThrow(/cells.*give a cell of at least [\d.]+ mm/)
  })

  it('takes no cell finer than a two-thousandth of the part', () => {
    const c = sphereCloud({ radius: 10, step: 0.3 })
    const m = meshCloud(c.positions, c.normals, 0.3, { cell: 1e-6, maxCells: 2_000_000 })
    // The box of the points, a little under the sphere's, sets the floor.
    expect(m.report.cell).toBeGreaterThan(0.99 * (Math.hypot(20, 20, 20) / 2000))
  })
})
