// SPDX-License-Identifier: AGPL-3.0-only
// From occt-wasm 5.17 the kernel merges faces on one surface on a copy of
// the shape: it no longer writes into the edges a boolean's result shares
// with its operands (which could leave an operand broken for the next
// boolean), but when it merges anything, every face it left alone comes
// back under a new hash. What the Reverse engineer reads by hash across a
// merge is held here: the history follows each face to its copy, a face
// copied untouched is known as the face it was (stoodBefore), and a
// join's sliver warning names only the slivers it made — a sliver an
// earlier step left stays out, on every way a join or a combine is played.

import { describe, expect, it, vi } from 'vitest'
import { Builder } from '../core/build'
import type { Feature } from '../core/features'
import { ReKernel, type RawFace } from '../core/kernel'
import { sameFace } from '../core/kernelMath'
import { addRectangle } from '../core/sketch'
import { build, extrudeAll, sketchOf } from './reKit'

vi.setConfig({ testTimeout: 120_000 })

const kernelPromise = ReKernel.load()

type Vec3 = [number, number, number]
const near = (a: Vec3, b: Vec3, tol = 1e-6) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) <= tol

/** A box 20 × 20 × 10 with its vertical edge at (0, 0) rounded R2, and
 *  the outline of its top at z 10 — occt-wasm's own case (its issue 462).
 *  On occt-wasm 5.15 a join of a boss on the whole top, merged as tracked
 *  merges it, wrote into the base's edges, and the base joined again came
 *  out invalid. */
async function filleted() {
  const k = await kernelPromise
  const box = k.box([0, 0, 0], [20, 20, 10])
  const edge = k.edges(box, 0.1).find((e) => near(e.mid, [0, 0, 5], 1e-3))!
  const base = k.filletTracked(box, [edge.hash], 2).shape
  k.release(box)
  const m = 2 - 2 * Math.SQRT1_2
  const top = k.face({
    outer: [
      { kind: 'line', a: [2, 0, 10], b: [20, 0, 10] },
      { kind: 'line', a: [20, 0, 10], b: [20, 20, 10] },
      { kind: 'line', a: [20, 20, 10], b: [0, 20, 10] },
      { kind: 'line', a: [0, 20, 10], b: [0, 2, 10] },
      { kind: 'arc', a: [0, 2, 10], m: [m, m, 10], b: [2, 0, 10] },
    ],
    holes: [],
  })
  /** A boss on the whole top, `h` tall: its walls lie on the box's. */
  const boss = (h: number) => k.extrude(top, [0, 0, 1], 0, h)
  return { k, base, top, boss }
}

describe('a merge of faces on one surface', () => {
  it('leaves the operands sound: the base joined again after a merging join is valid, of the volume it should be', async () => {
    const { k, base, top, boss } = await filleted()
    const tall = boss(5)
    const joined = k.fuseTracked(base, tall)
    // The boss's walls and the box's merged: 7 faces, as the base has.
    expect(k.faceHashes(joined.shape)).toHaveLength(7)
    const again = boss(3)
    const twice = k.fuseTracked(base, again)
    expect(k.isValid(twice.shape)).toBe(true)
    expect(k.volume(twice.shape)).toBeCloseTo(k.volume(base) + k.volume(again), 6)
    k.release(base, top, tall, joined.shape, again, twice.shape)
  })

  it('traces every face of the operands through the merge: one left alone to the face it is now, two merged to the one', async () => {
    const { k, base, top, boss } = await filleted()
    const tall = boss(5)
    const before = [...k.faces(base), ...k.faces(tall)]
    const joined = k.fuseTracked(base, tall)
    const after = k.faces(joined.shape)
    const now = new Set(after.map((f) => f.hash))
    // The box's top and the boss's foot meet inside: gone. Every other
    // face is in the result, by its hash or by the history.
    const inside = before.filter((f) => f.kind === 'plane' && Math.abs(f.centroid[2] - 10) < 1e-6)
    expect(inside).toHaveLength(2)
    for (const f of before) {
      if (inside.includes(f)) continue
      const became = now.has(f.hash) ? [f.hash] : (joined.history.get(f.hash) ?? [])
      expect(became.length, `face at ${f.centroid}`).toBeGreaterThan(0)
      for (const h of became) expect(now.has(h)).toBe(true)
    }
    // The bottom, which nothing touched, is one face — itself, or its copy.
    const bottom = before.find((f) => f.kind === 'plane' && Math.abs(f.centroid[2]) < 1e-9)!
    const bottomNow = now.has(bottom.hash) ? [bottom.hash] : joined.history.get(bottom.hash)!
    expect(bottomNow).toHaveLength(1)
    expect(sameFace(bottom, after.find((f) => f.hash === bottomNow[0])!, 30)).toBe(true)
    // The box's front (y 0) and the boss's are the one front now.
    const fronts = before.filter((f) => f.kind === 'plane' && near(f.dir, [0, -1, 0]) && f.centroid[1] === 0)
    expect(fronts).toHaveLength(2)
    const into = fronts.map((f) => joined.history.get(f.hash) ?? [f.hash])
    expect(into[0]).toHaveLength(1)
    expect(into[1]).toEqual(into[0])
    k.release(base, top, tall, joined.shape)
  })

  it('knows a face copied untouched as one that stood before (stoodBefore); a face the join merged is new', async () => {
    const { k, base, top, boss } = await filleted()
    const tall = boss(5)
    const joined = k.fuseTracked(base, tall)
    const after = k.faces(joined.shape)
    const stood = k.stoodBefore([base, tall], joined.shape)
    const bottom = after.find((f) => Math.abs(f.centroid[2]) < 1e-9)!
    const roof = after.find((f) => Math.abs(f.centroid[2] - 15) < 1e-9)!
    expect(stood.has(bottom.hash)).toBe(true)
    expect(stood.has(roof.hash)).toBe(true)
    // The walls are each two faces merged into one twice the height.
    const walls = after.filter((f) => f !== bottom && f !== roof)
    expect(walls).toHaveLength(5)
    for (const w of walls) expect(stood.has(w.hash)).toBe(false)
    expect(stood.size).toBe(2)
    // Asked of some faces, it answers of those alone.
    expect([...k.stoodBefore([base, tall], joined.shape, [roof.hash, walls[0].hash])]).toEqual([roof.hash])
    expect(k.stoodBefore([base, tall], joined.shape, []).size).toBe(0)
    k.release(base, top, tall, joined.shape)
  })

  it('takes a body against itself as all stood, and a body of other faces as none', async () => {
    const k = await kernelPromise
    const a = k.box([0, 0, 0], [10, 10, 10])
    const b = k.box([0, 0, 0], [10, 10, 11])
    expect(k.stoodBefore([a], a).size).toBe(6)
    // The bottom is b's too, to the micron: the same face of another box.
    // The walls and the top are not.
    const stood = k.stoodBefore([a], b)
    expect(stood.size).toBe(1)
    const bottom = k.faces(b).find((f) => Math.abs(f.centroid[2]) < 1e-9)!
    expect(stood.has(bottom.hash)).toBe(true)
    k.release(a, b)
  })
})

