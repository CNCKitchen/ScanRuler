// SPDX-License-Identifier: AGPL-3.0-only
import * as THREE from 'three'
import { selectionBoundary } from '../core/triangleSelection'
import { TriangleVisibility } from './triangleVisibility'

export type SelectionRegion =
  | { kind: 'window'; minX: number; minY: number; maxX: number; maxY: number }
  | { kind: 'lasso'; points: { x: number; y: number }[] }
  | { kind: 'brush'; a: { x: number; y: number }; b: { x: number; y: number }; radius: number }

export interface SelectionRequest {
  requestId: number
  type: 'select' | 'boundary'
  mesh?: { positions: Float32Array; indices: Uint32Array }
  mask: Uint8Array
  remove: boolean
  camera: { world: number[]; projection: number[] }
  part: number[]
  width: number
  height: number
  planes: number[][]
  regions: SelectionRegion[]
}

export type SelectionResponse =
  | { type: 'progress'; requestId: number; text: string; percent?: number }
  | { type: 'done'; requestId: number; mask: Uint8Array; edges: Uint32Array }
  | { type: 'error'; requestId: number; message: string }

export function regionContains(region: SelectionRegion, x: number, y: number): boolean {
  if (region.kind === 'window') return x >= region.minX && x <= region.maxX && y >= region.minY && y <= region.maxY
  if (region.kind === 'brush') {
    const { a, b, radius } = region
    const dx = b.x - a.x, dy = b.y - a.y, length2 = dx * dx + dy * dy
    const t = length2 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / length2)) : 0
    return (x - a.x - t * dx) ** 2 + (y - a.y - t * dy) ** 2 <= radius * radius
  }
  let inside = false
  const points = region.points
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i], b = points[j]
    if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

export class SelectionJob {
  private mesh: SelectionRequest['mesh']
  private visibility: TriangleVisibility | null = null

  run(request: SelectionRequest, progress: (text: string, percent?: number) => void): { mask: Uint8Array; edges: Uint32Array } {
    if (request.mesh) {
      this.visibility?.dispose()
      this.visibility = null
      this.mesh = request.mesh
    }
    const mesh = this.mesh
    if (!mesh) throw new Error('The visible-selection worker has no mesh. Retry the selection.')
    if (request.mask.length * 3 !== mesh.indices.length) throw new Error('The selection belongs to a different mesh.')
    if (request.type === 'select') {
      if (!this.visibility) {
        progress('Preparing visibility checks...')
        const soup = new Float32Array(mesh.indices.length * 3)
        for (let i = 0; i < mesh.indices.length; i++) {
          const at = mesh.indices[i] * 3
          soup[i * 3] = mesh.positions[at]
          soup[i * 3 + 1] = mesh.positions[at + 1]
          soup[i * 3 + 2] = mesh.positions[at + 2]
        }
        this.visibility = new TriangleVisibility(soup)
      }
      const camera = new THREE.OrthographicCamera()
      camera.matrixWorld.fromArray(request.camera.world)
      camera.matrixWorldInverse.copy(camera.matrixWorld).invert()
      camera.projectionMatrix.fromArray(request.camera.projection)
      camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert()
      camera.matrixAutoUpdate = false
      camera.matrixWorldAutoUpdate = false
      progress('Checking visible triangles...')
      this.visibility.apply(request.mask, request.remove, camera, new THREE.Matrix4().fromArray(request.part),
        request.width, request.height,
        request.planes.map((p) => new THREE.Plane(new THREE.Vector3(p[0], p[1], p[2]), p[3])),
        (x, y) => request.regions.length === 0 || request.regions.some((r) => regionContains(r, x, y)),
        progress)
    }
    progress('Finding selection boundaries...')
    return { mask: request.mask, edges: selectionBoundary(mesh.indices, mesh.positions.length / 3, request.mask) }
  }

  dispose(): void {
    this.visibility?.dispose()
    this.visibility = null
    this.mesh = undefined
  }
}
