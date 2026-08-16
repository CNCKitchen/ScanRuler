// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { parsePLY } from '../src/core/parsers/ply'
import { parseOBJ } from '../src/core/parsers/obj'

/** One right triangle, as a binary little-endian PLY with the given header
 *  comment lines. Comments may carry multi-byte UTF-8 — that is the point. */
function binaryPly(comments: string[]): ArrayBuffer {
  const header =
    ['ply', 'format binary_little_endian 1.0', ...comments.map((c) => `comment ${c}`),
      'element vertex 3', 'property float x', 'property float y', 'property float z',
      'element face 1', 'property list uchar int vertex_indices', 'end_header', ''].join('\n')
  const head = new TextEncoder().encode(header)
  const body = new ArrayBuffer(3 * 12 + 1 + 3 * 4)
  const dv = new DataView(body)
  const verts = [0, 0, 0, 1, 0, 0, 0, 1, 0]
  verts.forEach((v, i) => dv.setFloat32(i * 4, v, true))
  dv.setUint8(36, 3)
  ;[0, 1, 2].forEach((ix, i) => dv.setInt32(37 + i * 4, ix, true))
  const out = new Uint8Array(head.length + body.byteLength)
  out.set(head, 0)
  out.set(new Uint8Array(body), head.length)
  return out.buffer
}

describe('PLY parsing', () => {
  it('reads a binary body', () => {
    const mesh = parsePLY(binaryPly(['made by test']))
    expect(Array.from(mesh.positions)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0])
    expect(Array.from(mesh.indices!)).toEqual([0, 1, 2])
  })

  it('keeps the body offset in bytes when the header holds multi-byte UTF-8', () => {
    // "Créé par Ünïcode" is 3 characters shorter than its byte length; a
    // character-counted offset would start the body 3 bytes early.
    const mesh = parsePLY(binaryPly(['Créé par Ünïcode']))
    expect(Array.from(mesh.positions)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0])
    expect(Array.from(mesh.indices!)).toEqual([0, 1, 2])
  })

  it('rejects a non-PLY buffer', () => {
    expect(() => parsePLY(new TextEncoder().encode('solid nope').buffer)).toThrow(
      'Not a valid PLY file.',
    )
  })
})

describe('OBJ parsing', () => {
  it('accepts tabs after the v/f keywords', () => {
    const text = 'v\t0 0 0\nv\t1\t0 0\nv 0 1 0\nf\t1 2 3\n'
    const mesh = parseOBJ(new TextEncoder().encode(text).buffer)
    expect(Array.from(mesh.positions)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0])
    expect(Array.from(mesh.indices!)).toEqual([0, 1, 2])
  })
})
