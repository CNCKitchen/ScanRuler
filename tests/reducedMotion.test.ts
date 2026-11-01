// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { OrthoViewport } from '../src/viewer/orthoViewport'

// Exercise the actual camera interpolation without constructing a GPU renderer.
function cameraViewport() {
  const viewport = Object.create(OrthoViewport.prototype) as OrthoViewport
  Object.assign(viewport, {
    camera: new THREE.OrthographicCamera(-1, 1, 1, -1, .01, 100),
    controls: { target: new THREE.Vector3() },
    clipSphere: { center: new THREE.Vector3(), radius: 1 },
    invalidate: vi.fn(),
    poseOf: () => ({q: new THREE.Quaternion(),target: new THREE.Vector3(1,2,3),zoom:2,dist:10}),
  })
  return viewport
}
afterEach(() => vi.unstubAllGlobals())
describe('camera motion preference', () => {
  it('reaches the exact final pose immediately when reduced motion is requested', () => {
    vi.stubGlobal('matchMedia', () => ({matches:true}))
    const viewport = cameraViewport()
    viewport.animateLook(new THREE.Vector3(0,0,1),new THREE.Vector3(0,1,0),new THREE.Vector3(),500)
    expect(viewport.turning()).toBe(false)
    expect(viewport.pose().target.toArray()).toEqual([1,2,3])
    expect(viewport.pose().zoom).toBe(2)
  })
  it('retains animated navigation for the normal preference', () => {
    vi.stubGlobal('matchMedia', () => ({matches:false}))
    const viewport = cameraViewport()
    viewport.animateLook(new THREE.Vector3(0,0,1),new THREE.Vector3(0,1,0),new THREE.Vector3(),500)
    expect(viewport.turning()).toBe(true)
  })
})
