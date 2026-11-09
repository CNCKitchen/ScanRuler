// SPDX-License-Identifier: AGPL-3.0-only
// The Merge workspace through its commands alone, as an agent drives it: the
// +x half of a block opened as the scan, the -x half (scanned in a frame
// TRUE off) opened as a layer, nudged, refined, aligned by pairs and by
// datums, merged — every command on the real worker under the app's own
// headless session (tests/commandKit.ts, mergeKit.ts). Bad ids and datums
// that leave the part free answer with their exact text.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { listCommands } from '../../../src/commands/registry'
import { SCHEMA_BUDGET, schemaWeight } from '../../../src/commands/schema'
import { useHistory } from '../../../src/state/historyStore'
import { useShell } from '../../../src/state/shellStore'
import { useStore } from '../../../src/state/store'
import { boxMesh } from '../../../tests/helpers'
import { refused, run, stlBytes, undoLabels } from '../../../tests/commandKit'
import { buildPointCloudPly } from '../../../src/core/exportPointCloud'
import { rigidOf, type Cloud } from '../../../tests/cloudFixtures'
import type { Vec3 } from '../../../src/core/types'
import { MESH_BASE_CONFIRM } from '../app/mergeSession'
import { useMerge } from '../state/mergeStore'
import { delta, hi, layerPart, moved, nearest, nudged, POSE, startMerge, TRUE, type MergeKit } from './mergeKit'

vi.setConfig({ testTimeout: 120_000 })

let kit: MergeKit
beforeAll(async () => {
  kit = await startMerge()
}, 60_000)
afterAll(() => kit.stop())

const plyBytes = (c: Cloud, name: string) => new Uint8Array(buildPointCloudPly(c.positions, c.normals, null, name))
const row = (id: string) => useMerge.getState().layers.find((l) => l.id === id)!
const UNDER = 'Needs two datums on each side — one alone leaves the part free to turn or slide.'

/** A fresh session: the +x half is the scan, the workspace is Merge. */
async function withBase() {
  kit.merge.dropLayers(true)
  useStore.setState({ fileName: null })
  const r = await run<{ id: string }>('merge.open_layer', { bytes: plyBytes(hi, 'hi.ply'), name: 'hi.ply' })
  expect(r.id).toBe('base')
  useShell.getState().setWorkspace('merge')
}

const openLo = () => run<{ id: string; is_cloud: boolean; vertices: number; spacing_mm: number }>('merge.open_layer', { bytes: plyBytes(layerPart, 'lo.ply'), name: 'lo.ply' })

