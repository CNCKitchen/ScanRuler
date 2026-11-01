// SPDX-License-Identifier: AGPL-3.0-only
// PLY in all three encodings — ASCII, and binary of either byte order — read
// for vertex positions, per-vertex colours and face lists; normals and the
// other properties a scanner writes are stepped over. One header comment is
// honoured besides: a file that says its winding is settled
// (PLY_KEEP_WINDING) keeps it as written instead of having it guessed again.

import type { ParsedMesh } from '../types'

interface PlyProperty {
  name: string
  type: string
  list: boolean
  countType?: string
  itemType?: string
}

interface PlyElement {
  name: string
  count: number
  props: PlyProperty[]
}

const TYPE_SIZE: Record<string, number> = {
  char: 1, int8: 1, uchar: 1, uint8: 1,
  short: 2, int16: 2, ushort: 2, uint16: 2,
  int: 4, int32: 4, uint: 4, uint32: 4,
  float: 4, float32: 4, double: 8, float64: 8,
}

/**
 * The header comment by which a PLY says its triangles already face the way
 * they are meant to — written by ScanRuler for a mesh it read once and had
 * the winding of settled then. Read back, the winding is kept as written
 * instead of guessed again (see geometry/normals): a piece of a part, open
 * on every side — the top of a round wall with its inner face — can look
 * inside-out to the guess although it is not.
 */
export const PLY_KEEP_WINDING = 'ScanRuler: keep winding'

function checkType(type: string | undefined): void {
  if (type === undefined || !Object.hasOwn(TYPE_SIZE, type)) throw new Error(`Unsupported PLY type "${type}".`)
}

/** Where an element's colour properties sit, under the names scanners and
 *  MeshLab write them; null when any of the three is missing. */
function colorProps(el: PlyElement): [number, number, number] | null {
  const find = (names: string[]) => el.props.findIndex((p) => !p.list && names.includes(p.name))
  const r = find(['red', 'r', 'diffuse_red'])
  const g = find(['green', 'g', 'diffuse_green'])
  const b = find(['blue', 'b', 'diffuse_blue'])
  return r < 0 || g < 0 || b < 0 ? null : [r, g, b]
}

/** A colour channel as a byte: floats run 0…1, integer types 0…255. */
function channel(v: number, type: string): number {
  const byte = type.startsWith('float') || type === 'double' ? v * 255 : v
  return Math.max(0, Math.min(255, Math.round(byte)))
}

/** Puts the colours on the mesh when they say something: as for 3MF, a
 *  single colour on every vertex is an exporter's default, not the part's. */
function withColors(mesh: ParsedMesh, colors: Uint8Array | null): ParsedMesh {
  if (!colors) return mesh
  for (let i = 3; i < colors.length; i++) {
    if (colors[i] !== colors[i % 3]) {
      mesh.colors = colors
      break
    }
  }
  return mesh
}

/** The fewest bytes one item of the element can take: its fixed properties
 *  and the count of each list, with every list empty. */
function minStride(el: PlyElement): number {
  let stride = 0
  for (const p of el.props) stride += TYPE_SIZE[p.list ? p.countType! : p.type]
  return stride
}

/** Refuses an element the rest of the file cannot hold. Checked before the
 *  element is read, so a header count no file backs up allocates nothing,
 *  and an element with no properties cannot loop on without reading. */
function checkRoom(el: PlyElement, perItem: number, left: number): void {
  if (el.count > 0 && perItem === 0) throw new Error(`PLY element "${el.name}" has a count but no properties.`)
  if (el.count * perItem > left) throw new Error(`PLY element "${el.name}" counts more items than the file holds.`)
}

/** A list length; a negative one would step the reading backwards. */
function listLength(n: number): number {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`Invalid PLY list length ${n}.`)
  return n
}

