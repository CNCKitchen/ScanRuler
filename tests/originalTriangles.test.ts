// SPDX-License-Identifier: AGPL-3.0-only
// Volume deviation names a region by the reference triangles under it, read
// back through the tree's reordering. A Map keyed by text held at most 2^24
// triangles and threw past that (issue 34); the sorted walk has no limit.
import { describe, expect, it } from 'vitest'
import { originalTriangles } from '../src/core/deviation/volume'
import { NominalSurface } from '../src/core/deviation/surface'
import { boxMesh } from './helpers'
import { buildMeshGraph } from '../src/core/geometry/buildGraph'

describe('originalTriangles', () => {
  it('finds each triangle of the tree order in the mesh it came from', () => {
    const g = buildMeshGraph({ kind: 'soup', positions: boxMesh(20, 8) })
    const surface = new NominalSurface(g.positions, g.indices)
    const out = originalTriangles(g.indices, surface)
    expect(out.length).toBe(g.indices.length / 3)
    for (let f = 0; f < surface.triangleCount; f++) {
      const t = out[f]
      expect(t).toBeGreaterThanOrEqual(0)
      for (let k = 0; k < 3; k++) expect(g.indices[t * 3 + k]).toBe(surface.index[f * 3 + k])
    }
  })

  it('says -1 for a triangle the mesh does not have', () => {
    const out = originalTriangles(Uint32Array.from([0, 1, 2, 2, 3, 4]), { triangleCount: 2, index: [2, 3, 4, 7, 8, 9] })
    expect(Array.from(out)).toEqual([1, -1])
  })
})
