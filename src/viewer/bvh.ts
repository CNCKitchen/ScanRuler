// SPDX-License-Identifier: AGPL-3.0-only
// Keeping a geometry's bounds tree in step with positions that moved.

import type * as THREE from 'three'
import { computeBoundsTree } from 'three-mesh-bvh'

/**
 * Bring a geometry's culling bounds and bounds tree up to date after a rigid
 * move was baked into its positions.
 *
 * A rigid move leaves the triangles and the index as they were, so the tree's
 * shape — which triangles share a leaf — is still a good one; only the boxes
 * around them have moved. Refitting rewrites those boxes in place, walking the
 * tree once, where a rebuild partitions every triangle again on the main
 * thread; on a 287k-triangle part that is about eight times less work.
 * A mirroring counts as rigid here: the tree holds boxes and indices, never a
 * winding, so it does not mind which way the triangles now face.
 *
 * Only for a move that kept the index and the vertex count. Anything that lays
 * the geometry out again must build a tree afresh, as the tree is indexed by
 * the triangles it was built over. The tree object stays the same one, mutated
 * in place; nothing in the app holds on to it beyond a single call.
 *
 * The bounding box and sphere are renewed here too, before anything reads
 * them: a new tree only ever sets the box on a geometry that has none, so the
 * stale ones would otherwise outlive a fallback build as well.
 */
export function refitAfterRigid(geometry: THREE.BufferGeometry): void {
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  if (geometry.boundsTree) geometry.boundsTree.refit()
  else computeBoundsTree.call(geometry)
}
