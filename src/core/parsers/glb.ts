// SPDX-License-Identifier: AGPL-3.0-only
// glTF binary (GLB), read as far as a scan needs it. It is what phone scanning
// apps and photogrammetry services hand out: one file holding the mesh, its
// materials and their images. glTF is defined in metres with Y up, so the
// part comes in millimetres without the question an STL needs, and is turned
// Z up on the way in, as a printer or CAD system has it.
//
// What is read:
//  - the default scene (or, without one, every node no other node holds),
//    each node's meshes put in place by its transform, as one mesh — the
//    way an STL of several shells opens;
//  - triangle primitives, as lists, strips or fans; points and lines are
//    not a surface and are passed over;
//  - accessors of any component type, normalized or not, so a file
//    quantized by gltfpack (KHR_mesh_quantization) opens as any other, and
//    meshopt-compressed buffers (EXT_meshopt_compression), decoded by a
//    decoder the worker loads when a file needs it;
//  - colour, as a colour per vertex: the base colour texture (with
//    KHR_texture_transform) sampled where the vertex's texture coordinate
//    points, times its vertex colour and its material's base colour. The
//    images are decoded on the main thread and come in with the rest of a
//    textured scan's files (see objTexture, and glbColourImages below).
//
// glTF splits a vertex wherever the texture layout or the normals have a
// seam, so the mesh is welded where corners coincide exactly, or every seam
// would be an open edge to the fits.
//
// Draco-compressed geometry is refused with a message: its decoder is a
// large module for a compression scan apps rarely use.

import type { ParsedMesh } from '../types'
import { weldExact } from '../export3mf'
import { checkTextSize } from './text'
import { sampleTexture, type ObjCompanions, type TextureImage } from './objTexture'

const MAGIC = 0x46546c67 // "glTF"
const CHUNK_JSON = 0x4e4f534a
const CHUNK_BIN = 0x004e4942

/** glTF's metres, as the millimetres everything here is held in. */
const MM_PER_METRE = 1000

/** The colour of a vertex no colour reaches. */
const UNCOLOURED = 180

/** How deep nodes may hold nodes, and how many meshes a scene may put in
 *  place, before the file is taken to be broken or hostile. */
const MAX_DEPTH = 64
const MAX_PLACED = { meshes: 100_000, vertices: 30_000_000 }

/** What a file too large for its JSON to be read is told. */
const GLB_INSTEAD = 'Export it as binary STL or binary PLY.'

/** The part of the meshopt decoder the parser uses (meshoptimizer/decoder). */
export interface MeshoptDecoderLike {
  decodeGltfBuffer(target: Uint8Array, count: number, size: number, source: Uint8Array, mode: string, filter?: string): void
}

type J = Record<string, unknown>

const isObj = (v: unknown): v is J => typeof v === 'object' && v !== null && !Array.isArray(v)
const objOf = (v: unknown): J => (isObj(v) ? v : {})
const listOf = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

/** A count or offset the file gives: a whole number, not negative. */
function whole(v: unknown, fallback: number, what: string): number {
  if (v === undefined) return fallback
  if (!Number.isSafeInteger(v) || (v as number) < 0) throw new Error(`This GLB gives ${what} as ${String(v)}.`)
  return v as number
}

/** An index into one of the file's lists, checked against it. */
function indexInto(v: unknown, list: readonly unknown[], what: string): number {
  if (!Number.isSafeInteger(v) || (v as number) < 0 || (v as number) >= list.length) {
    throw new Error(`This GLB names ${what} ${String(v)}, which it does not hold.`)
  }
  return v as number
}

/** `n` finite numbers, or `fallback` when the file gives none. */
function numbers(v: unknown, n: number, fallback: readonly number[]): number[] {
  if (v === undefined) return fallback.slice()
  if (!Array.isArray(v) || v.length !== n || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) {
    throw new Error('This GLB holds a transform or colour that is not a list of numbers.')
  }
  return v as number[]
}

/** The file split into its JSON and its binary chunk. */
interface Glb {
  json: J
  bin: Uint8Array | null
}

