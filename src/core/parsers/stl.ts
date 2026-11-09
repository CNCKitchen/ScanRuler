// SPDX-License-Identifier: AGPL-3.0-only
// STL, binary or ASCII, read as the triangle soup it is — nine floats a
// triangle, each corner written out again for every face that meets there —
// and left to geometry/weld.ts to join up. The file's facet normals are
// skipped; the normals are worked out from the welded mesh instead.

import type { ParsedMesh } from '../types'
import { gatherFloats, textPieces } from './textChunks'

/** Binary if the byte length matches the triangle count in the header;
 *  some binary files start with "solid", so the size check comes first.
 *  Past that, a file starting "solid" is ASCII only if it reads as text
 *  (looksAscii): a binary file whose exporter wrote "solid" into its header
 *  and padded the end, or left bytes after the last triangle, was read as
 *  ASCII and came out with no triangles. */
export function parseSTL(buffer: ArrayBuffer, onProgress?: (text: string) => void): ParsedMesh {
  if (buffer.byteLength >= 84) {
    const dv = new DataView(buffer)
    const triCount = dv.getUint32(80, true)
    if (84 + triCount * 50 === buffer.byteLength) return parseBinary(dv, triCount, onProgress)
  }
  const head = new TextDecoder().decode(new Uint8Array(buffer, 0, Math.min(512, buffer.byteLength)))
  if (/^\s*solid/.test(head) && looksAscii(buffer)) return parseAscii(buffer, onProgress)
  if (buffer.byteLength >= 84) {
    const dv = new DataView(buffer)
    // The count the header gives, where the file holds that many: anything
    // after them is padding. Else as many as the bytes hold.
    const declared = dv.getUint32(80, true)
    const fits = Math.floor((buffer.byteLength - 84) / 50)
    return parseBinary(dv, declared > 0 && declared <= fits ? declared : fits, onProgress)
  }
  throw new Error('Not a valid STL file.')
}

/** Whether a file starting "solid" goes on as ASCII STL: no control bytes
 *  in its first kilobyte, with a facet or the end of the solid in it. A
 *  binary file's triangle count, coordinates and attribute bytes from byte
 *  80 on hold zeros and other control bytes no text has; a solid's name in
 *  UTF-8 does not. */
function looksAscii(buffer: ArrayBuffer): boolean {
  const bytes = new Uint8Array(buffer, 0, Math.min(1024, buffer.byteLength))
  for (const b of bytes) {
    if ((b < 32 && b !== 9 && b !== 10 && b !== 13) || b === 127) return false
  }
  const text = new TextDecoder().decode(bytes)
  return /\bfacet\b|\bendsolid\b/.test(text) || bytes.length < 84
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
  // A piece at a time, as a large file is too long to hold as text. The last
  // number must have a space after it: without one the piece may have cut it.
  const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)(?=\s)/g
  const coords = gatherFloats()
  let tail = ''
  const read = (text: string) => {
    let end = 0
    let m: RegExpExecArray | null
    re.lastIndex = 0
    while ((m = re.exec(text)) !== null) {
      coords.push3(parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]))
      end = re.lastIndex
    }
    // What the next piece may finish: no line of a facet is longer than this.
    tail = text.slice(Math.max(end, text.length - 4096))
  }
  for (const { text, done } of textPieces(new Uint8Array(buffer))) {
    read(tail + text)
    onProgress?.(`Reading STL… ${Math.round(done * 100)}%`)
  }
  read(tail + '\n')
  if (coords.length === 0 || coords.length % 9 !== 0) {
    throw new Error('Could not read triangles from ASCII STL.')
  }
  return { kind: 'soup', positions: coords.take() }
}
