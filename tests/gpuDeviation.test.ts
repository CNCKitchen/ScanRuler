// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { buildMeshGraph } from '../src/core/geometry/buildGraph'
import { computeDeviation } from '../src/core/deviation/deviation'
import { gpuNearestFaces } from '../src/core/deviation/gpuNearest'
import { rigidApply, rigidFromAxisAngle } from '../src/core/deviation/rigid'
import { NominalSurface } from '../src/core/deviation/surface'
import { boxMesh, icosphere } from './helpers'

/**
 * The compute shader's search, line for line in JS and single precision: the
 * same walk over the same flattened node buffer, so the layout it reads and
 * the faces it settles on are checked where no GPU is to hand.
 */
function shaderNearestFaces(surface: NominalSurface, points: Float32Array): Int32Array {
  const nodes = surface.flatTree()!
  const f = new Float32Array(nodes.buffer, nodes.byteOffset, nodes.length)
  const pos = surface.positions
  const tris = surface.index
  const n = points.length / 3
  const faces = new Int32Array(n)
  const box = (node: number, x: number, y: number, z: number) => {
    const dx = Math.max(f[node] - x, x - f[node + 3], 0)
    const dy = Math.max(f[node + 1] - y, y - f[node + 4], 0)
    const dz = Math.max(f[node + 2] - z, z - f[node + 5], 0)
    return Math.fround(dx * dx + dy * dy + dz * dz)
  }
  const hit = new Float64Array(3)
  for (let i = 0; i < n; i++) {
    const x = points[i * 3], y = points[i * 3 + 1], z = points[i * 3 + 2]
    let best = Infinity
    let bestFace = -1
    const stack = [0]
    while (stack.length) {
      const node = stack.pop()!
      if (box(node, x, y, z) >= best) continue
      const meta = nodes[node + 7]
      if (meta >>> 16 === 0xffff) {
        for (let t = nodes[node + 6], end = t + (meta & 0xffff); t < end; t++) {
          const a = tris[t * 3], b = tris[t * 3 + 1], c = tris[t * 3 + 2]
          triClosest(x, y, z, pos, a, b, c, hit)
          const d = Math.fround((hit[0] - x) ** 2 + (hit[1] - y) ** 2 + (hit[2] - z) ** 2)
          if (d < best) { best = d; bestFace = t }
        }
      } else {
        const l = node + 8, r = nodes[node + 6]
        const dl = box(l, x, y, z), dr = box(r, x, y, z)
        const [far, dFar, near, dNear] = dl < dr ? [r, dr, l, dl] : [l, dl, r, dr]
        if (dFar < best) stack.push(far)
        if (dNear < best) stack.push(near)
      }
    }
    faces[i] = bestFace
  }
  return faces
}

/** Closest point on a triangle, by brute force over a fine barycentric
 *  projection — plain enough to trust as the yardstick here. */
function triClosest(
  x: number, y: number, z: number,
  p: Float32Array, a: number, b: number, c: number,
  out: Float64Array,
): void {
  const ax = p[a * 3], ay = p[a * 3 + 1], az = p[a * 3 + 2]
  const abx = p[b * 3] - ax, aby = p[b * 3 + 1] - ay, abz = p[b * 3 + 2] - az
  const acx = p[c * 3] - ax, acy = p[c * 3 + 1] - ay, acz = p[c * 3 + 2] - az
  const apx = x - ax, apy = y - ay, apz = z - az
  // Solve for the plane's barycentrics, then clamp onto the triangle by
  // projecting onto whichever edge is nearest when outside.
  const d00 = abx * abx + aby * aby + abz * abz
  const d01 = abx * acx + aby * acy + abz * acz
  const d11 = acx * acx + acy * acy + acz * acz
  const d20 = apx * abx + apy * aby + apz * abz
  const d21 = apx * acx + apy * acy + apz * acz
  const den = d00 * d11 - d01 * d01
  const v = (d11 * d20 - d01 * d21) / den
  const w = (d00 * d21 - d01 * d20) / den
  if (v >= 0 && w >= 0 && v + w <= 1) {
    out[0] = ax + abx * v + acx * w; out[1] = ay + aby * v + acy * w; out[2] = az + abz * v + acz * w
    return
  }
  let best = Infinity
  const seg = (sx: number, sy: number, sz: number, ex: number, ey: number, ez: number) => {
    const dx = ex - sx, dy = ey - sy, dz = ez - sz
    const t = Math.min(1, Math.max(0, ((x - sx) * dx + (y - sy) * dy + (z - sz) * dz) / (dx * dx + dy * dy + dz * dz)))
    const qx = sx + dx * t, qy = sy + dy * t, qz = sz + dz * t
    const d = (qx - x) ** 2 + (qy - y) ** 2 + (qz - z) ** 2
    if (d < best) { best = d; out[0] = qx; out[1] = qy; out[2] = qz }
  }
  seg(ax, ay, az, ax + abx, ay + aby, az + abz)
  seg(ax, ay, az, ax + acx, ay + acy, az + acz)
  seg(ax + abx, ay + aby, az + abz, ax + acx, ay + acy, az + acz)
}

describe('the GPU deviation search', () => {
  const sphere = icosphere(4, 25)
  const reference = new NominalSurface(sphere.positions, sphere.indices)
  const scan = buildMeshGraph({ kind: 'soup', positions: boxMesh(30, 24, 0.4) })
  const transform = rigidFromAxisAngle([1, 2, 3], 0.4)
  const local = new Float32Array(scan.positions.length)
  const p = new Float64Array(3)
  for (let v = 0; v < local.length; v += 3) {
    rigidApply(transform, scan.positions[v], scan.positions[v + 1], scan.positions[v + 2], p)
    local.set(p, v)
  }
  const faces = shaderNearestFaces(reference, local)

  it('finds a face for every point', () => {
    expect(reference.flatTree()).not.toBeNull()
    expect(faces.every((face) => face >= 0)).toBe(true)
  })

  it('gives the CPU map with the faces it found', () => {
    const cpu = computeDeviation(reference, scan.positions, transform)
    const gpu = computeDeviation(reference, scan.positions, transform, { nearestFaces: faces })
    for (let i = 0; i < cpu.length; i++) expect(Math.abs(gpu[i] - cpu[i])).toBeLessThan(1e-4)
  })

  it('gives the CPU map under a facing limit too', () => {
    const options = { normals: scan.normals, maxNormalDeviation: Math.PI / 2 }
    const cpu = computeDeviation(reference, scan.positions, transform, options)
    const gpu = computeDeviation(reference, scan.positions, transform, { ...options, nearestFaces: faces })
    for (let i = 0; i < cpu.length; i++) {
      if (Number.isNaN(cpu[i])) expect(gpu[i]).toBeNaN()
      else expect(Math.abs(gpu[i] - cpu[i])).toBeLessThan(1e-4)
    }
  })

  it('searches the rest where a face is missing', () => {
    const cpu = computeDeviation(reference, scan.positions, transform)
    const some = faces.map((face, i) => (i % 3 === 0 ? -1 : face))
    const mixed = computeDeviation(reference, scan.positions, transform, { nearestFaces: some })
    for (let i = 0; i < cpu.length; i++) expect(Math.abs(mixed[i] - cpu[i])).toBeLessThan(1e-4)
  })

  it('answers null with no WebGPU, for the CPU search to run', async () => {
    expect(await gpuNearestFaces(reference, scan.positions, transform)).toBeNull()
  })
})
