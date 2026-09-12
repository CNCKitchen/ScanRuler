// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { trianglesWithin } from '../src/core/geometry/region'

// Two triangles sharing the edge 1–2: (0,1,2) and (1,3,2).
const INDICES = Uint32Array.from([0, 1, 2, 1, 3, 2])

describe('triangles within a marking', () => {
  it('keeps a triangle only when all three corners are marked', () => {
    expect(Array.from(trianglesWithin(INDICES, Uint32Array.from([0, 1, 2]), 4))).toEqual([0, 1, 2])
    expect(Array.from(trianglesWithin(INDICES, Uint32Array.from([1, 2, 3]), 4))).toEqual([1, 3, 2])
    expect(Array.from(trianglesWithin(INDICES, Uint32Array.from([0, 1, 2, 3]), 4))).toEqual([
      0, 1, 2, 1, 3, 2,
    ])
    // Two corners are not enough: the tint would leave the triangle bare.
    expect(trianglesWithin(INDICES, Uint32Array.from([1, 2]), 4)).toHaveLength(0)
  })

  it('ignores a vertex beyond the mesh rather than reading past it', () => {
    expect(Array.from(trianglesWithin(INDICES, Uint32Array.from([0, 1, 2, 99]), 4))).toEqual([0, 1, 2])
  })
})
