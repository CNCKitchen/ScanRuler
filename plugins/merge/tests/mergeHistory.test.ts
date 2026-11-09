// SPDX-License-Identifier: AGPL-3.0-only
// Merge and the undo history, for real: moves and alignments are steps that
// put the poses back; a merge is one step that puts a cloud in place of the
// scan under everything measured on it — the elements refitted, the base's
// alignment and scale kept, the deviation measured again — with the layers
// hidden; undo brings the scan before back with the layers shown (the
// worker keeping them through its own swap), redo merges again. A mesh base
// asks first. The merged scan goes into a project and comes back the same.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { rigidApply, rigidCompose } from '../../../src/core/deviation/rigid'
import { parsePLY } from '../../../src/core/parsers/ply'
import { collectProject } from '../../../src/app/project'
import { packProject, readMembers, unpackProject } from '../../../src/core/project/archive'
import { redo, undo, useHistory } from '../../../src/state/historyStore'
import { useDeviation } from '../../../src/state/deviationStore'
import { useShell } from '../../../src/state/shellStore'
import { useStore } from '../../../src/state/store'
import { boxMesh } from '../../../tests/helpers'
import { rigidOf, type Cloud } from '../../../tests/cloudFixtures'
import { run, stlBytes } from '../../../tests/commandKit'
import { MESH_BASE_CONFIRM } from '../app/mergeSession'
import { BASE } from '../core/protocol'
import { useMerge } from '../state/mergeStore'
import { delta, hi, layerPart, nearest, nudged, plyFile, POSE, startMerge, type MergeKit } from './mergeKit'

vi.setConfig({ testTimeout: 180_000 })

let kit: MergeKit
beforeAll(async () => {
  kit = await startMerge()
}, 60_000)
afterAll(() => kit.stop())

const layers = () => useMerge.getState().layers
const row = (id: string) => layers().find((l) => l.id === id)!
const labels = () => useHistory.getState().past.map((e) => e.label)
const BIG = 1e9

/** What the worker holds as the scan. */
const held = () => kit.headless.session.clientRef.current!.query({ min: [-BIG, -BIG, -BIG], max: [BIG, BIG, BIG], limit: 1e7 })

/** A cloud's points scaled by `k`. */
const scaled = (c: Cloud, k: number): Cloud => ({ positions: c.positions.map((v) => v * k), normals: c.normals.slice() })

async function openScan(file: File) {
  kit.merge.dropLayers(true)
  useShell.getState().setWorkspace('elements')
  await kit.headless.session.scan.openScan(file, 'mm')
}

/** The +x half as the scan, a plane fitted on its -y face, and the -x half
 *  as a layer refined into place — in the workspace. */
async function mergeReady() {
  await openScan(plyFile(hi, 'hi.ply'))
  await run('element.fit', { kind: 'plane', at: { point: [10, -15, 0] } })
  useShell.getState().setWorkspace('merge')
  const id = await kit.merge.openLayer(plyFile(layerPart, 'lo.ply'), 'mm')
  kit.merge.moveLayer(id, nudged(POSE))
  expect((await kit.merge.refine(id, BASE))!.confident).toBe(true)
  return id
}

/** A merge onto a mesh, answered `yes` once it asks. */
async function mergeAnswering(yes: boolean): Promise<boolean> {
  const merging = kit.merge.merge({ dedupe: null })
  for (let i = 0; i < 200 && useMerge.getState().confirming === null; i++) await new Promise((r) => setTimeout(r, 5))
  expect(useMerge.getState().confirming).toBe(MESH_BASE_CONFIRM)
  kit.merge.answerConfirm(yes)
  return merging
}

describe('moves and alignments in the undo history', () => {
  it('each is a step; undo and redo put the poses back', async () => {
    await openScan(plyFile(hi, 'hi.ply'))
    useShell.getState().setWorkspace('merge')
    const id = await kit.merge.openLayer(plyFile(layerPart, 'lo.ply'), 'mm')
    const opened = row(id).pose
    const moved = nudged(POSE)
    kit.merge.moveLayer(id, moved)
    expect(labels().at(-1)).toBe('Merge: move layer')
    await kit.merge.refine(id, BASE)
    expect(labels().at(-1)).toBe('Merge: refine layer')
    const refined = row(id).pose
    expect(delta(refined, POSE).mm).toBeLessThanOrEqual(0.02)

    await undo()
    expect(row(id).pose).toBe(moved)
    await undo()
    expect(row(id).pose).toBe(opened)
    await redo()
    expect(row(id).pose).toBe(moved)
    await redo()
    expect(row(id).pose).toBe(refined)
    // Pose only: the scan was never touched.
    expect(useStore.getState().fileName).toBe('hi.ply')
  })
})

