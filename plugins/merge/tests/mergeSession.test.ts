// SPDX-License-Identifier: AGPL-3.0-only
// The Merge workspace's session on the real worker: the first file becomes
// the scan, a layer opens as a row, its colour, visibility, lock and units
// change, it is moved and aligned onto the base or onto another layer, a
// refine from no one's guess is never confident, and the layers go with a
// new scan or on leaving the workspace.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { identityRigid, rigidCompose, rigidInvert } from '../../../src/core/deviation/rigid'
import { useShell } from '../../../src/state/shellStore'
import { useStore } from '../../../src/state/store'
import { applyRigidCloud, rigidOf } from '../../../tests/cloudFixtures'
import { BASE } from '../core/protocol'
import { useMerge } from '../state/mergeStore'
import { delta, hi, layerPart, moved, nudged, plyFile, POSE, startMerge, TRUE, type MergeKit } from './mergeKit'

vi.setConfig({ testTimeout: 120_000 })

let kit: MergeKit
beforeAll(async () => {
  kit = await startMerge()
}, 60_000)
afterAll(() => kit.stop())

const layers = () => useMerge.getState().layers
const row = (id: string) => layers().find((l) => l.id === id)!

/** A fresh session with the +x half open as the scan, in the workspace. */
async function withBase() {
  kit.merge.dropLayers(true)
  useStore.setState({ fileName: null })
  await kit.merge.openLayer(plyFile(hi, 'hi.ply'), 'mm')
  useShell.getState().setWorkspace('merge')
}