export function readGlb(bytes: Uint8Array): Glb {
  if (bytes.byteLength < 20) throw new Error('Not a valid GLB file.')
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (dv.getUint32(0, true) !== MAGIC) throw new Error('Not a valid GLB file.')
  const version = dv.getUint32(4, true)
  if (version !== 2) throw new Error(`This is a glTF ${version} file — only glTF 2 is supported.`)
  // The length the header gives, held to what is there: a file cut short
  // is read as far as it goes and found wanting where it falls short.
  const length = Math.min(dv.getUint32(8, true), bytes.byteLength)
  let json: J | null = null
  let bin: Uint8Array | null = null
  let at = 12
  while (at + 8 <= length) {
    const chunkLength = dv.getUint32(at, true)
    const type = dv.getUint32(at + 4, true)
    const start = at + 8
    if (start + chunkLength > length) throw new Error('This GLB is cut short: a chunk runs past the end of the file.')
    if (json === null) {
      if (type !== CHUNK_JSON) throw new Error('Not a valid GLB file: it does not start with its JSON.')
      checkTextSize(chunkLength, 'This GLB', GLB_INSTEAD)
      let parsed: unknown
      try {
        parsed = JSON.parse(new TextDecoder().decode(bytes.subarray(start, start + chunkLength)))
      } catch {
        throw new Error('This GLB could not be read: its JSON is damaged.')
      }
      if (!isObj(parsed)) throw new Error('This GLB could not be read: its JSON is damaged.')
      json = parsed
    } else if (type === CHUNK_BIN && bin === null) {
      bin = bytes.subarray(start, start + chunkLength)
    }
    // Chunks are padded to four bytes, and the padding counted in their length.
    at = start + chunkLength
  }
  if (!json) throw new Error('Not a valid GLB file.')
  if (objOf(json.asset).version !== undefined && !String(objOf(json.asset).version).startsWith('2.')) {
    throw new Error(`This is a glTF ${String(objOf(json.asset).version)} file — only glTF 2 is supported.`)
  }
  return { json, bin }
}

/** Whether the file's geometry is meshopt-compressed — what the worker loads
 *  the decoder for. False for a file that cannot be read: the parser says
 *  what is wrong with it. */
export function glbNeedsMeshopt(buffer: ArrayBuffer): boolean {
  try {
    const { json } = readGlb(new Uint8Array(buffer))
    return listOf(json.bufferViews).some((v) => isObj(objOf(v).extensions) && isObj(objOf(objOf(v).extensions).EXT_meshopt_compression))
  } catch {
    return false
  }
}

/** The data a `data:` URI holds; null for any other URI. */
function dataUri(uri: string): Uint8Array | null {
  const m = /^data:[^,]*?(;base64)?,(.*)$/s.exec(uri)
  if (!m) return null
  if (!m[1]) return new TextEncoder().encode(decodeURIComponent(m[2]))
  const text = atob(m[2])
  const out = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i)
  return out
}

/** The file's buffers and buffer views, read when first asked for. */
class Store {
  private readonly buffers = new Map<number, Uint8Array>()
  private readonly views = new Map<number, Uint8Array>()

  constructor(
    private readonly glb: Glb,
    private readonly meshopt?: MeshoptDecoderLike,
  ) {}

  buffer(i: number): Uint8Array {
    let data = this.buffers.get(i)
    if (data) return data
    const list = listOf(this.glb.json.buffers)
    const b = objOf(list[indexInto(i, list, 'buffer')])
    if (typeof b.uri === 'string') {
      const inline = dataUri(b.uri)
      if (!inline) throw new Error(`This GLB keeps its data in ${b.uri}, a file beside it — export it as one GLB with everything embedded.`)
      data = inline
    } else {
      if (!this.glb.bin) throw new Error('This GLB names a binary chunk it does not hold.')
      data = this.glb.bin
    }
    this.buffers.set(i, data)
    return data
  }