describe('merging', () => {
  it('puts one cloud in place of the scan as one step, the elements refitted and the layers hidden; undo and redo cross it', async () => {
    const id = await mergeReady()
    const s = useStore.getState()
    const before = { source: kit.headless.session.sources.current.scan, points: s.vertexCount, plane: s.elements[0] }
    const layerPoints = row(id).vertexCount
    await kit.merge.fitDatum(BASE, 'plane', [0])
    expect(useMerge.getState().datums[BASE]).toHaveLength(1)

    expect(await kit.merge.merge({ dedupe: null })).toBe(true)
    expect(labels().at(-1)).toBe('Merge: merge layers')
    const after = useStore.getState()
    expect(after.scanIsCloud).toBe(true)
    // Every point of both is written; the overlap's points the layer laid
    // exactly on the base's (the halves share them, and float rounding
    // lands them on the same values) are one point of the scan.
    const merged = kit.headless.session.sources.current.scan!
    expect(merged.name).toBe('hi-merged.ply')
    const written = parsePLY(await (merged.file as Blob).arrayBuffer(), () => {}).positions
    expect(written.length / 3).toBe(before.points + layerPoints)
    const distinct = new Set<string>()
    for (let i = 0; i < written.length; i += 3) distinct.add(`${written[i]},${written[i + 1]},${written[i + 2]}`)
    expect(after.vertexCount).toBe(distinct.size)
    expect(after.vertexCount).toBeGreaterThan(before.points)
    expect(after.statusText).toContain(`${after.vertexCount.toLocaleString('en-US')} points`)
    // The plane is fitted again, on the face the layer filled out.
    const plane = after.elements[0]
    expect(plane.fit).not.toBe(before.plane.fit)
    expect((plane.fit as { regionSize: number }).regionSize).toBeGreaterThan((before.plane.fit as { regionSize: number }).regionSize)
    expect(row(id).visible).toBe(false)
    // The base's fits were of the scan that went.
    expect(useMerge.getState().datums[BASE]).toBeUndefined()

    await undo()
    const undone = useStore.getState()
    expect(kit.headless.session.sources.current.scan).toBe(before.source)
    expect(undone.vertexCount).toBe(before.points)
    expect((undone.elements[0].fit as { regionSize: number }).regionSize).toBe((before.plane.fit as { regionSize: number }).regionSize)
    expect(row(id).visible).toBe(true)
    // The worker kept the layer through the history's own swap.
    expect((await kit.call('layer-geometry', { id })).positions.length).toBe(layerPoints * 3)

    await redo()
    expect(useStore.getState().vertexCount).toBe(after.vertexCount)
    expect(useStore.getState().scanIsCloud).toBe(true)
    expect(row(id).visible).toBe(false)
    expect((await kit.call('layer-geometry', { id })).positions.length).toBe(layerPoints * 3)
    // A swap of anyone else's still drops the layers: the flag was one-shot.
    await kit.headless.session.swap.swapScanBuffers({ name: 'x.ply', file: plyFile(hi, 'x.ply'), units: 'mm', scale: 1 }, { positions: hi.positions.slice(), normals: hi.normals.slice() }, null)
    expect(layers()).toEqual([])
    await expect(kit.call('layer-geometry', { id })).rejects.toThrow(`There is no layer "${id}".`)
  })

  it('keeps the base aligned and scaled: the alignment unchanged, the cloud written in the scaled file frame, the deviation measured again', async () => {
    // The +x half at half size, scaled to its true size, then aligned.
    await openScan(plyFile(scaled(hi, 0.5), 'half.ply'))
    await run('scan.scale', { factor: 2 })
    const M = rigidOf([10, 0, -30], [7, 8, 9])
    expect(await kit.headless.session.alignment.applyManual(M)).toBe(true)
    await run('deviation.open_reference', { bytes: stlBytes(boxMesh(40, 40)), name: 'nominal.stl' })
    await run('deviation.align')
    expect(useDeviation.getState().mapStatus).toBe('ready')
    useShell.getState().setWorkspace('merge')
    const id = await kit.merge.openLayer(plyFile(layerPart, 'lo.ply'), 'mm')
    kit.merge.moveLayer(id, rigidCompose(M, POSE))

    const s = useStore.getState()
    const alignment = s.appliedAlignment
    const scale = s.scanScale
    const baseCount = s.vertexCount
    const mapVersion = useDeviation.getState().mapVersion
    expect(await kit.merge.merge({ dedupe: null })).toBe(true)

    expect(useStore.getState().appliedAlignment).toBe(alignment)
    expect(useStore.getState().scanScale).toEqual(scale)
    // The swap put the map away; the merge's remeasure measured it again.
    expect(useDeviation.getState().mapVersion).toBeGreaterThan(mapVersion)
    expect(useDeviation.getState().mapStatus).toBe('ready')
    // The file: the base at its true size in its own frame, the layer laid
    // on it by POSE — no alignment in it, scale 1.
    const source = kit.headless.session.sources.current.scan!
    expect(source).toMatchObject({ units: 'mm', scale: 1 })
    const file = parsePLY(await (source.file as Blob).arrayBuffer(), () => {})
    const p = new Float64Array(3)
    const layer = (await kit.call('layer-geometry', { id })).positions
    for (let i = 0; i < layer.length / 3; i += 37) {
      // Layer point i, laid by POSE in the file frame.
      rigidApply(POSE, layer[3 * i], layer[3 * i + 1], layer[3 * i + 2], p)
      const j = baseCount + i
      for (let c = 0; c < 3; c++) expect(file.positions[3 * j + c]).toBeCloseTo(p[c], 3)
    }
    // And the base's own points are its file's, the true size: hi.
    for (let j = 0; j < baseCount; j += 41) {
      const at = [0, 1, 2].map((c) => file.positions[3 * j + c]) as [number, number, number]
      const k = nearest(hi.positions, at)
      expect(Math.hypot(hi.positions[3 * k] - at[0], hi.positions[3 * k + 1] - at[1], hi.positions[3 * k + 2] - at[2])).toBeLessThan(1e-3)
    }
    // What is shown is that file under the alignment kept.
    const shown = await held()
    rigidApply(alignment!, file.positions[0], file.positions[1], file.positions[2], p)
    const k = (() => {
      for (let i = 0; i < shown.positions.length; i += 3) if (Math.hypot(shown.positions[i] - p[0], shown.positions[i + 1] - p[1], shown.positions[i + 2] - p[2]) < 1e-3) return i
      return -1
    })()
    expect(k).toBeGreaterThanOrEqual(0)
  })

  it('asks before a mesh base becomes a cloud; then carries the elements\' selections across and refits them', async () => {
    useStore.setState({ creaseMode: 'on' })
    try {
      kit.merge.dropLayers(true)
      useShell.getState().setWorkspace('elements')
      await run('scan.open', { bytes: stlBytes(boxMesh(20, 20)), name: 'box.stl', discard: true })
      await run('element.fit_marked', { kind: 'plane', box: { min: [-11, -11, 9.5], max: [11, 11, 11] } })
      const before = useStore.getState().elements[0]
      const selection = (before.source as { selection: Uint32Array }).selection
      expect(selection.length).toBeGreaterThan(100)
      useShell.getState().setWorkspace('merge')
      // The top face again as points, between the mesh's.
      const pts: number[] = [], nrm: number[] = []
      for (let a = -10; a < 10; a++) for (let b = -10; b < 10; b++) { pts.push(a + 0.5, b + 0.5, 10); nrm.push(0, 0, 1) }
      const id = await kit.merge.openLayer(plyFile({ positions: Float32Array.from(pts), normals: Float32Array.from(nrm) }, 'top.ply'), 'mm')
      const points = useStore.getState().vertexCount

      // No: the scan stays a mesh.
      expect(await mergeAnswering(false)).toBe(false)
      expect(useStore.getState().scanIsCloud).toBe(false)
      expect(useMerge.getState().confirming).toBeNull()

      expect(await mergeAnswering(true)).toBe(true)
      const after = useStore.getState()
      expect(after.scanIsCloud).toBe(true)
      expect(after.vertexCount).toBe(points + row(id).vertexCount)
      const el = after.elements[0]
      // The base's vertices keep their numbers in the cloud: the selection
      // comes across whole, and the plane is fitted again on it.
      expect(Array.from((el.source as { selection: Uint32Array }).selection)).toEqual(Array.from(selection))
      expect(el.status).toBe('done')
      expect(el.fit).not.toBe(before.fit)
      const n = (el.fit as { normal: [number, number, number] }).normal
      expect(Math.abs(n[2])).toBeCloseTo(1, 4)

      await undo()
      expect(useStore.getState().scanIsCloud).toBe(false)
      expect(useStore.getState().triangleCount).toBeGreaterThan(0)
      expect(row(id).visible).toBe(true)
    } finally {
      useStore.setState({ creaseMode: 'auto' })
    }
  })

  it('a merged scan goes into a project and comes back the same', async () => {
    await mergeReady()
    expect(await kit.merge.merge({ dedupe: 0.5 })).toBe(true)
    const merged = useStore.getState().vertexCount
    const source = kit.headless.session.sources.current.scan!
    const { manifest, members } = collectProject({ scan: source, reference: null, image: null }, null, '0.1.0')
    const back = unpackProject(packProject(manifest, await readMembers(members)))
    const bytes = back.members.get(manifest.scan!.member)!
    expect(parsePLY(bytes.slice().buffer as ArrayBuffer, () => {}).positions.length / 3).toBe(merged)
    useShell.getState().setWorkspace('elements')
    await run('scan.open', { bytes, name: 'merged.ply', discard: true })
    expect(useStore.getState().vertexCount).toBe(merged)
    expect(useStore.getState().scanIsCloud).toBe(true)
  })
})
