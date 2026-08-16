// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { buildBinaryStl } from '../src/core/exportStl'
import { rigidFromAxisAngle } from '../src/core/deviation/rigid'

const HEADER_BYTES = 80
const TRIANGLE_BYTES = 50

/** Read a binary STL back into facet normals and corners. */
function readStl(buffer: ArrayBuffer) {
  const view = new DataView(buffer)
  const count = view.getUint32(HEADER_BYTES, true)
  const facets: { normal: number[]; corners: number[][] }[] = []
  for (let t = 0; t < count; t++) {
    const at = HEADER_BYTES + 4 + t * TRIANGLE_BYTES
    const f = (o: number) => view.getFloat32(at + o, true)
    facets.push({
      normal: [f(0), f(4), f(8)],
      corners: [
        [f(12), f(16), f(20)],
        [f(24), f(28), f(32)],
        [f(36), f(40), f(44)],
      ],
    })
  }
  return { count, facets }
}

const header = (buffer: ArrayBuffer) =>
  new TextDecoder().decode(new Uint8Array(buffer, 0, HEADER_BYTES)).replace(/\0+$/, '')

// One square in the z = 0 plane, wound counter-clockwise seen from +z.
const QUAD = new Float32Array([0, 0, 0, 10, 0, 0, 10, 4, 0, 0, 4, 0])
const QUAD_INDEX = new Uint32Array([0, 1, 2, 0, 2, 3])

describe('binary STL export', () => {
  it('writes the exact byte layout of an indexed mesh', () => {
    const buffer = buildBinaryStl(QUAD, QUAD_INDEX, null, 'ScanRuler test')
    expect(buffer.byteLength).toBe(HEADER_BYTES + 4 + 2 * TRIANGLE_BYTES)
    expect(header(buffer)).toBe('ScanRuler test')
    // Never "solid": readers sniff that word and would parse the file as ASCII.
    expect(header(buffer).startsWith('solid')).toBe(false)

    const { count, facets } = readStl(buffer)
    expect(count).toBe(2)
    for (const f of facets) expect(f.normal).toEqual([0, 0, 1])
    expect(facets[0].corners).toEqual([
      [0, 0, 0],
      [10, 0, 0],
      [10, 4, 0],
    ])
    expect(facets[1].corners[2]).toEqual([0, 4, 0])
  })

  it('takes a flat, unindexed mesh too', () => {
    const flat = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
    const { count, facets } = readStl(buildBinaryStl(flat, null, null, 'flat'))
    expect(count).toBe(1)
    expect(facets[0].corners[1]).toEqual([1, 0, 0])
  })

  it('bakes the transform into the vertices and the facet normals', () => {
    // A quarter turn about x: the z = 0 quad stands up into y = 0, and its
    // +z normal points along −y.
    const m = rigidFromAxisAngle([1, 0, 0], Math.PI / 2)
    const { facets } = readStl(buildBinaryStl(QUAD, QUAD_INDEX, m, 'moved'))
    for (const f of facets) {
      expect(f.normal[0]).toBeCloseTo(0, 5)
      expect(f.normal[1]).toBeCloseTo(-1, 5)
      expect(f.normal[2]).toBeCloseTo(0, 5)
      for (const c of f.corners) expect(c[1]).toBeCloseTo(0, 5)
    }
    // The corner at (10, 4, 0) lands at (10, 0, 4).
    const moved = facets[0].corners[2]
    expect(moved[0]).toBeCloseTo(10, 5)
    expect(moved[2]).toBeCloseTo(4, 5)
  })

  it('leaves a degenerate triangle with a zero normal rather than NaN', () => {
    const spike = new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0])
    const { facets } = readStl(buildBinaryStl(spike, null, null, 'degenerate'))
    expect(facets[0].normal).toEqual([0, 0, 0])
  })
})
