// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { PLY_KEEP_WINDING, parsePLY } from '../src/core/parsers/ply'
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

  it('keeps the winding of a PLY that says so, and of no other', () => {
    expect(parsePLY(binaryPly(['made by test', PLY_KEEP_WINDING])).keepWinding).toBe(true)
    expect(parsePLY(binaryPly(['made by test'])).keepWinding).toBeUndefined()
    expect(parsePLY(binaryPly([`${PLY_KEEP_WINDING} or not`])).keepWinding).toBeUndefined()
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


/** A PLY made of the given header lines (after the format line) and body bytes. */
function plyOf(format: string, lines: string[], body: number[] | string = []): ArrayBuffer {
  const head = new TextEncoder().encode(['ply', `format ${format} 1.0`, ...lines, 'end_header', ''].join('\n'))
  const tail = typeof body === 'string' ? new TextEncoder().encode(body) : Uint8Array.from(body)
  const out = new Uint8Array(head.length + tail.length)
  out.set(head, 0)
  out.set(tail, head.length)
  return out.buffer
}

const XYZ = ['property float x', 'property float y', 'property float z']

describe('PLY property types', () => {
  it('refuses a property type it does not know instead of reading garbage', () => {
    const buf = plyOf('binary_little_endian',
      ['element vertex 3', 'property int64 id', ...XYZ, 'element face 1', 'property list uchar int vertex_indices'],
      new Array(3 * 20 + 13).fill(0))
    expect(() => parsePLY(buf)).toThrow('Unsupported PLY type "int64".')
  })

  it('refuses an unknown list item type and a float list count', () => {
    const items = plyOf('binary_little_endian',
      ['element vertex 3', ...XYZ, 'element face 1', 'property list uchar uint64 vertex_indices'],
      new Array(36 + 25).fill(0))
    expect(() => parsePLY(items)).toThrow('Unsupported PLY type "uint64".')
    const count = plyOf('binary_little_endian',
      ['element vertex 3', ...XYZ, 'element face 1', 'property list float int vertex_indices'],
      new Array(36 + 16).fill(0))
    expect(() => parsePLY(count)).toThrow('PLY list count type "float"')
  })
})

describe('vertex colours', () => {
  const RGB = ['property uchar red', 'property uchar green', 'property uchar blue']
  const FACE = ['element face 1', 'property list uchar int vertex_indices']

  it('reads red/green/blue from an ASCII PLY', () => {
    const mesh = parsePLY(plyOf('ascii', ['element vertex 3', ...XYZ, ...RGB, ...FACE],
      '0 0 0 255 0 0\n1 0 0 0 255 0\n0 1 0 0 0 255\n3 0 1 2\n'))
    expect(Array.from(mesh.colors!)).toEqual([255, 0, 0, 0, 255, 0, 0, 0, 255])
  })

  it('reads red/green/blue from a binary PLY, as uchar and as float', () => {
    const body: number[] = []
    const f32 = (v: number) => Array.from(new Uint8Array(new Float32Array([v]).buffer))
    const verts = [[0, 0, 0, 10, 20, 30], [1, 0, 0, 40, 50, 60], [0, 1, 0, 70, 80, 90]]
    for (const [x, y, z, r, g, b] of verts) body.push(...f32(x), ...f32(y), ...f32(z), r, g, b)
    body.push(3, 0, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0)
    const mesh = parsePLY(plyOf('binary_little_endian', ['element vertex 3', ...XYZ, ...RGB, ...FACE], body))
    expect(Array.from(mesh.colors!)).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90])

    const floats = parsePLY(plyOf('ascii', ['element vertex 3', ...XYZ,
      'property float r', 'property float g', 'property float b', ...FACE],
    '0 0 0 1 0 0\n1 0 0 0 1 0\n0 1 0 0 0 0.5\n3 0 1 2\n'))
    expect(Array.from(floats.colors!)).toEqual([255, 0, 0, 0, 255, 0, 0, 0, 128])
  })

  it('reads v x y z r g b from an OBJ', () => {
    const text = 'v 0 0 0 1 0 0\nv 1 0 0 0 1 0\nv 0 1 0 0 0 1\nf 1 2 3\n'
    const mesh = parseOBJ(new TextEncoder().encode(text).buffer)
    expect(Array.from(mesh.colors!)).toEqual([255, 0, 0, 0, 255, 0, 0, 0, 255])
  })

  it('leaves the colour off when every vertex has the same one, or none', () => {
    const same = parsePLY(plyOf('ascii', ['element vertex 3', ...XYZ, ...RGB, ...FACE],
      '0 0 0 9 9 9\n1 0 0 9 9 9\n0 1 0 9 9 9\n3 0 1 2\n'))
    expect(same.colors).toBeUndefined()
    expect(parsePLY(binaryPly(['plain'])).colors).toBeUndefined()
    expect(parseOBJ(new TextEncoder().encode('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n').buffer).colors).toBeUndefined()
  })
})

describe('PLY header counts', () => {
  // Three little-endian float vertices of one right triangle.
  const TRI = [0, 0, 0, 0, 0, 0, 128, 63, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 128, 63,
    0, 0, 128, 63, 0, 0, 0, 0, 0, 0, 0, 0]
  const timed = (buf: ArrayBuffer, message: RegExp) => {
    const t = performance.now()
    expect(() => parsePLY(buf)).toThrow(message)
    expect(performance.now() - t).toBeLessThan(500)
  }

  it('refuses a binary element with no properties and a huge count', () => {
    timed(plyOf('binary_little_endian', ['element vertex 3', ...XYZ, 'element face 100000000'], TRI),
      /PLY element "face"/)
  })

  it('refuses a binary list with a negative count', () => {
    timed(plyOf('binary_little_endian',
      ['element vertex 3', ...XYZ, 'element face 100000000', 'property list char char vertex_indices'],
      [...TRI, 0xff, 0, 0, 0]), /PLY/)
  })

  it('refuses an ASCII body shorter than its header counts', () => {
    timed(plyOf('ascii',
      ['element vertex 3', ...XYZ, 'element face 100000000', 'property list uchar int vertex_indices'],
      '0 0 0\n1 0 0\n0 1 0\n3 0 1 2\n'), /PLY/)
  })

  it('refuses counts the file is too short to hold before allocating them', () => {
    timed(plyOf('binary_little_endian',
      ['element vertex 10000000000', ...XYZ, 'element face 1', 'property list uchar int vertex_indices'], TRI),
    /PLY/)
    timed(plyOf('binary_little_endian',
      ['element vertex 3', ...XYZ, 'element face 1', 'property list uint int vertex_indices'],
      [...TRI, 0xff, 0xff, 0xff, 0x3f]), /PLY/)
    timed(plyOf('binary_little_endian', ['element vertex -3', ...XYZ, 'element face 1',
      'property list uchar int vertex_indices'], TRI), /PLY/)
  })
})
