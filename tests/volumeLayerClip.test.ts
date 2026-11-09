// SPDX-License-Identifier: AGPL-3.0-only
// The volume regions are the reference's, and the section view cuts them as
// it cuts the reference; shown, they are something an orbit can turn about
// (issue 34).
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import type { VolumeDeviation } from '../src/core/deviation/volume'
import { VolumeLayer } from '../src/viewer/volumeLayer'

const quad = { positions: Float32Array.from([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]), indices: Uint32Array.from([0, 1, 2, 0, 2, 3]), region: Uint32Array.from([0, 0]) }
const empty = { positions: new Float32Array(0), indices: new Uint32Array(0), region: new Uint32Array(0) }
const volume = { meshes: { excess: quad, missing: empty, unsure: empty } } as unknown as VolumeDeviation

const materials = (layer: VolumeLayer) => layer.group.children.map((c) => (c as THREE.Mesh).material as THREE.Material)

describe('the volume regions and the section view', () => {
  it('are cut as the reference is, set before or after they are measured', () => {
    const planes = [new THREE.Plane(new THREE.Vector3(1, 0, 0), 0)]
    const before = new VolumeLayer()
    before.setClipping(planes)
    before.set(volume)
    expect(materials(before).every((m) => m.clippingPlanes === planes)).toBe(true)
    const after = new VolumeLayer()
    after.set(volume)
    after.setClipping(planes)
    expect(materials(after).every((m) => m.clippingPlanes === planes)).toBe(true)
    after.setClipping(null)
    expect(materials(after).every((m) => m.clippingPlanes === null)).toBe(true)
  })

  it('offer their solid meshes to turn about while shown, and none hidden', () => {
    const layer = new VolumeLayer()
    layer.set(volume)
    layer.setVisible(true)
    expect(layer.meshes()).toHaveLength(1)
    layer.setVisible(false)
    expect(layer.meshes()).toHaveLength(0)
  })
})
