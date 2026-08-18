// SPDX-License-Identifier: AGPL-3.0-only
import type { ParsedMesh } from '../types'

interface PlyProperty {
  name: string
  type: string
  isList: boolean
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
  const elements: PlyElement[] = []
  for (const rawLine of header.split('\n')) {
    const parts = rawLine.trim().split(/\s+/)
    if (parts[0] === 'format') format = parts[1]
    else if (parts[0] === 'element') {
      elements.push({ name: parts[1], count: parseInt(parts[2], 10), props: [] })
    } else if (parts[0] === 'property') {
      const el = elements[elements.length - 1]
      if (!el) continue
      if (parts[1] === 'list') {
        el.props.push({ name: parts[4], type: 'list', isList: true, countType: parts[2], itemType: parts[3] })
      } else {
        el.props.push({ name: parts[2], type: parts[1], isList: false })
      }
    }
  }

  const vertexEl = elements.find((e) => e.name === 'vertex')
  const faceEl = elements.find((e) => e.name === 'face')
  if (!vertexEl) throw new Error('PLY file has no vertex element.')
  if (!faceEl || faceEl.count === 0) {
    throw new Error('This PLY contains no faces — point clouds are not supported yet.')
  }

  if (format === 'ascii') return parseAsciiBody(bytes, bodyStart, elements, onProgress)
  const little = format === 'binary_little_endian'
  if (!little && format !== 'binary_big_endian') throw new Error(`Unsupported PLY format "${format}".`)
  return parseBinaryBody(buffer, bodyStart, elements, little, onProgress)
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
  let indices = new Uint32Array(0)

  for (const el of elements) {
    if (el.name === 'vertex') {
      const xi = el.props.findIndex((p) => p.name === 'x')
      const yi = el.props.findIndex((p) => p.name === 'y')
      const zi = el.props.findIndex((p) => p.name === 'z')
      if (xi < 0 || yi < 0 || zi < 0) throw new Error('PLY vertex element is missing x/y/z.')
      const hasList = el.props.some((p) => p.isList)
      positions = new Float32Array(el.count * 3)
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
          if (onProgress && (i & 0xfffff) === 0 && i > 0) {
            onProgress(`Reading PLY vertices… ${Math.round((i / el.count) * 100)}%`)
          }
        }
        off += el.count * stride
      } else {
        for (let i = 0; i < el.count; i++) {
          for (let p = 0; p < el.props.length; p++) {
            const prop = el.props[p]
            if (prop.isList) {
              const n = readScalar(dv, off, prop.countType!, little)
              off += TYPE_SIZE[prop.countType!] + n * TYPE_SIZE[prop.itemType!]
            } else {
              const v = readScalar(dv, off, prop.type, little)
              if (p === xi) positions[i * 3] = v
              else if (p === yi) positions[i * 3 + 1] = v
              else if (p === zi) positions[i * 3 + 2] = v
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
          if (prop.isList) {
            const n = readScalar(dv, off, prop.countType!, little)
            off += TYPE_SIZE[prop.countType!] + n * TYPE_SIZE[prop.itemType!]
            if (prop.name === 'vertex_indices' || prop.name === 'vertex_index') {
              if (n >= 3) triTotal += n - 2
            }
          } else {
            off += TYPE_SIZE[prop.type]
          }
        }
      }
      indices = new Uint32Array(triTotal * 3)
      off = faceStart
      let w = 0
      for (let i = 0; i < el.count; i++) {
        for (const prop of el.props) {
          if (prop.isList) {
            const n = readScalar(dv, off, prop.countType!, little)
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
        if (p.isList) throw new Error(`Cannot skip PLY element "${el.name}" with list properties.`)
        stride += TYPE_SIZE[p.type]
      }
      off += el.count * stride
    }
  }

  if (!positions) throw new Error('PLY file has no vertices.')
  return { kind: 'indexed', positions, indices }
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
  const indices: number[] = []

  for (const el of elements) {
    if (el.name === 'vertex') {
      const xi = el.props.findIndex((p) => p.name === 'x')
      const yi = el.props.findIndex((p) => p.name === 'y')
      const zi = el.props.findIndex((p) => p.name === 'z')
      if (xi < 0 || yi < 0 || zi < 0) throw new Error('PLY vertex element is missing x/y/z.')
      positions = new Float32Array(el.count * 3)
      for (let i = 0; i < el.count; i++) {
        for (let p = 0; p < el.props.length; p++) {
          const prop = el.props[p]
          if (prop.isList) {
            const n = parseInt(tokens[ti++], 10)
            ti += n
          } else {
            const v = parseFloat(tokens[ti++])
            if (p === xi) positions[i * 3] = v
            else if (p === yi) positions[i * 3 + 1] = v
            else if (p === zi) positions[i * 3 + 2] = v
          }
        }
      }
    } else if (el.name === 'face') {
      for (let i = 0; i < el.count; i++) {
        for (const prop of el.props) {
          if (prop.isList) {
            const n = parseInt(tokens[ti++], 10)
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
          if (prop.isList) {
            const n = parseInt(tokens[ti++], 10)
            ti += n
          } else {
            ti++
          }
        }
      }
    }
  }

  if (!positions) throw new Error('PLY file has no vertices.')
  return { kind: 'indexed', positions, indices: Uint32Array.from(indices) }
}
