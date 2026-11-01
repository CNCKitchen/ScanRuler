// SPDX-License-Identifier: AGPL-3.0-only
// Notes pinned to the part between the person at the screen and an agent:
// what the person wants done, and where — or what the agent is unsure of,
// and where — a sentence, the place on the part it was pinned to, and what
// was there: the scan, or faces, edges and corners of the bodies by their
// fingerprints, which the bodies are searched for again whenever the notes
// are read, as a feature finds its picks on a rebuild; and the other side's
// answer.
// The places are in the part's frame, the one the features are built in,
// and move with it when an alignment moves the part.

import { rigidApply, rigidRotate, type Rigid } from '../../../src/core/deviation/rigid'
import type { Vec3 } from '../../../src/core/types'
import type { KernelMesh } from './kernelTypes'
import { transformEdgeFingerprint, transformFingerprint, type EdgeFingerprint, type FaceFingerprint } from './topo'

/** What a note was pinned on: the scan, or a face, an edge or a corner of
 *  a body — kept by fingerprint, as a feature keeps its picks. */
export type NoteTarget =
  | { kind: 'scan' }
  | { kind: 'face'; body: number; face: FaceFingerprint }
  | { kind: 'edge'; body: number; edge: EdgeFingerprint }
  | { kind: 'vertex'; body: number; point: Vec3 }

export interface Note {
  /** Counts from one; the number on the pin. */
  id: number
  /** Who pinned it: the agent, with a question — the person otherwise. */
  by?: 'agent'
  /** Came in with a project file opened, not written at this screen: the
   *  file may be someone else's, so its text is not taken as the person's
   *  own. Gone once the person writes the note again; never saved. */
  fromFile?: true
  text: string
  /** Where the pin stands, mm, in the part's frame. */
  at: Vec3
  /** Which way the surface faces there, where it is known. */
  normal?: Vec3
  /** What the pin went on — one thing for a click, several for a note made
   *  on a selection. */
  on: NoteTarget[]
  /** Handled — by the agent, or ticked off by hand. */
  done?: boolean
  /** The other side's answer: the agent's to the person's note, the
   *  person's to the agent's question. */
  reply?: string
}

/** The nearest point of a mesh's triangles to `p`. */
export interface MeshNearest {
  point: Vec3
  distance: number
  /** The triangle, by index. */
  triangle: number
}

/** The point of triangle a b c nearest p — Ericson's region test. */
function nearestOnTriangle(p: Vec3, a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const sub = (u: Vec3, v: Vec3): Vec3 => [u[0] - v[0], u[1] - v[1], u[2] - v[2]]
  const dot = (u: Vec3, v: Vec3) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2]
  const along = (o: Vec3, d: Vec3, t: number): Vec3 => [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t]
  const ab = sub(b, a)
  const ac = sub(c, a)
  const ap = sub(p, a)
  const d1 = dot(ab, ap)
  const d2 = dot(ac, ap)
  if (d1 <= 0 && d2 <= 0) return a
  const bp = sub(p, b)
  const d3 = dot(ab, bp)
  const d4 = dot(ac, bp)
  if (d3 >= 0 && d4 <= d3) return b
  const vc = d1 * d4 - d3 * d2
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return along(a, ab, d1 / (d1 - d3))
  const cp = sub(p, c)
  const d5 = dot(ab, cp)
  const d6 = dot(ac, cp)
  if (d6 >= 0 && d5 <= d6) return c
  const vb = d5 * d2 - d1 * d6
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return along(a, ac, d2 / (d2 - d6))
  const va = d3 * d6 - d5 * d4
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return along(b, sub(c, b), (d4 - d3) / (d4 - d3 + (d5 - d6)))
  const denom = 1 / (va + vb + vc)
  const v = vb * denom
  const w = vc * denom
  return [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w]
}

/** The nearest point of a mesh to `p` — of the triangles on one face of it
 *  only, by the face's hash, with `faceHash`. Null for a mesh with no
 *  triangle to offer. A body's mesh is a few thousand triangles, and the
 *  notes a handful: every triangle is looked at. */
export function nearestOnMesh(mesh: KernelMesh, p: Vec3, faceHash?: number): MeshNearest | null {
  const { positions: x, indices } = mesh
  const at = (i: number): Vec3 => [x[i * 3], x[i * 3 + 1], x[i * 3 + 2]]
  let best: MeshNearest | null = null
  for (let t = 0; t * 3 + 2 < indices.length; t++) {
    if (faceHash !== undefined && mesh.faceHash?.[t] !== faceHash) continue
    const q = nearestOnTriangle(p, at(indices[t * 3]), at(indices[t * 3 + 1]), at(indices[t * 3 + 2]))
    const d = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2])
    if (!best || d < best.distance) best = { point: q, distance: d, triangle: t }
  }
  return best
}

/** Which way a mesh's surface faces on one of its triangles: its corners'
 *  normals averaged — the kernel's normals point out of the body. */