function readScalar(dv: DataView, off: number, type: string, little: boolean): number {
  switch (type) {
    case 'char': case 'int8': return dv.getInt8(off)
    case 'uchar': case 'uint8': return dv.getUint8(off)
    case 'short': case 'int16': return dv.getInt16(off, little)
    case 'ushort': case 'uint16': return dv.getUint16(off, little)
    case 'int': case 'int32': return dv.getInt32(off, little)
    case 'uint': case 'uint32': return dv.getUint32(off, little)
    case 'float': case 'float32': return dv.getFloat32(off, little)
    case 'double': case 'float64': return dv.getFloat64(off, little)
    default: throw new Error(`Unsupported PLY type "${type}".`)
  }
}

export function parsePLY(buffer: ArrayBuffer, onProgress?: (text: string) => void): ParsedMesh {
  const bytes = new Uint8Array(buffer)
  // Locate "end_header" plus its newline in the raw bytes. The body offset
  // must not come from decoded text: a multi-byte character in a comment
  // would put every character index off its byte.
  const headerLimit = Math.min(bytes.length, 64 * 1024)
  const endTag = indexOfAscii(bytes, 'end_header', headerLimit)
  const isPly = bytes[0] === 0x70 && bytes[1] === 0x6c && bytes[2] === 0x79
  if (!isPly || endTag < 0) throw new Error('Not a valid PLY file.')
  let bodyStart = endTag
  while (bodyStart < headerLimit && bytes[bodyStart] !== 0x0a) bodyStart++
  bodyStart++
  const header = new TextDecoder().decode(bytes.subarray(0, endTag))

  let format = ''
  let keepWinding = false
  const elements: PlyElement[] = []
  for (const rawLine of header.split('\n')) {
    const parts = rawLine.trim().split(/\s+/)
    if (parts[0] === 'format') format = parts[1]
    else if (parts[0] === 'comment') {
      if (parts.slice(1).join(' ') === PLY_KEEP_WINDING) keepWinding = true
    } else if (parts[0] === 'element') {
      // The counts drive every loop and allocation below, so a sign, a
      // fraction or a number past safe integers is refused here.
      const count = Number(parts[2])
      if (!/^\d+$/.test(parts[2] ?? '') || !Number.isSafeInteger(count)) {
        throw new Error(`PLY element "${parts[1]}" has an invalid count "${parts[2]}".`)
      }
      elements.push({ name: parts[1], count, props: [] })
    } else if (parts[0] === 'property') {
      const el = elements[elements.length - 1]
      if (!el) continue
      // Every type is checked against the table here: an unknown one would
      // give NaN strides and offsets, which DataView reads as offset 0, so
      // the file would turn into garbage geometry rather than an error.
      if (parts[1] === 'list') {
        checkType(parts[2])
        checkType(parts[3])
        if (/^(float|double)/.test(parts[2])) throw new Error(`PLY list count type "${parts[2]}" is not an integer type.`)
        el.props.push({ name: parts[4], type: 'list', list: true, countType: parts[2], itemType: parts[3] })
      } else {
        checkType(parts[1])
        el.props.push({ name: parts[2], type: parts[1], list: false })
      }
    }
  }

  const vertexEl = elements.find((e) => e.name === 'vertex')
  const faceEl = elements.find((e) => e.name === 'face')
  if (!vertexEl) throw new Error('PLY file has no vertex element.')
  if (!faceEl || faceEl.count === 0) {
    throw new Error('This PLY contains no faces — point clouds are not supported yet.')
  }

  const little = format === 'binary_little_endian'
  if (format !== 'ascii' && !little && format !== 'binary_big_endian') throw new Error(`Unsupported PLY format "${format}".`)
  const mesh = format === 'ascii'
    ? parseAsciiBody(bytes, bodyStart, elements, onProgress)
    : parseBinaryBody(buffer, bodyStart, elements, little, onProgress)
  if (keepWinding) mesh.keepWinding = true
  return mesh
}

function indexOfAscii(bytes: Uint8Array, needle: string, limit: number): number {
  outer: for (let i = 0; i + needle.length <= limit; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (bytes[i + j] !== needle.charCodeAt(j)) continue outer
    }
    return i
  }
  return -1
}