  /** A buffer view's bytes and the stride its elements are laid out at
   *  (0 when packed). A meshopt-compressed view comes back decoded. */
  view(i: number): { bytes: Uint8Array; stride: number } {
    const list = listOf(this.glb.json.bufferViews)
    const v = objOf(list[indexInto(i, list, 'buffer view')])
    const stride = whole(v.byteStride, 0, 'a buffer view stride')
    let data = this.views.get(i)
    if (data) return { bytes: data, stride }
    const compressed = objOf(v.extensions).EXT_meshopt_compression
    if (isObj(compressed)) {
      if (!this.meshopt) throw new Error('This GLB is meshopt-compressed, and the decoder for it could not be loaded.')
      const source = this.slice(compressed.buffer, compressed.byteOffset, compressed.byteLength)
      const count = whole(compressed.count, 0, 'a compressed element count')
      const size = whole(compressed.byteStride, 0, 'a compressed element size')
      if (count * size > 1 << 30) throw new Error('This GLB unpacks to more data than ScanRuler can open.')
      data = new Uint8Array(count * size)
      try {
        this.meshopt.decodeGltfBuffer(data, count, size, source, String(compressed.mode), typeof compressed.filter === 'string' ? compressed.filter : undefined)
      } catch {
        throw new Error('This GLB\'s compressed geometry could not be decoded — the file is damaged.')
      }
    } else {
      data = this.slice(v.buffer, v.byteOffset, v.byteLength)
    }
    this.views.set(i, data)
    return { bytes: data, stride }
  }

  private slice(buffer: unknown, offset: unknown, length: unknown): Uint8Array {
    const data = this.buffer(whole(buffer, -1, 'a buffer'))
    const start = whole(offset, 0, 'a buffer offset')
    const size = whole(length, -1, 'a buffer view length')
    if (start + size > data.byteLength) throw new Error('This GLB is cut short: a buffer view runs past the end of its data.')
    return data.subarray(start, start + size)
  }
}

/** Bytes and reader of each component type, and the largest value of the
 *  integer ones (what a normalized one is divided by). */
const COMPONENTS: Record<number, { size: number; max: number; read: (dv: DataView, at: number) => number }> = {
  5120: { size: 1, max: 127, read: (dv, at) => dv.getInt8(at) },
  5121: { size: 1, max: 255, read: (dv, at) => dv.getUint8(at) },
  5122: { size: 2, max: 32767, read: (dv, at) => dv.getInt16(at, true) },
  5123: { size: 2, max: 65535, read: (dv, at) => dv.getUint16(at, true) },
  5125: { size: 4, max: 4294967295, read: (dv, at) => dv.getUint32(at, true) },
  5126: { size: 4, max: 0, read: (dv, at) => dv.getFloat32(at, true) },
}

const TYPE_SIZE: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }

/** An accessor's elements as floats, `comps` to an element. An accessor
 *  without a buffer view is all zeros, as the specification has it. */
function readAccessor(store: Store, json: J, i: number, comps: readonly number[], what: string): { data: Float32Array; comps: number; count: number } {
  const list = listOf(json.accessors)
  const a = objOf(list[indexInto(i, list, 'accessor')])
  const component = COMPONENTS[a.componentType as number]
  const n = TYPE_SIZE[a.type as string]
  if (!component || !n || !comps.includes(n)) throw new Error(`This GLB holds its ${what} in a form ScanRuler does not read (${String(a.type)}).`)
  if (a.sparse !== undefined) throw new Error(`This GLB holds its ${what} as a sparse accessor, which ScanRuler does not read.`)
  const count = whole(a.count, -1, 'an accessor count')
  if (count * n > 3 * MAX_PLACED.vertices) throw new Error('This GLB holds more geometry than ScanRuler can open.')
  const out = new Float32Array(count * n)
  if (a.bufferView === undefined || count === 0) return { data: out, comps: n, count }
  const { bytes, stride: viewStride } = store.view(whole(a.bufferView, -1, 'a buffer view'))
  const offset = whole(a.byteOffset, 0, 'an accessor offset')
  const stride = viewStride || component.size * n
  if (offset + stride * (count - 1) + component.size * n > bytes.byteLength) {
    throw new Error(`This GLB is cut short: its ${what} run past the end of their data.`)
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const scale = a.normalized === true && component.max > 0 ? 1 / component.max : 1
  const signed = a.componentType === 5120 || a.componentType === 5122
  for (let e = 0; e < count; e++) {
    const at = offset + e * stride
    for (let c = 0; c < n; c++) {
      let x = component.read(dv, at + c * component.size) * scale
      if (signed && scale !== 1 && x < -1) x = -1
      out[e * n + c] = x
    }
  }
  return { data: out, comps: n, count }
}

/** An index accessor: whole numbers, each a vertex of the primitive. */
function readIndices(store: Store, json: J, i: number, vertexCount: number): Uint32Array {
  const list = listOf(json.accessors)
  const a = objOf(list[indexInto(i, list, 'accessor')])
  if (a.type !== 'SCALAR' || ![5121, 5123, 5125].includes(a.componentType as number)) {
    throw new Error('This GLB holds triangle indices in a form ScanRuler does not read.')
  }
  const { data, count } = readAccessor(store, json, i, [1], 'triangle indices')
  const out = new Uint32Array(count)
  for (let k = 0; k < count; k++) {
    if (data[k] >= vertexCount) throw new Error('This GLB references vertices that do not exist.')
    out[k] = data[k]
  }
  return out
}

/** A primitive's corners as triangles, three to a triangle: a list as it
 *  is, a strip or a fan laid out as one. Null for points and lines. */
function triangleCorners(mode: number, corners: Uint32Array): Uint32Array | null {
  if (mode === 4) return corners.subarray(0, corners.length - (corners.length % 3))
  if (mode !== 5 && mode !== 6) return null
  const n = Math.max(0, corners.length - 2)
  const out = new Uint32Array(n * 3)
  for (let i = 0; i < n; i++) {
    if (mode === 5) {
      // Every other triangle of a strip turns the other way.
      out[i * 3] = corners[i]
      out[i * 3 + 1] = corners[i + 1 + (i % 2)]
      out[i * 3 + 2] = corners[i + 2 - (i % 2)]
    } else {
      out[i * 3] = corners[i + 1]
      out[i * 3 + 1] = corners[i + 2]
      out[i * 3 + 2] = corners[0]
    }
  }
  return out
}

/** A 4×4 transform, column-major as glTF writes it. */
type Mat4 = Float64Array

function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float64Array(16)
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3]
    }
  }
  return out
}

