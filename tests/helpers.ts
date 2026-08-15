// SPDX-License-Identifier: AGPL-3.0-only
import { mulberry32 } from '../src/core/fit/ransac'

export function gaussian(rand: () => number): number {
  // Box-Muller
  let u = 0
  while (u === 0) u = rand()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand())
}

/** Random points on a sphere surface with radial Gaussian noise. When
 *  capAngle (radians, half-angle around +Z) is given, only that cap is
 *  sampled — mimicking a partially visible sphere. */
export function sampleSphere(
  n: number,
  center: [number, number, number],
  radius: number,
  noise: number,
  seed = 42,
  capAngle?: number,
): Float32Array {
  const rand = mulberry32(seed)
  const out = new Float32Array(n * 3)
  const cosCap = capAngle === undefined ? -1 : Math.cos(capAngle)
  for (let i = 0; i < n; i++) {
    const z = cosCap + rand() * (1 - cosCap)
    const phi = rand() * 2 * Math.PI
    const s = Math.sqrt(Math.max(0, 1 - z * z))
    const r = radius + gaussian(rand) * noise
    out[i * 3] = center[0] + r * s * Math.cos(phi)
    out[i * 3 + 1] = center[1] + r * s * Math.sin(phi)
    out[i * 3 + 2] = center[2] + r * z
  }
  return out
}

/** Random points on a cylinder wall about the given axis point/direction, with
 *  radial Gaussian noise. `arc` (radians) limits how far around the axis the
 *  points wrap — a partially visible cylinder. */
export function sampleCylinder(
  n: number,
  point: [number, number, number],
  axis: [number, number, number],
  radius: number,
  length: number,
  noise: number,
  seed = 42,
  arc = 2 * Math.PI,
): Float32Array {
  const rand = mulberry32(seed)
  const d = normalize([axis[0], axis[1], axis[2]])
  const helper = Math.abs(d[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]
  const u = normalize(cross(d, helper))
  const v = normalize(cross(d, u))
  const out = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    const ang = (rand() - 0.5) * arc
    const t = (rand() - 0.5) * length
    const r = radius + gaussian(rand) * noise
    const cu = Math.cos(ang) * r
    const cv = Math.sin(ang) * r
    out[i * 3] = point[0] + cu * u[0] + cv * v[0] + t * d[0]
    out[i * 3 + 1] = point[1] + cu * u[1] + cv * v[1] + t * d[1]
    out[i * 3 + 2] = point[2] + cu * u[2] + cv * v[2] + t * d[2]
  }
  return out
}

/** Random points on a plane patch with Gaussian noise along the normal. */
export function samplePlane(
  n: number,
  point: [number, number, number],
  normal: [number, number, number],
  size: number,
  noise: number,
  seed = 42,
): Float32Array {
  const rand = mulberry32(seed)
  const nrm = normalize([normal[0], normal[1], normal[2]])
  const helper = Math.abs(nrm[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]
  const u = normalize(cross(nrm, helper))
  const v = normalize(cross(nrm, u))
  const out = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    const a = (rand() - 0.5) * size
    const b = (rand() - 0.5) * size
    const h = gaussian(rand) * noise
    out[i * 3] = point[0] + a * u[0] + b * v[0] + h * nrm[0]
    out[i * 3 + 1] = point[1] + a * u[1] + b * v[1] + h * nrm[1]
    out[i * 3 + 2] = point[2] + a * u[2] + b * v[2] + h * nrm[2]
  }
  return out
}

type P3 = [number, number, number]

/** Emit a quad as two triangles into a soup. Corner coordinates are shared
 *  between neighbouring quads bit-for-bit, so welding rebuilds the topology. */
function quad(tris: number[], a: P3, b: P3, c: P3, d: P3): void {
  tris.push(...a, ...b, ...c, ...a, ...c, ...d)
}

/** Triangle soup of a closed cylinder about +Z — wall plus flat end caps, so
 *  a fit of the wall has neighbouring surfaces it must not leak onto. Wall
 *  vertices carry radial noise, except on the rims, which stay exact so they
 *  weld to the caps. Returns the soup and the share of it that is wall. */
export function cylinderMesh(
  radius: number,
  length: number,
  radial = 64,
  axial = 24,
  noise = 0,
  seed = 11,
): { positions: Float32Array; wallFraction: number } {
  const rand = mulberry32(seed)
  const z0 = -length / 2

  // Precompute the vertex grid: every triangle then references these exact
  // values rather than re-rolling the noise per triangle.
  const grid: P3[][] = []
  for (let j = 0; j <= axial; j++) {
    const row: P3[] = []
    const z = z0 + (length * j) / axial
    for (let k = 0; k < radial; k++) {
      const a = (k / radial) * 2 * Math.PI
      const rim = j === 0 || j === axial
      const r = radius + (noise > 0 && !rim ? gaussian(rand) * noise : 0)
      row.push([Math.cos(a) * r, Math.sin(a) * r, z])
    }
    grid.push(row)
  }

  const tris: number[] = []
  for (let j = 0; j < axial; j++) {
    for (let k = 0; k < radial; k++) {
      const k2 = (k + 1) % radial
      quad(tris, grid[j][k], grid[j][k2], grid[j + 1][k2], grid[j + 1][k])
    }
  }
  const wallTriangles = tris.length / 9

  for (const j of [0, axial]) {
    const z = grid[j][0][2]
    const hub: P3 = [0, 0, z]
    for (let k = 0; k < radial; k++) {
      const k2 = (k + 1) % radial
      if (j === 0) tris.push(...hub, ...grid[j][k2], ...grid[j][k])
      else tris.push(...hub, ...grid[j][k], ...grid[j][k2])
    }
  }

  return {
    positions: Float32Array.from(tris),
    wallFraction: wallTriangles / (tris.length / 9),
  }
}

