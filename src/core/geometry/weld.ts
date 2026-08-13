/** Merge duplicated vertices of an STL triangle soup into an indexed mesh.
 *  Vertices are matched on exact float bit patterns via an open-addressing
 *  hash table (binary STL repeats vertices bit-identically). */
export function weldTriangleSoup(
  soup: Float32Array,
  onProgress?: (text: string) => void,
): { positions: Float32Array; indices: Uint32Array } {
  const vertCount = soup.length / 3
  const bits = new Uint32Array(soup.buffer, soup.byteOffset, soup.length)

  let cap = 16
  while (cap < vertCount * 2) cap <<= 1
  const mask = cap - 1
  const table = new Int32Array(cap).fill(-1)

  const indices = new Uint32Array(vertCount)
  const outPos = new Float32Array(soup.length)
  const outBits = new Uint32Array(outPos.buffer)
  let outCount = 0

  for (let i = 0; i < vertCount; i++) {
    const j = i * 3
    const bx = bits[j]
    const by = bits[j + 1]
    const bz = bits[j + 2]
    let h = hash3(bx, by, bz) & mask
    for (;;) {
      const slot = table[h]
      if (slot === -1) {
        table[h] = outCount
        const o = outCount * 3
        outPos[o] = soup[j]
        outPos[o + 1] = soup[j + 1]
        outPos[o + 2] = soup[j + 2]
        indices[i] = outCount
        outCount++
        break
      }
      const s = slot * 3
      if (outBits[s] === bx && outBits[s + 1] === by && outBits[s + 2] === bz) {
        indices[i] = slot
        break
      }
      h = (h + 1) & mask
    }
    if (onProgress && (i & 0x1fffff) === 0 && i > 0) {
      onProgress(`Merging vertices… ${Math.round((i / vertCount) * 100)}%`)
    }
  }

  return { positions: outPos.slice(0, outCount * 3), indices }
}

function hash3(a: number, b: number, c: number): number {
  let h = Math.imul(a, 0x9e3779b1)
  h ^= b
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h ^= c
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

/** Drop triangles that reference the same vertex twice (zero-area after welding). */
export function filterDegenerateTriangles(indices: Uint32Array): Uint32Array {
  let write = 0
  const out = new Uint32Array(indices.length)
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t]
    const b = indices[t + 1]
    const c = indices[t + 2]
    if (a === b || b === c || a === c) continue
    out[write] = a
    out[write + 1] = b
    out[write + 2] = c
    write += 3
  }
  return out.slice(0, write)
}
