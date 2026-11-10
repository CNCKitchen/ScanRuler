// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { sliceCloud } from '../src/core/section/sliceCloud'
import type { SectionCut } from '../src/core/section/slice'
import { cylinderCloud, gearCloud, planeCloud } from './cloudFixtures'

const chains = (cut: SectionCut): Float32Array[] => {
  const out: Float32Array[] = []
  for (let c = 0; c + 1 < cut.offsets.length; c++) out.push(cut.points.subarray(cut.offsets[c] * 3, cut.offsets[c + 1] * 3))
  return out
}
const closed = (pts: Float32Array): boolean => {
  const n = pts.length / 3
  return n > 2 && pts[0] === pts[(n - 1) * 3] && pts[1] === pts[(n - 1) * 3 + 1] && pts[2] === pts[(n - 1) * 3 + 2]
}
const pathLength = (pts: Float32Array): number => {
  let l = 0
  for (let i = 3; i < pts.length; i += 3) l += Math.hypot(pts[i] - pts[i - 3], pts[i + 1] - pts[i - 2], pts[i + 2] - pts[i - 1])
  return l
}

describe('sliceCloud', () => {
  it('cuts a cylinder square to its axis into one closed ring on its radius, sides facing out', () => {
    const c = cylinderCloud({ radius: 10, length: 20, step: 0.3 })
    const cut = sliceCloud(c.positions, c.normals, 0.3, [0, 0, 0.05], [0, 0, 1])
    const cs = chains(cut)
    expect(cs).toHaveLength(1)
    expect(closed(cs[0])).toBe(true)
    for (let i = 0; i < cs[0].length; i += 3) {
      const x = cs[0][i], y = cs[0][i + 1]
      const r = Math.hypot(x, y)
      expect(Math.abs(r - 10)).toBeLessThan(0.15)
      expect(Math.abs(cs[0][i + 2] - 0.05)).toBeLessThan(1e-4)
      const at = cut.offsets[0] * 3 + i
      expect((cut.normals![at] * x + cut.normals![at + 1] * y) / r).toBeGreaterThan(0.9)
    }
  })

  it('keeps one open chain across a density seam', () => {
    const c = planeCloud({ size: 40, step: 0.3, denseHalf: true })
    const cut = sliceCloud(c.positions, c.normals, 0.3, [0, 0.07, 0], [0, 1, 0])
    const cs = chains(cut)
    expect(cs).toHaveLength(1)
    expect(closed(cs[0])).toBe(false)
    expect(Math.abs(pathLength(cs[0]) - 40)).toBeLessThan(1)
  })

  it('answers an empty cut for a plane that misses the cloud', () => {
    const c = planeCloud({ size: 40, step: 0.3 })
    const cut = sliceCloud(c.positions, c.normals, 0.3, [0, 0, 5], [0, 0, 1])
    expect(cut.offsets.length).toBe(1)
    expect(cut.points.length).toBe(0)
  })

  it('cuts a gear into its toothed outline and its bore, the teeth at the tip radius', () => {
    const g = gearCloud({ teeth: 15, tipRadius: 25, rootRadius: 21, width: 12, boreRadius: 6, step: 0.3 })
    const cut = sliceCloud(g.positions, g.normals, 0.3, [0, 0, 0.05], [0, 0, 1])
    const cs = chains(cut)
    expect(cs).toHaveLength(2)
    for (const ch of cs) expect(closed(ch)).toBe(true)
    const outer = cs.reduce((a, b) => (pathLength(a) > pathLength(b) ? a : b))
    // Teeth: runs of points beyond the mid radius.
    let teeth = 0
    let out = false
    let maxR = 0
    for (let i = 0; i < outer.length; i += 3) {
      const r = Math.hypot(outer[i], outer[i + 1])
      maxR = Math.max(maxR, r)
      if (r > 23 && !out) teeth++
      out = r > 23 ? true : r < 23 ? false : out
    }
    // A loop starting inside a tooth counts it twice.
    const r0 = Math.hypot(outer[0], outer[1])
    if (r0 > 23) teeth--
    expect(teeth).toBe(15)
    expect(Math.abs(maxR - 25)).toBeLessThan(0.2)
  })

  it('drops chains shorter than minLength', () => {
    const c = cylinderCloud({ radius: 1, length: 4, step: 0.1 })
    const cut = sliceCloud(c.positions, c.normals, 0.1, [0, 0, 0.03], [0, 0, 1], { minLength: 10 })
    expect(cut.offsets.length).toBe(1)
  })

  it('keeps a thin wall’s two faces two loops', () => {
    // A 1 mm wall at 0.25 spacing: its faces lie four spacings apart, nearer
    // than the cells are joined across — but they face away from each other.
    const outer = cylinderCloud({ radius: 10, length: 4, step: 0.25 })
    const inner = cylinderCloud({ radius: 9, length: 4, step: 0.25 })
    const positions = new Float32Array([...outer.positions, ...inner.positions])
    const normals = new Float32Array([...outer.normals, ...[...inner.normals].map((v) => -v)])
    const cs = chains(sliceCloud(positions, normals, 0.25, [0, 0, 0.03], [0, 0, 1]))
    expect(cs).toHaveLength(2)
    for (const ch of cs) {
      expect(closed(ch)).toBe(true)
      const r = Math.hypot(ch[0], ch[1])
      for (let i = 0; i < ch.length; i += 3) expect(Math.abs(Math.hypot(ch[i], ch[i + 1]) - r)).toBeLessThan(0.15)
    }
  })

  it('leaves a split ring open across its gap', () => {
    // A ring cut through by a 0.8 mm slot, a little over three spacings: wider
    // than the cells read (two spacings), so it shows.
    const ring = cylinderCloud({ radius: 10, length: 4, step: 0.25 })
    const keep: number[] = []
    for (let i = 0; i < ring.positions.length / 3; i++) if (!(ring.positions[i * 3] > 0 && Math.abs(ring.positions[i * 3 + 1]) < 0.4)) keep.push(i)
    const pick = (a: Float32Array) => Float32Array.from(keep.flatMap((i) => [a[i * 3], a[i * 3 + 1], a[i * 3 + 2]]))
    const cs = chains(sliceCloud(pick(ring.positions), pick(ring.normals), 0.25, [0, 0, 0.03], [0, 0, 1]))
    expect(cs).toHaveLength(1)
    expect(closed(cs[0])).toBe(false)
  })
})
