// SPDX-License-Identifier: AGPL-3.0-only
// Files that claim far more than they hold are refused before anything is
// sized from the claim.
import { strToU8, unzipSync, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { parsePLY } from '../src/core/parsers/ply'
import { parse3MF } from '../src/core/parsers/threemf'
import { ZipTooLargeError, limitedFilter } from '../src/core/parsers/zipLimit'

const bytesOf = (text: string): ArrayBuffer => {
  const u = new TextEncoder().encode(text)
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer
}

describe('PLY limits', () => {
  it('refuses a header that counts more vertices than the file can hold', () => {
    const ply = bytesOf(['ply', 'format binary_little_endian 1.0', 'element vertex 900000000', 'property float x', 'property float y', 'property float z', 'element face 1', 'property list uchar int vertex_indices', 'end_header', ''].join('\n'))
    expect(() => parsePLY(ply)).toThrow(/more than the file holds/)
  })

  it('refuses an ASCII face list longer than the tokens that follow', () => {
    const ply = bytesOf(['ply', 'format ascii 1.0', 'element vertex 3', 'property float x', 'property float y', 'property float z', 'element face 1', 'property list uchar int vertex_indices', 'end_header', '0 0 0', '1 0 0', '0 1 0', '1000000000 0 1 2', ''].join('\n'))
    expect(() => parsePLY(ply)).toThrow(/longer than the file/)
  })

  it('refuses a binary face list whose count runs past the end', () => {
    const head = new TextEncoder().encode(['ply', 'format binary_little_endian 1.0', 'element vertex 3', 'property float x', 'property float y', 'property float z', 'element face 1', 'property list uint int vertex_indices', 'end_header', ''].join('\n'))
    const body = new DataView(new ArrayBuffer(36 + 4 + 12))
    body.setUint32(36, 4_000_000_000, true)
    const out = new Uint8Array(head.length + body.byteLength)
    out.set(head)
    out.set(new Uint8Array(body.buffer), head.length)
    expect(() => parsePLY(out.buffer)).toThrow(/longer than the file/)
  })

  it('refuses a negative or non-numeric count', () => {
    const ply = bytesOf(['ply', 'format ascii 1.0', 'element vertex -5', 'property float x', 'end_header', ''].join('\n'))
    expect(() => parsePLY(ply)).toThrow(/invalid count|no faces/)
  })
})

describe('3MF limits', () => {
  const model = (objects: string, build: string) =>
    `<?xml version="1.0"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>${objects}</resources><build>${build}</build></model>`
  const pack = (xml: string): ArrayBuffer => {
    const zip = zipSync({ '3D/3dmodel.model': strToU8(xml) })
    return zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer
  }

  it('refuses components that fan out to billions of placements', () => {
    // Ai names Ai+1 twice, so object 0 stands for 2^30 copies of the triangle in the last.
    let objects = ''
    for (let i = 0; i < 30; i++) objects += `<object id="${i}" type="model"><components><component objectid="${i + 1}"/><component objectid="${i + 1}"/></components></object>`
    objects += '<object id="30" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>'
    expect(() => parse3MF(pack(model(objects, '<item objectid="0"/>')))).toThrow(/more objects than ScanRuler can open/)
  })

  it('still reads an ordinary assembly', () => {
    const objects =
      '<object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>' +
      '<object id="2" type="model"><components><component objectid="1"/><component objectid="1" transform="1 0 0 0 1 0 0 0 1 5 0 0"/></components></object>'
    const mesh = parse3MF(pack(model(objects, '<item objectid="2"/>')))
    expect(mesh.kind).toBe('indexed')
    expect(mesh.indices?.length).toBe(6)
  })
})

describe('zip size ceiling', () => {
  it('sums the sizes the headers declare and refuses past the limit', () => {
    const zip = zipSync({ 'a.model': new Uint8Array(600), 'b.model': new Uint8Array(600), 'c.txt': new Uint8Array(10_000) })
    expect(Object.keys(unzipSync(zip, { filter: limitedFilter((n) => n.endsWith('.model'), 2000) }))).toEqual(['a.model', 'b.model'])
    expect(() => unzipSync(zip, { filter: limitedFilter((n) => n.endsWith('.model'), 1000) })).toThrow(ZipTooLargeError)
  })
})
