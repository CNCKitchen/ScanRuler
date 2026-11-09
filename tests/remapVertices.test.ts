// SPDX-License-Identifier: AGPL-3.0-only
// Vertex sets carried through a vertex map: the ones that went left out, and
// a map that makes one vertex of several giving each number once, in order.
import { describe, expect, it } from 'vitest'
import { remapVertices } from '../src/core/geometry/remap'

describe('remapVertices', () => {
  it('leaves out the vertices that went and keeps the order', () => {
    expect(Array.from(remapVertices(Uint32Array.from([0, 1, 2, 3]), Int32Array.from([0, -1, 1, 2])))).toEqual([0, 1, 2])
  })

  it('gives a vertex several were welded onto once, sorted', () => {
    expect(Array.from(remapVertices(Uint32Array.from([1, 2, 3, 4]), Int32Array.from([0, 3, 0, 1, 3])))).toEqual([0, 1, 3])
  })
})