/** A node's own transform: its matrix, or translation × rotation × scale. */
function nodeMatrix(node: J): Mat4 {
  if (node.matrix !== undefined) return Float64Array.from(numbers(node.matrix, 16, []))
  const [tx, ty, tz] = numbers(node.translation, 3, [0, 0, 0])
  const [x, y, z, w] = numbers(node.rotation, 4, [0, 0, 0, 1])
  const [sx, sy, sz] = numbers(node.scale, 3, [1, 1, 1])
  return Float64Array.of(
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  )
}

/** glTF's frame as ScanRuler's: metres to millimetres, and Y up turned to
 *  Z up — a quarter turn about X, so what faced the viewer (+Z) faces the
 *  front view (−Y). */
const TO_SCANRULER: Mat4 = Float64Array.of(
  MM_PER_METRE, 0, 0, 0,
  0, 0, MM_PER_METRE, 0,
  0, -MM_PER_METRE, 0, 0,
  0, 0, 0, 1,
)

function determinant3(m: Mat4): number {
  return m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2])
}

/** sRGB byte to linear light, and back. */
const LINEAR = Float64Array.from({ length: 256 }, (_, i) => {
  const c = i / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
})
function toSrgbByte(linear: number): number {
  const c = Math.max(0, Math.min(1, linear))
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055
  return Math.round(s * 255)
}

/** The name an embedded image travels to the worker under — the same on
 *  both sides, whatever the file calls it. */
export function glbImageKey(index: number): string {
  return `glb-image-${index}`
}

/** The image a texture shows: a WebP or KTX2 one the extension names where
 *  there is one, else its own. Null for none. */
function textureSource(json: J, texture: number): number | null {
  const textures = listOf(json.textures)
  const t = objOf(textures[indexInto(texture, textures, 'texture')])
  const ext = objOf(t.extensions)
  const source = objOf(ext.EXT_texture_webp).source ?? objOf(ext.KHR_texture_basisu).source ?? t.source
  return source === undefined ? null : indexInto(source, listOf(json.images), 'image')
}

/** The images a material's base colour is drawn from, by index — the only
 *  ones a scan's colour needs; normal and roughness maps are left be. */
function baseColourImages(json: J): number[] {
  const out = new Set<number>()
  for (const m of listOf(json.materials)) {
    const texture = objOf(objOf(objOf(m).pbrMetallicRoughness).baseColorTexture).index
    if (texture === undefined) continue
    const source = textureSource(json, whole(texture, -1, 'a texture'))
    if (source !== null) out.add(source)
  }
  return [...out]
}

