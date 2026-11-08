// SPDX-License-Identifier: AGPL-3.0-only
// Wrap's sharp edges (Edges: Sharp). The grid rounds every edge of the part
// by a cell: where the wrap goes round an edge, its vertices snap onto one
// face or the other, and the triangles between them cut the edge off like a
// chamfer. Here each such triangle edge — from a vertex on one face to one
// on another at an angle — is split where the two faces' planes meet, the
// point on that line nearest its middle; and a triangle with a vertex on
// each of three faces gets the point where the three planes meet, its
// corner. The pieces each lie on one face, and the edge is sharp.
//
// Only what is really there is put back: each point has to lie on the part
// itself, within a share of a cell. Where two faces of a tessellated round
// meet at an angle their planes cross off the part, and a round stays round;
// so does a scan's curved surface. A point where a vertex of the wrap
// already is — one snapped onto the part's own corner — is left out: two
// vertices in one place are one to the reduction, which would join the wrap
// to itself there. Splitting an edge splits the triangles either side of it
// alike, so the wrap stays closed and manifold.
//
// Concave edges are not the part's own edges on the wrap — the ball rounds
// them — and a grown wrap's edges are rounds of the growth: Sharp leaves both.

import { Grow } from './marching'

/** Two faces meet at an edge where their normals are further apart than
 *  this — 25°. */
const FEATURE_COS = Math.cos((25 * Math.PI) / 180)

/** A point put back has to lie this near the part, cells. */
const ON_PART = 0.05

/** And no further than this from where the wrap was, cells. */
const NEAR_EDGE = 1
const NEAR_CORNER = 1.5

/** Nor this near a vertex of the wrap, cells — at the ends of the edge it
 *  splits, that one is on the part's edge already. */
const APART = 0.02

export interface Sharpened {
  positions: Float32Array
  indices: Uint32Array
  bridge: Uint8Array
  /** Points put on the part's edges, and at its corners. */
  edges: number
  corners: number
}

/**
 * The wrap with the part's edges and corners put back. `plane` holds, for
 * each vertex snapped onto the part, the unit normal of the face it lies on
 * (zero for the rest); `h` is the grid's cell; `probe` gives the distance
 * from each of a list of points to the part.
 */
