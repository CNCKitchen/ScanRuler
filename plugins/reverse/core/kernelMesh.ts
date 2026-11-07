// SPDX-License-Identifier: AGPL-3.0-only
// A shape's triangles with every face there: OCCT's mesher leaves a face bare
// or drawn in small part now and then, which only the face's area against
// its triangles' shows, and such a face is drawn again on its own. The part
// of ReKernel's mesh (kernel.ts) that is more than one call to the kernel.

import type { Vec3 } from '../../../src/core/types'
import { faceEdgesOff } from './kernelEdges'
import { vec } from './kernelMath'
import { HASH_BOUND } from './kernelOps'
import type { OcctLike } from './occtTypes'

type RawMesh = ReturnType<OcctLike['meshShape']>

/** A face whose triangles cover less than this share of its area has not
 *  been drawn. A chord's sag takes off a few percent at the most: a round
 *  of the flange's loses 3 % at a chord 0.05 mm, where the two faces the
 *  mesher fails on have 0 and 3 % of theirs. */
const MESHED_SHARE = 0.75
/** A face's own triangles are refused over this share of its area: they
 *  stand off it, wherever they are. */
const OVERDRAWN_SHARE = 1.5
/** Under this a face has no area to draw, mm². */
const NO_FACE_MM2 = 1e-6
/** Over this a mesh's triangles do not sum to nothing, mm²: see closes. */
const OPEN_MM2 = 1e-3
/** How many times a face is meshed again at twice the chord, and at what
 *  angles after that, at the chord asked. A chord 2 to 8 times finer than
 *  what draws a face leaves it as bare as the first: the flange's two take
 *  8 and 16 times the 0.04 mm asked, each with an edge 0.16 and 0.57 mm off
 *  its surface. */
const CHORD_DOUBLINGS = 7
const COARSER_ANGLES = [0.5, 1]

/** A face the mesher did not draw whole with the others. */
export interface MeshFault {
  hash: number
  /** The middle of the face, mm. */
  at: Vec3
  /** Its area and what its triangles cover, mm². */
  area: number
  drawn: number
  /** The chord it was drawn to on its own, where one did it whole; a face
   *  no chord did has what it had. */
  chord?: number
  /** How far the worst of its edges lies off its surface, mm: a round's
   *  run-out that the kernel's check lets through on the edge's own
   *  tolerance, and what the mesher stumbles on. */
  off: number
}

/**
 * A face the mesher did not draw whole, as an answer names it: which it is
 * and where, how it was drawn in the end, and that in a sentence — what the
 * body check and a volume compare say of it alike. The face was put in on
 * its own at a coarser chord, or a hole was left, which the volume error
 * reads from the columns beside it.
 */
export function meshFaultOut(body: string, f: MeshFault, named: { index: number | null; madeBy?: { name: string | null } } | null) {
  const at = f.at.map((v) => Math.round(v * 100) / 100) as Vec3
  const off = Number(f.off.toPrecision(2))
  const area = Math.round(f.area * 100) / 100
  const drawn = Math.round(f.drawn * 100) / 100
  const which = `face ${named?.index ?? '?'} of ${body}${named?.madeBy?.name ? `, made by ${named.madeBy.name},` : ''} at (${at.join(', ')})`
  // units-ok: the agent's answer — in millimetres always.
  const how = f.chord !== undefined ? `drawn on its own at a ${Number(f.chord.toPrecision(2))} mm chord` : `a hole in the mesh, its triangles covering ${drawn} of ${area} mm², read from what lies beside it`
  // units-ok: as above.
  const why = off > 1e-3 ? ` — an edge of it lies ${off} mm off its surface, a round’s run-out the kernel’s check passes on the edge’s own tolerance` : ''
  return { index: named?.index ?? null, at, area, drawn, ...(f.chord !== undefined ? { chord: f.chord } : {}), off, words: `The mesher failed on ${which}: ${how}${why}.` }
}

/** The volume a closed mesh holds, mm³: its triangles' signed tetrahedra. */
export function meshVolume(m: { positions: ArrayLike<number>; indices: ArrayLike<number> }): number {
  const { positions: p, indices: ix } = m
  let v = 0
  for (let i = 0; i + 2 < ix.length; i += 3) {
    const [a, b, c] = [ix[i] * 3, ix[i + 1] * 3, ix[i + 2] * 3]
    v += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])
  }
  return Math.abs(v) / 6
}

/**
 * The indices without a triangle two of whose corners lie on one point. The
 * mesher leaves one where a surface closes to a point, a cone's apex: its
 * seam and the apex's zero-length edge meet there. It has no area, so a
 * volume or a picture never shows it, but it counts twice on the edge beside
 * it: a file for a printer then has an edge four triangles share and an edge
 * from a point to itself. Taken out, every edge has its two.
 */
export function withoutCollapsed(positions: ArrayLike<number>, indices: Uint32Array): Uint32Array {
  const same = (a: number, b: number) => positions[a * 3] === positions[b * 3] && positions[a * 3 + 1] === positions[b * 3 + 1] && positions[a * 3 + 2] === positions[b * 3 + 2]
  const kept = new Uint32Array(indices.length)
  let at = 0
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = indices[t], b = indices[t + 1], c = indices[t + 2]
    if (same(a, b) || same(b, c) || same(c, a)) continue
    kept[at++] = a
    kept[at++] = b
    kept[at++] = c
  }
  return at === indices.length ? indices : kept.slice(0, at)
}

