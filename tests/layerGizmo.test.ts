// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'

const made: { dispatchEvent(e: { type: string }): void; mode: string; dragging: boolean; axis: string | null }[] = []
vi.mock('three/examples/jsm/controls/TransformControls.js', async (orig) => {
  const mod = await orig<typeof import('three/examples/jsm/controls/TransformControls.js')>()
  class Spy extends mod.TransformControls {
    constructor(...a: ConstructorParameters<typeof mod.TransformControls>) {
      super(...a)
      made.push(this as never)
    }
  }
  return { ...mod, TransformControls: Spy }
})

import { layerGizmo } from '../src/viewer/layerGizmo'
import type { SceneLayerHost } from '../src/viewer/sceneLayers'

function setup() {
  const claims: boolean[] = []
  const host = {
    scene: new THREE.Scene(),
    camera: () => new THREE.PerspectiveCamera(),
    canvas: { addEventListener() {}, removeEventListener() {}, style: {} },
    invalidate() {},
    claimDrag: (on: boolean) => claims.push(on),
  } as unknown as SceneLayerHost
  const gizmo = layerGizmo(host)
  return { gizmo, claims, controls: made[made.length - 1] }
}

describe('layerGizmo', () => {
  it('claims the drag while a handle is hovered or held, and gives it back', () => {
    const { gizmo, claims, controls } = setup()
    gizmo.attach(new THREE.Object3D(), () => {})
    claims.length = 0
    controls.axis = 'X'
    expect(claims.at(-1)).toBe(true)
    controls.dragging = true
    controls.axis = null
    expect(claims.at(-1)).toBe(true) // still held
    controls.dragging = false
    expect(claims.at(-1)).toBe(false)
  })

  it('takes the mode and releases the claim on detach', () => {
    const { gizmo, claims, controls } = setup()
    gizmo.attach(new THREE.Object3D(), () => {}, 'rotate')
    expect(controls.mode).toBe('rotate')
    controls.axis = 'Z'
    expect(claims.at(-1)).toBe(true)
    gizmo.attach(null, () => {})
    expect(claims.at(-1)).toBe(false)
  })

  it('reaches onChange on an objectChange', () => {
    const { gizmo, controls } = setup()
    const cb = vi.fn()
    gizmo.attach(new THREE.Object3D(), cb)
    controls.dispatchEvent({ type: 'objectChange' })
    expect(cb).toHaveBeenCalledTimes(1)
  })
})