describe('sameFace', () => {
  const plane: RawFace = { hash: 1, kind: 'plane', centroid: [5, 5, 0], dir: [0, 0, -1], area: 100 }
  it('holds a face to its kind, place, way and size, to a millionth', () => {
    expect(sameFace(plane, { ...plane, hash: 2 }, 20)).toBe(true)
    expect(sameFace(plane, { ...plane, area: 100 * (1 + 1e-9) }, 20)).toBe(true)
    expect(sameFace(plane, { ...plane, area: 100.01 }, 20)).toBe(false)
    expect(sameFace(plane, { ...plane, centroid: [5, 5, 1e-3] }, 20)).toBe(false)
    expect(sameFace(plane, { ...plane, dir: [0, 0, 1] }, 20)).toBe(false)
    expect(sameFace(plane, { ...plane, kind: 'cylinder' }, 20)).toBe(false)
  })
  it('holds a round face to its radius', () => {
    const round: RawFace = { hash: 1, kind: 'cylinder', centroid: [0, 0, 5], dir: [0, 0, 1], area: 62.8, radius: 1 }
    expect(sameFace(round, { ...round, hash: 2 }, 20)).toBe(true)
    expect(sameFace(round, { ...round, radius: 1.001 }, 20)).toBe(false)
    expect(sameFace(round, { ...round, radius: undefined }, 20)).toBe(false)
  })
})

// ---- a sliver an earlier step left is not the join's ---------------------------

/** Three blocks on z 0, 10 deep: A x 0…10 and C x 12…20 10 tall, B x 5…15
 *  10.005 tall — B's top stands 0.005 above both, a riser a sliver wide at
 *  x 5 and one at x 15 — as `join(id, sketch, block)` puts each on. */
async function threeBlocks(join: (id: number, block: Feature & { kind: 'extrude' }) => Feature[]) {
  const builder = new Builder(await kernelPromise)
  const a = sketchOf(1, (s) => addRectangle(s, [0, 0], [10, 10]))
  const b = sketchOf(3, (s) => addRectangle(s, [5, 0], [15, 10]))
  const c = sketchOf(5, (s) => addRectangle(s, [12, 0], [20, 10]))
  const features = [a, extrudeAll(2, a, 0, 10, 'new'), b, ...join(4, extrudeAll(4, b, 0, 10.005, 'new')), c, ...join(6, extrudeAll(6, c, 0, 10, 'new'))]
  const out = await build(builder, features)
  builder.dispose()
  return out.results
}

const SLIVER_AT_5 = /^The (join|combine) left 1 sliver face, under 0\.01 mm wide: 0\.005 mm wide at \(5\.00, 5\.00, 10\.00\) — /
const SLIVER_AT_15 = /^The (join|combine) left 1 sliver face, under 0\.01 mm wide: 0\.005 mm wide at \(15\.00, 5\.00, 10\.00\) — /

describe('a join names only the slivers it made', () => {
  it('on a join on the body a feature names (target)', async () => {
    const results = await threeBlocks((_, block) => [{ ...block, op: 'join', target: 2 }])
    expect(results.find((r) => r.id === 4)?.warning).toMatch(SLIVER_AT_5)
    expect(results.find((r) => r.id === 6)?.warning).toMatch(SLIVER_AT_15)
  })

  it('on a Combine of bodies apart', async () => {
    const combine = (id: number): Feature => ({ id: id + 100, kind: 'boolean', name: `Combine ${id}`, op: 'join', body: 2, tool: id, keep: false, visible: true })
    const results = await threeBlocks((id, block) => [block, combine(id)])
    expect(results.find((r) => r.id === 104)?.warning).toMatch(SLIVER_AT_5)
    expect(results.find((r) => r.id === 106)?.warning).toMatch(SLIVER_AT_15)
  })
})
