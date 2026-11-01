// SPDX-License-Identifier: AGPL-3.0-only
// Wavefront OBJ, read as far as a scan needs it: vertex positions, faces
// fanned into triangles from their first corner, and — for a scan that
// captured colour — the texture coordinates, materials and material
// libraries that give each vertex its colour (see objTexture). The file's
// normals and groups are passed over — normals are worked out afresh from
// the mesh — and a file with no faces is refused, as point clouds are not
// supported. Read a line at a time, as a large one is too long to hold as text.

import type { ParsedMesh } from '../types'
import { bakeObjTexture, mtllibNames, type ObjCompanions } from './objTexture'
import { eachLine, gatherFloats, gatherIndices } from './textChunks'

export function parseOBJ(buffer: ArrayBuffer, onProgress?: (text: string) => void, companions?: ObjCompanions): ParsedMesh {
  onProgress?.('Reading OBJ…')
  const coords = gatherFloats()
  const indices = gatherIndices()
  const uvs: number[] = []
  // Per vertex, the texture coordinate and material of its first textured
  // corner; filled in as faces name them, so sized when the reading is done.
  const vertexUv: number[] = []
  const vertexMaterial: number[] = []
  const materialNames: string[] = []
  const materialIndex = new Map<string, number>()
  const libraries: string[] = []
  let material = -1

  const readLine = (raw: string, li: number) => {
    const hash = raw.indexOf('#')
    const line = (hash < 0 ? raw : raw.slice(0, hash)).trim()
    if (line.length < 3) return
    const c0 = line.charCodeAt(0)
    const c1 = line.charCodeAt(1)
    const sep = c1 === 32 /* space */ || c1 === 9 /* tab */
    if (c0 === 118 /* v */ && sep) {
      const parts = line.split(/\s+/)
      const x = Number(parts[1])
      const y = Number(parts[2])
      const z = Number(parts[3])
      if (parts.length < 4 || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) throw new Error(`Invalid OBJ vertex on line ${li + 1}.`)
      coords.push3(x, y, z)
    } else if (c0 === 118 /* v */ && c1 === 116 /* t */ && (line.charCodeAt(2) === 32 || line.charCodeAt(2) === 9)) {
      const parts = line.split(/\s+/)
      const u = Number(parts[1])
      const v = parts.length > 2 ? Number(parts[2]) : 0
      uvs.push(Number.isFinite(u) ? u : 0, Number.isFinite(v) ? v : 0)
    } else if (c0 === 102 /* f */ && sep) {
      const parts = line.split(/\s+/)
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
        indices.push3(face[0], face[k - 1], face[k])
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
  }
  eachLine(new Uint8Array(buffer), readLine, (done) => onProgress?.(`Reading OBJ… ${Math.round(done * 100)}%`))

  if (coords.length === 0) throw new Error('OBJ file has no vertices.')
  if (indices.length === 0) throw new Error('This OBJ contains no faces — point clouds are not supported yet.')
  const n = coords.length / 3
  const mesh: ParsedMesh = { kind: 'indexed', positions: coords.take(), indices: indices.take() }

  if (uvs.length > 0) {
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