/** What triangles a mesh's runs, one a face, cover: by the face's hash. */
function coveredByFace(m: RawMesh): Map<number, number> {
  const out = new Map<number, number>()
  const g = m.faceGroups
  if (!g) return out
  for (let r = 0; r + 2 < g.length; r += 3) out.set(g[r + 2], (out.get(g[r + 2]) ?? 0) + covered(m, g[r], g[r] + g[r + 1]))
  return out
}

/** The area of a run of a mesh's index buffer, mm². */
function covered(m: RawMesh, start: number, end: number): number {
  const P = m.positions, I = m.indices
  let sum = 0
  for (let t = start; t + 2 < end; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2]
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2]
    sum += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2
  }
  return sum
}

/** Whether a mesh's triangles, as vectors along their normals, sum to
 *  nothing, as a closed one's do: its faces share their edges' points, so
 *  each edge cancels. Asked first of every mesh, a millisecond against the
 *  half second of 480 faces' areas: only a mesh with a hole needs those.
 *  A hole with no such sum, a whole tube, is a face with no run at all. */
function closes(m: RawMesh): boolean {
  const P = m.positions, I = m.indices
  let x = 0, y = 0, z = 0
  for (let t = 0; t + 2 < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2]
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2]
    x += uy * vz - uz * vy
    y += uz * vx - ux * vz
    z += ux * vy - uy * vx
  }
  return Math.hypot(x, y, z) / 2 < OPEN_MM2
}

/** The mesh with a face's run taken out and `piece`, that face's triangles
 *  on their own, put in. */
function withFace(m: RawMesh, hash: number, piece: RawMesh): RawMesh {
  const g = m.faceGroups!
  const kept: number[] = []
  const indices = new Uint32Array(m.indices.length + piece.indices.length)
  let at = 0
  for (let r = 0; r + 2 < g.length; r += 3) {
    if (g[r + 2] === hash) continue
    indices.set(m.indices.subarray(g[r], g[r] + g[r + 1]), at)
    kept.push(at, g[r + 1], g[r + 2])
    at += g[r + 1]
  }
  const offset = m.positions.length / 3
  for (let i = 0; i < piece.indices.length; i++) indices[at + i] = piece.indices[i] + offset
  kept.push(at, piece.indices.length, hash)
  at += piece.indices.length
  const positions = new Float32Array(m.positions.length + piece.positions.length)
  positions.set(m.positions)
  positions.set(piece.positions, m.positions.length)
  const normals = new Float32Array(m.normals.length + piece.normals.length)
  normals.set(m.normals)
  normals.set(piece.normals, m.normals.length)
  return { positions, normals, indices: indices.slice(0, at), faceGroups: Int32Array.from(kept) }
}

/**
 * The shape meshed with a triangle on every face it can have. A mesh with a
 * face missing is not closed: an STL with a hole in it, a comparison that
 * sees through it, a volume error that reads material all the way up its
 * grid over it. Which faces those are is not which have no triangles: of
 * the flange's two, one has 112 covering 3 % of it. A face under
 * MESHED_SHARE is meshed again on its own — a copy, without the mesh OCCT
 * keeps and would not redo — at twice the chord and on, then at coarser
 * angles, and its triangles put in the place of what it had. The rest of
 * the mesh keeps the chord asked. Its rim is its own, so it meets the faces
 * beside it to within the chord, not vertex to vertex. `faults` names every
 * such face, drawn in the end or not.
 */
export function meshEveryFace(occt: OcctLike, shape: number, linearDeflection: number, angularDeflection: number): RawMesh & { faults?: MeshFault[] } {
  const first = occt.meshShape(shape, { linearDeflection, angularDeflection })
  if (!first.faceGroups) return first
  if (first.faceGroups.length / 3 >= occt.subShapeCount(shape, 'face') && closes(first)) return first
  const drawn = coveredByFace(first)
  const faces = occt.getSubShapes(shape, 'face')
  let mesh = first
  const faults: MeshFault[] = []
  const seen = new Set<number>()
  try {
    for (const face of faces) {
      const hash = occt.hashCode(face, HASH_BOUND)
      if (seen.has(hash)) continue
      seen.add(hash)
      const area = occt.getSurfaceArea(face)
      const had = drawn.get(hash) ?? 0
      if (!(area > NO_FACE_MM2) || had >= MESHED_SHARE * area) continue
      const tries = [
        ...Array.from({ length: CHORD_DOUBLINGS }, (_, k) => ({ chord: linearDeflection * 2 ** (k + 1), angle: angularDeflection })),
        ...COARSER_ANGLES.filter((angle) => angle > angularDeflection).map((angle) => ({ chord: linearDeflection, angle })),
      ]
      let best: RawMesh | null = null
      let cover = had
      let chord: number | undefined
      for (const t of tries) {
        const copy = occt.copy(face)
        try {
          const m = occt.meshShape(copy, { linearDeflection: t.chord, angularDeflection: t.angle })
          const a = covered(m, 0, m.indices.length)
          if (a > cover && a <= OVERDRAWN_SHARE * area) {
            best = m
            cover = a
          }
          if (cover >= MESHED_SHARE * area) {
            chord = t.chord
            break
          }
        } finally {
          occt.release(copy)
        }
      }
      if (best) mesh = withFace(mesh, hash, best)
      faults.push({ hash, at: vec(occt.getSurfaceCenterOfMass(face)), area, drawn: cover, ...(chord !== undefined ? { chord } : {}), off: faceEdgesOff(occt, face) })
    }
  } finally {
    for (const f of faces) occt.release(f)
  }
  return faults.length > 0 ? { ...mesh, faults } : mesh
}