/** Triangle soup of an axis-aligned box, each face a grid so region growing
 *  has somewhere to grow. Noise is applied along each face's own normal, but
 *  not on the face borders — those stay exact so the six faces weld into one
 *  closed mesh and a plane fit has edges it must stop at. */
export function boxMesh(size: number, grid = 20, noise = 0, seed = 13): Float32Array {
  const rand = mulberry32(seed)
  const h = size / 2
  const tris: number[] = []
  // Each face as (origin, edge u, edge v), wound outward — the face normal is
  // cross(u, v), so the order of the two edges is what points a face out of
  // the solid rather than into it.
  const faces: [P3, P3, P3][] = [
    [[-h, -h, h], [1, 0, 0], [0, 1, 0]],
    [[-h, -h, -h], [0, 1, 0], [1, 0, 0]],
    [[h, -h, -h], [0, 1, 0], [0, 0, 1]],
    [[-h, -h, -h], [0, 0, 1], [0, 1, 0]],
    [[-h, h, -h], [0, 0, 1], [1, 0, 0]],
    [[-h, -h, -h], [1, 0, 0], [0, 0, 1]],
  ]
  for (const [o, eu, ev] of faces) {
    const nrm = normalize(cross(eu, ev))
    const verts: P3[][] = []
    for (let i = 0; i <= grid; i++) {
      const row: P3[] = []
      for (let j = 0; j <= grid; j++) {
        const a = (i / grid) * size
        const b = (j / grid) * size
        const border = i === 0 || j === 0 || i === grid || j === grid
        const d = noise > 0 && !border ? gaussian(rand) * noise : 0
        row.push([
          o[0] + a * eu[0] + b * ev[0] + d * nrm[0],
          o[1] + a * eu[1] + b * ev[1] + d * nrm[1],
          o[2] + a * eu[2] + b * ev[2] + d * nrm[2],
        ])
      }
      verts.push(row)
    }
    for (let i = 0; i < grid; i++) {
      for (let j = 0; j < grid; j++) {
        quad(tris, verts[i][j], verts[i + 1][j], verts[i + 1][j + 1], verts[i][j + 1])
      }
    }
  }
  return Float32Array.from(tris)
}

export function allIndices(n: number): Uint32Array {
  const idx = new Uint32Array(n)
  for (let i = 0; i < n; i++) idx[i] = i
  return idx
}

/** Subdivided icosahedron on a sphere of the given radius, with optional
 *  radial noise — a small synthetic scan of a ball. */
export function icosphere(
  subdivisions: number,
  radius: number,
  noise = 0,
  seed = 7,
): { positions: Float32Array; indices: Uint32Array } {
  const t = (1 + Math.sqrt(5)) / 2
  let verts: number[][] = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ].map((v) => normalize(v))
  let faces: number[][] = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ]

  for (let s = 0; s < subdivisions; s++) {
    const midCache = new Map<string, number>()
    const midpoint = (a: number, b: number): number => {
      const key = a < b ? `${a}_${b}` : `${b}_${a}`
      const hit = midCache.get(key)
      if (hit !== undefined) return hit
      const m = normalize([
        (verts[a][0] + verts[b][0]) / 2,
        (verts[a][1] + verts[b][1]) / 2,
        (verts[a][2] + verts[b][2]) / 2,
      ])
      verts.push(m)
      midCache.set(key, verts.length - 1)
      return verts.length - 1
    }
    const next: number[][] = []
    for (const [a, b, c] of faces) {
      const ab = midpoint(a, b)
      const bc = midpoint(b, c)
      const ca = midpoint(c, a)
      next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca])
    }
    faces = next
  }

  const rand = mulberry32(seed)
  const positions = new Float32Array(verts.length * 3)
  for (let i = 0; i < verts.length; i++) {
    const r = radius + (noise > 0 ? gaussian(rand) * noise : 0)
    positions[i * 3] = verts[i][0] * r
    positions[i * 3 + 1] = verts[i][1] * r
    positions[i * 3 + 2] = verts[i][2] * r
  }
  const indices = new Uint32Array(faces.length * 3)
  for (let i = 0; i < faces.length; i++) {
    indices[i * 3] = faces[i][0]
    indices[i * 3 + 1] = faces[i][1]
    indices[i * 3 + 2] = faces[i][2]
  }
  return { positions, indices }
}

function normalize(v: number[]): [number, number, number] {
  const l = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])
  return [v[0] / l, v[1] / l, v[2] / l]
}

function cross(a: number[], b: number[]): [number, number, number] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ]
}
