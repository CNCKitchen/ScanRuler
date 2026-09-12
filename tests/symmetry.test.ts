// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { NominalSurface } from '../src/core/deviation/surface'
import { buildMeshGraph } from '../src/core/geometry/buildGraph'
import { findSymmetryPlane } from '../src/core/symmetry'
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

  it('says so when the part is not symmetric', () => {
    // The small cube lifted 3 mm out of the plane: nothing mirrors cleanly.
    const g = lShape(0, 3)
    const surface = new NominalSurface(g.positions, g.indices)
    const r = findSymmetryPlane(surface, g.positions, g.normals, null, OPTS)
    expect(r.rms).toBeGreaterThan(0.2)
  })
})