function parseBinaryBody(
  buffer: ArrayBuffer,
  bodyStart: number,
  elements: PlyElement[],
  little: boolean,
  onProgress?: (text: string) => void,
): ParsedMesh {
  const dv = new DataView(buffer)
  let off = bodyStart
  let positions: Float32Array | null = null
  let colors: Uint8Array | null = null
  let indices = new Uint32Array(0)

  for (const el of elements) {
    checkRoom(el, minStride(el), buffer.byteLength - off)
    if (el.name === 'vertex') {
      const xi = el.props.findIndex((p) => p.name === 'x')
      const yi = el.props.findIndex((p) => p.name === 'y')
      const zi = el.props.findIndex((p) => p.name === 'z')
      if (xi < 0 || yi < 0 || zi < 0) throw new Error('PLY vertex element is missing x/y/z.')
      const hasList = el.props.some((p) => p.list)
      positions = new Float32Array(el.count * 3)
      const rgb = colorProps(el)
      if (rgb) colors = new Uint8Array(el.count * 3)
      if (!hasList) {
        // Fixed stride fast path.
        let stride = 0
        const offsets: number[] = []
        for (const p of el.props) {
          offsets.push(stride)
          stride += TYPE_SIZE[p.type]
        }
        for (let i = 0; i < el.count; i++) {
          const base = off + i * stride
          positions[i * 3] = readScalar(dv, base + offsets[xi], el.props[xi].type, little)
          positions[i * 3 + 1] = readScalar(dv, base + offsets[yi], el.props[yi].type, little)
          positions[i * 3 + 2] = readScalar(dv, base + offsets[zi], el.props[zi].type, little)
          if (rgb) {
            for (let c = 0; c < 3; c++) {
              const type = el.props[rgb[c]].type
              colors![i * 3 + c] = channel(readScalar(dv, base + offsets[rgb[c]], type, little), type)
            }
          }
          if (onProgress && (i & 0xfffff) === 0 && i > 0) {
            onProgress(`Reading PLY vertices… ${Math.round((i / el.count) * 100)}%`)
          }
        }
        off += el.count * stride
      } else {
        for (let i = 0; i < el.count; i++) {
          for (let p = 0; p < el.props.length; p++) {
            const prop = el.props[p]
            if (prop.list) {
              const n = listLength(readScalar(dv, off, prop.countType!, little))
              off += TYPE_SIZE[prop.countType!] + n * TYPE_SIZE[prop.itemType!]
            } else {
              const v = readScalar(dv, off, prop.type, little)
              if (p === xi) positions[i * 3] = v
              else if (p === yi) positions[i * 3 + 1] = v
              else if (p === zi) positions[i * 3 + 2] = v
              else if (rgb && rgb.includes(p)) colors![i * 3 + rgb.indexOf(p)] = channel(v, prop.type)
              off += TYPE_SIZE[prop.type]
            }
          }
        }
      }
    } else if (el.name === 'face') {
      // Two passes: total the triangles first, then fill an exact-size index
      // buffer. A scan-sized file fans out to tens of millions of indices,
      // which a growing JS number array both crawls through and triples in
      // memory. The sizing pass only touches each face's list count.
      const faceStart = off
      let triTotal = 0
      for (let i = 0; i < el.count; i++) {
        for (const prop of el.props) {
          if (prop.list) {
            const n = listLength(readScalar(dv, off, prop.countType!, little))
            off += TYPE_SIZE[prop.countType!] + n * TYPE_SIZE[prop.itemType!]
            if (prop.name === 'vertex_indices' || prop.name === 'vertex_index') {
              if (n >= 3) triTotal += n - 2
            }
          } else {
            off += TYPE_SIZE[prop.type]
          }
        }
      }
      if (off > buffer.byteLength) throw new Error('PLY face lists run past the end of the file.')
      indices = new Uint32Array(triTotal * 3)
      off = faceStart
      let w = 0
      for (let i = 0; i < el.count; i++) {
        for (const prop of el.props) {
          if (prop.list) {
            const n = listLength(readScalar(dv, off, prop.countType!, little))
            off += TYPE_SIZE[prop.countType!]
            const itemSize = TYPE_SIZE[prop.itemType!]
            if (prop.name === 'vertex_indices' || prop.name === 'vertex_index') {
              const first = readScalar(dv, off, prop.itemType!, little)
              let prev = readScalar(dv, off + itemSize, prop.itemType!, little)
              for (let k = 2; k < n; k++) {
                const cur = readScalar(dv, off + k * itemSize, prop.itemType!, little)
                indices[w] = first
                indices[w + 1] = prev
                indices[w + 2] = cur
                w += 3
                prev = cur
              }
            }
            off += n * itemSize
          } else {
            off += TYPE_SIZE[prop.type]
          }
        }
        if (onProgress && (i & 0xfffff) === 0 && i > 0) {
          onProgress(`Reading PLY faces… ${Math.round((i / el.count) * 100)}%`)
        }
      }
    } else {
      // Skip unknown elements (only possible when fixed-size).
      let stride = 0
      for (const p of el.props) {
        if (p.list) throw new Error(`Cannot skip PLY element "${el.name}" with list properties.`)
        stride += TYPE_SIZE[p.type]
      }
      off += el.count * stride
    }
  }

  if (!positions) throw new Error('PLY file has no vertices.')
  return withColors({ kind: 'indexed', positions, indices }, colors)
}

