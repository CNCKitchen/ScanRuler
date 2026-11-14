// SPDX-License-Identifier: AGPL-3.0-only
// What the window and the lasso share, whether they select triangles or
// points: the point-in-outline test and the size of a pixel in the world.
import * as THREE from 'three'

/** Point-in-polygon by crossing number, with the outline's bounding box in
 *  front of it. The box rejects the great majority of a part's triangles for
 *  four comparisons, which matters when the test runs once per triangle of a
 *  million-triangle scan. A lasso that crosses itself is filled by the
 *  odd-even rule — the same thing every drawing program does with one. */
export function polygonTester(outline: { x: number; y: number }[]): (x: number, y: number) => boolean {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of outline) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x)
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y)
  }
  const n = outline.length
  return (x, y) => {
    if (x < minX || x > maxX || y < minY || y > maxY) return false
    let inside = false
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const yi = outline[i].y
      const yj = outline[j].y
      if (yi > y === yj > y) continue
      const xi = outline[i].x
      if (x < ((outline[j].x - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
    }
    return inside
  }
}

/**
 * How many millimetres a pixel spans where the outline marks. A parallel
 * camera spans the same everywhere. In perspective it grows with depth, so it
 * is taken at the mean depth of what is drawn inside the outline's box.
 */
export function pixelSpan(
  camera: THREE.OrthographicCamera | THREE.PerspectiveCamera,
  h: number,
  sx: Float32Array,
  sy: Float32Array,
  sz: Float32Array,
  clipped: Uint8Array,
  box: { minX: number; minY: number; maxX: number; maxY: number },
): number {
  if (!(camera instanceof THREE.PerspectiveCamera)) return (camera.top - camera.bottom) / camera.zoom / h
  let sum = 0
  let n = 0
  for (let v = 0; v < sz.length; v++) {
    if (clipped[v] || sx[v] < box.minX || sx[v] > box.maxX || sy[v] < box.minY || sy[v] > box.maxY) continue
    sum += sz[v]
    n++
  }
  const depth = n > 0 ? sum / n : camera.position.length()
  return (2 * depth * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / camera.zoom / h
}
