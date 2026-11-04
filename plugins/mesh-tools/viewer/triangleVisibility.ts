// SPDX-License-Identifier: AGPL-3.0-only
import * as THREE from 'three'
import { MeshBVH } from 'three-mesh-bvh'

/** Geometric centre rays supplement raster coverage for subpixel triangles. */
export class TriangleVisibility {
  private geometry = new THREE.BufferGeometry()
  private tree: MeshBVH

  constructor(private positions: Float32Array) {
    this.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    this.tree = new MeshBVH(this.geometry)
  }

  apply(
    mask: Uint8Array,
    remove: boolean,
    camera: THREE.OrthographicCamera,
    partMatrix: THREE.Matrix4,
    width: number,
    height: number,
    planes: THREE.Plane[],
    contains: (x: number, y: number) => boolean,
  ): void {
    const inverse = partMatrix.clone().invert()
    const project = camera.projectionMatrix.clone().multiply(camera.matrixWorldInverse).multiply(partMatrix)
    const localPlanes = planes.map((p) => p.clone().applyMatrix4(inverse))
    const direction = camera.getWorldDirection(new THREE.Vector3()).transformDirection(inverse)
    const ray = new THREE.Ray(new THREE.Vector3(), direction)
    const centre = new THREE.Vector3(), screen = new THREE.Vector3()
    const index = this.geometry.getIndex()!
    const wanted = remove ? 0 : 1
    for (let t = 0; t < mask.length; t++) {
      if (mask[t] === wanted) continue
      const at = t * 9, p = this.positions
      centre.set((p[at] + p[at + 3] + p[at + 6]) / 3,
        (p[at + 1] + p[at + 4] + p[at + 7]) / 3,
        (p[at + 2] + p[at + 5] + p[at + 8]) / 3)
      if (localPlanes.some((plane) => plane.distanceToPoint(centre) < 0)) continue
      screen.copy(centre).applyMatrix4(project)
      if (screen.x < -1 || screen.x > 1 || screen.y < -1 || screen.y > 1 || screen.z < -1 || screen.z > 1) continue
      if (!contains((screen.x + 1) * width / 2, (1 - screen.y) * height / 2)) continue
      ray.origin.set(screen.x, screen.y, -1).unproject(camera).applyMatrix4(inverse)
      // Compare triangle identity, never a depth tolerance that could reach a nearby sheet.
      const hit = localPlanes.length
        ? this.tree.raycast(ray, THREE.DoubleSide).filter((h) => localPlanes.every((plane) => plane.distanceToPoint(h.point) >= 0))
          .sort((a, b) => a.distance - b.distance)[0]
        : this.tree.raycastFirst(ray, THREE.DoubleSide)
      if (hit && hit.faceIndex != null && Math.floor(index.getX(hit.faceIndex * 3) / 3) === t) mask[t] = wanted
    }
  }

  dispose(): void {
    this.geometry.dispose()
  }
}
