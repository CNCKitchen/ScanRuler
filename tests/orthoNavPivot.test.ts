// SPDX-License-Identifier: AGPL-3.0-only
// The orbit's pivot on the surface under the cursor while a part's bounds
// tree is still being built off the thread: the part waiting is not run
// through triangle by triangle, but it still hides what lies behind it, and
// it does not take the pivot off a part beside it that has its tree.
import * as THREE from 'three'
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrthoNavigator } from '../src/viewer/orthoNav'
import { treeOffThread } from '../src/viewer/bvh'
import type { SerializedTree } from '../src/core/workerProtocol'

/** A box of side `size` centred at `at`, its tree on its way and never landing. */
function waitingBox(size: number, at: [number, number, number]): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(size, size, size))
  mesh.position.set(...at)
  mesh.updateMatrixWorld()
  treeOffThread(mesh.geometry, () => new Promise<SerializedTree>(() => {}), () => {})
  return mesh
}

function navigatorOver(targets: THREE.Object3D[]): OrthoNavigator {
  vi.stubGlobal('document', { addEventListener: () => {}, removeEventListener: () => {} })
  const canvas = {
    addEventListener: () => {},
    removeEventListener: () => {},
    clientHeight: 600,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
  } as unknown as HTMLCanvasElement
  const camera = new THREE.OrthographicCamera(-4 / 3, 4 / 3, 1, -1, 0.01, 100)
  camera.position.set(0, 0, 10)
  camera.lookAt(0, 0, 0)
  camera.updateMatrixWorld()
  return new OrthoNavigator(camera, { target: new THREE.Vector3(), update: () => {} } as unknown as OrbitControls, canvas, () => targets, {
    center: new THREE.Vector3(),
    radius: 5,
  })
}

describe('the orbit pivot while a tree is on its way', () => {
  afterEach(() => vi.unstubAllGlobals())

  const ready = () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1))
    mesh.updateMatrixWorld()
    return mesh
  }

  it('is on the part with a tree when the waiting one is beside it', () => {
    const nav = navigatorOver([ready(), waitingBox(0.4, [1, 0, 3])])
    const at = nav.surfaceAt(400, 300)
    expect(at).not.toBeNull()
    expect(at!.z).toBeCloseTo(0.5)
  })

  it('is nowhere when the waiting part may stand in front of it', () => {
    const nav = navigatorOver([ready(), waitingBox(0.4, [0, 0, 3])])
    expect(nav.surfaceAt(400, 300)).toBeNull()
  })

  it('is nowhere when every part is waiting', () => {
    const nav = navigatorOver([waitingBox(1, [0, 0, 0])])
    expect(nav.surfaceAt(400, 300)).toBeNull()
  })
})
