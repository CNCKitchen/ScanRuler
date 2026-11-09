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
import type { Rigid } from '../../../src/core/deviation/rigid'

describe('MergeScene gizmo', () => {
  it('delivers a rotated pose in rotate mode', () => {
    const partGroup = new THREE.Group()
    const host = { partGroup, invalidate() {}, clipPlanes: () => null, camera: () => new THREE.PerspectiveCamera() } as unknown as SceneLayerHost
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

  function scene() {
    const host = { partGroup: new THREE.Group(), invalidate() {}, clipPlanes: () => null, camera: () => new THREE.PerspectiveCamera() } as unknown as SceneLayerHost
    const s = new MergeScene(host)
    s.add('a', { positions: new Float32Array(9), normals: new Float32Array(9), spacing: 1 }, '#fff')
    return s
  }
  const move = (x: number, y: number, z: number): Rigid => ({ r: Float64Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1]), t: Float64Array.from([x, y, z]) })

  it('delivers a moved pose in translate mode', () => {
    const s = scene()
    const poses: Rigid[] = []
    s.gizmo('a', (p) => poses.push(p))
    const g = attached[attached.length - 1]
    expect(g.mode).toBe('translate')
    g.obj!.position.set(1, 2, 3)
    g.cb()
    expect(Array.from(poses[0].t)).toEqual([1, 2, 3])
    expect(poses[0].r[0]).toBeCloseTo(1)
  })

  it('hands a drag after a baked transform a pose consistent with T o pose', () => {
    const s = scene()
    s.setPose('a', move(1, 0, 0))
    const poses: Rigid[] = []
    s.gizmo('a', (p) => poses.push(p))
    const g = attached[attached.length - 1]
    s.partMoved(move(0, 0, 5)) // pose is now (1,0,5)
    g.obj!.position.x += 1 // the drag steps one along x
    g.cb()
    expect(Array.from(poses[0].t)).toEqual([2, 0, 5])
  })
})