describe('merge commands', () => {
  it('are listed, within the schema budget, merge.list_layers read-only', () => {
    const mine = listCommands().filter((c) => c.name.startsWith('merge.'))
    expect(mine.map((c) => c.name).sort()).toEqual(
      ['merge.align_datums', 'merge.align_pairs', 'merge.fit_datum', 'merge.list_layers', 'merge.merge', 'merge.move_layer', 'merge.open_layer', 'merge.refine', 'merge.remove_layer'],
    )
    for (const c of mine) {
      const w = schemaWeight(c.input)
      expect(w.bytes, c.name).toBeLessThanOrEqual(SCHEMA_BUDGET.bytes)
      expect(w.depth, c.name).toBeLessThanOrEqual(SCHEMA_BUDGET.depth)
    }
    expect(mine.find((c) => c.name === 'merge.list_layers')!.readOnly).toBe(true)
    for (const n of ['fit_datum', 'align_pairs', 'align_datums', 'refine', 'merge']) expect(mine.find((c) => c.name === `merge.${n}`)!.long, n).toBe(true)
  })

  describe('with a scan open', () => {
    beforeEach(withBase)

    it('opens a layer, lists it, and removes it', async () => {
      expect((await run<{ layers: unknown[] }>('merge.list_layers')).layers).toEqual([])
      const o = await openLo()
      expect(o.is_cloud).toBe(true)
      expect(o.vertices).toBeGreaterThan(1000)
      expect(o.spacing_mm).toBeGreaterThan(0.5)
      const l = await run<{ layers: { id: string; name: string; units: string; visible: boolean; locked: boolean; pose: number[]; datums: unknown[] }[]; datums_base: unknown[] }>('merge.list_layers')
      expect(l.layers).toHaveLength(1)
      expect(l.layers[0]).toMatchObject({ id: o.id, name: 'lo.ply', units: 'mm', visible: true, locked: false, datums: [] })
      expect(l.layers[0].pose).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
      expect(l.datums_base).toEqual([])
      useHistory.setState({ past: [], future: [] })
      const gone = await run<{ removed: string; layers: string[] }>('merge.remove_layer', { id: o.id })
      expect(gone).toEqual({ removed: o.id, layers: [] })
      // Closing a layer is no step of the history.
      expect(undoLabels()).toEqual([])
    })

    it('answers a bad id with not_found and the layer it lacks', async () => {
      const text = 'There is no layer "L99".'
      for (const [name, input] of [
        ['merge.move_layer', { id: 'L99', translate_mm: [1, 0, 0] }],
        ['merge.remove_layer', { id: 'L99' }],
        ['merge.refine', { id: 'L99', target: 'base' }],
        ['merge.align_pairs', { id: 'L99', target: 'base', pairs: [{ layer: [0, 0, 0], target: [0, 0, 0] }, { layer: [1, 0, 0], target: [1, 0, 0] }, { layer: [0, 1, 0], target: [0, 1, 0] }] }],
        ['merge.align_datums', { id: 'L99', target: 'base', layer: { primary: 0, secondary: 1 }, target_datums: { primary: 0, secondary: 1 } }],
      ] as const) {
        const e = await refused(name, input)
        expect([name, e.code, e.message]).toEqual([name, 'not_found', text])
      }
      const o = await openLo()
      expect((await refused('merge.refine', { id: o.id, target: 'L99' })).code).toBe('not_found')
      expect((await refused('merge.fit_datum', { layer: 'L99', kind: 'plane', seeds: [0] })).message).toMatch(/There is no layer "L99"/)
      expect((await refused('merge.refine', { id: o.id, target: o.id })).code).toBe('invalid_input')
    })

    it('moves a layer relative to where it stands, about its centre', async () => {
      const { id } = await openLo()
      useHistory.setState({ past: [], future: [] })
      const first = await run<{ pose: number[] }>('merge.move_layer', { id, translate_mm: [4, -5, 6] })
      expect(first.pose.slice(12, 15)).toEqual([4, -5, 6])
      // A turn about the centre keeps the centre where it was; a second move is on top of the first.
      const lo: Vec3 = [Infinity, Infinity, Infinity], hi2: Vec3 = [-Infinity, -Infinity, -Infinity]
      for (let i = 0; i < layerPart.positions.length; i += 3) for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], layerPart.positions[i + k])
        hi2[k] = Math.max(hi2[k], layerPart.positions[i + k])
      }
      const centre: Vec3 = [(lo[0] + hi2[0]) / 2, (lo[1] + hi2[1]) / 2, (lo[2] + hi2[2]) / 2]
      const before = moved(row(id).pose, centre)
      await run('merge.move_layer', { id, rotate_deg: [20, -10, 35] })
      const after = moved(row(id).pose, centre)
      for (let k = 0; k < 3; k++) expect(after[k]).toBeCloseTo(before[k], 3)
      // Each is one "Merge: move layer" step of the history.
      expect(undoLabels().filter((l) => l === 'Merge: move layer')).toHaveLength(2)
    })

    it('turns about x, then y, then z, as rigidOf does', async () => {
      const { id } = await openLo()
      await run('merge.move_layer', { id, rotate_deg: [10, 20, 30] })
      const want = rigidOf([10, 20, 30], [0, 0, 0])
      for (let i = 0; i < 9; i++) expect(row(id).pose.r[i]).toBeCloseTo(want.r[i], 6)
    })

    it('moves an inch layer by millimetres', async () => {
      const inches: Cloud = { positions: layerPart.positions.map((v) => v / 25.4), normals: layerPart.normals }
      const o = await run<{ id: string; spacing_mm: number }>('merge.open_layer', { bytes: plyBytes(inches, 'in.ply'), name: 'in.ply', units: 'in' })
      expect(o.spacing_mm).toBeGreaterThan(0.5)
      const r = await run<{ pose: number[] }>('merge.move_layer', { id: o.id, translate_mm: [25.4, 0, 0] })
      expect(r.pose.slice(12, 15)).toEqual([25.4, 0, 0])
      expect(row(o.id).units).toBe('in')
    })

    it('fits a datum by a point, and refuses a point off the part', async () => {
      const { id } = await openLo()
      const far = await refused('merge.fit_datum', { layer: id, kind: 'plane', at: [500, 0, 0] })
      expect(far.code).toBe('invalid_input')
      expect(far.message).toMatch(/^No point of layer "L\d+" within [\d.]+ mm of at\.$/)
      const farBase = await refused('merge.fit_datum', { layer: 'base', kind: 'plane', at: [500, 0, 0] })
      expect(farBase.message).toMatch(/^No point of the base within [\d.]+ mm of at\.$/)
      expect((await refused('merge.fit_datum', { layer: id, kind: 'plane', at: [Number.NaN, 0, 0] })).code).toBe('invalid_input')
      expect((await run<{ kind: string }>('merge.fit_datum', { layer: id, kind: 'plane', at: moved(TRUE, [0, -15, 0]) })).kind).toBe('plane')
    })

    it('fits a datum by a point on a mesh layer', async () => {
      const o = await run<{ id: string; is_cloud: boolean }>('merge.open_layer', { bytes: stlBytes(boxMesh(20, 20)), name: 'box.stl' })
      expect(o.is_cloud).toBe(false)
      const f = await run<{ kind: string }>('merge.fit_datum', { layer: o.id, kind: 'plane', at: [0.3, 0.2, 10] })
      expect(f.kind).toBe('plane')
      expect((await refused('merge.fit_datum', { layer: o.id, kind: 'plane', at: [0, 0, 400] })).message).toMatch(/^No point of layer/)
    })

    it('refuses to move a locked layer', async () => {
      const { id } = await openLo()
      await kit.merge.setLayer(id, { locked: true })
      const e = await refused('merge.move_layer', { id, translate_mm: [1, 0, 0] })
      expect(e.code).toBe('invalid_state')
      expect(e.message).toBe('lo.ply is locked — unlock it to move it.')
    })

    it('refines from a nudged start: confident, pose recovered, answers in mm', async () => {
      const { id } = await openLo()
      // Without a start nobody chose, never confident.
      kit.merge.moveLayer(id, nudged(POSE))
      useHistory.setState({ past: [], future: [] })
      const r = await run<{ rms: number; matched: number; confident: boolean; low_overlap: boolean; pose: number[] }>('merge.refine', { id, target: 'base' })
      expect(r.confident).toBe(true)
      expect(r.low_overlap).toBe(false)
      expect(r.matched).toBeGreaterThan(0.1)
      expect(r.rms).toBeLessThan(0.5)
      const d = delta(row(id).pose, POSE)
      expect(d.deg).toBeLessThanOrEqual(0.05)
      expect(d.mm).toBeLessThanOrEqual(0.02)
      const listed = await run<{ layers: { last: { confident: boolean } }[] }>('merge.list_layers')
      expect(listed.layers[0].last.confident).toBe(true)
      expect(undoLabels()).toEqual(['Merge: refine layer'])
    })

    it('aligns by pairs, and refuses pairs in a line', async () => {
      const { id } = await openLo()
      const at = (p: Vec3) => ({ layer: moved(TRUE, p), target: p })
      const good = [[5, -10, -8], [10, 12, 5], [8, 0, 9], [12, -6, 3]] as Vec3[]
      useHistory.setState({ past: [], future: [] })
      const r = await run<{ confident: boolean; low_overlap: boolean; rms: number }>('merge.align_pairs', { id, target: 'base', pairs: good.map(at) })
      expect(r.confident).toBe(true)
      expect(r.rms).toBeLessThan(0.5)
      expect(undoLabels()).toEqual(['Merge: align layer by pairs'])
      const d = delta(row(id).pose, POSE)
      expect(d.deg).toBeLessThanOrEqual(0.05)
      expect(d.mm).toBeLessThanOrEqual(0.02)
      const line = [[0, 0, 0], [5, 0, 0], [10, 0, 0]] as Vec3[]
      const e = await refused('merge.align_pairs', { id, target: 'base', pairs: line.map(at) })
      expect(e.code).toBe('failed')
      expect(e.message).toMatch(/nearly in a line/)
    })

    it('fits datums by a point on each side, refuses one alone with the exact text, and aligns with two', async () => {
      const { id } = await openLo()
      const bore = await run<{ fit_id: number; kind: string; radius: number }>('merge.fit_datum', { layer: id, kind: 'cylinder', at: moved(TRUE, [-6, 0, 0]) })
      expect(bore.kind).toBe('cylinder')
      expect(bore.radius).toBeCloseTo(6, 1)
      const face = await run<{ fit_id: number }>('merge.fit_datum', { layer: id, kind: 'plane', at: moved(TRUE, [0, -15, 0]) })
      const boreB = await run<{ fit_id: number }>('merge.fit_datum', { layer: 'base', kind: 'cylinder', at: [6, 0, 0] })
      const faceB = await run<{ fit_id: number }>('merge.fit_datum', { layer: 'base', kind: 'plane', at: [5, -15, 0] })
      expect((await refused('merge.fit_datum', { layer: id, kind: 'plane' })).message).toBe('Give seeds or at — exactly one of them.')
      expect((await refused('merge.fit_datum', { layer: id, kind: 'plane', seeds: [0], at: [0, 0, 0] })).code).toBe('invalid_input')
      // seeds still work: the vertex `at` resolved to.
      const geo = (await kit.call('layer-geometry', { id })).positions
      const seeded = await run<{ kind: string }>('merge.fit_datum', { layer: id, kind: 'plane', seeds: [nearest(geo, moved(TRUE, [0, -15, 0]))] })
      expect(seeded.kind).toBe('plane')
      const listed = await run<{ layers: { datums: { fit_id: number; kind: string }[] }[]; datums_base: unknown[] }>('merge.list_layers')
      expect(listed.layers[0].datums.map((d) => d.fit_id).slice(0, 2)).toEqual([bore.fit_id, face.fit_id])
      expect(listed.datums_base).toHaveLength(2)

      for (const input of [
        { id, target: 'base', layer: { primary: bore.fit_id }, target_datums: { primary: boreB.fit_id } },
        { id, target: 'base', layer: { primary: bore.fit_id, secondary: face.fit_id }, target_datums: { primary: boreB.fit_id } },
        { id, target: 'base', layer: { primary: bore.fit_id }, target_datums: { primary: boreB.fit_id, secondary: faceB.fit_id } },
      ]) {
        const e = await refused('merge.align_datums', input)
        expect(e.message).toBe(UNDER)
      }
      useHistory.setState({ past: [], future: [] })
      const r = await run<{ confident: boolean; matched: number; low_overlap: boolean }>('merge.align_datums', {
        id,
        target: 'base',
        layer: { primary: bore.fit_id, secondary: face.fit_id },
        target_datums: { primary: boreB.fit_id, secondary: faceB.fit_id },
      })
      expect(r.confident).toBe(true)
      expect(r.low_overlap).toBe(false)
      expect(undoLabels()).toEqual(['Merge: align layer by datums'])
      const d = delta(row(id).pose, POSE)
      expect(d.deg).toBeLessThanOrEqual(0.05)
      expect(d.mm).toBeLessThanOrEqual(0.02)
    })

    it('merges the shown layers into the scan; with none shown, refuses', async () => {
      const { id } = await openLo()
      kit.merge.moveLayer(id, POSE)
      const before = useStore.getState().vertexCount
      await kit.merge.setLayer(id, { visible: false })
      expect((await refused('merge.merge', {})).message).toBe('Show at least one layer to merge — the hidden ones are left out.')
      await kit.merge.setLayer(id, { visible: true })
      useHistory.setState({ past: [], future: [] })
      const r = await run<{ points: number; layers_merged: number }>('merge.merge', { dedupe_mm: 0.5 })
      expect(undoLabels()).toEqual(['Merge: merge layers'])
      expect(r.layers_merged).toBe(1)
      expect(r.points).toBeGreaterThan(before)
      expect(useStore.getState().vertexCount).toBe(r.points)
      expect(useStore.getState().scanIsCloud).toBe(true)
      // Hidden after: nothing left to merge.
      expect((await refused('merge.merge', {})).code).toBe('invalid_state')
    })
  })

  it('asks before a mesh becomes a cloud: refused until confirm, then merged', async () => {
    await run('scan.open', { bytes: stlBytes(boxMesh(20, 20)), name: 'box.stl', discard: true })
    useShell.getState().setWorkspace('merge')
    const pts: number[] = [], nrm: number[] = []
    for (let a = -10; a < 10; a++) for (let b = -10; b < 10; b++) { pts.push(a + 0.5, b + 0.5, 10); nrm.push(0, 0, 1) }
    const id = (await run<{ id: string }>('merge.open_layer', { bytes: plyBytes({ positions: Float32Array.from(pts), normals: Float32Array.from(nrm) }, 'a.ply'), name: 'a.ply' })).id
    const e = await refused('merge.merge', {})
    expect(e.code).toBe('invalid_state')
    expect(e.message.startsWith(MESH_BASE_CONFIRM)).toBe(true)
    expect(useStore.getState().scanIsCloud).toBe(false)
    expect(useMerge.getState().confirming).toBeNull()
    const r = await run<{ points: number }>('merge.merge', { dedupe_mm: null, confirm: true })
    expect(r.points).toBeGreaterThan(400)
    expect(useStore.getState().scanIsCloud).toBe(true)
    expect(row(id).visible).toBe(false)
  })

  it('needs a scan for everything but opening one', async () => {
    kit.merge.dropLayers(true)
    useStore.setState({ fileName: null })
    expect((await refused('merge.move_layer', { id: 'L1', translate_mm: [1, 0, 0] })).code).toBe('no_scan')
    expect((await refused('merge.merge', {})).code).toBe('no_scan')
    expect((await run<{ layers: unknown[] }>('merge.list_layers')).layers).toEqual([])
  })
})
