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

function normalize(v: number[]): number[] {
  const l = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])
  return [v[0] / l, v[1] / l, v[2] / l]
}
