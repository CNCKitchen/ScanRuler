// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Which triangles of a mesh are the surface in front: the ones that can be
 * seen, rather than ones that only face the right way.
 *
 * The window and the lasso take what they enclose on the screen, and facing the
 * camera is not enough to be seen. Both walls of a fold, a rib and the face
 * behind it, the far side of a bore: each faces the camera and the near one
 * hides the far one. So the triangles are drawn into a depth buffer the size of
 * the gesture, on the CPU (it runs once, when the button comes up), and a
 * triangle counts as in front when it is nearest on some pixel or its centre
 * lies on the nearest surface there.
 *
 * Both tests are needed. A triangle bigger than a pixel is in front when it
 * wins a pixel, which is exact. A scan seen whole has many triangles to a
 * pixel, and only one of them can win it, so a triangle that wins nothing is
 * judged by depth: its centre against the surface the buffer holds at that
 * pixel, give or take a pixel's worth of the slope it lies on.
 */

/** A mesh projected onto the screen: pixels across and down, and depth away
 *  from the camera in world units (mm). */
export interface ProjectedMesh {
  index: ArrayLike<number>
  sx: Float32Array
  sy: Float32Array
  sz: Float32Array
  /** Triangles that are not drawn (cut away by a section, or past the
   *  camera's near or far plane), so they hide nothing. Null for none. */
  dropped: ((triangle: number) => boolean) | null
}

/** A rectangle on the screen, in pixels. */
export interface ScreenBox {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** How far behind the surface in front a triangle may lie and still be on it,
 *  in pixels' worth of world. Scan noise is about a pixel when a scan is seen
 *  whole, and a triangle can lie a pixel from the centre it is compared at. */
const ON_SURFACE_PX = 2
/** The steepest a triangle is taken to slope away from the screen, in pixels
 *  of depth per pixel across (a face turned about 83° from the camera). Past
 *  that, a triangle on edge would excuse anything behind it. */
const STEEPEST = 8
/** Pixel centres on a shared edge belong to both triangles. */
const EDGE = 1e-7

/**
 * Draw the triangles into a depth buffer over `box` and return a test of
 * whether a triangle is in front. Only triangles inside `box` can be judged: a
 * triangle off it reads as in front, since nothing was drawn there to hide it.
 *
 * `worldPerPixel` is the camera's scale (a parallel camera, the same anywhere
 * on the screen), and sets how close to the surface in front counts as on it.
 */
export function frontSurface(
  mesh: ProjectedMesh,
  box: ScreenBox,
  worldPerPixel: number,
): (triangle: number) => boolean {
  const { index, sx, sy, sz, dropped } = mesh
  // One pixel of margin all round, so a triangle whose centre lies on the
  // box's edge still has its pixel in the buffer.
  const x0 = Math.floor(box.minX) - 1
  const y0 = Math.floor(box.minY) - 1
  const w = Math.max(1, Math.ceil(box.maxX) + 2 - x0)
  const h = Math.max(1, Math.ceil(box.maxY) + 2 - y0)
  const depth = new Float32Array(w * h).fill(Infinity)
  const owner = new Int32Array(w * h).fill(-1)
  const triangles = Math.floor(index.length / 3)

  for (let t = 0; t < triangles; t++) {
    if (dropped?.(t)) continue
    const a = index[t * 3], b = index[t * 3 + 1], c = index[t * 3 + 2]
    const ax = sx[a] - x0, ay = sy[a] - y0
    const bx = sx[b] - x0, by = sy[b] - y0
    const cx = sx[c] - x0, cy = sy[c] - y0
    const minX = Math.min(ax, bx, cx), maxX = Math.max(ax, bx, cx)
    const minY = Math.min(ay, by, cy), maxY = Math.max(ay, by, cy)
    if (maxX < 0 || maxY < 0 || minX > w || minY > h) continue
    const za = sz[a], zb = sz[b], zc = sz[c]

    // Pixel centres sit at i + 0.5.
    const i0 = Math.max(0, Math.ceil(minX - 0.5))
    const i1 = Math.min(w - 1, Math.floor(maxX - 0.5))
    const j0 = Math.max(0, Math.ceil(minY - 0.5))
    const j1 = Math.min(h - 1, Math.floor(maxY - 0.5))
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
    let covered = false
    if (area !== 0 && i0 <= i1 && j0 <= j1) {
      const inv = 1 / area
      for (let j = j0; j <= j1; j++) {
        const py = j + 0.5
        for (let i = i0; i <= i1; i++) {
          const px = i + 0.5
          const wa = ((cx - bx) * (py - by) - (cy - by) * (px - bx)) * inv
          if (wa < -EDGE) continue
          const wb = ((ax - cx) * (py - cy) - (ay - cy) * (px - cx)) * inv
          if (wb < -EDGE) continue
          const wc = 1 - wa - wb
          if (wc < -EDGE) continue
          covered = true
          const z = wa * za + wb * zb + wc * zc
          const k = j * w + i
          if (z < depth[k]) {
            depth[k] = z
            owner[k] = t
          }
        }
      }
    }
    // A triangle that covers no pixel centre still hides what is behind it:
    // on a scan seen whole that is most of them, and a gap where a run of
    // them lies would let the far wall show through.
    if (!covered) {
      const i = Math.floor((ax + bx + cx) / 3)
      const j = Math.floor((ay + by + cy) / 3)
      if (i >= 0 && j >= 0 && i < w && j < h) {
        const z = (za + zb + zc) / 3
        const k = j * w + i
        if (z < depth[k]) {
          depth[k] = z
          owner[k] = t
        }
      }
    }
  }

  const won = new Uint8Array(triangles)
  for (let k = 0; k < owner.length; k++) if (owner[k] >= 0) won[owner[k]] = 1

  const onSurface = ON_SURFACE_PX * worldPerPixel
  const steepest = STEEPEST * worldPerPixel
  return (t) => {
    if (won[t]) return true
    const a = index[t * 3], b = index[t * 3 + 1], c = index[t * 3 + 2]
    const ax = sx[a], ay = sy[a], bx = sx[b], by = sy[b], cx = sx[c], cy = sy[c]
    const i = Math.floor((ax + bx + cx) / 3) - x0
    const j = Math.floor((ay + by + cy) / 3) - y0
    if (i < 0 || j < 0 || i >= w || j >= h) return true
    const nearest = depth[j * w + i]
    if (nearest === Infinity) return true
    const za = sz[a], zb = sz[b], zc = sz[c]
    // How fast the triangle's own plane falls away across the screen: the
    // surface the buffer holds at the pixel centre can be that much further
    // on, or nearer, than the triangle's centre a pixel away.
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
    let slope = steepest
    if (area !== 0) {
      const dzdx = ((zb - za) * (cy - ay) - (by - ay) * (zc - za)) / area
      const dzdy = ((bx - ax) * (zc - za) - (zb - za) * (cx - ax)) / area
      slope = Math.min(Math.abs(dzdx) + Math.abs(dzdy), steepest)
    }
    return (za + zb + zc) / 3 <= nearest + onSurface + slope
  }
}
