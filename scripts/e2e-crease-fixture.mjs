// SPDX-License-Identifier: AGPL-3.0-only
// Writes the low-poly CAD-style STL the crease e2e loads: a block with four
// round bosses and a raised pad, 24 facets to a boss — the kind of mesh an
// OpenSCAD export is, and the kind issue #5 was raised on.
//   node scripts/e2e-crease-fixture.mjs [out.stl]
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { repoFile } from './e2e-lib.mjs'

const out = process.argv[2] ?? repoFile('e2e-out/lowpoly.stl')
const tris = []
const tri = (a, b, c) => tris.push([a, b, c])
const quad = (a, b, c, d) => {
  tri(a, b, c)
  tri(a, c, d)
}
function box(x0, y0, z0, x1, y1, z1) {
  const p = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ]
  quad(p[0], p[3], p[2], p[1])
  quad(p[4], p[5], p[6], p[7])
  quad(p[0], p[1], p[5], p[4])
  quad(p[1], p[2], p[6], p[5])
  quad(p[2], p[3], p[7], p[6])
  quad(p[3], p[0], p[4], p[7])
}
function cyl(cx, cy, z0, z1, r, n = 24) {
  const ring = (z) =>
    Array.from({ length: n }, (_, i) => [
      cx + r * Math.cos((2 * Math.PI * i) / n),
      cy + r * Math.sin((2 * Math.PI * i) / n),
      z,
    ])
  const lo = ring(z0)
  const hi = ring(z1)
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    quad(lo[i], lo[j], hi[j], hi[i])
    tri([cx, cy, z1], hi[i], hi[j])
    tri([cx, cy, z0], lo[j], lo[i])
  }
}
box(0, 0, 0, 50, 40, 8)
for (const [cx, cy] of [[12, 10], [38, 10], [12, 30], [38, 30]]) cyl(cx, cy, 8, 20, 4.5)
box(18, 14, 8, 32, 26, 14)

const buf = Buffer.alloc(84 + tris.length * 50)
buf.write('lowpoly', 0, 'ascii')
buf.writeUInt32LE(tris.length, 80)
let at = 84
for (const t of tris) {
  at += 12 // normal, left zero — readers take the winding
  for (const p of t) for (const v of p) {
    buf.writeFloatLE(v, at)
    at += 4
  }
  at += 2
}
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, buf)
console.log(`${out}: ${tris.length} triangles`)
