// SPDX-License-Identifier: AGPL-3.0-only
import * as THREE from 'three'
import { MeshBVH, SAH } from 'three-mesh-bvh'

/** Where on a triangle the closest point landed. Which normal is the correct
 *  one to sign a distance with depends on this: a point that projects into the
 *  interior of a face is signed by that face, but one that lands on a shared
 *  edge or a corner has to be signed by a normal representing *every* face
 *  meeting there, or the sign flips arbitrarily along the seam. */
const enum Feature {
  VertexA = 0,
  VertexB = 1,
  VertexC = 2,
  EdgeAB = 3,
  EdgeAC = 4,
  EdgeBC = 5,
  Face = 6,
}

export interface ClosestHit {
  /** Unsigned distance to the surface. */
  distance: number
  /** Negative when the query point lies inside the solid. */
  signed: number
  /** The closest point itself. */
  px: number
  py: number
  pz: number
  /** Outward pseudonormal at the closest point — the plane for point-to-plane
   *  ICP, and the direction that defines the sign. */
  nx: number
  ny: number
  nz: number
  faceIndex: number
}

export function emptyHit(): ClosestHit {
  return { distance: 0, signed: 0, px: 0, py: 0, pz: 0, nx: 0, ny: 0, nz: 1, faceIndex: -1 }
}

/** Closest point on a triangle, in barycentric form, plus which feature of the
 *  triangle it belongs to (Ericson, *Real-Time Collision Detection*, §5.1.5 —
 *  the branch that fires *is* the classification, so no epsilon-comparison of
 *  barycentric coordinates is needed and the seam is exact). */
function closestOnTriangle(
  px: number, py: number, pz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  out: Float64Array, // [x, y, z, feature]
): void {
  const abx = bx - ax, aby = by - ay, abz = bz - az
  const acx = cx - ax, acy = cy - ay, acz = cz - az
  const apx = px - ax, apy = py - ay, apz = pz - az

  const d1 = abx * apx + aby * apy + abz * apz
  const d2 = acx * apx + acy * apy + acz * apz
  if (d1 <= 0 && d2 <= 0) {
    out[0] = ax; out[1] = ay; out[2] = az; out[3] = Feature.VertexA
    return
  }

  const bpx = px - bx, bpy = py - by, bpz = pz - bz
  const d3 = abx * bpx + aby * bpy + abz * bpz
  const d4 = acx * bpx + acy * bpy + acz * bpz
  if (d3 >= 0 && d4 <= d3) {
    out[0] = bx; out[1] = by; out[2] = bz; out[3] = Feature.VertexB
    return
  }

  const vc = d1 * d4 - d3 * d2
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3)
    out[0] = ax + abx * v; out[1] = ay + aby * v; out[2] = az + abz * v
    out[3] = Feature.EdgeAB
    return
  }

  const cpx = px - cx, cpy = py - cy, cpz = pz - cz
  const d5 = abx * cpx + aby * cpy + abz * cpz
  const d6 = acx * cpx + acy * cpy + acz * cpz
  if (d6 >= 0 && d5 <= d6) {
    out[0] = cx; out[1] = cy; out[2] = cz; out[3] = Feature.VertexC
    return
  }

  const vb = d5 * d2 - d1 * d6
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6)
    out[0] = ax + acx * w; out[1] = ay + acy * w; out[2] = az + acz * w
    out[3] = Feature.EdgeAC
    return
  }

  const va = d3 * d6 - d5 * d4
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6))
    out[0] = bx + (cx - bx) * w; out[1] = by + (cy - by) * w; out[2] = bz + (cz - bz) * w
    out[3] = Feature.EdgeBC
    return
  }

  const denom = 1 / (va + vb + vc)
  const v = vb * denom
  const w = vc * denom
  out[0] = ax + abx * v + acx * w
  out[1] = ay + aby * v + acy * w
  out[2] = az + abz * v + acz * w
  out[3] = Feature.Face
}

/**
 * The nominal geometry, prepared for signed closest-point queries.
 *
 * The distance itself is easy; the *sign* is the part that has to be right.
 * Taking it from the normal of the nearest face is wrong wherever the nearest
 * point lies on an edge or a corner — and against a CAD part full of sharp
 * pockets and bores, a scanned surface projects onto those seams constantly,
 * which would speckle every edge of the map with false inside/outside flips.
 *
 * So each edge and vertex carries a pseudonormal instead: the angle-weighted
 * sum of the normals of the faces meeting there. Bærentzen & Aanæs showed
 * that signing by the pseudonormal of whichever feature the closest point
 * actually belongs to gives the exact sign for any closed mesh, which is why
 * the nominal has to be watertight (and why the scan, which is not, is never
 * the thing being queried).
 */
