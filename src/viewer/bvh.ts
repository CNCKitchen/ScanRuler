// SPDX-License-Identifier: AGPL-3.0-only
// Keeping a geometry's bounds tree in step with positions that moved, and
// building one off the main thread.

import type * as THREE from 'three'
import { computeBoundsTree, MeshBVH, type MeshBVHOptions } from 'three-mesh-bvh'
import type { SerializedTree } from '../core/workerProtocol'

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
 *
 * A geometry whose tree is being built off the thread (see treeOffThread) is
 * left to it: the tree is refitted to the move when it lands, which costs a
 * walk over it rather than the build it is there to spare.
 */
export function refitAfterRigid(geometry: THREE.BufferGeometry): void {
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  if (geometry.boundsTree) geometry.boundsTree.refit()
  else if (!treeAwaited(geometry)) computeBoundsTree.call(geometry, INDIRECT)
}

/** A tree that sorts its own list of triangle numbers and never the index:
 *  the index is drawn and read by triangle — the section caps, the picks —
 *  so a tree built over a part already shown must leave it as it is. */
const INDIRECT = { indirect: true } as MeshBVHOptions

/** A tree sent from the worker, laid over the geometry it was built for,
 *  whose index it reads as it stands. */
function treeFrom(data: SerializedTree, geometry: THREE.BufferGeometry, index: THREE.BufferAttribute): MeshBVH {
  // three-mesh-bvh's own type knows nothing of the indirect order; the
  // index it asks for is the geometry's, and is not laid back (setIndex).
  const serialized = { roots: data.roots, indirectBuffer: data.indirectBuffer, index: index.array }
  return MeshBVH.deserialize(serialized, geometry, { setIndex: false })
}

/** The geometries whose tree is being built off the thread, each with the
 *  build it waits for — a later one supersedes it. */
const awaiting = new WeakMap<THREE.BufferGeometry, object>()

/** Whether a geometry's tree is on its way from off the thread, and it has
 *  none in the meantime. */
export function treeAwaited(geometry: THREE.BufferGeometry): boolean {
  return !geometry.boundsTree && awaiting.has(geometry)
}

/**
 * Have a geometry's bounds tree built elsewhere — the mesh worker, through
 * `build` — and laid over it when it comes back, rather than built here in
 * one long task. `build` is handed copies of the positions and the index as
 * they are now. The tree is indirect: it keeps its own order of the
 * triangles and never sorts the index, which is drawn and read by triangle
 * — the section caps and the picks — from the moment the part is shown.
 *
 * Until it lands the geometry has no tree: a pick takes three.js's ray
 * through every triangle, and the pointer tests a frame makes skip the part
 * (see sparingRays). A tree is laid over the geometry only if that is still
 * the geometry it was built for — the same index and the same positions
 * attribute — and the geometry has not been given a tree of its own since;
 * positions moved in place by a rigid move in the meantime are refitted to.
 * If the build fails, the tree is built here after all, as late as it is,
 * and over the index as it stands. `landed` is called once a tree is in
 * place, for whoever has something to look at again.
 */
export function treeOffThread(
  geometry: THREE.BufferGeometry,
  build: (positions: Float32Array, indices: Uint32Array) => Promise<SerializedTree>,
  landed: () => void,
): void {
  const index = geometry.getIndex()
  const position = geometry.getAttribute('position') as THREE.BufferAttribute
  if (!index) {
    computeBoundsTree.call(geometry)
    return
  }
  const ticket = {}
  awaiting.set(geometry, ticket)
  const version = position.version
  // Still the geometry the tree describes, and still without one: anything
  // else that laid it out again built its own.
  const current = () => {
    if (awaiting.get(geometry) !== ticket) return false
    awaiting.delete(geometry)
    return !geometry.boundsTree && geometry.getIndex() === index && geometry.getAttribute('position') === position
  }
  // A build that throws as it is asked fails like one that answers so.
  new Promise<SerializedTree>((resolve) => resolve(build((position.array as Float32Array).slice(), new Uint32Array(index.array)))).then(
    (tree) => {
      if (!current()) return
      try {
        const bvh = treeFrom(tree, geometry, index)
        // Moved while the tree was out: the same triangles, boxes elsewhere.
        if (position.version !== version) bvh.refit()
        geometry.boundsTree = bvh
      } catch (e) {
        // A tree that does not fit what it landed on: built here instead.
        console.warn('The bounds tree from the mesh worker could not be used; building it here.', e)
        geometry.boundsTree = undefined
        computeBoundsTree.call(geometry, INDIRECT)
      }
      landed()
    },
    (e) => {
      if (!current()) return
      console.warn('The mesh worker could not build the bounds tree; building it here.', e)
      computeBoundsTree.call(geometry, INDIRECT)
      landed()
    },
  )
}

/** Turn away the tree on its way to a geometry given up — see treeOffThread.
 *  For a part taken off the stage: a geometry is disposed, too, to free its
 *  GPU buffers while it goes on being drawn, so that says nothing. */
export function forgetTree(geometry: THREE.BufferGeometry): void {
  awaiting.delete(geometry)
}

/** How many pointer tests a frame makes are running — see sparingRays. */
let sparing = 0

/**
 * Run the pointer tests a frame makes — the hover, the brush's footprint,
 * the pins' line of sight — so that a ray meets nothing on a geometry whose
 * tree is still being built off the thread (see treeOffThread). Without a
 * tree, a ray goes through every triangle; on a scan of a million that is
 * far more than a frame has, paid on every frame the cursor moves. A click
 * is not run this way: it is made once, and finds the part the slow way.
 * When the tree lands, the tests are run again.
 */
export function sparingRays<T>(test: () => T): T {
  sparing++
  try {
    return test()
  } finally {
    sparing--
  }
}

/** Whether a ray at this geometry is to meet nothing — see sparingRays. */
export function raySpared(geometry: THREE.BufferGeometry): boolean {
  return sparing > 0 && treeAwaited(geometry)
}
