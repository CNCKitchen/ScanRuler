// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { mergeLayers } from '../core/merge'
import { identityRigid, rigidCompose, rigidFromAxisAngle, rigidInvert, type Rigid } from '../../../src/core/deviation/rigid'

/** A flat n x n grid of points in z = oz at `step` spacing, normals +z. */
function grid(n: number, step: number, ox = 0, oy = 0, oz = 0) {
  const positions = new Float32Array(n * n * 3)
  const normals = new Float32Array(n * n * 3)
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const k = i * n + j
    positions.set([ox + i * step, oy + j * step, oz], 3 * k)
    normals.set([0, 0, 1], 3 * k)
  }
  return { positions, normals }
}
const move = (x: number, y: number, z: number): Rigid => ({ ...identityRigid(), t: Float64Array.from([x, y, z]) })
const none = { positions: new Float32Array(0), normals: new Float32Array(0) }

describe('mergeLayers', () => {
  it('concatenates with identity baseMap when nothing is deduped', () => {
    const base = grid(4, 1)
    const layer = grid(3, 1, 0, 0, 10)
    const out = mergeLayers({ base, layers: [{ ...layer, pose: identityRigid() }], toFile: identityRigid(), scale: 1, dedupe: null })
    expect(out.positions.length).toBe((16 + 9) * 3)
    expect(out.dropped).toBe(0)
    expect(Array.from(out.baseMap)).toEqual(Array.from({ length: 16 }, (_, i) => i))
    expect(Array.from(out.positions.subarray(0, 48))).toEqual(Array.from(base.positions))
  })

  it('drops layer points within dedupe; count = base + layer - dropped; base never dropped', () => {
    const base = grid(4, 1)
    const layer = grid(4, 1, 0.1, 0, 0) // each point 0.1 from a base point
    const out = mergeLayers({ base, layers: [{ ...layer, pose: identityRigid() }], toFile: identityRigid(), scale: 1, dedupe: 0.2 })
    expect(out.dropped).toBe(16)
    expect(out.positions.length / 3).toBe(16 + 16 - 16)
    expect(Array.from(out.positions)).toEqual(Array.from(base.positions))
  })

  it('keeps layer points farther than dedupe, and never dedupes a layer against itself', () => {
    const layer = { positions: Float32Array.from([5, 5, 5, 5.05, 5, 5]), normals: Float32Array.from([0, 0, 1, 0, 0, 1]) }
    const out = mergeLayers({ base: grid(2, 1), layers: [{ ...layer, pose: identityRigid() }], toFile: identityRigid(), scale: 1, dedupe: 0.2 })
    expect(out.dropped).toBe(0)
    expect(out.positions.length / 3).toBe(6)
  })

  it('applies toFile o pose to positions and rotates normals only', () => {
    const pose = rigidCompose(move(1, 2, 3), rigidFromAxisAngle([0, 1, 0], Math.PI / 2))
    const toFile = move(-4, 0, 7)
    const layer = { positions: Float32Array.from([1, 0, 0]), normals: Float32Array.from([0, 0, 1]) }
    const out = mergeLayers({ base: none, layers: [{ ...layer, pose }], toFile, scale: 1, dedupe: null })
    const m = rigidCompose(toFile, pose)
    expect(out.positions[0]).toBeCloseTo(m.r[0] + m.t[0], 4)
    expect(out.positions[1]).toBeCloseTo(m.r[3] + m.t[1], 4)
    expect(out.positions[2]).toBeCloseTo(m.r[6] + m.t[2], 4)
    // +z turned +90 deg about y is +x; the translation does not touch it
    expect(out.normals[0]).toBeCloseTo(1, 5)
    expect(out.normals[1]).toBeCloseTo(0, 5)
    expect(out.normals[2]).toBeCloseTo(0, 5)
  })

  it('identity poses with dedupe null: base then layers verbatim', () => {
    const base = grid(3, 2)
    const a = grid(3, 2, 0, 0, 1)
    const out = mergeLayers({ base, layers: [{ ...a, pose: identityRigid() }, { ...a, pose: identityRigid() }], toFile: identityRigid(), scale: 1, dedupe: null })
    expect(out.positions.length / 3).toBe(27)
    expect(Array.from(out.positions.subarray(27, 54))).toEqual(Array.from(a.positions))
  })

  it('toFile and scale: a base shown aligned comes back as its file points, scaled', () => {
    // The base is shown as A(raw). Merging with toFile = A^-1 and scale 2 must
    // give 2 * raw, and the shown normals turned back by A^-1 the raw ones.
    const A = rigidCompose(move(5, -3, 2), rigidFromAxisAngle([1, 1, 0], 0.7))
    const raw = grid(5, 1.3)
    const rawN = new Float32Array(raw.normals.length)
    for (let i = 0; i < 25; i++) {
      // Not all alike, so a wrong turn of the normals shows.
      const n = [Math.sin(i), Math.cos(i), 0.5]
      const l = Math.hypot(n[0], n[1], n[2])
      rawN.set([n[0] / l, n[1] / l, n[2] / l], 3 * i)
    }
    const shown = new Float32Array(raw.positions.length)
    const shownN = new Float32Array(raw.positions.length)
    for (let i = 0; i < 25; i++) {
      const x = raw.positions[3 * i], y = raw.positions[3 * i + 1], z = raw.positions[3 * i + 2]
      const u = rawN[3 * i], v = rawN[3 * i + 1], w = rawN[3 * i + 2]
      for (let a = 0; a < 3; a++) {
        shown[3 * i + a] = A.r[3 * a] * x + A.r[3 * a + 1] * y + A.r[3 * a + 2] * z + A.t[a]
        shownN[3 * i + a] = A.r[3 * a] * u + A.r[3 * a + 1] * v + A.r[3 * a + 2] * w
      }
    }
    const s = 2
    const out = mergeLayers({ base: { positions: shown, normals: shownN }, layers: [], toFile: rigidInvert(A), scale: s, dedupe: null })
    for (let i = 0; i < raw.positions.length; i++) {
      expect(Math.abs(out.positions[i] - s * raw.positions[i])).toBeLessThan(1e-4)
      expect(Math.abs(out.normals[i] - rawN[i])).toBeLessThan(1e-5)
    }
  })

  it('dedupe 0 or below keeps every point', () => {
    const base = grid(3, 1)
    for (const dedupe of [0, -1]) {
      const out = mergeLayers({ base, layers: [{ ...base, pose: identityRigid() }], toFile: identityRigid(), scale: 1, dedupe })
      expect(out.dropped).toBe(0)
      expect(out.positions.length / 3).toBe(18)
    }
  })

  it('dedupe is in output units, after the scale', () => {
    // 0.05 apart in the file, 0.5 apart once scaled by 10.
    const base = grid(3, 1)
    const layer = grid(3, 1, 0.05, 0, 0)
    const merge = (dedupe: number) =>
      mergeLayers({ base, layers: [{ ...layer, pose: identityRigid() }], toFile: identityRigid(), scale: 10, dedupe })
    expect(merge(0.2).dropped).toBe(0)
    expect(merge(1).dropped).toBe(9)
  })

  it('a tie on the normal keeps the point already there', () => {
    const l1 = { positions: Float32Array.from([0, 0, 0, 0.1, 0, 0]), normals: Float32Array.from([0, 0, 1, 0, 0, 1]) }
    const l2 = { positions: Float32Array.from([0.01, 0, 0.02]), normals: Float32Array.from([0, 0, 1]) }
    const out = mergeLayers({ base: none, layers: [{ ...l1, pose: identityRigid() }, { ...l2, pose: identityRigid() }], toFile: identityRigid(), scale: 1, dedupe: 0.05 })
    expect(out.dropped).toBe(1)
    expect(Array.from(out.positions)).toEqual(Array.from(l1.positions))
  })

  it('a kept point is replaced once a layer: a second winner near it is only dropped', () => {
    const p1: number[] = [], n1: number[] = []
    for (let i = 0; i < 5; i++) { p1.push(i * 0.1, 0, 0); n1.push(0, 0, 1) }
    const h = Math.SQRT1_2
    p1.push(0.2, 0.05, 0); n1.push(h, 0, h) // tilted, index 5
    const l1 = { positions: Float32Array.from(p1), normals: Float32Array.from(n1) }
    // Both nearest the tilted point, both +z: the first replaces it.
    const l2 = { positions: Float32Array.from([0.2, 0.06, 0.01, 0.2, 0.065, 0.03]), normals: Float32Array.from([0, 0, 1, 0, 0, 1]) }
    const out = mergeLayers({ base: none, layers: [{ ...l1, pose: identityRigid() }, { ...l2, pose: identityRigid() }], toFile: identityRigid(), scale: 1, dedupe: 0.06 })
    expect(out.dropped).toBe(2)
    expect(out.positions.length / 3).toBe(6)
    expect(out.positions[16]).toBeCloseTo(0.06, 5)
    expect(out.positions[17]).toBeCloseTo(0.01, 5)
  })

  it('between layers keeps the point whose normal agrees best with its neighbours', () => {
    const p1: number[] = [], n1: number[] = []
    for (let i = 0; i < 5; i++) { p1.push(i * 0.1, 0, 0); n1.push(0, 0, 1) }
    p1.push(0.2, 0.05, 0)
    const h = Math.SQRT1_2
    n1.push(h, 0, h) // tilted
    const l1 = { positions: Float32Array.from(p1), normals: Float32Array.from(n1) }
    const l2 = { positions: Float32Array.from([0.2, 0.05, 0.01]), normals: Float32Array.from([0, 0, 1]) }
    const out = mergeLayers({ base: none, layers: [{ ...l1, pose: identityRigid() }, { ...l2, pose: identityRigid() }], toFile: identityRigid(), scale: 1, dedupe: 0.2 })
    expect(out.positions.length / 3).toBe(6)
    expect(out.dropped).toBe(1)
    // the tilted point (index 5) was replaced in place by the +z one
    expect(out.normals[15]).toBeCloseTo(0, 5)
    expect(out.normals[17]).toBeCloseTo(1, 5)
    expect(out.positions[17]).toBeCloseTo(0.01, 5)
  })

  it('never replaces a base point, even with a better normal', () => {
    const base = { positions: Float32Array.from([0, 0, 0]), normals: Float32Array.from([1, 0, 0]) }
    const l = { positions: Float32Array.from([0.01, 0, 0]), normals: Float32Array.from([1, 0, 0]) }
    const out = mergeLayers({ base, layers: [{ ...l, pose: identityRigid() }], toFile: identityRigid(), scale: 1, dedupe: 0.1 })
    expect(out.dropped).toBe(1)
    expect(out.positions[0]).toBe(0)
  })
})