export class NominalSurface {
  readonly positions: Float32Array
  readonly index: Uint32Array
  readonly triangleCount: number
  readonly vertexCount: number
  readonly bboxMin: [number, number, number]
  readonly bboxMax: [number, number, number]
  readonly bboxDiagonal: number

  private bvh: MeshBVH
  private faceNormal: Float64Array
  private vertexNormal: Float64Array
  private edgeNormal: Float64Array
  private edgeId: Map<number, number>
  private probe = new THREE.Vector3()
  private target = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 }
  private scratch = new Float64Array(4)

  constructor(positions: Float32Array, indices: Uint32Array) {
    this.positions = positions
    this.vertexCount = positions.length / 3

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geometry.setIndex(new THREE.BufferAttribute(indices.slice(), 1))
    // SAH costs a little more to build than the median split and pays it back
    // many times over: every scan vertex is one descent of this tree.
    this.bvh = new MeshBVH(geometry, { strategy: SAH, maxLeafTris: 8 })
    // MeshBVH reorders the index buffer in place, so the normals below — which
    // are looked up by the face index the BVH reports — must be built from the
    // buffer as it stands *after* the tree.
    this.index = geometry.getIndex()!.array as Uint32Array
    this.triangleCount = this.index.length / 3

    const box = new THREE.Box3().setFromBufferAttribute(
      geometry.getAttribute('position') as THREE.BufferAttribute,
    )
    this.bboxMin = [box.min.x, box.min.y, box.min.z]
    this.bboxMax = [box.max.x, box.max.y, box.max.z]
    this.bboxDiagonal = box.min.distanceTo(box.max)

    this.faceNormal = new Float64Array(this.triangleCount * 3)
    this.vertexNormal = new Float64Array(this.vertexCount * 3)
    this.edgeId = new Map()
    const edgeAccum: number[] = []
    this.buildNormals(edgeAccum)
    this.edgeNormal = Float64Array.from(edgeAccum)
    normalizeTriples(this.vertexNormal)
    normalizeTriples(this.edgeNormal)
  }

  private edgeKey(a: number, b: number): number {
    return a < b ? a * this.vertexCount + b : b * this.vertexCount + a
  }

  private buildNormals(edgeAccum: number[]): void {
    const p = this.positions
    const idx = this.index
    for (let f = 0; f < this.triangleCount; f++) {
      const ia = idx[f * 3], ib = idx[f * 3 + 1], ic = idx[f * 3 + 2]
      const ax = p[ia * 3], ay = p[ia * 3 + 1], az = p[ia * 3 + 2]
      const bx = p[ib * 3], by = p[ib * 3 + 1], bz = p[ib * 3 + 2]
      const cx = p[ic * 3], cy = p[ic * 3 + 1], cz = p[ic * 3 + 2]
      const ux = bx - ax, uy = by - ay, uz = bz - az
      const vx = cx - ax, vy = cy - ay, vz = cz - az
      let nx = uy * vz - uz * vy
      let ny = uz * vx - ux * vz
      let nz = ux * vy - uy * vx
      const len = Math.hypot(nx, ny, nz)
      if (len > 1e-20) {
        nx /= len; ny /= len; nz /= len
      } else {
        nz = 1
      }
      this.faceNormal[f * 3] = nx
      this.faceNormal[f * 3 + 1] = ny
      this.faceNormal[f * 3 + 2] = nz

      // Vertex pseudonormal: weighted by the angle the face subtends there, so
      // the result is independent of how finely the surface is triangulated.
      const corners: [number, number, number, number, number, number, number][] = [
        [ia, bx - ax, by - ay, bz - az, cx - ax, cy - ay, cz - az],
        [ib, ax - bx, ay - by, az - bz, cx - bx, cy - by, cz - bz],
        [ic, ax - cx, ay - cy, az - cz, bx - cx, by - cy, bz - cz],
      ]
      for (const [vi, e1x, e1y, e1z, e2x, e2y, e2z] of corners) {
        const l1 = Math.hypot(e1x, e1y, e1z)
        const l2 = Math.hypot(e2x, e2y, e2z)
        if (!(l1 > 1e-20 && l2 > 1e-20)) continue
        const cos = Math.min(1, Math.max(-1, (e1x * e2x + e1y * e2y + e1z * e2z) / (l1 * l2)))
        const w = Math.acos(cos)
        this.vertexNormal[vi * 3] += nx * w
        this.vertexNormal[vi * 3 + 1] += ny * w
        this.vertexNormal[vi * 3 + 2] += nz * w
      }

      // Edge pseudonormal: the plain sum of the (here, two) adjacent faces.
      for (const [u, v] of [[ia, ib], [ia, ic], [ib, ic]]) {
        const key = this.edgeKey(u, v)
        let id = this.edgeId.get(key)
        if (id === undefined) {
          id = edgeAccum.length / 3
          this.edgeId.set(key, id)
          edgeAccum.push(0, 0, 0)
        }
        edgeAccum[id * 3] += nx
        edgeAccum[id * 3 + 1] += ny
        edgeAccum[id * 3 + 2] += nz
      }
    }
  }

  /** Signed distance from a point to the surface. Returns false only when the
   *  BVH finds nothing within `maxDistance`, which lets a caller cap the search
   *  and skip the tail of the tree. */
  closest(x: number, y: number, z: number, out: ClosestHit, maxDistance = Infinity): boolean {
    this.probe.set(x, y, z)
    const hit = this.bvh.closestPointToPoint(this.probe, this.target, 0, maxDistance)
    if (!hit) return false

    const f = hit.faceIndex
    const p = this.positions
    const idx = this.index
    const ia = idx[f * 3], ib = idx[f * 3 + 1], ic = idx[f * 3 + 2]
    const s = this.scratch
    closestOnTriangle(
      x, y, z,
      p[ia * 3], p[ia * 3 + 1], p[ia * 3 + 2],
      p[ib * 3], p[ib * 3 + 1], p[ib * 3 + 2],
      p[ic * 3], p[ic * 3 + 1], p[ic * 3 + 2],
      s,
    )

    let nx: number, ny: number, nz: number
    switch (s[3] as Feature) {
      case Feature.VertexA:
      case Feature.VertexB:
      case Feature.VertexC: {
        const vi = idx[f * 3 + (s[3] as number)]
        nx = this.vertexNormal[vi * 3]
        ny = this.vertexNormal[vi * 3 + 1]
        nz = this.vertexNormal[vi * 3 + 2]
        break
      }
      case Feature.EdgeAB:
      case Feature.EdgeAC:
      case Feature.EdgeBC: {
        // Plain locals: this runs millions of times per map, so even a
        // two-element array here would dominate the allocator.
        const e0 = s[3] === Feature.EdgeBC ? ib : ia
        const e1 = s[3] === Feature.EdgeAB ? ib : ic
        const id = this.edgeId.get(this.edgeKey(e0, e1))
        if (id === undefined) {
          nx = this.faceNormal[f * 3]
          ny = this.faceNormal[f * 3 + 1]
          nz = this.faceNormal[f * 3 + 2]
        } else {
          nx = this.edgeNormal[id * 3]
          ny = this.edgeNormal[id * 3 + 1]
          nz = this.edgeNormal[id * 3 + 2]
        }
        break
      }
      default:
        nx = this.faceNormal[f * 3]
        ny = this.faceNormal[f * 3 + 1]
        nz = this.faceNormal[f * 3 + 2]
    }

    const dx = x - s[0], dy = y - s[1], dz = z - s[2]
    const distance = Math.hypot(dx, dy, dz)
    const side = dx * nx + dy * ny + dz * nz

    out.distance = distance
    out.signed = side < 0 ? -distance : distance
    out.px = s[0]; out.py = s[1]; out.pz = s[2]
    out.nx = nx; out.ny = ny; out.nz = nz
    out.faceIndex = f
    return true
  }
}

function normalizeTriples(a: Float64Array): void {
  for (let i = 0; i < a.length; i += 3) {
    const len = Math.hypot(a[i], a[i + 1], a[i + 2])
    if (len > 1e-20) {
      a[i] /= len
      a[i + 1] /= len
      a[i + 2] /= len
    } else {
      a[i] = 0
      a[i + 1] = 0
      a[i + 2] = 1
    }
  }
}
