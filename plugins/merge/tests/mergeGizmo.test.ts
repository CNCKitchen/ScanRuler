// SPDX-License-Identifier: AGPL-3.0-only
// The handle on a layer stays on it when the layer is read again — a change
// of units, and the history stepping across one — and still moves it.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'

const attached: { obj: THREE.Object3D | null; cb: () => void }[] = []
vi.mock('../../../src/viewer/layerGizmo', () => ({
  layerGizmo: () => ({
    attach: (obj: THREE.Object3D | null, cb: () => void) => attached.push({ obj, cb }),
    tick() {},
    dispose() {},
  }),
}))

import type { SceneLayerHost } from '../../../src/viewer/sceneLayers'
import type { SceneManager } from '../../../src/viewer/SceneManager'
import { undo } from '../../../src/state/historyStore'
import { useShell } from '../../../src/state/shellStore'
import { useMerge } from '../state/mergeStore'
import { hi, layerPart, plyFile, startMerge, type MergeKit } from './mergeKit'

vi.setConfig({ testTimeout: 120_000 })

const host = {
  scene: new THREE.Scene(),
  partGroup: new THREE.Group(),
  invalidate() {},
  clipPlanes: () => null,
  camera: () => new THREE.PerspectiveCamera(),
} as unknown as SceneLayerHost
const viewport = { layerHost: () => host, addLayer: () => () => {} } as unknown as SceneManager

let kit: MergeKit
beforeAll(async () => {
  kit = await startMerge({ current: viewport })
}, 60_000)
afterAll(() => kit.stop())

const row = (id: string) => useMerge.getState().layers.find((l) => l.id === id)!
const last = () => attached[attached.length - 1]

describe('the handle on a layer', () => {
  it('stays on it when it is read in other units, and across undo', async () => {
    await kit.headless.session.scan.openScan(plyFile(hi, 'hi.ply'), 'mm')
    useShell.getState().setWorkspace('merge')
    const id = await kit.merge.openLayer(plyFile(layerPart, 'lo.ply'), 'mm')
    kit.merge.setGizmo(id, 'translate')
    const first = last().obj
    expect(first).not.toBeNull()

    await kit.merge.setLayer(id, { units: 'in' })
    expect(row(id).units).toBe('in')
    const second = last().obj
    expect(second).not.toBeNull()
    expect(second).not.toBe(first)
    // It drives the layer read again.
    second!.position.set(1, 2, 3)
    last().cb()
    expect(Array.from(row(id).pose.t)).toEqual([1, 2, 3])

    await undo() // the drag
    await undo() // the units
    expect(row(id).units).toBe('mm')
    expect(last().obj).not.toBeNull()
    expect(last().obj).not.toBe(second)
  })
})
