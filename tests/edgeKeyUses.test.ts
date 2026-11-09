// SPDX-License-Identifier: AGPL-3.0-only
// An undirected edge keyed as lo · 2³² + hi is exact only while that sum stays
// under 2⁵³, so from vertex 2²¹ on — an ordinary multi-million-vertex scan —
// two different edges can share a key: an open rim reads as closed, a rim edge
// matches an inner one, Densify gives an edge another edge's middle. 0.9.8
// moved openEdges.ts and the volume-error rim test to `edgeKey(n)`, exact while
// n² stays under 2⁵³; Densify, added in 0.9.9, brought the old key back. This
// check reads the sources so the pattern does not return in another file.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { edgeKey } from '../src/core/geometry/openEdges'

const ROOTS = ['src', 'plugins']

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (name !== 'node_modules' && name !== 'tests') sources(path, out)
    } else if (/\.tsx?$/.test(name)) out.push(path)
  }
  return out
}

describe('edge keys built from two vertex numbers', () => {
  it('no source multiplies a vertex number by 2³² to key an edge', () => {
    // `x * 4294967296 + y` with both operands vertex numbers; a hash that
    // scales a random 32-bit word into [0, 1) (ransac.ts) divides instead.
    const pattern = /\b[a-z]\w*\s*\*\s*(4_?294_?967_?296|2\s*\*\*\s*32|0x100000000)\s*\+\s*[a-z]\w*/
    const hits = ROOTS.flatMap((root) => sources(root))
      .filter((file) => pattern.test(readFileSync(file, 'utf8')))
    expect(hits).toEqual([])
  })

  it('edgeKey tells apart the edges the old key merges past vertex 2²¹', () => {
    const a = 2 ** 21 + 7
    const key = edgeKey(a + 3)
    // lo · 2³² + hi rounds these two onto one double.
    expect(a * 4_294_967_296 + (a + 1)).toBe(a * 4_294_967_296 + (a + 2))
    expect(key(a, a + 1)).not.toBe(key(a, a + 2))
    expect(key(a + 1, a)).toBe(key(a, a + 1))
  })
})
