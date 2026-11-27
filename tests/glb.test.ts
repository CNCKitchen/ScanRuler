// SPDX-License-Identifier: AGPL-3.0-only
// GLB, as phone scanning apps write it: metres and Y up read as millimetres
// and Z up, the seams glTF splits its vertices along welded shut, colour
// from the base colour texture, and the files ScanRuler cannot read refused
// with a reason.

import { describe, expect, it } from 'vitest'
import { MeshoptDecoder } from 'meshoptimizer/decoder'
import { MeshoptEncoder } from 'meshoptimizer/encoder'
import { glbColourImages, glbImageKey, glbNeedsMeshopt, parseGLB } from '../src/core/parsers/glb'
import { buildMeshGraph } from '../src/core/geometry/buildGraph'
import { isModelFile, saysOwnUnits } from '../src/core/formats'
import type { TextureImage } from '../src/core/parsers/objTexture'

type J = Record<string, unknown>

/** A GLB of `json` and `bin`, each chunk padded to four bytes. */
function glb(json: J, bin?: Uint8Array): ArrayBuffer {
  const text = new TextEncoder().encode(JSON.stringify(json))
  const jsonLength = (text.length + 3) & ~3
  const binLength = bin ? (bin.length + 3) & ~3 : 0
  const total = 12 + 8 + jsonLength + (bin ? 8 + binLength : 0)
  const out = new Uint8Array(total)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, 0x46546c67, true)
  dv.setUint32(4, 2, true)
  dv.setUint32(8, total, true)
  dv.setUint32(12, jsonLength, true)
  dv.setUint32(16, 0x4e4f534a, true)
  out.fill(0x20, 20, 20 + jsonLength)
  out.set(text, 20)
  if (bin) {
    const at = 20 + jsonLength
    dv.setUint32(at, binLength, true)
    dv.setUint32(at + 4, 0x004e4942, true)
    out.set(bin, at + 8)
  }
  return out.buffer
}

/** Typed arrays one after another in one binary chunk, each at a multiple
 *  of four; the views and the offsets they start at. */
function pack(...parts: ArrayBufferView[]): { bin: Uint8Array; views: J[] } {
  const views: J[] = []
  let length = 0
  for (const p of parts) {
    views.push({ buffer: 0, byteOffset: length, byteLength: p.byteLength })
    length += (p.byteLength + 3) & ~3
  }
  const bin = new Uint8Array(length)
  parts.forEach((p, i) => bin.set(new Uint8Array(p.buffer, p.byteOffset, p.byteLength), views[i].byteOffset as number))
  return { bin, views }
}

const FLOAT = 5126
const USHORT = 5123

/** One triangle in glTF's frame, metres: along X, and up (+Y). */
function triangleFile(extra: { node?: J; mode?: number } = {}): ArrayBuffer {
  const { bin, views } = pack(Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0))
  return glb({
    asset: { version: '2.0' },
    buffers: [{ byteLength: bin.length }],
    bufferViews: views,
    accessors: [{ bufferView: 0, componentType: FLOAT, count: 3, type: 'VEC3' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, ...(extra.mode !== undefined ? { mode: extra.mode } : {}) }] }],
    nodes: [{ mesh: 0, ...extra.node }],
    scenes: [{ nodes: [0] }],
  }, bin)
}

const vertex = (positions: Float32Array, i: number) => Array.from(positions.subarray(i * 3, i * 3 + 3)).map((x) => x + 0)

/** The triangle's normal, unnormalized. */
function normalOf(p: Float32Array, idx: Uint32Array, t = 0): number[] {
  const [a, b, c] = [idx[t * 3], idx[t * 3 + 1], idx[t * 3 + 2]].map((i) => vertex(p, i))
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
  return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
}

