// SPDX-License-Identifier: AGPL-3.0-only
// What the worker can do with a point cloud. A cloud has no triangles, so an
// op that reads triangle data (an index, a face area, a ray hit) has nothing
// to work on; the worker refuses it up front, in words, instead of letting it
// fall over (or quietly answer for an empty mesh).
import type { MeshGraph } from './types'
import type { WorkerRequest } from './workerProtocol'
import { isCloud } from './geometry/cloud'

export const CLOUD_REFUSAL = 'Needs a mesh — this scan is a point cloud. Use Mesh this cloud (on the scan’s card, or mesh.mesh_cloud), or mesh it in your scanner software and open the mesh.'

/** Every request type, classified once (the `satisfies` makes a type missing
 *  here a compile error). `align` is one type with several variants — auto,
 *  points, local — and none of them reads the scan's triangles: the scan is
 *  only ever moved and measured as points against the reference.
 *
 *  Audit of the scan's triangle data (`.indices`, `triangleCount`, face
 *  areas, `scanSurfaceOf`) reached from a worker op:
 *   - shadow: shadowMesh
 *   - centroid: meshCentroid; symmetry: trianglesWithin / scanSurfaceOf
 *   - curvature: triangle areas
 *   - heights, scan-qa, scan-rim: solid index, rim loops
 *   - thickness: solid index; closed-shells (scan): closedVertices
 *   - deviate-reference, deviate-volume: scanSurfaceOf, WindingTree
 *  Taken on a cloud after all: section (sliceCloud reads the cut off the
 *  points in a band about the plane), segment and auto-align (each point weighs its
 *  density-based patch, vertexAreas, in place of a third of each triangle),
 *  nearest (the spot is the nearest point, with no
 *  triangle) and plane-region (vertexAreas gives each point its density-based
 *  patch; closedAlong finds no triangle crossings, so a bore on a cloud reports
 *  no closed end — tested).
 *  Left false: bounds-tree works on the positions and index sent with the
 *  request, never the scan (it also serves the reference's tree while the
 *  scan is a cloud); recrease re-posts through postScan, which has its own
 *  cloud branch; the rest read points, normals and adjacency only. */
export const OP_CAPS = {
  load: { needsTriangles: false },
  'load-buffers': { needsTriangles: false },
  'commit-import': { needsTriangles: false },
  'discard-import': { needsTriangles: false },
  recrease: { needsTriangles: false },
  fit: { needsTriangles: false },
  'fit-selection': { needsTriangles: false },
  'load-nominal': { needsTriangles: false },
  align: { needsTriangles: false },
  'align-abort': { needsTriangles: false },
  deviate: { needsTriangles: false },
  'deviate-reference': { needsTriangles: true },
  'deviate-volume': { needsTriangles: true },
  thickness: { needsTriangles: true },
  transform: { needsTriangles: false },
  section: { needsTriangles: false },
  shadow: { needsTriangles: true },
  centroid: { needsTriangles: true },
  symmetry: { needsTriangles: true },
  flood: { needsTriangles: false },
  'plane-region': { needsTriangles: false },
  segment: { needsTriangles: false },
  curvature: { needsTriangles: true },
  nearest: { needsTriangles: false },
  bounds: { needsTriangles: false },
  query: { needsTriangles: false },
  heights: { needsTriangles: true },
  'scan-qa': { needsTriangles: true },
  'scan-rim': { needsTriangles: true },
  'auto-align': { needsTriangles: false },
  // The cloud's stand-in for heights: rays against points (geometry/insideRays).
  'inside-rays': { needsTriangles: false },
  // which='nominal' is the reference's own shells; the worker lets it through.
  'closed-shells': { needsTriangles: true },
  deflection: { needsTriangles: false },
  'element-deviation': { needsTriangles: false },
  'bounds-tree': { needsTriangles: false },
  // Gated per plugin in the worker (WorkerPlugin.acceptsClouds), not here.
  plugin: { needsTriangles: false },
} satisfies Record<WorkerRequest['type'], { needsTriangles: boolean }>

/** The refusal for running `op` on `g`, or null when it may run. */
export function refusesOnCloud(op: WorkerRequest['type'], g: MeshGraph | null): string | null {
  return g && isCloud(g) && OP_CAPS[op].needsTriangles ? CLOUD_REFUSAL : null
}

/** The refusal for work that reaches `ops`, when the scan is a cloud — the
 *  same ruling the worker gives each op, asked before the work starts. */
export function refusesOpsOnCloud(ops: readonly WorkerRequest['type'][], scanIsCloud: boolean): string | null {
  return scanIsCloud && ops.some((op) => OP_CAPS[op].needsTriangles) ? CLOUD_REFUSAL : null
}
