// SPDX-License-Identifier: AGPL-3.0-only
// Wavefront OBJ, read as far as a scan needs it: vertex positions, faces
// fanned into triangles from their first corner, the per-vertex colours of
// the common "v x y z r g b" extension, and — for a scan that captured
// colour as a texture — the texture coordinates, materials and material
// libraries that give each vertex its colour (see objTexture). The file's
// normals and groups are passed over — normals are worked out afresh from
// the mesh — and a file with no faces is refused, as point clouds are not
// supported.

import type { ParsedMesh } from '../types'
import { bakeObjTexture, mtllibNames, type ObjCompanions } from './objTexture'

export function parseOBJ(buffer: ArrayBuffer, onProgress?: (text: string) => void, companions?: ObjCompanions): ParsedMesh {
  onProgress?.('Reading OBJ…')
  const text = new TextDecoder().decode(buffer)
  const coords: number[] = []
  // Per vertex, the colour the "v x y z r g b" extension gives it, or -1.
  const vertexColor: number[] = []
  let colored = false
  const indices: number[] = []
  const uvs: number[] = []
  // Per vertex, the texture coordinate and material of its first textured
  // corner; filled in as faces name them, so sized when the reading is done.
  const vertexUv: number[] = []
  const vertexMaterial: number[] = []
  const materialNames: string[] = []
  const materialIndex = new Map<string, number>()
  const libraries: string[] = []
  let material = -1

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
      const rgb = parts.length >= 7 ? parts.slice(4, 7).map(Number) : null
      if (rgb && rgb.every(Number.isFinite)) {
        vertexColor.push(...rgb)
        colored = true
      } else {
        vertexColor.push(-1, -1, -1)
      }
    } else if (c0 === 118 /* v */ && c1 === 116 /* t */ && (line.charCodeAt(2) === 32 || line.charCodeAt(2) === 9)) {
      const parts = line.split(/\s+/)
      const u = Number(parts[1])
      const v = parts.length > 2 ? Number(parts[2]) : 0
      uvs.push(Number.isFinite(u) ? u : 0, Number.isFinite(v) ? v : 0)
    } else if (c0 === 102 /* f */ && sep) {
      const parts = line.trim().split(/\s+/)
      const vcount = coords.length / 3
      const tcount = uvs.length / 2
      const face: number[] = []
      for (let i = 1; i < parts.length; i++) {
        // "12/34/56" → 12; negative indices are relative to the current count
        const fields = parts[i].split('/')
        const token = fields[0]
        const idx = Number(token)
        if (!/^-?\d+$/.test(token) || !Number.isSafeInteger(idx) || idx === 0 || idx > 0xffffffff || idx < -vcount) {
          throw new Error(`Invalid OBJ face index on line ${li + 1}.`)
        }
        const vi = idx < 0 ? vcount + idx : idx - 1
        face.push(vi)
        // The corner's texture coordinate, the first time the vertex has one.
        if (fields.length > 1 && fields[1] !== '' && vertexUv[vi] === undefined) {
          const t = Number(fields[1])
          const ti = t < 0 ? tcount + t : t - 1
          if (Number.isSafeInteger(t) && ti >= 0 && ti < tcount) {
            vertexUv[vi] = ti
            vertexMaterial[vi] = material
          }
        }
      }
      for (let k = 2; k < face.length; k++) {
        indices.push(face[0], face[k - 1], face[k])
      }
    } else if (line.startsWith('usemtl')) {
      const name = line.slice(6).trim()
      let m = materialIndex.get(name)
      if (m === undefined) {
        m = materialNames.length
        materialNames.push(name)
        materialIndex.set(name, m)
      }
      material = m
    } else if (line.startsWith('mtllib')) {
      libraries.push(...mtllibNames(line.slice(6)))
    }
    if (onProgress && (li & 0xfffff) === 0 && li > 0) {
      onProgress(`Reading OBJ… ${Math.round((li / lines.length) * 100)}%`)
    }
  }

  if (coords.length === 0) throw new Error('OBJ file has no vertices.')
  if (indices.length === 0) throw new Error('This OBJ contains no faces — point clouds are not supported yet.')
  const mesh: ParsedMesh = { kind: 'indexed', positions: Float32Array.from(coords), indices: Uint32Array.from(indices) }

  if (colored) {
    // Colours run 0…1 as most writers put them; a file with any channel
    // above 1 is taken to write bytes instead. A vertex without one is grey.
    const scale = vertexColor.some((c) => c > 1) ? 1 : 255
    const colors = new Uint8Array(vertexColor.length)
    for (let i = 0; i < vertexColor.length; i++) {
      const c = vertexColor[i]
      colors[i] = c < 0 ? 180 : Math.max(0, Math.min(255, Math.round(c * scale)))
    }
    // As for 3MF, one colour on every vertex is an exporter's default.
    if (colors.some((c, i) => c !== colors[i % 3])) mesh.colors = colors
  }

  if (uvs.length > 0) {
    const n = coords.length / 3
    const uvOf = new Int32Array(n).fill(-1)
    const materialOf = new Int32Array(n).fill(-1)
    for (let v = 0; v < n; v++) {
      if (vertexUv[v] === undefined) continue
      uvOf[v] = vertexUv[v]
      materialOf[v] = vertexMaterial[v]
    }
    if (companions?.images.length) onProgress?.('Colouring the scan from its texture…')
    const baked = bakeObjTexture({ uvs, vertexUv: uvOf, vertexMaterial: materialOf, materialNames, libraries }, companions)
    if (baked) {
      if (baked.colors) mesh.colors = baked.colors
      mesh.texture = baked.note
    }
  }
  return mesh
}
