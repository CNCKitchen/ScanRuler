// SPDX-License-Identifier: AGPL-3.0-only
// A merge onto a mesh asks first. While it asks nothing that changes what
// is merged goes through; once answered it merges the layers as they stand
// then; and a merge left asking — the workspace left — answers no.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { undo } from '../../../src/state/historyStore'
import { useShell } from '../../../src/state/shellStore'
import { useStore } from '../../../src/state/store'
import { boxMesh } from '../../../tests/helpers'
import { rigidOf } from '../../../tests/cloudFixtures'
import { run, stlBytes } from '../../../tests/commandKit'
import { MESH_BASE_CONFIRM } from '../app/mergeSession'
import { useMerge } from '../state/mergeStore'
import { plyFile, startMerge, type MergeKit } from './mergeKit'

vi.setConfig({ testTimeout: 120_000 })

let kit: MergeKit
beforeAll(async () => {
  kit = await startMerge()
}, 60_000)
afterAll(() => kit.stop())

const layers = () => useMerge.getState().layers
const row = (id: string) => layers().find((l) => l.id === id)!

/** A 20 × 20 face of points at height z, between the box mesh's vertices. */
function face(z: number) {
  const pts: number[] = [], nrm: number[] = []
  for (let a = -10; a < 10; a++) for (let b = -10; b < 10; b++) { pts.push(a + 0.5, b + 0.5, z); nrm.push(0, 0, Math.sign(z)) }
  return { positions: Float32Array.from(pts), normals: Float32Array.from(nrm) }
}

/** A merge started, once it asks — boxed: an async function returning the
 *  promise itself would wait on it. */
async function asking(): Promise<{ merging: Promise<boolean> }> {
  const merging = kit.merge.merge({ dedupe: null })
  for (let i = 0; i < 400 && useMerge.getState().confirming === null; i++) await new Promise((r) => setTimeout(r, 5))
  expect(useMerge.getState().confirming).toBe(MESH_BASE_CONFIRM)
  return { merging }
}

describe('the question a mesh base asks', () => {
  it('holds the layers while it asks, merges them as they stand once answered, and a merge left asking answers no', async () => {
    await run('scan.open', { bytes: stlBytes(boxMesh(20, 20)), name: 'box.stl', discard: true })
    useShell.getState().setWorkspace('merge')
    const a = await kit.merge.openLayer(plyFile(face(10), 'a.ply'), 'mm')
    const b = await kit.merge.openLayer(plyFile(face(-10), 'b.ply'), 'mm')
    const base = useStore.getState().vertexCount
    const lift = rigidOf([0, 0, 0], [0, 0, 5])

    const { merging } = await asking()
    // Nothing that changes what is merged goes through while it asks.
    const was = row(a).pose
    expect(kit.merge.moveLayer(a, lift)).toBe(false)
    await kit.merge.setLayer(b, { visible: false })
    await kit.merge.removeLayer(b)
    expect(row(a).pose).toBe(was)
    expect(row(b).visible).toBe(true)
    expect(layers()).toHaveLength(2)
    // What stands once it is answered is what is merged: the store itself
    // changed meanwhile — a lifted, b hidden.
    useMerge.getState().setPose(a, lift)
    useMerge.getState().patchLayer(b, { visible: false })
    kit.merge.answerConfirm(true)
    expect(await merging).toBe(true)
    expect(useStore.getState().vertexCount).toBe(base + row(a).vertexCount)
    const lifted = await kit.headless.session.clientRef.current!.query({ min: [-11, -11, 14.5], max: [11, 11, 15.5], limit: 1e6 })
    expect(lifted.matched).toBe(row(a).vertexCount)

    await undo()
    expect(useStore.getState().scanIsCloud).toBe(false)
    // A merge left asking — the workspace left — answers no and lets go.
    const { merging: left } = await asking()
    useShell.getState().setWorkspace('elements')
    expect(await left).toBe(false)
    expect(useMerge.getState().confirming).toBeNull()
    expect(layers()).toEqual([])
    expect(useStore.getState().scanIsCloud).toBe(false)
  })
})