/** The images the file's base colours are drawn from, as bytes for the main
 *  thread to decode (see app/scanFiles), each under glbImageKey. An image
 *  kept outside the file is left out, and the part stays grey where it lies. */
export function glbColourImages(bytes: Uint8Array): { name: string; bytes: Uint8Array }[] {
  const glb = readGlb(bytes)
  const store = new Store(glb)
  const images = listOf(glb.json.images)
  const out: { name: string; bytes: Uint8Array }[] = []
  for (const i of baseColourImages(glb.json)) {
    const img = objOf(images[i])
    let data: Uint8Array | null = null
    if (img.bufferView !== undefined) data = store.view(whole(img.bufferView, -1, 'a buffer view')).bytes
    else if (typeof img.uri === 'string') data = dataUri(img.uri)
    if (data) out.push({ name: glbImageKey(i), bytes: data })
  }
  return out
}

/** What the images a scan was coloured from are called on the status line:
 *  by the names the file gives them, and those it gives none together —
 *  a phone app's GLB names none, and "image 1, image 2, …" says nothing. */
function imageLabels(json: J, used: Iterable<number>): string[] {
  const named = new Set<string>()
  let unnamed = 0
  for (const i of used) {
    const img = objOf(listOf(json.images)[i])
    if (typeof img.name === 'string' && img.name.trim()) named.add(img.name.trim())
    else unnamed++
  }
  const out = [...named]
  if (unnamed === 1) out.push('the file’s texture')
  else if (unnamed > 1) out.push(`the file’s ${unnamed} textures`)
  return out
}

/** UV after KHR_texture_transform: scaled, turned, then moved — the turn
 *  the way three.js's glTF loader takes it, which the sample models check. */
interface UvTransform {
  offset: number[]
  rotation: number
  scale: number[]
}

function uvTransformOf(info: J): UvTransform | null {
  const t = objOf(info.extensions).KHR_texture_transform
  if (!isObj(t)) return null
  const rotation = typeof t.rotation === 'number' && Number.isFinite(t.rotation) ? t.rotation : 0
  return { offset: numbers(t.offset, 2, [0, 0]), rotation, scale: numbers(t.scale, 2, [1, 1]) }
}

