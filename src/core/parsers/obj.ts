// SPDX-License-Identifier: AGPL-3.0-only
import type { ParsedMesh } from '../types'

export function parseOBJ(buffer: ArrayBuffer, onProgress?: (text: string) => void): ParsedMesh {
  onProgress?.('Reading OBJ…')
  const text = new TextDecoder().decode(buffer)
  const coords: number[] = []
  const indices: number[] = []

  const lines = text.split('\n')
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li].split('#', 1)[0].trim()
    if (line.length < 3) continue
    const c0 = line.charCodeAt(0)
    const c1 = line.charCodeAt(1)
    const sep = c1 === 32 /* space */ || c1 === 9 /* tab */
    if (c0 === 118 /* v */ && sep) {
      const parts = line.trim().split(/\s+/)
      const xyz = parts.slice(1, 4).map(Number)
      if (xyz.length !== 3 || !xyz.every(Number.isFinite)) throw new Error(`Invalid OBJ vertex on line ${li + 1}.`)
      coords.push(...xyz)
    } else if (c0 === 102 /* f */ && sep) {
      const parts = line.trim().split(/\s+/)
      const vcount = coords.length / 3
      const face: number[] = []
      for (let i = 1; i < parts.length; i++) {
        // "12/34/56" → 12; negative indices are relative to the current count
        const token = parts[i].split('/')[0]
        const idx = Number(token)
        if (!/^-?\d+$/.test(token) || !Number.isSafeInteger(idx) || idx === 0 || idx > 0xffffffff || idx < -vcount) {
          throw new Error(`Invalid OBJ face index on line ${li + 1}.`)
        }
        face.push(idx < 0 ? vcount + idx : idx - 1)
      }
      for (let k = 2; k < face.length; k++) {
        indices.push(face[0], face[k - 1], face[k])
      }
    }
    if (onProgress && (li & 0xfffff) === 0 && li > 0) {
      onProgress(`Reading OBJ… ${Math.round((li / lines.length) * 100)}%`)
    }
  }

  if (coords.length === 0) throw new Error('OBJ file has no vertices.')
  if (indices.length === 0) throw new Error('This OBJ contains no faces — point clouds are not supported yet.')
  return { kind: 'indexed', positions: Float32Array.from(coords), indices: Uint32Array.from(indices) }
}