export async function sharpen(
  positions: Float32Array,
  indices: Uint32Array,
  bridge: Uint8Array,
  plane: Float32Array,
  h: number,
  probe: (points: Float32Array) => Promise<Float32Array>,
): Promise<Sharpened> {
  const nv = positions.length / 3
  const nt = indices.length / 3
  const has = (v: number) => plane[v * 3] !== 0 || plane[v * 3 + 1] !== 0 || plane[v * 3 + 2] !== 0
  const dotN = (a: number, b: number) => plane[a * 3] * plane[b * 3] + plane[a * 3 + 1] * plane[b * 3 + 1] + plane[a * 3 + 2] * plane[b * 3 + 2]
  const apart = APART * h
  const near = nearVertices(positions, indices, plane, apart)

  // ---- the edges between two faces, and where their planes meet --------------------------
  // Each triangle's three edges (p0 → p1, p1 → p2, p2 → p0): the edge point
  // proposed on it, or −1.
  const onEdge = new Int32Array(nt * 3).fill(-1)
  const byKey = new Map<number, number>()
  const points = new Grow(new Float64Array(1024))
  const x = [0, 0, 0]
  for (let t = 0; t < nt; t++) {
    for (let k = 0; k < 3; k++) {
      const a = indices[t * 3 + k], b = indices[t * 3 + ((k + 1) % 3)]
      if (!has(a) || !has(b) || dotN(a, b) > FEATURE_COS) continue
      const key = a < b ? a * nv + b : b * nv + a
      const known = byKey.get(key)
      if (known !== undefined) {
        onEdge[t * 3 + k] = known
        continue
      }
      byKey.set(key, -1)
      if (!meetTwo(positions, plane, a, b, x)) continue
      const mx = (positions[a * 3] + positions[b * 3]) / 2, my = (positions[a * 3 + 1] + positions[b * 3 + 1]) / 2, mz = (positions[a * 3 + 2] + positions[b * 3 + 2]) / 2
      if (Math.hypot(x[0] - mx, x[1] - my, x[2] - mz) > NEAR_EDGE * h || near(x[0], x[1], x[2])) continue
      const c = points.length / 3
      points.push(x[0])
      points.push(x[1])
      points.push(x[2])
      byKey.set(key, c)
      onEdge[t * 3 + k] = c
    }
  }
  const pts = points.done()
  const count = pts.length / 3
  const ok = new Uint8Array(count)
  if (count > 0) {
    const onPart = await probe(Float32Array.from(pts))
    for (let c = 0; c < count; c++) ok[c] = onPart[c] <= ON_PART * h ? 1 : 0
  }
  // Two edges proposing one point: the first keeps it.
  {
    const seen = new Set<string>()
    for (let c = 0; c < count; c++) {
      if (!ok[c]) continue
      const place = `${Math.round(pts[c * 3] / apart)},${Math.round(pts[c * 3 + 1] / apart)},${Math.round(pts[c * 3 + 2] / apart)}`
      if (seen.has(place)) ok[c] = 0
      else seen.add(place)
    }
  }
  // Each kept unless splitting it turns a triangle beside it over.
  const n0 = [0, 0, 0], n1 = [0, 0, 0]
  for (let t = 0; t < nt; t++) {
    if (onEdge[t * 3] < 0 && onEdge[t * 3 + 1] < 0 && onEdge[t * 3 + 2] < 0) continue
    for (let k = 0; k < 3; k++) {
      const c = onEdge[t * 3 + k]
      if (c < 0 || !ok[c]) continue
      const a = indices[t * 3 + k], b = indices[t * 3 + ((k + 1) % 3)], o = indices[t * 3 + ((k + 2) % 3)]
      normalOf(positions, a, b, o, n0)
      const xa = [pts[c * 3], pts[c * 3 + 1], pts[c * 3 + 2]]
      normalAt(at(positions, a), xa, at(positions, o), n1)
      if (n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2] <= 0) ok[c] = 0
      normalAt(xa, at(positions, b), at(positions, o), n1)
      if (n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2] <= 0) ok[c] = 0
    }
  }
  // The points kept become vertices after the wrap's own.
  const vertexOf = new Int32Array(count).fill(-1)
  let edges = 0
  for (let c = 0; c < count; c++) if (ok[c]) vertexOf[c] = nv + edges++
  const split = (t: number, k: number) => {
    const c = onEdge[t * 3 + k]
    return c < 0 ? -1 : vertexOf[c]
  }

  // ---- corners: a triangle split on all three edges ----------------------------------------
  const cornerTri: number[] = []
  const cornerPts: number[] = []
  const k3 = [0, 0, 0]
  for (let t = 0; t < nt; t++) {
    if (split(t, 0) < 0 || split(t, 1) < 0 || split(t, 2) < 0) continue
    const p0 = indices[t * 3], p1 = indices[t * 3 + 1], p2 = indices[t * 3 + 2]
    if (!meetThree(positions, plane, p0, p1, p2, k3)) continue
    const cx = (positions[p0 * 3] + positions[p1 * 3] + positions[p2 * 3]) / 3
    const cy = (positions[p0 * 3 + 1] + positions[p1 * 3 + 1] + positions[p2 * 3 + 1]) / 3
    const cz = (positions[p0 * 3 + 2] + positions[p1 * 3 + 2] + positions[p2 * 3 + 2]) / 3
    if (Math.hypot(k3[0] - cx, k3[1] - cy, k3[2] - cz) > NEAR_CORNER * h || near(k3[0], k3[1], k3[2])) continue
    cornerTri.push(t)
    cornerPts.push(k3[0], k3[1], k3[2])
  }
  const cornerAt = new Map<number, number>()
  let corners = 0
  if (cornerTri.length > 0) {
    const cornerOn = await probe(Float32Array.from(cornerPts))
    // One triangle to a corner: two fanned round the same point would lay
    // their shared edge's pieces over each other.
    const seen = new Set<string>()
    for (let i = 0; i < cornerTri.length; i++) {
      if (cornerOn[i] > ON_PART * h) continue
      const place = `${Math.round(cornerPts[i * 3] / apart)},${Math.round(cornerPts[i * 3 + 1] / apart)},${Math.round(cornerPts[i * 3 + 2] / apart)}`
      if (seen.has(place)) continue
      seen.add(place)
      cornerAt.set(cornerTri[i], i)
      corners++
    }
  }

  // ---- the wrap with them --------------------------------------------------------------------
  const out = new Float32Array((nv + edges + corners) * 3)
  out.set(positions)
  for (let c = 0; c < count; c++) {
    if (vertexOf[c] < 0) continue
    out[vertexOf[c] * 3] = pts[c * 3]
    out[vertexOf[c] * 3 + 1] = pts[c * 3 + 1]
    out[vertexOf[c] * 3 + 2] = pts[c * 3 + 2]
  }
  let next = nv + edges
  const cornerVertex = new Map<number, number>()
  for (const [t, i] of cornerAt) {
    out.set(cornerPts.slice(i * 3, i * 3 + 3), next * 3)
    cornerVertex.set(t, next++)
  }
  const d2 = (a: number, b: number) => (out[a * 3] - out[b * 3]) ** 2 + (out[a * 3 + 1] - out[b * 3 + 1]) ** 2 + (out[a * 3 + 2] - out[b * 3 + 2]) ** 2
  // Split alike either side of every edge split.
  const tris = new Grow(new Uint32Array(Math.max(16, indices.length + 12 * (edges + corners))))
  const put = (a: number, b: number, c: number) => {
    tris.push(a)
    tris.push(b)
    tris.push(c)
  }
  for (let t = 0; t < nt; t++) {
    if (onEdge[t * 3] < 0 && onEdge[t * 3 + 1] < 0 && onEdge[t * 3 + 2] < 0) {
      put(indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2])
      continue
    }
    const p = [indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2]]
    const s = [split(t, 0), split(t, 1), split(t, 2)]
    const n = (s[0] >= 0 ? 1 : 0) + (s[1] >= 0 ? 1 : 0) + (s[2] >= 0 ? 1 : 0)
    if (n === 0) put(p[0], p[1], p[2])
    else if (n === 1) {
      // Turned so the edge split runs a → b.
      const r = s.findIndex((v) => v >= 0)
      const a = p[r], b = p[(r + 1) % 3], c = p[(r + 2) % 3], m = s[r]
      put(a, m, c)
      put(m, b, c)
    } else if (n === 2) {
      // Turned so the edge not split runs b → c: a is where the two meet.
      const r = (s.findIndex((v) => v < 0) + 2) % 3
      const a = p[r], b = p[(r + 1) % 3], c = p[(r + 2) % 3]
      const sab = s[r], sca = s[(r + 2) % 3]
      put(a, sab, sca)
      // The rest, a quad, cut along its shorter diagonal.
      if (d2(sab, c) <= d2(b, sca)) {
        put(sab, b, c)
        put(sab, c, sca)
      } else {
        put(sab, b, sca)
        put(b, c, sca)
      }
    } else {
      const k = cornerVertex.get(t)
      if (k !== undefined) {
        const ring = [p[0], s[0], p[1], s[1], p[2], s[2]]
        for (let i = 0; i < 6; i++) put(ring[i], ring[(i + 1) % 6], k)
      } else {
        put(p[0], s[0], s[2])
        put(s[0], p[1], s[1])
        put(s[2], s[1], p[2])
        put(s[0], s[1], s[2])
      }
    }
  }
  const outBridge = new Uint8Array(out.length / 3)
  outBridge.set(bridge)
  return { positions: out, indices: tris.done(), bridge: outBridge, edges, corners }
}

