// SPDX-License-Identifier: AGPL-3.0-only
// Level of detail for the scan while the camera moves. A scan of a few million
// triangles can orbit at a crawl, so where it does — measured, see
// SlowMotion — a coarse proxy is drawn in its place while the view is in
// motion, and the full mesh comes back once the view settles.
// The proxy is only an index buffer over the scan's own vertices — colours,
// deviation, paint and texture ride along unchanged — and it is never
// raycast: picking and measuring always see full detail.

/** Scans above this many triangles get a proxy, cut to about this many. */
export const LOD_TRIANGLES = 400_000

/** How long the view has to hold still before full detail comes back. */
export const LOD_SETTLE_MS = 180

/** Frames this slow or slower while the view moves, at the median, call for
 *  the proxy: under 20 a second. A scan that turns faster than that is drawn
 *  whole throughout — the swap to the coarse copy and back is itself a
 *  distraction, worth it only where the full mesh really drags. */
export const LOD_SLOW_FRAME_MS = 50

/** How many moving frames the median is taken over. */
const SLOW_SAMPLES = 12

/**
 * Triangles of a coarser mesh by vertex clustering: the bounding box is cut
 * into a grid, every vertex stands in for the first one met in its cell, and
 * triangles that collapse are dropped. The grid is resized until the result
 * is near `target` triangles. Null when the mesh is small enough already.
 *
 * With `normals`, a cell is shared only by vertices facing the same way (the
 * same axis their normal leans along most, and the same side of it). On a
 * sheet as thick as a cell both skins fall into one cell, and a triangle of
 * the near skin could be built on a vertex of the far one: lit by a normal
 * pointing into the part, it drew black while the view turned.
 */
export function clusterIndices(
  positions: Float32Array,
  indices: Uint32Array,
  target = LOD_TRIANGLES,
  normals: Float32Array | null = null,
): Uint32Array | null {
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
  // Which of six directions each vertex faces: 0–2 for +X, +Y, +Z, 3–5 for
  // the negatives. All 0 without normals.
  const facingOf = new Uint8Array(n)
  if (normals) {
    for (let i = 0; i < n; i++) {
      const x = normals[i * 3], y = normals[i * 3 + 1], z = normals[i * 3 + 2]
      const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z)
      const axis = ax >= ay && ax >= az ? 0 : ay >= az ? 1 : 2
      facingOf[i] = axis + ((axis === 0 ? x : axis === 1 ? y : z) < 0 ? 3 : 0)
    }
  }
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
      const key = ((cx * (k + 1) + cy) * (k + 1) + cz) * 6 + facingOf[i]
      let r = cells.get(key)
      if (r === undefined) cells.set(key, (r = i))
      rep[i] = r
    }
    const kept: number[] = []
    for (let t = 0; t < indices.length; t += 3) {
      const a = rep[indices[t]], b = rep[indices[t + 1]], c = rep[indices[t + 2]]
      if (a === b || b === c || a === c) continue
      // Moving each corner to its cell's first vertex can turn a triangle
      // over on a rough scan. Drawn as it came, it shows its back while the
      // view turns, and the double-sided material shades a back face as if
      // lit from behind: black specks all over the part. Kept facing the way
      // the triangle it came from faced.
      if (turnedOver(positions, a, b, c, indices[t], indices[t + 1], indices[t + 2])) kept.push(a, c, b)
      else kept.push(a, b, c)
    }
    out = Uint32Array.from(kept)
    const got = out.length / 3
    if (got > target * 0.7 && got <= target * 1.1) break
    side *= Math.sqrt(target / Math.max(got, 1))
  }
  return out.length / 3 < tris ? out : null
}

/** Whether triangles (a, b, c) and (p, q, r) face away from each other:
 *  their normals, unnormalised, have a negative dot product. */
function turnedOver(pos: Float32Array, a: number, b: number, c: number, p: number, q: number, r: number): boolean {
  const ux = pos[b * 3] - pos[a * 3], uy = pos[b * 3 + 1] - pos[a * 3 + 1], uz = pos[b * 3 + 2] - pos[a * 3 + 2]
  const vx = pos[c * 3] - pos[a * 3], vy = pos[c * 3 + 1] - pos[a * 3 + 1], vz = pos[c * 3 + 2] - pos[a * 3 + 2]
  const sx = pos[q * 3] - pos[p * 3], sy = pos[q * 3 + 1] - pos[p * 3 + 1], sz = pos[q * 3 + 2] - pos[p * 3 + 2]
  const tx = pos[r * 3] - pos[p * 3], ty = pos[r * 3 + 1] - pos[p * 3 + 1], tz = pos[r * 3 + 2] - pos[p * 3 + 2]
  return (uy * vz - uz * vy) * (sy * tz - sz * ty) + (uz * vx - ux * vz) * (sz * tx - sx * tz) + (ux * vy - uy * vx) * (sx * ty - sy * tx) < 0
}

/** Whether the camera is on the move: true from the frame its matrix changes
 *  until it has held still for `settleMs`. */
export class MotionLatch {
  private last: number[] | null = null
  private movedAt = -Infinity
  /** Whether the matrix changed on the last update itself. */
  changed = false

  constructor(private settleMs = LOD_SETTLE_MS) {}

  update(matrix: ArrayLike<number>, now: number): boolean {
    const m = Array.from(matrix)
    this.changed = this.last !== null && m.some((v, i) => v !== this.last![i])
    if (this.changed) this.movedAt = now
    this.last = m
    return now - this.movedAt < this.settleMs
  }
}

/**
 * Whether the full scan turns too slowly to be drawn while the view moves:
 * the median time between frames the camera moved on, over the last few, at
 * LOD_SLOW_FRAME_MS or more. Once found slow it stays so until `reset` — the
 * proxy's own quick frames say nothing about the full mesh's. A pause in a
 * drag (no frame for half a second) is not a slow frame.
 */
export class SlowMotion {
  private last = -1
  private samples: number[] = []
  slow = false

  constructor(private slowMs = LOD_SLOW_FRAME_MS) {}

  /** One frame at `now`; `moved` whether the camera moved on it. */
  note(now: number, moved: boolean): boolean {
    if (this.slow) return true
    if (!moved) {
      this.last = -1
      return false
    }
    if (this.last >= 0 && now - this.last < 500) {
      this.samples.push(now - this.last)
      if (this.samples.length > SLOW_SAMPLES) this.samples.shift()
    }
    this.last = now
    if (this.samples.length === SLOW_SAMPLES) {
      const sorted = [...this.samples].sort((a, b) => a - b)
      if (sorted[SLOW_SAMPLES >> 1] >= this.slowMs) this.slow = true
    }
    return this.slow
  }

  reset(): void {
    this.last = -1
    this.samples = []
    this.slow = false
  }
}
