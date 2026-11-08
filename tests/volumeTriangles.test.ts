// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { buildMeshGraph } from '../src/core/geometry/buildGraph'
import { NominalSurface } from '../src/core/deviation/surface'
import { originalTriangles } from '../src/core/deviation/volume'
import { boxMesh } from './helpers'

describe('the reference triangles behind the tree', () => {
  it('finds each tree triangle at its place in the mesh', () => {
    const g = buildMeshGraph({ kind: 'soup', positions: boxMesh(20, 6) })
    const surface = new NominalSurface(g.positions, g.indices)
    const original = originalTriangles(g.indices, surface)
    const seen = new Set<number>()
    for (let f = 0; f < surface.triangleCount; f++) {
      const t = original[f]
      expect(t).toBeGreaterThanOrEqual(0)
      for (let k = 0; k < 3; k++) expect(g.indices[t * 3 + k]).toBe(surface.index[f * 3 + k])
      seen.add(t)
    }
    expect(seen.size).toBe(surface.triangleCount)
  })

  it('matches a triangle given twice once each, and misses one it never had', () => {
    const indices = Uint32Array.of(0, 1, 2, 2, 3, 0, 0, 1, 2)
    const tree = { index: Uint32Array.of(0, 1, 2, 2, 3, 0, 0, 1, 2, 3, 2, 1), triangleCount: 4 }
    expect([...originalTriangles(indices, tree)]).toEqual([0, 1, 2, -1])
  })
})
