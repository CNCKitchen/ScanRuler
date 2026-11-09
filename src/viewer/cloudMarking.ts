// SPDX-License-Identifier: AGPL-3.0-only
// Marking on a point cloud. The brush takes the points within its radius of
// the one under the cursor; the window and the lasso take the points they
// enclose that can be seen — facing the camera and not hidden behind a
// nearer surface (a depth splat per point, see frontSurfacePoints).
// Everything but the projection is in the frame the points are given in.

import * as THREE from 'three'
import type { PointGrid } from '../core/geometry/pointGrid'
import { frontSurfacePoints } from './frontSurface'
import { pixelSpan, polygonTester } from './screenSelect'

/** The points within `radius` of `center`. */
export function brushCloud(grid: PointGrid, center: readonly [number, number, number], radius: number): number[] {
  const out: number[] = []
  grid.withinRadius(center[0], center[1], center[2], radius, out)
  return out
}

export interface CloudMarqueeInput {
  positions: Float32Array
  normals: Float32Array
  /** Median point spacing, in the same units as the positions. */
  spacing: number
  camera: THREE.OrthographicCamera | THREE.PerspectiveCamera
  /** The cloud's local-to-world matrix. */
  partMatrix: THREE.Matrix4
  /** The viewport's size in pixels. */
  width: number
  height: number
  /** The window's corners or the lasso's trail, in pixels. */
  outline: { x: number; y: number }[]
  /** Through: take points facing away and ones hidden behind others. */
  backfaces: boolean
  /** The section's planes, in world space, as the material holds them. */
  clip: readonly THREE.Plane[]
}

/** Slack on a plane, as the mesh path allows. */
const ON_PLANE = 3e-6

/** The points an outline encloses that can be seen. */
export function marqueeCloud(o: CloudMarqueeInput): number[] {
  const { positions, normals, camera, partMatrix, width: w, height: h, outline, clip } = o
  if (outline.length < 3) return []
  const n = Math.floor(positions.length / 3)
  camera.updateMatrixWorld()
  const toView = new THREE.Matrix4().multiplyMatrices(camera.matrixWorldInverse, partMatrix)
  const toClip = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, toView)
  const world = new THREE.Vector3()
  const p = new THREE.Vector3()
  const view = new THREE.Vector3()
  const sx = new Float32Array(n)
  const sy = new Float32Array(n)
  const sz = new Float32Array(n)
  const dropped = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    p.set(positions[3 * i], positions[3 * i + 1], positions[3 * i + 2])
    if (clip.length > 0) {
      world.copy(p).applyMatrix4(partMatrix)
      for (const pl of clip) if (pl.distanceToPoint(world) < -ON_PLANE) dropped[i] = 1
    }
    sz[i] = -view.copy(p).applyMatrix4(toView).z
    p.applyMatrix4(toClip)
    sx[i] = ((p.x + 1) / 2) * w
    sy[i] = ((1 - p.y) / 2) * h
    if (p.z < -1 || p.z > 1 || !Number.isFinite(p.x + p.y + p.z)) dropped[i] = 1
  }

  let minX = w, minY = h, maxX = 0, maxY = 0
  for (const q of outline) {
    minX = Math.min(minX, q.x); maxX = Math.max(maxX, q.x)
    minY = Math.min(minY, q.y); maxY = Math.max(maxY, q.y)
  }
  const box = { minX: Math.max(0, minX), minY: Math.max(0, minY), maxX: Math.min(w, maxX), maxY: Math.min(h, maxY) }
  if (box.minX > box.maxX || box.minY > box.maxY) return []

  // The view direction in the cloud's own frame, for the facing test.
  const look = new THREE.Vector3(0, 0, -1)
    .applyQuaternion(camera.quaternion)
    .applyMatrix3(new THREE.Matrix3().setFromMatrix4(partMatrix).invert())
  const inFront = o.backfaces
    ? null
    : (() => {
        const perPixel = pixelSpan(camera, h, sx, sy, sz, dropped, box)
        return frontSurfacePoints(
          { sx, sy, sz, dropped: (i) => dropped[i] === 1 },
          box,
          o.spacing / perPixel,
          1.5 * o.spacing + 2 * perPixel,
        )
      })()

  const inside = polygonTester(outline)
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    if (dropped[i] || !inside(sx[i], sy[i])) continue
    if (!o.backfaces && normals[3 * i] * look.x + normals[3 * i + 1] * look.y + normals[3 * i + 2] * look.z >= 0) continue
    if (inFront && !inFront(i)) continue
    out.push(i)
  }
  return out
}
