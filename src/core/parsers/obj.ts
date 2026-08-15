// SPDX-License-Identifier: AGPL-3.0-only
import type { ParsedMesh } from '../types'

export function parseOBJ(buffer: ArrayBuffer, onProgress?: (text: string) => void): ParsedMesh {
  onProgress?.('Reading OBJ…')
  const text = new TextDecoder().decode(buffer)
  const coords: number[] = []
  const indices: number[] = []

  const lines = text.split('\n')
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]
    if (line.length < 3) continue
    const c0 = line.charCodeAt(0)
    if (c0 === 118 /* v */ && line.charCodeAt(1) === 32) {
      const parts = line.trim().split(/\s+/)
      coords.push(parseFloat(parts[1]), parseFloat(parts[2]), parseFloat(parts[3]))
    } else if (c0 === 102 /* f */ && line.charCodeAt(1) === 32) {
      const parts = line.trim().split(/\s+/)
      const vcount = coords.length / 3
      const face: number[] = []
      for (let i = 1; i < parts.length; i++) {
        // "12/34/56" → 12; negative indices are relative to the current count
        const idx = parseInt(parts[i], 10)
        if (Number.isNaN(idx)) continue
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
