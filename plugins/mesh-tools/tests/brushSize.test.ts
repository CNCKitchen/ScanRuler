// SPDX-License-Identifier: AGPL-3.0-only
import { Matrix4, OrthographicCamera } from 'three'
import { expect, it } from 'vitest'
import { brushDiameterPixels } from '../viewer/brushSize'

it('projects model-unit brush diameter consistently through zoom, resize and part scale', () => {
  const camera = new OrthographicCamera(-50, 50, 50, -50)
  const part = new Matrix4()
  expect(brushDiameterPixels(10, camera, part, 1000)).toBe(100)
  camera.zoom = 2
  expect(brushDiameterPixels(10, camera, part, 1000)).toBe(200)
  expect(brushDiameterPixels(10, camera, part, 500)).toBe(100)
  part.makeScale(3, 3, 3)
  expect(brushDiameterPixels(10, camera, part, 500)).toBe(300)
  expect(brushDiameterPixels(0.1, camera, new Matrix4(), 500)).toBe(1)
})