function parseAsciiBody(
  bytes: Uint8Array,
  bodyStart: number,
  elements: PlyElement[],
  onProgress?: (text: string) => void,
): ParsedMesh {
  onProgress?.('Reading PLY…')
  const body = new TextDecoder().decode(bytes.subarray(bodyStart))
  const tokens = body.split(/\s+/).filter((t) => t.length > 0)
  let ti = 0
  let positions: Float32Array | null = null
  let colors: Uint8Array | null = null
  const indices: number[] = []

  for (const el of elements) {
    // In text every property takes at least one token.
    checkRoom(el, el.props.length, tokens.length - ti)
    if (el.name === 'vertex') {
      const xi = el.props.findIndex((p) => p.name === 'x')
      const yi = el.props.findIndex((p) => p.name === 'y')
      const zi = el.props.findIndex((p) => p.name === 'z')
      if (xi < 0 || yi < 0 || zi < 0) throw new Error('PLY vertex element is missing x/y/z.')
      positions = new Float32Array(el.count * 3)
      const rgb = colorProps(el)
      if (rgb) colors = new Uint8Array(el.count * 3)
      for (let i = 0; i < el.count; i++) {
        for (let p = 0; p < el.props.length; p++) {
          const prop = el.props[p]
          if (prop.list) {
            const n = listLength(parseInt(tokens[ti++], 10))
            ti += n
          } else {
            const v = parseFloat(tokens[ti++])
            if (p === xi) positions[i * 3] = v
            else if (p === yi) positions[i * 3 + 1] = v
            else if (p === zi) positions[i * 3 + 2] = v
            else if (rgb && rgb.includes(p)) colors![i * 3 + rgb.indexOf(p)] = channel(v, prop.type)
          }
        }
      }
    } else if (el.name === 'face') {
      for (let i = 0; i < el.count; i++) {
        for (const prop of el.props) {
          if (prop.list) {
            const n = listLength(parseInt(tokens[ti++], 10))
            if (prop.name === 'vertex_indices' || prop.name === 'vertex_index') {
              const first = parseInt(tokens[ti], 10)
              for (let k = 2; k < n; k++) {
                indices.push(first, parseInt(tokens[ti + k - 1], 10), parseInt(tokens[ti + k], 10))
              }
            }
            ti += n
          } else {
            ti++
          }
        }
      }
    } else {
      for (let i = 0; i < el.count; i++) {
        for (const prop of el.props) {
          if (prop.list) {
            const n = listLength(parseInt(tokens[ti++], 10))
            ti += n
          } else {
            ti++
          }
        }
      }
    }
    if (ti > tokens.length) throw new Error(`PLY element "${el.name}" runs past the end of the file.`)
  }

  if (!positions) throw new Error('PLY file has no vertices.')
  return withColors({ kind: 'indexed', positions, indices: Uint32Array.from(indices) }, colors)
}