describe('GLB', () => {
  it('is a model format that says its own units', () => {
    expect(isModelFile('scan.GLB')).toBe(true)
    expect(saysOwnUnits('scan.glb')).toBe(true)
    expect(saysOwnUnits('scan.3mf')).toBe(true)
    expect(saysOwnUnits('scan.stl')).toBe(false)
  })

  it('reads metres as millimetres and turns Y up into Z up', () => {
    const m = parseGLB(triangleFile())
    expect(m.kind).toBe('indexed')
    expect(vertex(m.positions, 0)).toEqual([0, 0, 0])
    expect(vertex(m.positions, 1)).toEqual([1000, 0, 0])
    // glTF's up is ScanRuler's up.
    expect(vertex(m.positions, 2)).toEqual([0, 0, 1000])
    // The triangle faced the viewer (+Z in glTF): it faces the front (−Y).
    const n = normalOf(m.positions, m.indices!)
    expect(n[1]).toBeLessThan(0)
    expect(m.colors).toBeUndefined()
  })

  it('puts nodes in place through their parents, and turns a mirrored one back out', () => {
    const { bin, views } = pack(Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0))
    const file = (child: J) => glb({
      asset: { version: '2.0' },
      buffers: [{ byteLength: bin.length }],
      bufferViews: views,
      accessors: [{ bufferView: 0, componentType: FLOAT, count: 3, type: 'VEC3' }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      nodes: [{ translation: [0, 0, 2], children: [1] }, { mesh: 0, ...child }],
      scene: 0,
      scenes: [{ nodes: [0] }],
    }, bin)
    const moved = parseGLB(file({ scale: [2, 2, 2] }))
    // 2 m towards the viewer (+Z) is 2000 mm towards −Y; the child doubles.
    expect(vertex(moved.positions, 1)).toEqual([2000, -2000, 0])
    expect(vertex(moved.positions, 2)).toEqual([0, -2000, 2000])
    const mirrored = parseGLB(file({ scale: [-1, 1, 1] }))
    // Mirrored in X, the triangle's own facing is kept (−Y), not flipped.
    expect(normalOf(mirrored.positions, mirrored.indices!)[1]).toBeLessThan(0)
  })

  it('welds the vertices glTF splits along its seams', () => {
    // A square as two primitives sharing an edge, as a texture seam leaves it.
    const { bin, views } = pack(
      Float32Array.of(0, 0, 0, 1, 0, 0, 1, 1, 0),
      Float32Array.of(0, 0, 0, 1, 1, 0, 0, 1, 0),
    )
    const m = parseGLB(glb({
      asset: { version: '2.0' },
      buffers: [{ byteLength: bin.length }],
      bufferViews: views,
      accessors: [
        { bufferView: 0, componentType: FLOAT, count: 3, type: 'VEC3' },
        { bufferView: 1, componentType: FLOAT, count: 3, type: 'VEC3' },
      ],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }, { attributes: { POSITION: 1 } }] }],
      nodes: [{ mesh: 0 }],
      scenes: [{ nodes: [0] }],
    }, bin))
    expect(m.positions.length / 3).toBe(4)
    expect(m.indices!.length / 3).toBe(2)
    expect(buildMeshGraph(m).vertexCount).toBe(4)
  })

  it('reads quantized positions, indices and a triangle strip', () => {
    // KHR_mesh_quantization: normalized uint16 positions, scaled back by the node.
    const { bin, views } = pack(
      // Four corners of a square: x y z, and a pad to keep each at 8 bytes.
      Uint16Array.of(0, 0, 0, 0, 65535, 0, 0, 0, 0, 65535, 0, 0, 65535, 65535, 0, 0),
      Uint16Array.of(0, 1, 2, 3),
    )
    views[0].byteStride = 8
    const m = parseGLB(glb({
      asset: { version: '2.0' },
      extensionsUsed: ['KHR_mesh_quantization'],
      extensionsRequired: ['KHR_mesh_quantization'],
      buffers: [{ byteLength: bin.length }],
      bufferViews: views,
      accessors: [
        { bufferView: 0, componentType: USHORT, normalized: true, count: 4, type: 'VEC3' },
        { bufferView: 1, componentType: USHORT, count: 4, type: 'SCALAR' },
      ],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, mode: 5 }] }],
      nodes: [{ mesh: 0, scale: [0.5, 0.5, 0.5] }],
      scenes: [{ nodes: [0] }],
    }, bin))
    expect(m.indices!.length / 3).toBe(2)
    expect(vertex(m.positions, 1)).toEqual([500, 0, 0])
    expect(vertex(m.positions, 3)).toEqual([500, 0, 500])
    // Both triangles of the strip face the same way.
    const a = normalOf(m.positions, m.indices!, 0)
    const b = normalOf(m.positions, m.indices!, 1)
    expect(Math.sign(a[1])).toBe(Math.sign(b[1]))
  })

  it('passes over points and lines, and refuses a file with no triangles', () => {
    expect(() => parseGLB(triangleFile({ mode: 0 }))).toThrow(/no triangles/)
    expect(() => parseGLB(triangleFile({ mode: 1 }))).toThrow(/no triangles/)
    expect(parseGLB(triangleFile({ mode: 6 })).indices!.length).toBe(3)
  })

  it('colours the vertices from the base colour texture, v down', () => {
    // A 2×2 image: red and green on the top row, blue and white below.
    const rgba = new Uint8Array(16)
    ;[[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255]].forEach((c, i) => rgba.set([...c, 255], i * 4))
    const image: TextureImage = { name: glbImageKey(1), width: 2, height: 2, rgba }
    const png = Uint8Array.of(0x89, 0x50, 0x4e, 0x47)
    const { bin, views } = pack(
      Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0),
      // glTF's v = 0 is the top row: red, green; then blue below.
      Float32Array.of(0.25, 0.25, 0.75, 0.25, 0.25, 0.75),
      png,
      png,
    )
    const file = glb({
      asset: { version: '2.0' },
      buffers: [{ byteLength: bin.length }],
      bufferViews: views,
      accessors: [
        { bufferView: 0, componentType: FLOAT, count: 3, type: 'VEC3' },
        { bufferView: 1, componentType: FLOAT, count: 3, type: 'VEC2' },
      ],
      // Image 0 is a normal map: not the part's colour, never decoded.
      images: [{ bufferView: 2, mimeType: 'image/png' }, { bufferView: 3, mimeType: 'image/png', name: 'albedo.png' }],
      textures: [{ source: 0 }, { source: 1 }],
      materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 1 } }, normalTexture: { index: 0 } }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, material: 0 }] }],
      nodes: [{ mesh: 0 }],
      scenes: [{ nodes: [0] }],
    }, bin)
    expect(glbColourImages(new Uint8Array(file)).map((f) => f.name)).toEqual([glbImageKey(1)])

    const m = parseGLB(file, undefined, { materials: [], images: [image] })
    expect(m.texture).toEqual({ kind: 'applied', images: ['albedo.png'] })
    const rgb = (v: number) => Array.from(m.colors!.subarray(v * 3, v * 3 + 3))
    expect(rgb(0)).toEqual([255, 0, 0])
    expect(rgb(1)).toEqual([0, 255, 0])
    expect(rgb(2)).toEqual([0, 0, 255])

    // Without its image — one the browser could not decode — the scan opens grey.
    const bare = parseGLB(file)
    expect(bare.colors).toBeUndefined()
    expect(bare.texture).toBeUndefined()
  })

  it('names the images it was coloured from, and those without a name together', () => {
    const rgba = new Uint8Array([200, 100, 50, 255])
    const { bin, views } = pack(Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0), Float32Array.of(0, 0, 0, 0, 0, 0))
    const file = (names: (string | undefined)[]) => glb({
      asset: { version: '2.0' },
      buffers: [{ byteLength: bin.length }],
      bufferViews: views,
      accessors: [
        { bufferView: 0, componentType: FLOAT, count: 3, type: 'VEC3' },
        { bufferView: 1, componentType: FLOAT, count: 3, type: 'VEC2' },
      ],
      images: names.map((name) => ({ bufferView: 1, mimeType: 'image/png', ...(name ? { name } : {}) })),
      textures: names.map((_, i) => ({ source: i })),
      materials: names.map((_, i) => ({ pbrMetallicRoughness: { baseColorTexture: { index: i } } })),
      meshes: [{ primitives: names.map((_, i) => ({ attributes: { POSITION: 0, TEXCOORD_0: 1 }, material: i })) }],
      nodes: [{ mesh: 0 }],
      scenes: [{ nodes: [0] }],
    }, bin)
    const given = (n: number) => ({ materials: [], images: Array.from({ length: n }, (_, i) => ({ name: glbImageKey(i), width: 1, height: 1, rgba })) })
    expect(parseGLB(file([undefined, undefined, undefined]), undefined, given(3)).texture).toEqual({ kind: 'applied', images: ['the file’s 3 textures'] })
    expect(parseGLB(file(['skin.jpg', undefined]), undefined, given(2)).texture).toEqual({ kind: 'applied', images: ['skin.jpg', 'the file’s texture'] })
  })

  it('takes vertex colours and material colours, linear light as sRGB', () => {
    const { bin, views } = pack(
      Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 0, 0, 3, 0, 0, 2, 1, 0),
      Float32Array.of(1, 0, 0, 0.2159, 0.2159, 0.2159, 0, 0, 1),
    )
    const m = parseGLB(glb({
      asset: { version: '2.0' },
      buffers: [{ byteLength: bin.length }],
      bufferViews: views,
      accessors: [
        { bufferView: 0, componentType: FLOAT, count: 3, type: 'VEC3' },
        { bufferView: 0, byteOffset: 36, componentType: FLOAT, count: 3, type: 'VEC3' },
        { bufferView: 1, componentType: FLOAT, count: 3, type: 'VEC3' },
      ],
      materials: [{ pbrMetallicRoughness: { baseColorFactor: [0, 1, 0, 1] } }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0, COLOR_0: 2 } }, { attributes: { POSITION: 1 }, material: 0 }] }],
      nodes: [{ mesh: 0 }],
      scenes: [{ nodes: [0] }],
    }, bin))
    const rgb = (v: number) => Array.from(m.colors!.subarray(v * 3, v * 3 + 3))
    expect(rgb(0)).toEqual([255, 0, 0])
    // Linear 0.2159 is sRGB 128, mid grey.
    expect(rgb(1)).toEqual([128, 128, 128])
    expect(rgb(3)).toEqual([0, 255, 0])
  })

  it('drops a single material colour: an exporter\'s default is not the part\'s', () => {
    const { bin, views } = pack(Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0))
    const m = parseGLB(glb({
      asset: { version: '2.0' },
      buffers: [{ byteLength: bin.length }],
      bufferViews: views,
      accessors: [{ bufferView: 0, componentType: FLOAT, count: 3, type: 'VEC3' }],
      materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.8, 0.8, 0.8, 1] } }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
      nodes: [{ mesh: 0 }],
      scenes: [{ nodes: [0] }],
    }, bin))
    expect(m.colors).toBeUndefined()
  })

  it('reads meshopt-compressed geometry with the decoder, and says so without it', async () => {
    await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready])
    const positions = Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0)
    const indices = Uint32Array.of(0, 1, 2, 2, 1, 3)
    const vb = MeshoptEncoder.encodeGltfBuffer(new Uint8Array(positions.buffer), 4, 12, 'ATTRIBUTES')
    const ib = MeshoptEncoder.encodeGltfBuffer(new Uint8Array(indices.buffer), 6, 4, 'TRIANGLES')
    const { bin, views } = pack(vb, ib)
    const file = glb({
      asset: { version: '2.0' },
      extensionsUsed: ['EXT_meshopt_compression'],
      extensionsRequired: ['EXT_meshopt_compression'],
      buffers: [{ byteLength: bin.length }, { byteLength: 72, extensions: { EXT_meshopt_compression: { fallback: true } } }],
      bufferViews: [
        { buffer: 1, byteOffset: 0, byteLength: 48, byteStride: 12, extensions: { EXT_meshopt_compression: { ...views[0], byteStride: 12, count: 4, mode: 'ATTRIBUTES' } } },
        { buffer: 1, byteOffset: 48, byteLength: 24, extensions: { EXT_meshopt_compression: { ...views[1], byteStride: 4, count: 6, mode: 'TRIANGLES' } } },
      ],
      accessors: [
        { bufferView: 0, componentType: FLOAT, count: 4, type: 'VEC3' },
        { bufferView: 1, componentType: 5125, count: 6, type: 'SCALAR' },
      ],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
      nodes: [{ mesh: 0 }],
      scenes: [{ nodes: [0] }],
    }, bin)
    expect(glbNeedsMeshopt(file)).toBe(true)
    expect(glbNeedsMeshopt(triangleFile())).toBe(false)
    expect(() => parseGLB(file)).toThrow(/meshopt/)
    const m = parseGLB(file, undefined, undefined, MeshoptDecoder)
    expect(m.indices!.length / 3).toBe(2)
    expect(vertex(m.positions, 3)).toEqual([1000, 0, 1000])
  })

  it('refuses what it cannot read, with a reason', () => {
    const bytes = new Uint8Array(triangleFile())
    const corrupt = (edit: (b: Uint8Array) => void) => {
      const b = bytes.slice()
      edit(b)
      return b.buffer
    }
    expect(() => parseGLB(corrupt((b) => (b[0] = 0)))).toThrow(/Not a valid GLB/)
    expect(() => parseGLB(corrupt((b) => (b[4] = 1)))).toThrow(/glTF 1/)
    expect(() => parseGLB(bytes.slice(0, bytes.length - 8).buffer)).toThrow(/cut short/)
    const json = (j: J) => glb({ asset: { version: '2.0' }, ...j })
    expect(() => parseGLB(json({ extensionsRequired: ['KHR_draco_mesh_compression'] }))).toThrow(/Draco/)
    expect(() => parseGLB(json({
      buffers: [{ byteLength: 36, uri: 'scan.bin' }],
      bufferViews: [{ buffer: 0, byteLength: 36 }],
      accessors: [{ bufferView: 0, componentType: FLOAT, count: 3, type: 'VEC3' }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      nodes: [{ mesh: 0 }],
    }))).toThrow(/scan\.bin, a file beside it/)
    expect(() => parseGLB(json({ nodes: [{ mesh: 3 }] }))).toThrow(/mesh 3/)
    expect(() => parseGLB(json({ nodes: [{ children: [0] }] , scenes: [{ nodes: [0] }] }))).toThrow(/ring/)
    // An accessor that claims more than its view holds.
    const { bin, views } = pack(Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0))
    expect(() => parseGLB(glb({
      asset: { version: '2.0' },
      buffers: [{ byteLength: bin.length }],
      bufferViews: views,
      accessors: [{ bufferView: 0, componentType: FLOAT, count: 30, type: 'VEC3' }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      nodes: [{ mesh: 0 }],
    }, bin))).toThrow(/cut short/)
  })

  it('reads a buffer held in a data URI', () => {
    const positions = new Uint8Array(Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0).buffer)
    const uri = `data:application/octet-stream;base64,${btoa(String.fromCharCode(...positions))}`
    const m = parseGLB(glb({
      asset: { version: '2.0' },
      buffers: [{ byteLength: 36, uri }],
      bufferViews: [{ buffer: 0, byteLength: 36 }],
      accessors: [{ bufferView: 0, componentType: FLOAT, count: 3, type: 'VEC3' }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      nodes: [{ mesh: 0 }],
    }))
    expect(m.indices!.length).toBe(3)
  })
})
