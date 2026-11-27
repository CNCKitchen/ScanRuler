// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { unzipSync } from 'fflate'
import { previewCamera, visiblePreviewBounds } from '../src/viewer/projectPreview'
import { PREVIEW_NAME, packProject, unpackProject } from '../src/core/project/archive'
import { blankManifest } from '../src/app/project'

describe('saved project preview framing', () => {
  for (const perspective of [false, true]) {
    for (const aspect of [0.5, 1, 2]) {
      it(`fits visible bounds with a small border (${perspective ? 'perspective' : 'parallel'}, aspect ${aspect}) without changing the live pose`, () => {
        const original = perspective ? new THREE.PerspectiveCamera(45, 1, 0.1, 1000) : new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000)
        original.position.set(13, 25, 16)
        original.lookAt(new THREE.Vector3(10, -5, 2))
        original.zoom = 7
        original.updateProjectionMatrix()
        original.updateMatrixWorld(true)
        const before = original.toJSON()
        const box = new THREE.Box3(new THREE.Vector3(-40, -1, 8), new THREE.Vector3(250, 4, 25))
        const fitted = previewCamera(original, box, aspect)
        let reach = 0
        for (let i = 0; i < 8; i++) {
          const point = new THREE.Vector3(
            i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z,
          ).project(fitted)
          reach = Math.max(reach, Math.abs(point.x), Math.abs(point.y))
          expect(Math.abs(point.x)).toBeLessThan(0.94)
          expect(Math.abs(point.y)).toBeLessThan(0.94)
          expect(Math.abs(point.z)).toBeLessThanOrEqual(1)
        }
        expect(reach).toBeGreaterThan(0.91)
        expect(fitted.quaternion.equals(original.quaternion)).toBe(true)
        expect(original.toJSON()).toEqual(before)
      })
    }
  }

  it('does not frame hidden trial bodies, their descendants, or transparent materials', () => {
    const root = new THREE.Group()
    const part = new THREE.Mesh(new THREE.BoxGeometry(10, 4, 2))
    part.position.x = 50
    root.add(part)
    const hidden = new THREE.Group()
    hidden.visible = false
    const farAway = new THREE.Mesh(new THREE.BoxGeometry(1000, 1000, 1000))
    hidden.add(farAway)
    root.add(hidden)
    root.add(new THREE.Mesh(new THREE.BoxGeometry(2000, 2000, 2000), new THREE.MeshBasicMaterial({ opacity: 0 })))
    const bounds = visiblePreviewBounds([root])
    expect(bounds.min.toArray()).toEqual([45, -2, -1])
    expect(bounds.max.toArray()).toEqual([55, 2, 1])
    expect(hidden.visible).toBe(false)
    expect(part.position.x).toBe(50)
  })

  it('rejects invalid bounds rather than silently making a broken camera', () => {
    const camera = new THREE.PerspectiveCamera()
    expect(() => previewCamera(camera, new THREE.Box3())).toThrow('visible content')
    expect(() => previewCamera(camera, new THREE.Box3(new THREE.Vector3(), new THREE.Vector3(Infinity, 1, 1)))).toThrow('visible content')
  })
})

describe('optional embedded preview archive member', () => {
  it('stores the PNG without deflating it and retains old project compatibility', () => {
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
    const manifest = blankManifest('0.10.2')
    const bytes = packProject(manifest, [{ name: PREVIEW_NAME, bytes: png }])
    let method: number | undefined
    unzipSync(bytes, { filter: (file) => { if (file.name === PREVIEW_NAME) method = file.compression; return true } })
    expect(method).toBe(0)
    expect(unpackProject(bytes).members.get(PREVIEW_NAME)).toEqual(png)
    expect(unpackProject(packProject(manifest, [])).members.has(PREVIEW_NAME)).toBe(false)
  })
})
