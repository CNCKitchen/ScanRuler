// SPDX-License-Identifier: AGPL-3.0-only
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { perspectiveFrom } from '../src/viewer/orthoViewport'

/** A parallel camera as the viewport holds one: looking at `target` from
 *  `dir`, zoomed, its clip range about the part. */
function ortho(target: THREE.Vector3, dir: THREE.Vector3, zoom: number): THREE.OrthographicCamera {
  const camera = new THREE.OrthographicCamera(-80, 80, 50, -50, -20, 300)
  camera.position.copy(target).addScaledVector(dir.clone().normalize(), 120)
  camera.up.set(0, 0, 1)
  camera.lookAt(target)
  camera.zoom = zoom
  camera.updateProjectionMatrix()
  camera.updateMatrixWorld(true)
  return camera
}

describe('the perspective view', () => {
  const target = new THREE.Vector3(12, -7, 30)
  const o = ortho(target, new THREE.Vector3(0.7, -0.9, 0.5), 2.5)
  const p = perspectiveFrom(o, target, new THREE.PerspectiveCamera(30, 1, 0.1, 1000))

  it('draws the orbit target and the plane through it where the parallel view does', () => {
    const right = new THREE.Vector3().setFromMatrixColumn(o.matrixWorld, 0)
    const up = new THREE.Vector3().setFromMatrixColumn(o.matrixWorld, 1)
    for (const [a, b] of [[0, 0], [10, 0], [0, -12], [-15, 9]]) {
      const spot = target.clone().addScaledVector(right, a).addScaledVector(up, b)
      const inParallel = spot.clone().project(o)
      const inPerspective = spot.clone().project(p)
      expect(inPerspective.x).toBeCloseTo(inParallel.x, 9)
      expect(inPerspective.y).toBeCloseTo(inParallel.y, 9)
    }
  })

  it('looks the same way, at the same shape of frame, with the part between its clip planes', () => {
    expect(p.getWorldDirection(new THREE.Vector3()).angleTo(o.getWorldDirection(new THREE.Vector3()))).toBeCloseTo(0, 9)
    expect(p.aspect).toBeCloseTo(160 / 100, 12)
    const depth = p.position.distanceTo(target)
    expect(p.near).toBeLessThan(depth)
    expect(p.far).toBeGreaterThan(depth)
  })

  it('shows nearer things larger and farther ones smaller', () => {
    const toward = o.getWorldDirection(new THREE.Vector3()).negate()
    const side = new THREE.Vector3().setFromMatrixColumn(o.matrixWorld, 0)
    const near = target.clone().addScaledVector(toward, 20).addScaledVector(side, 10).project(p)
    const far = target.clone().addScaledVector(toward, -20).addScaledVector(side, 10).project(p)
    const flat = target.clone().addScaledVector(side, 10).project(o)
    expect(Math.abs(near.x)).toBeGreaterThan(Math.abs(flat.x))
    expect(Math.abs(far.x)).toBeLessThan(Math.abs(flat.x))
  })
})
