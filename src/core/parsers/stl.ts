// SPDX-License-Identifier: AGPL-3.0-only
import type { ParsedMesh } from '../types'

/** Binary if the byte length matches the triangle count in the header;
 *  some binary files start with "solid", so the size check comes first. */
export function parseSTL(buffer: ArrayBuffer, onProgress?: (text: string) => void): ParsedMesh {
  if (buffer.byteLength >= 84) {
    const dv = new DataView(buffer)
    const triCount = dv.getUint32(80, true)
    if (84 + triCount * 50 === buffer.byteLength) return parseBinary(dv, triCount, onProgress)
  }
  const head = new TextDecoder().decode(new Uint8Array(buffer, 0, Math.min(512, buffer.byteLength)))
  if (/^\s*solid/.test(head)) return parseAscii(buffer, onProgress)
  if (buffer.byteLength >= 84) {
    const dv = new DataView(buffer)
    return parseBinary(dv, Math.floor((buffer.byteLength - 84) / 50), onProgress)
  }
  throw new Error('Not a valid STL file.')
}

function parseBinary(dv: DataView, triCount: number, onProgress?: (text: string) => void): ParsedMesh {
  const positions = new Float32Array(triCount * 9)
  let off = 84
  let k = 0
  for (let t = 0; t < triCount; t++) {
    off += 12 // skip facet normal
    for (let v = 0; v < 9; v++) {
      positions[k++] = dv.getFloat32(off, true)
      off += 4
    }
    off += 2 // attribute byte count
    if (onProgress && (t & 0x3ffff) === 0 && t > 0) {
      onProgress(`Reading STL… ${Math.round((t / triCount) * 100)}%`)
    }
  }
  return { kind: 'soup', positions }
}

function parseAscii(buffer: ArrayBuffer, onProgress?: (text: string) => void): ParsedMesh {
  onProgress?.('Reading STL…')
  const text = new TextDecoder().decode(buffer)
  const re = /vertex\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)/g
  const coords: number[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    coords.push(parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]))
  }
  if (coords.length === 0 || coords.length % 9 !== 0) {
    throw new Error('Could not read triangles from ASCII STL.')
  }
  return { kind: 'soup', positions: Float32Array.from(coords) }
}
