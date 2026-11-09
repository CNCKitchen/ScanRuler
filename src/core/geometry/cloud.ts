// SPDX-License-Identifier: AGPL-3.0-only
// What tells a point cloud's graph from a mesh's: a cloud has no triangles.
// A mesh without any is refused at load (buildMeshGraph), so the count alone
// is enough.

export function isCloud(g: { triangleCount: number }): boolean {
  return g.triangleCount === 0
}
