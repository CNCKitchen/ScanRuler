// SPDX-License-Identifier: AGPL-3.0-only
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { TriangleVisibility } from '../viewer/triangleVisibility'

function sheets(n: number): Float32Array {
  const positions = new Float32Array(n * n * 36)
  let at = 0
  for (const z of [0, -0.000001]) {
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const a = [x / n, y / n, z], b = [(x + 1) / n, y / n, z]
      const c = [(x + 1) / n, (y + 1) / n, z], d = [x / n, (y + 1) / n, z]
      for (const p of [a, b, c, a, c, d]) { positions.set(p, at); at += 3 }
    }
  }
  return positions
}

function camera(zoom: number, underneath = false) {
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100)
  cam.position.set(0.5, 0.5, underneath ? -10 : 10)
  cam.lookAt(0.5, 0.5, 0)
  cam.zoom = zoom
  cam.updateProjectionMatrix()
  cam.updateMatrixWorld(true)
  return cam
}

describe('subpixel triangle visibility', () => {
  it('selects every front triangle regardless of pixel density and zoom, never the nearby rear sheet', () => {
    const visibility = new TriangleVisibility(sheets(25))
    try {
      for (const zoom of [0.001, 0.05, 1]) {
        const mask = new Uint8Array(2500)
        visibility.apply(mask, false, camera(zoom), new THREE.Matrix4(), 32, 32, [], () => true)
        expect(mask.subarray(0, 1250).every((v) => v === 1), `zoom ${zoom}`).toBe(true)
        expect(mask.subarray(1250).every((v) => v === 0), `zoom ${zoom}`).toBe(true)
      }
    } finally { visibility.dispose() }
  })
  it('supports back-facing undersides, subtracts only visible triangles, and preserves prior hidden selection', () => {
    const visibility = new TriangleVisibility(sheets(8))
    try {
      const mask = new Uint8Array(256)
      visibility.apply(mask, false, camera(0.001, true), new THREE.Matrix4(), 32, 32, [], () => true)
      expect(mask.subarray(128).every((v) => v === 1)).toBe(true)
      visibility.apply(mask, true, camera(1), new THREE.Matrix4(), 32, 32, [], () => true)
      expect(mask.subarray(128).every((v) => v === 1)).toBe(true)
      visibility.apply(mask, false, camera(1), new THREE.Matrix4(), 32, 32, [], () => true)
      expect(mask.every((v) => v === 1)).toBe(true)
      visibility.apply(mask, true, camera(1, true), new THREE.Matrix4(), 32, 32, [], () => true)
      expect(mask.subarray(0, 128).every((v) => v === 1)).toBe(true)
      expect(mask.subarray(128).every((v) => v === 0)).toBe(true)
    } finally { visibility.dispose() }
  })
  it('limits completion to a window and respects clipping and alignment', () => {
    const visibility = new TriangleVisibility(sheets(8))
    try {
      const part = new THREE.Matrix4().makeTranslation(2, 0, 0)
      const cam = camera(1)
      cam.position.x += 2
      cam.lookAt(2.5, 0.5, 0)
      cam.updateMatrixWorld(true)
      const mask = new Uint8Array(256)
      visibility.apply(mask, false, cam, part, 100, 100,
        [new THREE.Plane(new THREE.Vector3(0, 0, -1), -0.0000005)], (x) => x < 50)
      expect(mask.subarray(0, 128).every((v) => v === 0)).toBe(true)
      expect(mask.subarray(128).reduce((n, v) => n + v, 0)).toBe(64)
    } finally { visibility.dispose() }
  })
})