describe('opening files in Merge', () => {
  beforeEach(() => kit.merge.dropLayers(true))

  it('takes the first file as the scan when none is open', async () => {
    useStore.setState({ fileName: null })
    const id = await kit.merge.openLayer(plyFile(hi, 'hi.ply'), 'mm')
    expect(id).toBe(BASE)
    expect(useStore.getState().fileName).toBe('hi.ply')
    expect(useStore.getState().scanIsCloud).toBe(true)
    expect(layers()).toEqual([])
  })

  it('opens the next file as a layer row', async () => {
    await withBase()
    const id = await kit.merge.openLayer(plyFile(layerPart, 'lo.ply'), 'mm')
    const r = row(id)
    expect(r).toMatchObject({ id, name: 'lo.ply', visible: true, units: 'mm', locked: false, isCloud: true })
    expect(r.vertexCount).toBeGreaterThan(1000)
    expect(r.color).toMatch(/^#[0-9a-f]{6}$/)
    expect(Array.from(r.pose.r)).toEqual(Array.from(identityRigid().r))
    expect(kit.merge.layers()).toBe(layers())
    // The worker holds it under the same id.
    const geo = await kit.call('layer-geometry', { id })
    expect(geo.positions.length).toBe(r.vertexCount * 3)
    // A second layer takes another colour.
    const other = await kit.merge.openLayer(plyFile(layerPart, 'lo2.ply'), 'mm')
    expect(row(other).color).not.toBe(r.color)
  })
})

describe('a layer row', () => {
  beforeEach(withBase)

  it('changes colour and visibility, locks, and is removed', async () => {
    const id = await kit.merge.openLayer(plyFile(layerPart, 'lo.ply'), 'mm')
    await kit.merge.setLayer(id, { color: '#123456', visible: false })
    expect(row(id)).toMatchObject({ color: '#123456', visible: false })
    await kit.merge.setLayer(id, { locked: true })
    expect(row(id).locked).toBe(true)
    // A locked layer ignores a move and an alignment.
    expect(kit.merge.moveLayer(id, rigidOf([0, 0, 10], [1, 2, 3]))).toBe(false)
    expect(await kit.merge.refine(id, BASE)).toBeNull()
    expect(await kit.merge.alignPairs(id, BASE, [])).toBeNull()
    expect(Array.from(row(id).pose.t)).toEqual([0, 0, 0])
    await kit.merge.setLayer(id, { locked: false })
    expect(kit.merge.moveLayer(id, rigidOf([0, 0, 10], [1, 2, 3]))).toBe(true)
    await kit.merge.removeLayer(id)
    expect(layers()).toEqual([])
    await expect(kit.call('layer-geometry', { id })).rejects.toThrow(`There is no layer "${id}".`)
  })

  it('reads a layer again in inches, scaled about its centre where it was laid', async () => {
    const id = await kit.merge.openLayer(plyFile(layerPart, 'lo.ply'), 'mm')
    const before = (await kit.call('layer-geometry', { id })).positions
    const pose = rigidOf([5, 10, -20], [3, 4, 5])
    kit.merge.moveLayer(id, pose)
    const spacing = row(id).spacing
    // The middle of the layer's box, where the pose puts it.
    const box = (p: Float32Array) => {
      const lo = [Infinity, Infinity, Infinity], up = [-Infinity, -Infinity, -Infinity]
      for (let i = 0; i < p.length; i += 3) for (let c = 0; c < 3; c++) { lo[c] = Math.min(lo[c], p[i + c]); up[c] = Math.max(up[c], p[i + c]) }
      return [0, 1, 2].map((c) => (lo[c] + up[c]) / 2) as [number, number, number]
    }
    const centre = moved(pose, box(before))
    await kit.merge.setLayer(id, { units: 'in' })
    expect(row(id).units).toBe('in')
    expect(row(id).spacing).toBeCloseTo(spacing * 25.4, 3)
    const after = (await kit.call('layer-geometry', { id })).positions
    expect(after[0]).toBeCloseTo(before[0] * 25.4, 2)
    const now = moved(row(id).pose, box(after))
    for (let c = 0; c < 3; c++) expect(now[c]).toBeCloseTo(centre[c], 3)
    // Rotation is untouched.
    expect(Array.from(row(id).pose.r)).toEqual(Array.from(pose.r))
  })
})

describe('aligning a layer', () => {
  beforeEach(withBase)

  it('aligns from picked pairs onto the base and remembers the result', async () => {
    const id = await kit.merge.openLayer(plyFile(layerPart, 'lo.ply'), 'mm')
    const pick = (p: [number, number, number]) => ({ layer: moved(TRUE, p), target: p })
    const r = await kit.merge.alignPairs(id, BASE, [pick([-8, -15, 10]), pick([5, 15, -10]), pick([8, -15, -10])])
    expect(r).not.toBeNull()
    const d = delta(row(id).pose, POSE)
    expect(d.deg).toBeLessThanOrEqual(0.05)
    expect(d.mm).toBeLessThanOrEqual(0.02)
    expect(row(id).last).toMatchObject({ confident: true, lowOverlap: false })
  })

  it('refines from where nobody put it: never confident', async () => {
    const id = await kit.merge.openLayer(plyFile(applyRigidCloud(layerPart, identityRigid()), 'lo.ply'), 'mm')
    // The layer opened where it was scanned; a refine from there is no one's guess.
    const r = await kit.merge.refine(id, BASE)
    expect(r).not.toBeNull()
    expect(r!.confident).toBe(false)
    expect(row(id).last!.confident).toBe(false)
    expect(useStore.getState().statusText).toMatch(/start nobody chose|Low overlap/)
  })

  it('refines from a pose the user gave: confident, and the pose recovered', async () => {
    const id = await kit.merge.openLayer(plyFile(layerPart, 'lo.ply'), 'mm')
    kit.merge.moveLayer(id, nudged(POSE))
    const r = await kit.merge.refine(id, BASE)
    expect(r!.confident).toBe(true)
    const d = delta(row(id).pose, POSE)
    expect(d.deg).toBeLessThanOrEqual(0.05)
    expect(d.mm).toBeLessThanOrEqual(0.02)
  })

  it('refines onto another layer: the answer, in that layer\'s frame, is carried on by its pose', async () => {
    // The target layer is the +x half scanned in its own frame OTHER off,
    // laid on the base by OTHER^-1.
    const OTHER = rigidOf([-5, 9, 3], [-4, 2, 1])
    const t = await kit.merge.openLayer(plyFile(applyRigidCloud(hi, OTHER), 't.ply'), 'mm')
    kit.merge.moveLayer(t, rigidInvert(OTHER))
    const a = await kit.merge.openLayer(plyFile(layerPart, 'lo.ply'), 'mm')
    kit.merge.moveLayer(a, nudged(POSE))
    const r = await kit.merge.refine(a, t)
    expect(r!.confident).toBe(true)
    // Into the base as shown: OTHER^-1 o (OTHER o POSE).
    const d = delta(row(a).pose, POSE)
    expect(d.deg).toBeLessThanOrEqual(0.05)
    expect(d.mm).toBeLessThanOrEqual(0.02)
    expect(r!.pose).toBe(row(a).pose)
  })

  it('aligns by datums fitted on each side, and refuses one datum a side', async () => {
    const id = await kit.merge.openLayer(plyFile(layerPart, 'lo.ply'), 'mm')
    const geo = (await kit.call('layer-geometry', { id })).positions
    const near = (positions: Float32Array, at: [number, number, number]) => {
      let best = 0, d = Infinity
      for (let i = 0; i < positions.length; i += 3) {
        const e = Math.hypot(positions[i] - at[0], positions[i + 1] - at[1], positions[i + 2] - at[2])
        if (e < d) { d = e; best = i / 3 }
      }
      return best
    }
    const base = (await kit.headless.session.clientRef.current!.query({ min: [-1e9, -1e9, -1e9], max: [1e9, 1e9, 1e9], limit: 1e7 })).positions
    const boreL = await kit.merge.fitDatum(id, 'cylinder', [near(geo, moved(TRUE, [-6, 0, 0]))])
    const faceL = await kit.merge.fitDatum(id, 'plane', [near(geo, moved(TRUE, [0, -15, 0]))])
    const boreB = await kit.merge.fitDatum(BASE, 'cylinder', [near(base, [6, 0, 0])])
    const faceB = await kit.merge.fitDatum(BASE, 'plane', [near(base, [5, -15, 0])])
    expect(useMerge.getState().datums[id]).toHaveLength(2)
    expect(useMerge.getState().datums[BASE]).toHaveLength(2)
    const one = await kit.merge.alignDatums(id, BASE, { primary: boreL!.fitId, secondary: null, origin: null }, { primary: boreB!.fitId, secondary: null, origin: null })
    expect(one).toBeNull()
    expect(useStore.getState().errorText).toBe('Needs two datums on each side — one alone leaves the part free to turn or slide.')
    const r = await kit.merge.alignDatums(
      id, BASE,
      { primary: boreL!.fitId, secondary: faceL!.fitId, origin: null },
      { primary: boreB!.fitId, secondary: faceB!.fitId, origin: null },
    )
    expect(r!.confident).toBe(true)
    const d = delta(row(id).pose, POSE)
    expect(d.deg).toBeLessThanOrEqual(0.05)
    expect(d.mm).toBeLessThanOrEqual(0.02)
  })

  it('keeps the poses on the base as shown when an alignment is baked into it', async () => {
    const id = await kit.merge.openLayer(plyFile(layerPart, 'lo.ply'), 'mm')
    kit.merge.moveLayer(id, POSE)
    const M = rigidOf([10, 0, -30], [7, 8, 9])
    expect(await kit.headless.session.alignment.applyManual(M)).toBe(true)
    // The layer moved with the base: M o POSE.
    const d = delta(row(id).pose, rigidCompose(M, POSE))
    expect(d.mm).toBeLessThan(1e-6)
    // And a refine onto the moved base finds it there.
    const r = await kit.merge.refine(id, BASE)
    expect(r!.confident).toBe(true)
    expect(delta(row(id).pose, rigidCompose(M, POSE)).mm).toBeLessThanOrEqual(0.02)
  })

  it('is refused while an alignment runs, and Stop leaves the layer where it was', async () => {
    const id = await kit.merge.openLayer(plyFile(layerPart, 'lo.ply'), 'mm')
    kit.merge.moveLayer(id, nudged(POSE))
    const was = row(id).pose
    const running = kit.merge.refine(id, BASE)
    expect(useMerge.getState().running).not.toBeNull()
    expect(await kit.merge.refine(id, BASE)).toBeNull()
    expect(useStore.getState().errorText).toMatch(/alignment or the merge in progress/)
    await expect(kit.merge.openLayer(plyFile(layerPart, 'x.ply'), 'mm')).rejects.toThrow(/in progress/)
    kit.merge.stop()
    const r = await running
    // Stopped, or finished before the stop arrived: either way nothing else ran.
    if (r === null) expect(row(id).pose).toBe(was)
    expect(useMerge.getState().running).toBeNull()
    expect(layers()).toHaveLength(1)
  })
})

describe('the layers belong to the scan and the workspace', () => {
  beforeEach(withBase)

  it('go when the workspace is left', async () => {
    const id = await kit.merge.openLayer(plyFile(layerPart, 'lo.ply'), 'mm')
    useShell.getState().setWorkspace('elements')
    expect(layers()).toEqual([])
    // The worker let it go too (asked without waiting: look again).
    await new Promise((r) => setTimeout(r, 50))
    await expect(kit.call('layer-geometry', { id })).rejects.toThrow(`There is no layer "${id}".`)
  })

  it('go when another scan is opened', async () => {
    await kit.merge.openLayer(plyFile(layerPart, 'lo.ply'), 'mm')
    await kit.headless.session.scan.openScan(plyFile(hi, 'other.ply'), 'mm')
    expect(layers()).toEqual([])
  })

  it('base fit ids go with any scan replaced', async () => {
    await kit.merge.openLayer(plyFile(layerPart, 'lo.ply'), 'mm')
    await kit.merge.fitDatum(BASE, 'plane', [0])
    expect(useMerge.getState().datums[BASE]).toHaveLength(1)
    await kit.headless.session.swap.swapScanBuffers({ name: 'b.ply', file: plyFile(hi, 'b.ply'), units: 'mm', scale: 1 }, { positions: hi.positions.slice(), normals: hi.normals.slice() }, null)
    expect(useMerge.getState().datums[BASE]).toBeUndefined()
    // Not the workspace's own swap: the layers went too.
    expect(layers()).toEqual([])
  })
})