export function parseGLB(buffer: ArrayBuffer, onProgress?: (text: string) => void, companions?: ObjCompanions, meshopt?: MeshoptDecoderLike): ParsedMesh {
  onProgress?.('Reading GLB…')
  const glb = readGlb(new Uint8Array(buffer))
  const { json } = glb
  const required = listOf(json.extensionsRequired)
  if (required.includes('KHR_draco_mesh_compression')) {
    throw new Error('This GLB is Draco-compressed, which ScanRuler does not read. Export it without Draco compression, or as STL, PLY or OBJ.')
  }
  const store = new Store(glb, meshopt)
  const meshes = listOf(json.meshes)
  const nodes = listOf(json.nodes)
  const materials = listOf(json.materials)

  const images = new Map((companions?.images ?? []).map((img) => [img.name, img]))
  // The images the part was coloured from, by index. One the browser could
  // not decode (a KTX2 texture, say) leaves the part grey, unremarked: the
  // note a textured OBJ gives for a missing image is about files to bring.
  const applied = new Set<number>()
  const imageFor = (i: number): TextureImage | null => {
    const img = images.get(glbImageKey(i)) ?? null
    if (img) applied.add(i)
    return img
  }

  const positionParts: Float32Array[] = []
  const indexParts: Uint32Array[] = []
  // Per vertex written, its colour (0xRRGGBB), -1 for none.
  const colourParts: Int32Array[] = []
  let vertexTotal = 0
  let placed = 0
  const texel = new Uint8Array(3)

  const placeMesh = (meshIndex: number, m: Mat4) => {
    const mesh = objOf(meshes[indexInto(meshIndex, meshes, 'mesh')])
    // A mirroring transform turns the triangles inside out; turned back.
    const flip = determinant3(m) < 0
    for (const p of listOf(mesh.primitives)) {
      const prim = objOf(p)
      const mode = whole(prim.mode, 4, 'a primitive mode')
      if (mode !== 4 && mode !== 5 && mode !== 6) continue
      const attributes = objOf(prim.attributes)
      if (isObj(objOf(prim.extensions).KHR_draco_mesh_compression) && attributes.POSITION !== undefined &&
        objOf(listOf(json.accessors)[attributes.POSITION as number]).bufferView === undefined) {
        throw new Error('This GLB is Draco-compressed, which ScanRuler does not read. Export it without Draco compression, or as STL, PLY or OBJ.')
      }
      if (attributes.POSITION === undefined) continue
      const pos = readAccessor(store, json, whole(attributes.POSITION, -1, 'an accessor'), [3], 'vertex positions')
      const n = pos.count
      if (vertexTotal + n > MAX_PLACED.vertices) throw new Error('This GLB places more geometry than ScanRuler can open.')
      const corners = prim.indices === undefined
        ? Uint32Array.from({ length: n }, (_, k) => k)
        : readIndices(store, json, whole(prim.indices, -1, 'an accessor'), n)
      const tris = triangleCorners(mode, corners)
      if (!tris || tris.length === 0) continue

      const out = new Float32Array(n * 3)
      const v = pos.data
      for (let k = 0; k < n; k++) {
        const x = v[k * 3], y = v[k * 3 + 1], z = v[k * 3 + 2]
        out[k * 3] = m[0] * x + m[4] * y + m[8] * z + m[12]
        out[k * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13]
        out[k * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14]
      }
      const idx = new Uint32Array(tris.length)
      for (let t = 0; t < tris.length; t += 3) {
        idx[t] = vertexTotal + tris[t]
        idx[t + 1] = vertexTotal + tris[t + (flip ? 2 : 1)]
        idx[t + 2] = vertexTotal + tris[t + (flip ? 1 : 2)]
      }
      positionParts.push(out)
      indexParts.push(idx)
      colourParts.push(primitiveColours(prim, attributes, n))
      vertexTotal += n
    }
  }

  /** Each vertex's colour: base colour factor × vertex colour × texture, in
   *  linear light as glTF has them, written back as sRGB. -1 where the
   *  primitive says nothing of colour. */
  const primitiveColours = (prim: J, attributes: J, n: number): Int32Array => {
    const colours = new Int32Array(n).fill(-1)
    const material = prim.material === undefined ? null : objOf(materials[indexInto(prim.material, materials, 'material')])
    const pbr = objOf(material?.pbrMetallicRoughness)
    const factor = numbers(pbr.baseColorFactor, 4, [1, 1, 1, 1])
    const info = objOf(pbr.baseColorTexture)
    let img: TextureImage | null = null
    let uv: Float32Array | null = null
    let transform: UvTransform | null = null
    if (info.index !== undefined) {
      transform = uvTransformOf(info)
      const set = whole(objOf(objOf(info.extensions).KHR_texture_transform).texCoord ?? info.texCoord, 0, 'a texture coordinate set')
      const source = textureSource(json, whole(info.index, -1, 'a texture'))
      const uvAccessor = attributes[`TEXCOORD_${set}`]
      if (source !== null && uvAccessor !== undefined) {
        img = imageFor(source)
        if (img) uv = readAccessor(store, json, whole(uvAccessor, -1, 'an accessor'), [2], 'texture coordinates').data
        // Fewer coordinates than vertices: the texture cannot be laid on.
        if (uv && uv.length < n * 2) uv = null
      }
    }
    let vertexColour: { data: Float32Array; comps: number } | null = null
    if (attributes.COLOR_0 !== undefined) {
      vertexColour = readAccessor(store, json, whole(attributes.COLOR_0, -1, 'an accessor'), [3, 4], 'vertex colours')
      if (vertexColour.data.length < n * vertexColour.comps) vertexColour = null
    }
    if (!material && !vertexColour) return colours
    const white = factor[0] === 1 && factor[1] === 1 && factor[2] === 1
    const cos = transform ? Math.cos(transform.rotation) : 1
    const sin = transform ? Math.sin(transform.rotation) : 0
    for (let k = 0; k < n; k++) {
      let r = factor[0], g = factor[1], b = factor[2]
      if (vertexColour) {
        const c = vertexColour.comps
        r *= vertexColour.data[k * c]
        g *= vertexColour.data[k * c + 1]
        b *= vertexColour.data[k * c + 2]
      }
      if (img && uv) {
        let u = uv[k * 2], w = uv[k * 2 + 1]
        if (transform) {
          const su = u * transform.scale[0], sw = w * transform.scale[1]
          u = cos * su + sin * sw + transform.offset[0]
          w = -sin * su + cos * sw + transform.offset[1]
        }
        // glTF's v runs down the image, the sampler's (OBJ's) up.
        sampleTexture(img, u, 1 - w, texel, 0)
        if (white && !vertexColour) {
          colours[k] = (texel[0] << 16) | (texel[1] << 8) | texel[2]
          continue
        }
        r *= LINEAR[texel[0]]
        g *= LINEAR[texel[1]]
        b *= LINEAR[texel[2]]
      }
      colours[k] = (toSrgbByte(r) << 16) | (toSrgbByte(g) << 8) | toSrgbByte(b)
    }
    return colours
  }

  const visit = (nodeIndex: number, parent: Mat4, depth: number) => {
    if (depth > MAX_DEPTH) throw new Error('This GLB\'s nodes hold each other in a ring.')
    if (++placed > MAX_PLACED.meshes) throw new Error('This GLB places more objects than ScanRuler can open.')
    const node = objOf(nodes[indexInto(nodeIndex, nodes, 'node')])
    const m = multiply(parent, nodeMatrix(node))
    if (node.mesh !== undefined) placeMesh(whole(node.mesh, -1, 'a mesh'), m)
    for (const child of listOf(node.children)) visit(whole(child, -1, 'a node'), m, depth + 1)
  }

  onProgress?.('Placing the GLB\'s meshes…')
  const scenes = listOf(json.scenes)
  let roots: unknown[]
  if (scenes.length > 0) {
    roots = listOf(objOf(scenes[json.scene === undefined ? 0 : indexInto(json.scene, scenes, 'scene')]).nodes)
  } else {
    // No scene: every node no other node holds.
    const held = new Set(nodes.flatMap((n) => listOf(objOf(n).children)))
    roots = nodes.map((_, i) => i).filter((i) => !held.has(i))
  }
  for (const root of roots) visit(whole(root, -1, 'a node'), TO_SCANRULER, 0)
  if (indexParts.length === 0) {
    // A file of meshes but no scene that places them is read mesh by mesh.
    if (roots.length === 0) meshes.forEach((_, i) => placeMesh(i, TO_SCANRULER))
    if (indexParts.length === 0) throw new Error('This GLB holds no triangles — point clouds are not supported.')
  }

  const positions = concat(positionParts, Float32Array, vertexTotal * 3)
  const corners = concat(indexParts, Uint32Array, indexParts.reduce((s, p) => s + p.length, 0))
  const vertexColour = concat(colourParts, Int32Array, vertexTotal)

  onProgress?.('Joining the GLB\'s seams…')
  const welded = weldExact(positions, corners)
  if (welded.triangles.length === 0) throw new Error('This GLB holds no triangles — point clouds are not supported.')
  const mesh: ParsedMesh = { kind: 'indexed', positions: welded.vertices, indices: welded.triangles }

  // Colour only when it says something: a texture, or more than one colour
  // — an exporter's single default material is not the part's.
  const distinct = new Set<number>()
  for (let v = 0; v < welded.first.length && distinct.size < 2; v++) {
    const c = vertexColour[welded.first[v]]
    if (c >= 0) distinct.add(c)
  }
  if (applied.size > 0 || distinct.size > 1) {
    const colors = new Uint8Array(welded.first.length * 3)
    for (let v = 0; v < welded.first.length; v++) {
      const c = vertexColour[welded.first[v]]
      colors[v * 3] = c >= 0 ? c >> 16 : UNCOLOURED
      colors[v * 3 + 1] = c >= 0 ? (c >> 8) & 0xff : UNCOLOURED
      colors[v * 3 + 2] = c >= 0 ? c & 0xff : UNCOLOURED
    }
    mesh.colors = colors
  }
  if (applied.size > 0) mesh.texture = { kind: 'applied', images: imageLabels(json, applied) }
  return mesh
}

function concat<T extends Float32Array | Uint32Array | Int32Array>(parts: readonly T[], Kind: new (n: number) => T, length: number): T {
  const out = new Kind(length)
  let at = 0
  for (const p of parts) {
    out.set(p as never, at)
    at += p.length
  }
  return out
}
