// SPDX-License-Identifier: AGPL-3.0-only
// A ray meets only what is drawn. On a mesh whose material clips it, a hit
// on the side clipped away is no hit — the surface is not there to be
// clicked, hovered, painted or pivoted on — and where the cut is closed with
// a cap (sliceCap), a hit behind the cap is hidden by it, as the surface
// behind a solid face is. Installed over three-mesh-bvh's raycast for every
// mesh (see SceneManager), so every pick, the orbit pivot, the brush and the
// pins' occlusion test hold to it without asking.

import type * as THREE from 'three'
import { acceleratedRaycast } from 'three-mesh-bvh'
import { raySpared } from './bvh'

/** How far behind a plane a hit may lie and still count as on it, mm: the
 *  clip in the shader and the hit off the BVH are worked out apart. */
const ON_PLANE = 1e-6

/** The key on a mesh's userData naming its triangles a cap closes — one byte
 *  each, 1 for a triangle of a closed shell — while the cut is capped. */
export const CAPPED_TRIANGLES = 'cappedTriangles'

/** The planes a material clips by, or null for none. */
function clipPlanesOf(material: THREE.Material | THREE.Material[]): THREE.Plane[] | null {
  const m = Array.isArray(material) ? material[0] : material
  const planes = m?.clippingPlanes
  return planes && planes.length > 0 ? planes : null
}

/**
 * Of every hit along a ray, nearest first, the ones that can be seen: on the
 * kept side of every plane, and — with `capped`, the triangles whose cut a
 * cap closes on the first plane — not behind the cap. The ray is inside a
 * closed shell where it crosses the plane when it has crossed that shell's
 * surface an odd number of times on the way; the cap is drawn there, and
 * whatever lies past it is hidden.
 */
export function keptHits(
  hits: readonly THREE.Intersection[],
  planes: readonly THREE.Plane[],
  ray: THREE.Ray,
  capped: Uint8Array | null,
): THREE.Intersection[] {
  const sorted = [...hits].sort((a, b) => a.distance - b.distance)
  let kept = sorted.filter((h) => planes.every((p) => p.distanceToPoint(h.point) >= -ON_PLANE))
  if (capped && kept.length > 0) {
    const at = ray.distanceToPlane(planes[0])
    if (at !== null) {
      let crossed = 0
      for (const h of sorted) {
        if (h.distance >= at) break
        if (h.faceIndex !== undefined && h.faceIndex !== null && capped[h.faceIndex] === 1) crossed++
      }
      if (crossed % 2 === 1) kept = kept.filter((h) => h.distance < at)
    }
  }
  return kept
}

/** Mesh.raycast for every mesh: three-mesh-bvh's, holding to the clip. */
export function clippedRaycast(this: THREE.Mesh, raycaster: THREE.Raycaster, intersects: THREE.Intersection[]): void {
  // A frame's pointer test does not go through every triangle of a part
  // whose tree is still on its way — see bvh.ts sparingRays.
  if (raySpared(this.geometry)) return
  const planes = clipPlanesOf(this.material)
  if (!planes) {
    acceleratedRaycast.call(this, raycaster, intersects)
    return
  }
  // Every hit, the clipped ones too: the nearest may be on the side cut away,
  // and the ones before the plane say whether the ray is inside a shell there.
  const rc = raycaster as THREE.Raycaster & { firstHitOnly?: boolean }
  const first = rc.firstHitOnly === true
  const all: THREE.Intersection[] = []
  rc.firstHitOnly = false
  try {
    acceleratedRaycast.call(this, raycaster, all)
  } finally {
    rc.firstHitOnly = first
  }
  const capped = (this.userData[CAPPED_TRIANGLES] as Uint8Array | undefined) ?? null
  const kept = keptHits(all, planes, raycaster.ray, capped)
  if (first) {
    if (kept.length > 0) intersects.push(kept[0])
  } else intersects.push(...kept)
}