const at = (p: Float32Array, v: number) => [p[v * 3], p[v * 3 + 1], p[v * 3 + 2]]

function normalOf(p: Float32Array, a: number, b: number, c: number, out: number[]): void {
  normalAt(at(p, a), at(p, b), at(p, c), out)
}

function normalAt(A: number[], B: number[], C: number[], out: number[]): void {
  const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2]
  const vx = C[0] - A[0], vy = C[1] - A[1], vz = C[2] - A[2]
  out[0] = uy * vz - uz * vy
  out[1] = uz * vx - ux * vz
  out[2] = ux * vy - uy * vx
}

/**
 * Whether a vertex of the wrap lies within `apart` of a point — among the
 * vertices snapped onto the part (with a `plane`), which are the only ones
 * an edge or a corner of the part can be at: a grid of cells `apart` wide,
 * each vertex filed under its cell, looked through the 27 round the point.
 */
function nearVertices(positions: Float32Array, indices: Uint32Array, plane: Float32Array, apart: number): (x: number, y: number, z: number) => boolean {
  const nv = positions.length / 3
  const used = new Uint8Array(nv)
  for (let i = 0; i < indices.length; i++) used[indices[i]] = 1
  const vs: number[] = []
  for (let v = 0; v < nv; v++) if (used[v] && (plane[v * 3] !== 0 || plane[v * 3 + 1] !== 0 || plane[v * 3 + 2] !== 0)) vs.push(v)
  let size = 1
  while (size < 2 * vs.length) size *= 2
  const mask = size - 1
  const cell = (x: number) => Math.floor(x / apart)
  const slot = (i: number, j: number, k: number) => (Math.imul(i, 73856093) ^ Math.imul(j, 19349663) ^ Math.imul(k, 83492791)) & mask
  const start = new Uint32Array(size + 1)
  const slotOf = new Uint32Array(vs.length)
  for (let e = 0; e < vs.length; e++) {
    const v = vs[e]
    slotOf[e] = slot(cell(positions[v * 3]), cell(positions[v * 3 + 1]), cell(positions[v * 3 + 2]))
    start[slotOf[e] + 1]++
  }
  for (let s = 0; s < size; s++) start[s + 1] += start[s]
  const members = new Uint32Array(vs.length)
  const fill = start.slice(0, size)
  for (let e = 0; e < vs.length; e++) members[fill[slotOf[e]]++] = vs[e]
  const apart2 = apart * apart
  return (x, y, z) => {
    const i = cell(x), j = cell(y), k = cell(z)
    for (let dk = -1; dk <= 1; dk++) {
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const s = slot(i + di, j + dj, k + dk)
          for (let e = start[s]; e < start[s + 1]; e++) {
            const v = members[e]
            if ((positions[v * 3] - x) ** 2 + (positions[v * 3 + 1] - y) ** 2 + (positions[v * 3 + 2] - z) ** 2 < apart2) return true
          }
        }
      }
    }
    return false
  }
}

