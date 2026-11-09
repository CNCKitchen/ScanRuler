// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'

const attached: { obj: THREE.Object3D | null; cb: () => void; mode?: string }[] = []
vi.mock('../../../src/viewer/layerGizmo', () => ({
  layerGizmo: () => ({
    attach: (obj: THREE.Object3D | null, cb: () => void, mode?: string) => attached.push({ obj, cb, mode }),
    tick() {},
    dispose() {},
  }),
}))

import { MergeScene } from '../viewer/mergeScene'
import type { SceneLayerHost } from '../../../src/viewer/sceneLayers'

describe('MergeScene gizmo', () => {
  it('delivers a rotated pose in rotate mode', () => {
    const partGroup = new THREE.Group()
    const host = { partGroup, invalidate() {}, camera: () => new THREE.PerspectiveCamera() } as unknown as SceneLayerHost
    const s = new MergeScene(host)
    s.add('a', { positions: new Float32Array(9), normals: new Float32Array(9), spacing: 1 }, '#fff')
    const poses: { r: Float64Array; t: Float64Array }[] = []
    s.gizmo('a', (p) => poses.push(p), 'rotate')
    const g = attached[attached.length - 1]
    expect(g.mode).toBe('rotate')
    g.obj!.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2)
    g.cb()
    expect(poses[0].r[1]).toBeCloseTo(-1)
    expect(poses[0].r[3]).toBeCloseTo(1)
  })
})
