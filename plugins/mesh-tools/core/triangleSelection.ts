// SPDX-License-Identifier: AGPL-3.0-only

export function triangleMask(triangleCount: number, triangles: Uint32Array): Uint8Array {
  const mask = new Uint8Array(triangleCount)
  for (const t of triangles) {
    if (t >= triangleCount) throw new Error(`The mesh has no triangle ${t}.`)
    mask[t] = 1
  }
  return mask
}

export function selectedTriangles(mask: Uint8Array): Uint32Array {
  const out = new Uint32Array(mask.reduce((n, v) => n + v, 0))
  let at = 0
  for (let t = 0; t < mask.length; t++) if (mask[t]) out[at++] = t
  return out
}

/** Shared-edge transitions and selected open rims, not geometric intersections. */
export function selectionBoundary(indices: Uint32Array, vertexCount: number, mask: Uint8Array): Uint32Array {
  if (mask.length * 3 !== indices.length) throw new Error('The selection belongs to a different mesh.')
  if (vertexCount * vertexCount * 2 > Number.MAX_SAFE_INTEGER) throw new Error('The mesh is too large to index selection edges safely.')
  // Packed, sorted edges avoid millions of individually allocated map entries.
  const edges = new Float64Array(indices.length)
  for (let t = 0; t < mask.length; t++) {
    for (let k = 0; k < 3; k++) {
      const a = indices[t * 3 + k], b = indices[t * 3 + (k + 1) % 3]
      edges[t * 3 + k] = (Math.min(a, b) * vertexCount + Math.max(a, b)) * 2 + mask[t]
    }
  }
  edges.sort()
  const boundary: number[] = []
  for (let start = 0; start < edges.length;) {
    const key = Math.floor(edges[start] / 2)
    let end = start + 1
    while (end < edges.length && Math.floor(edges[end] / 2) === key) end++
    const selected = edges[end - 1] % 2 === 1
    const unselected = edges[start] % 2 === 0
    if (selected && (unselected || end - start === 1)) boundary.push(Math.floor(key / vertexCount), key % vertexCount)
    start = end
  }
  return Uint32Array.from(boundary)
}

export function visibleTriangles(pixels: Uint8Array, triangleCount: number): Uint8Array {
  const mask = new Uint8Array(triangleCount)
  for (let i = 0; i < pixels.length; i += 4) {
    const id = pixels[i] + pixels[i + 1] * 256 + pixels[i + 2] * 65536 + pixels[i + 3] * 16777216
    if (id > 0 && id <= triangleCount) mask[id - 1] = 1
  }
  return mask
}
