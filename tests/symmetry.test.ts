// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { NominalSurface } from '../src/core/deviation/surface'
import { buildMeshGraph } from '../src/core/geometry/buildGraph'
import { trianglesWithin } from '../src/core/geometry/region'
import { BASE_PLANE_SEEDS, baseSeedPlane, findSymmetryPlane } from '../src/core/symmetry'
import type { MeshGraph, Vec3 } from '../src/core/types'
import { boxMesh } from './helpers'

const shifted = (soup: Float32Array, d: Vec3) => soup.map((v, i) => v + d[i % 3])

/** An L-shaped part: a 20 mm cube with a 10 mm cube grown off one side,
 *  off-centre in y — so the only mirror plane is z = `dz`. Lightly noisy,
 *  the way a scan is. */
function lShape(dz = 0, bumpZ = 0): MeshGraph {
  const a = shifted(boxMesh(20, 12, 0.01, 1), [0, 0, dz])
  const b = shifted(boxMesh(10, 8, 0.01, 2), [15, 5, dz + bumpZ])
  const soup = new Float32Array(a.length + b.length)
  soup.set(a)
  soup.set(b, a.length)
  return buildMeshGraph({ kind: 'soup', positions: soup })
}

const OPTS = { samples: 1500 }

describe('symmetry plane', () => {
  it('finds the one mirror plane of an L-shaped part from its principal planes', () => {
    const g = lShape()
    const surface = new NominalSurface(g.positions, g.indices)
    const r = findSymmetryPlane(surface, g.positions, g.normals, null, OPTS)
    expect(Math.abs(r.normal[2])).toBeGreaterThan(0.9999)
    expect(Math.abs(r.point[0] * r.normal[0] + r.point[1] * r.normal[1] + r.point[2] * r.normal[2])).toBeLessThan(0.02)
    expect(r.rms).toBeLessThan(0.03)
    // The box's edge vertices carry no noise, which pulls the median down
    // and the three-median cut in with it; most samples still match.
    expect(r.matched).toBeGreaterThan(0.6 * r.sampled)
    expect(r.candidate).toBeGreaterThanOrEqual(0)
  })

  it('settles from a seed that is tilted and off the plane, and reports it as such', () => {
    const g = lShape()
    const surface = new NominalSurface(g.positions, g.indices)
    const t = (5 * Math.PI) / 180
    const r = findSymmetryPlane(
      surface,
      g.positions,
      g.normals,
      { normal: [0, Math.sin(t), Math.cos(t)], point: [0, 0, 1.5] },
      OPTS,
    )
    expect(Math.abs(r.normal[2])).toBeGreaterThan(0.9999)
    expect(Math.abs(r.point[2])).toBeLessThan(0.02)
    expect(r.rms).toBeLessThan(0.03)
    expect(r.candidate).toBe(-1)
  })

  it('finds the plane where the part is, not at the origin', () => {
    const g = lShape(7)
    const surface = new NominalSurface(g.positions, g.indices)
    const r = findSymmetryPlane(surface, g.positions, g.normals, null, OPTS)
    expect(Math.abs(r.normal[2])).toBeGreaterThan(0.9999)
    const offset = r.point[0] * r.normal[0] + r.point[1] * r.normal[1] + r.point[2] * r.normal[2]
    expect(Math.abs(Math.abs(offset) - 7)).toBeLessThan(0.02)
  })

  it('takes the caller’s directions as further candidates, and drops the ones it already has', () => {
    const g = lShape()
    const surface = new NominalSurface(g.positions, g.indices)
    // The mirror normal itself and a direction of no use: the first is a
    // principal axis already, so nothing past the three principal planes is
    // tried and the winner is one of those.
    const r = findSymmetryPlane(surface, g.positions, g.normals, null, { ...OPTS, directions: [[0, 0, 1]] })
    expect(Math.abs(r.normal[2])).toBeGreaterThan(0.9999)
    expect(r.candidate).toBeLessThan(3)
    expect(r.rms).toBeLessThan(0.03)
  })

  it('says so when the part is not symmetric', () => {
    // The small cube lifted 3 mm out of the plane: nothing mirrors cleanly.
    const g = lShape(0, 3)
    const surface = new NominalSurface(g.positions, g.indices)
    const r = findSymmetryPlane(surface, g.positions, g.normals, null, OPTS)
    expect(r.rms).toBeGreaterThan(0.2)
  })

  it('finds the symmetry of the marked surface alone when the rest is left out', () => {
    // The same asymmetric part, with only the big cube marked: the lifted
    // cube is neither sampled nor surface a mirror image may land on, and
    // the cube's own symmetry comes out clean.
    const g = lShape(0, 3)
    const marked: number[] = []
    for (let v = 0; v < g.vertexCount; v++) {
      const x = g.positions[v * 3], y = g.positions[v * 3 + 1], z = g.positions[v * 3 + 2]
      if (Math.abs(x) <= 10.001 && Math.abs(y) <= 10.001 && Math.abs(z) <= 10.001) marked.push(v)
    }
    const vertices = Uint32Array.from(marked)
    const cube = trianglesWithin(g.indices, vertices, g.vertexCount)
    const surface = new NominalSurface(g.positions, cube)
    const r = findSymmetryPlane(surface, g.positions, g.normals, null, { ...OPTS, vertices })
    expect(r.rms).toBeLessThan(0.03)
    expect(Math.max(...r.normal.map(Math.abs))).toBeGreaterThan(0.9999)
    expect(Math.abs(r.point[0] * r.normal[0] + r.point[1] * r.normal[1] + r.point[2] * r.normal[2])).toBeLessThan(0.02)
    expect(r.sampled).toBeLessThanOrEqual(vertices.length)
  })
})

describe('a coordinate plane as the seed', () => {
  it('is the plane itself where it cuts the part, and its parallel through the part’s centre where it does not', () => {
    expect(BASE_PLANE_SEEDS.map((p) => p.id).every((id) => id < 0)).toBe(true)
    // A part of 40 across, centred 5 off the XY plane: the plane runs through it.
    expect(baseSeedPlane(-1, [10, 20, 5], 40)).toMatchObject({ name: 'XY plane', normal: [0, 0, 1], point: [0, 0, 0] })
    // The same part 300 up, fresh from the scanner: the plane misses it.
    expect(baseSeedPlane(-1, [10, 20, 300], 40)).toMatchObject({ normal: [0, 0, 1], point: [10, 20, 300] })
    expect(baseSeedPlane(-2, [0, 0, 0], 40)?.normal).toEqual([1, 0, 0])
    expect(baseSeedPlane(-3, [0, 0, 0], 40)?.normal).toEqual([0, 1, 0])
    expect(baseSeedPlane(7, [0, 0, 0], 40)).toBeNull()
  })
})
