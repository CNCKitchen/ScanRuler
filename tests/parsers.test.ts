// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { PLY_KEEP_WINDING, parsePLY } from '../src/core/parsers/ply'
import { parseOBJ } from '../src/core/parsers/obj'
import { parseSTL } from '../src/core/parsers/stl'
import { checkTextSize, decodeWhole, TEXT_LIMIT } from '../src/core/parsers/text'
import { eachLine, gatherFloats, TEXT_CHUNK, textPieces, Words } from '../src/core/parsers/textChunks'

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

describe('text too large for one string', () => {
  // Chrome's TextDecoder returns "" past the limit, and does not throw.
  it('says so instead of finding nothing in the file', () => {
    expect(() => checkTextSize(TEXT_LIMIT, 'This file', 'Do something.')).not.toThrow()
    expect(() => checkTextSize(TEXT_LIMIT + 1, 'This 3MF', 'Do something.')).toThrow(/^This 3MF is too large: 512 MB of text.*at most 512 MB in one piece\. Do something\.$/)
    expect(() => checkTextSize(900 * 1024 ** 2, 'This file', 'Do something.')).toThrow(/900 MB of text/)
  })

  it('reads what fits, and takes an empty answer on bytes that hold text as the limit met', () => {
    expect(decodeWhole(new TextEncoder().encode('v 0 0 0'), 'This OBJ', 'Do something.')).toBe('v 0 0 0')
    expect(decodeWhole(new Uint8Array(0), 'This OBJ', 'Do something.')).toBe('')
    const silent = globalThis.TextDecoder
    globalThis.TextDecoder = class { decode() { return '' } } as unknown as typeof TextDecoder
    try {
      expect(() => decodeWhole(new Uint8Array(1000), 'This OBJ', 'Do something.')).toThrow(/This OBJ is too large/)
    } finally {
      globalThis.TextDecoder = silent
    }
  })
})

describe('text read a piece at a time', () => {
  const bytesOf = (text: string) => new TextEncoder().encode(text)
  const sample = 'v 1 2 3\r\n\n# Grüße, 日本語 🙂\nlast line'

  it('keeps multi-byte characters whole wherever a piece is cut', () => {
    for (const chunk of [1, 2, 3, 5, 7, 1000]) {
      expect([...textPieces(bytesOf(sample), chunk)].map((p) => p.text).join('')).toBe(sample)
    }
  })

  it('gives the lines a split would, at any size of piece', () => {
    for (const text of [sample, sample + '\n', '', '\n', 'a', '\n\nb\n\n']) {
      for (const chunk of [1, 2, 3, 5, 7, 1000]) {
        const lines: string[] = []
        eachLine(bytesOf(text), (line, i) => {
          expect(i).toBe(lines.length)
          lines.push(line)
        }, undefined, chunk)
        const whole = text.split('\n')
        if (whole.at(-1) === '') whole.pop()
        expect(lines).toEqual(whole)
      }
    }
  })

  it('gives the words a split would, at any size of piece', () => {
    for (const text of ['', ' ', 'one', '  one  two\tthree\r\nfour  ', sample, 'a\u00a0b\u2003c']) {
      for (const chunk of [1, 2, 3, 5, 7, 1000]) {
        const words = new Words(bytesOf(text), undefined, chunk)
        const got: string[] = []
        for (let w = words.next(); w !== undefined; w = words.next()) got.push(w)
        expect(got).toEqual(text.split(/\s+/).filter((t) => t.length > 0))
        expect(words.next()).toBeUndefined()
      }
    }
  })

  it('gathers numbers past any first guess at how many', () => {
    const floats = gatherFloats()
    for (let i = 0; i < 100_000; i++) floats.push3(i, i + 1, i + 2)
    floats.push(7)
    const out = floats.take()
    expect(out.length).toBe(300_001)
    expect([out[0], out[299_999], out[300_000]]).toEqual([0, 100_001, 7])
  })
})

/** More than one piece's worth of a format: a grid of `n` × `n` squares whose
 *  coordinates say where they are, so a number cut in two would be found. */
