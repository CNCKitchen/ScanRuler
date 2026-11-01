// SPDX-License-Identifier: AGPL-3.0-only
// Level of detail for the scan while the camera moves. A scan of a few million
// triangles orbits at a crawl, so while the view is in motion a coarse proxy
// is drawn in its place and the full mesh comes back once the view settles.
// The proxy is only an index buffer over the scan's own vertices — colours,
// deviation, paint and texture ride along unchanged — and it is never
// raycast: picking and measuring always see full detail.

/** Scans above this many triangles get a proxy, cut to about this many. */
export const LOD_TRIANGLES = 400_000

/** How long the view has to hold still before full detail comes back. */
export const LOD_SETTLE_MS = 180

/**
 * Triangles of a coarser mesh by vertex clustering: the bounding box is cut
 * into a grid, every vertex stands in for the first one met in its cell, and
 * triangles that collapse are dropped. The grid is resized until the result
 * is near `target` triangles. Null when the mesh is small enough already.
 */
export function clusterIndices(positions: Float32Array, indices: Uint32Array, target = LOD_TRIANGLES): Uint32Array | null {
  const tris = indices.length / 3
  if (tris <= target) return null
  const n = positions.length / 3
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2]
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
    if (z < minZ) minZ = z
    if (z > maxZ) maxZ = z
  }
  const extent = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1e-9)
  const rep = new Int32Array(n)
  const cells = new Map<number, number>()
  // A surface meets about as many cells as the grid's side squared, and a
  // mesh has about twice as many triangles as vertices.
  let side = Math.max(2, Math.sqrt(target / 2))
  let out: Uint32Array = new Uint32Array(0)
  for (let pass = 0; pass < 3; pass++) {
    const k = Math.min(Math.floor(side), 2 ** 20 - 1)
    const s = k / extent
    cells.clear()
    for (let i = 0; i < n; i++) {
      const cx = Math.min(k, Math.floor((positions[i * 3] - minX) * s))
      const cy = Math.min(k, Math.floor((positions[i * 3 + 1] - minY) * s))
      const cz = Math.min(k, Math.floor((positions[i * 3 + 2] - minZ) * s))
      const key = (cx * (k + 1) + cy) * (k + 1) + cz
      let r = cells.get(key)
      if (r === undefined) cells.set(key, (r = i))
      rep[i] = r
    }
    const kept: number[] = []
    for (let t = 0; t < indices.length; t += 3) {
      const a = rep[indices[t]], b = rep[indices[t + 1]], c = rep[indices[t + 2]]
      if (a !== b && b !== c && a !== c) kept.push(a, b, c)
    }
    out = Uint32Array.from(kept)
    const got = out.length / 3
    if (got > target * 0.7 && got <= target * 1.1) break
    side *= Math.sqrt(target / Math.max(got, 1))
  }
  return out.length / 3 < tris ? out : null
}

/** Whether the camera is on the move: true from the frame its matrix changes
 *  until it has held still for `settleMs`. */
export class MotionLatch {
  private last: number[] | null = null
  private movedAt = -Infinity

  constructor(private settleMs = LOD_SETTLE_MS) {}

  update(matrix: ArrayLike<number>, now: number): boolean {
    const m = Array.from(matrix)
    if (this.last && m.some((v, i) => v !== this.last![i])) this.movedAt = now
    this.last = m
    return now - this.movedAt < this.settleMs
  }
}
