// SPDX-License-Identifier: AGPL-3.0-only
import type { Matrix4, OrthographicCamera } from 'three'

export function brushDiameterPixels(diameter: number, camera: OrthographicCamera, part: Matrix4, height: number): number {
  return diameter * part.getMaxScaleOnAxis() * height * camera.zoom / (camera.top - camera.bottom)
}
