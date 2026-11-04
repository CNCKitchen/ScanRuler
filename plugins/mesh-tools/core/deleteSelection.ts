// SPDX-License-Identifier: AGPL-3.0-only
import { triangleMask } from './triangleSelection'

export interface DeleteMeshSnapshot {
  positions: Float32Array
  indices: Uint32Array
}

/** Render BVHs reorder faces. Match exact oriented vertex triples, not face numbers. */
export function deletionMask(
  positions: Float32Array,
  indices: Uint32Array,
  preview: DeleteMeshSnapshot,
  triangles: Uint32Array,
): Uint8Array {
  const mismatch = () => new Error('The mesh no longer matches the deletion preview. Nothing was removed; select and preview again.')
  if (positions.length % 3 || indices.length % 3 || positions.length !== preview.positions.length || indices.length !== preview.indices.length) throw mismatch()
  for (let i = 0; i < positions.length; i++) if (positions[i] !== preview.positions[i]) throw mismatch()
  const selected = triangleMask(indices.length / 3, triangles)
  const ordered = (faces: Uint32Array) => {
    const canonical = new Uint32Array(faces.length)
    const order = new Uint32Array(faces.length / 3)
    for (let t = 0; t < order.length; t++) {
      const at = t * 3
      const a = faces[at], b = faces[at + 1], c = faces[at + 2]
      if (a >= positions.length / 3 || b >= positions.length / 3 || c >= positions.length / 3) throw mismatch()
      let first = 0
      for (let k = 1; k < 3; k++) {
        if (faces[at + k] < faces[at + first] ||
            (faces[at + k] === faces[at + first] && faces[at + (k + 1) % 3] < faces[at + (first + 1) % 3])) first = k
      }
      for (let k = 0; k < 3; k++) canonical[at + k] = faces[at + (first + k) % 3]
      order[t] = t
    }
    order.sort((a, b) => {
      for (let k = 0; k < 3; k++) {
        const diff = canonical[a * 3 + k] - canonical[b * 3 + k]
        if (diff) return diff
      }
      return a - b
    })
    return { canonical, order }
  }
  const source = ordered(preview.indices), target = ordered(indices)
  const mask = new Uint8Array(selected.length)
  const same = (a: number, b: number) =>
    source.canonical[a * 3] === source.canonical[b * 3] &&
    source.canonical[a * 3 + 1] === source.canonical[b * 3 + 1] &&
    source.canonical[a * 3 + 2] === source.canonical[b * 3 + 2]
  for (let start = 0; start < selected.length;) {
    let end = start + 1
    while (end < selected.length && same(source.order[start], source.order[end])) end++
    let chosen = 0
    for (let i = start; i < end; i++) {
      const from = source.order[i], to = target.order[i]
      for (let k = 0; k < 3; k++) {
        if (source.canonical[from * 3 + k] !== target.canonical[to * 3 + k]) throw mismatch()
      }
      chosen += selected[from]
    }
    if (chosen !== 0 && chosen !== end - start) {
      throw new Error('The preview selects only some identical duplicate faces. Their identities are ambiguous; nothing was removed.')
    }
    if (chosen) for (let i = start; i < end; i++) mask[target.order[i]] = 1
    start = end
  }
  return mask
}