/** Where the planes of vertices a and b meet, the point nearest the middle
 *  of a and b, into `out` — false when they are as good as parallel. */
function meetTwo(p: Float32Array, n: Float32Array, a: number, b: number, out: number[]): boolean {
  const ax = n[a * 3], ay = n[a * 3 + 1], az = n[a * 3 + 2]
  const bx = n[b * 3], by = n[b * 3 + 1], bz = n[b * 3 + 2]
  const c = ax * bx + ay * by + az * bz
  const det = 1 - c * c
  if (det < 1e-6) return false
  const mx = (p[a * 3] + p[b * 3]) / 2, my = (p[a * 3 + 1] + p[b * 3 + 1]) / 2, mz = (p[a * 3 + 2] + p[b * 3 + 2]) / 2
  // x = m + α nA + β nB, on both planes.
  const ra = ax * (p[a * 3] - mx) + ay * (p[a * 3 + 1] - my) + az * (p[a * 3 + 2] - mz)
  const rb = bx * (p[b * 3] - mx) + by * (p[b * 3 + 1] - my) + bz * (p[b * 3 + 2] - mz)
  const alpha = (ra - c * rb) / det
  const beta = (rb - c * ra) / det
  out[0] = mx + alpha * ax + beta * bx
  out[1] = my + alpha * ay + beta * by
  out[2] = mz + alpha * az + beta * bz
  return true
}

/** Where the planes of vertices a, b and c meet, into `out` — false when two
 *  of them are as good as parallel. */
function meetThree(p: Float32Array, n: Float32Array, a: number, b: number, c: number, out: number[]): boolean {
  const N = [a, b, c].map((v) => [n[v * 3], n[v * 3 + 1], n[v * 3 + 2]])
  const d = [a, b, c].map((v, i) => N[i][0] * p[v * 3] + N[i][1] * p[v * 3 + 1] + N[i][2] * p[v * 3 + 2])
  const cross = (u: number[], v: number[]) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
  const c12 = cross(N[1], N[2]), c20 = cross(N[2], N[0]), c01 = cross(N[0], N[1])
  const det = N[0][0] * c12[0] + N[0][1] * c12[1] + N[0][2] * c12[2]
  if (Math.abs(det) < 0.05) return false
  for (let k = 0; k < 3; k++) out[k] = (d[0] * c12[k] + d[1] * c20[k] + d[2] * c01[k]) / det
  return true
}