export function triangleNormal(mesh: KernelMesh, triangle: number): Vec3 | null {
  const n: Vec3 = [0, 0, 0]
  for (let k = 0; k < 3; k++) {
    const v = mesh.indices[triangle * 3 + k]
    for (let i = 0; i < 3; i++) n[i] += mesh.normals[v * 3 + i]
  }
  const len = Math.hypot(n[0], n[1], n[2])
  return len > 1e-12 ? [n[0] / len, n[1] / len, n[2] / len] : null
}

/** Which way a mesh faces at a point of it: on the faces named by hash —
 *  between them, for an edge's two — or on whichever face is nearest. */
export function meshNormalAt(mesh: KernelMesh, at: Vec3, faceHashes: readonly number[] = []): Vec3 | null {
  const sum: Vec3 = [0, 0, 0]
  for (const hash of faceHashes.length > 0 ? faceHashes : [undefined]) {
    const near = nearestOnMesh(mesh, at, hash)
    const n = near && triangleNormal(mesh, near.triangle)
    if (n) for (let i = 0; i < 3; i++) sum[i] += n[i]
  }
  const len = Math.hypot(sum[0], sum[1], sum[2])
  return len > 1e-9 ? [sum[0] / len, sum[1] / len, sum[2] / len] : null
}

/** The nearest point of the bodies to `p`, with the body it is on and the
 *  hash of the face — null with no body. */
export function nearestOnBodies(meshes: ReadonlyMap<number, KernelMesh>, p: Vec3): (MeshNearest & { body: number; faceHash: number | null }) | null {
  let best: (MeshNearest & { body: number; faceHash: number | null }) | null = null
  for (const [body, mesh] of meshes) {
    const near = nearestOnMesh(mesh, p)
    if (near && (!best || near.distance < best.distance)) best = { ...near, body, faceHash: mesh.faceHash?.[near.triangle] ?? null }
  }
  return best
}

/** A place on a face to pin a note made on it, where no click said where:
 *  the face's point nearest its centroid — a round face's centroid is on
 *  its axis, off the face. */
export function placeOnFace(mesh: KernelMesh, faceHash: number, centroid: Vec3): { at: Vec3; normal: Vec3 | null } {
  const near = nearestOnMesh(mesh, centroid, faceHash)
  return near ? { at: near.point, normal: triangleNormal(mesh, near.triangle) } : { at: centroid, normal: null }
}

/** A note carried by a rigid move of the part — its pin, its normal and
 *  the fingerprints it holds. */
export function moveNote(note: Note, m: Rigid): Note {
  const out = new Float64Array(3)
  const move = (p: Vec3): Vec3 => {
    rigidApply(m, p[0], p[1], p[2], out)
    return [out[0], out[1], out[2]]
  }
  const turn = (d: Vec3): Vec3 => {
    rigidRotate(m, d[0], d[1], d[2], out)
    return [out[0], out[1], out[2]]
  }
  const on = note.on.map((t): NoteTarget => {
    if (t.kind === 'face') return { ...t, face: transformFingerprint(t.face, m) }
    if (t.kind === 'edge') return { ...t, edge: transformEdgeFingerprint(t.edge, m) }
    if (t.kind === 'vertex') return { ...t, point: move(t.point) }
    return t
  })
  return { ...note, at: move(note.at), ...(note.normal ? { normal: turn(note.normal) } : {}), on }
}

const isVec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x))

/** Check notes as read from a file; throws on what would not load. */
export function validateNotes(raw: unknown): Note[] {
  const bad = (what: string): never => {
    throw new Error(`Malformed project: notes — ${what}.`)
  }
  if (!Array.isArray(raw)) bad('not a list')
  const ids = new Set<number>()
  for (const n of raw as unknown[]) {
    if (typeof n !== 'object' || n === null) bad('a note is not an object')
    const note = n as Record<string, unknown>
    if (!Number.isSafeInteger(note.id) || (note.id as number) < 1 || ids.has(note.id as number)) bad('id')
    ids.add(note.id as number)
    if (typeof note.text !== 'string') bad('text')
    if (!isVec3(note.at)) bad('at')
    if (note.normal !== undefined && !isVec3(note.normal)) bad('normal')
    if (note.done !== undefined && typeof note.done !== 'boolean') bad('done')
    if (note.reply !== undefined && typeof note.reply !== 'string') bad('reply')
    if (note.by !== undefined && note.by !== 'agent') bad('by')
    if (note.fromFile !== undefined && note.fromFile !== true) bad('fromFile')
    if (!Array.isArray(note.on)) bad('on')
    for (const t of note.on as unknown[]) {
      const target = t as Record<string, unknown>
      if (typeof t !== 'object' || t === null) bad('a target is not an object')
      if (target.kind === 'scan') continue
      if (typeof target.body !== 'number' || !Number.isFinite(target.body)) bad('target.body')
      if (target.kind === 'face' && (typeof target.face !== 'object' || target.face === null || !isVec3((target.face as Record<string, unknown>).centroid))) bad('target.face')
      else if (target.kind === 'edge' && (typeof target.edge !== 'object' || target.edge === null || !isVec3((target.edge as Record<string, unknown>).mid))) bad('target.edge')
      else if (target.kind === 'vertex' && !isVec3(target.point)) bad('target.point')
      else if (!['face', 'edge', 'vertex'].includes(target.kind as string)) bad('target.kind')
    }
  }
  return raw as Note[]
}