describe('files larger than a piece', () => {
  const n = 1000
  const at = (i: number, j: number) => [i * 0.125, j * 0.25, (i + j) * 0.5]
  const encode = (text: string) => {
    const out = new TextEncoder().encode(text)
    expect(out.length).toBeGreaterThan(TEXT_CHUNK)
    return out.buffer as ArrayBuffer
  }
  /** Lots of lines the reader passes over, to carry the file past a piece. */
  const padding = (line: string) => line.repeat(Math.ceil((TEXT_CHUNK * 1.2) / line.length))

  const expectGrid = (positions: Float32Array) => {
    expect(positions.length).toBe((n + 1) * (n + 1) * 3)
    for (const [i, j] of [[0, 0], [17, 400], [999, 1000], [n, n]]) {
      const k = (i * (n + 1) + j) * 3
      expect([positions[k], positions[k + 1], positions[k + 2]]).toEqual(at(i, j))
    }
    for (let k = 0; k < positions.length; k += 3) {
      const i = Math.floor(k / 3 / (n + 1))
      const j = k / 3 - i * (n + 1)
      if (positions[k] !== at(i, j)[0] || positions[k + 1] !== at(i, j)[1] || positions[k + 2] !== at(i, j)[2]) throw new Error(`vertex ${i},${j} read wrong`)
    }
  }
  const vertexLines: string[] = []
  const quads: [number, number, number, number][] = []
  for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) vertexLines.push(at(i, j).join(' '))
  for (let i = 0; i < n; i += 50) for (let j = 0; j < n; j += 50) quads.push([i * (n + 1) + j, i * (n + 1) + j + 1, (i + 1) * (n + 1) + j + 1, (i + 1) * (n + 1) + j])

  it('reads an OBJ', () => {
    const faces = quads.map((q) => `f ${q.map((v) => v + 1).join(' ')}`)
    const mesh = parseOBJ(encode(`${padding('# a comment the reader passes over\n')}${vertexLines.map((l) => `v ${l}`).join('\n')}\n${faces.join('\n')}\n`))
    expectGrid(mesh.positions)
    expect(mesh.indices!.length).toBe(quads.length * 6)
    expect(Array.from(mesh.indices!.subarray(0, 6))).toEqual([quads[0][0], quads[0][1], quads[0][2], quads[0][0], quads[0][2], quads[0][3]])
  })

  it('reads an ASCII PLY', () => {
    const header = ['ply', 'format ascii 1.0', `element vertex ${vertexLines.length}`, 'property float x', 'property float y', 'property float z', `element face ${quads.length}`, 'property list uchar int vertex_indices', 'end_header', ''].join('\n')
    const mesh = parsePLY(encode(`${header}${vertexLines.join('\n')}\n${quads.map((q) => `4 ${q.join(' ')}`).join('\n')}\n${padding('  \n')}`))
    expectGrid(mesh.positions)
    expect(mesh.indices!.length).toBe(quads.length * 6)
    expect(Array.from(mesh.indices!.subarray(0, 6))).toEqual([quads[0][0], quads[0][1], quads[0][2], quads[0][0], quads[0][2], quads[0][3]])
  })

  it('reads an ASCII STL', () => {
    const facets: string[] = []
    const count = 120_000
    for (let t = 0; t < count; t++) {
      const v = (k: number) => `      vertex ${t + k * 0.25} ${t * 0.5} ${k}.5`
      facets.push(`  facet normal 0 0 1\n    outer loop\n${v(0)}\n${v(1)}\n${v(2)}\n    endloop\n  endfacet`)
    }
    const mesh = parseSTL(encode(`solid big\n${facets.join('\n')}\nendsolid big\n`))
    expect(mesh.positions.length).toBe(count * 9)
    for (let t = 0; t < count; t++) {
      for (let k = 0; k < 3; k++) {
        const o = (t * 3 + k) * 3
        if (mesh.positions[o] !== Math.fround(t + k * 0.25) || mesh.positions[o + 1] !== Math.fround(t * 0.5) || mesh.positions[o + 2] !== k + 0.5) throw new Error(`facet ${t} read wrong`)
      }
    }
  })

  it('reads an ASCII STL with no line feed after its last number, and refuses a cut one', () => {
    const facet = 'solid s\nfacet\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 2.5'
    const buffer = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer
    expect(Array.from(parseSTL(buffer(facet)).positions)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 2.5])
    expect(() => parseSTL(buffer('solid s\nvertex 0 0 0\nvertex 1 0 0\n'))).toThrow(/Could not read/)
  })
})

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
