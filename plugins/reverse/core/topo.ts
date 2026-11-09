// SPDX-License-Identifier: AGPL-3.0-only
// Stable names for the faces and edges of a body. A feature that fillets an
// edge or opens a face for a shell has to say which one, and an index into
// the kernel's face list is not a name: the list is remade on every rebuild
// and an earlier dimension changed reorders it. So a pick is stored as a
// **fingerprint** — the kind of surface or curve, where its middle is, which
// way it faces or runs, how big it is, and which feature first made it — and
// re-found on the body as it stands before the feature, the best candidate
// within a tolerance winning. A pick that cannot be found fails its feature
// loudly, with the fingerprint's description in the message, never a
// silently substituted neighbour.
//
// The kernel side (kernel.ts) reads the geometry off the shapes and the
// builder (build.ts) carries the creating feature across steps through the
// kernel's history; this module is the geometry and the matching, testable
// without the kernel.

import type { Vec3 } from '../../../src/core/types'
import { type DisplayUnits, fmtArea, fmtLen } from '../../../src/core/units'
import { dot, len, normalize, scale, sub } from '../../../src/core/vec'
import { rigidApply, rigidRotate, type Rigid } from '../../../src/core/deviation/rigid'

export type FaceKind = 'plane' | 'cylinder' | 'cone' | 'sphere' | 'torus' | 'other'
export type EdgeKind = 'line' | 'circle' | 'other'

export interface FaceFingerprint {
  kind: FaceKind
  /** The area-weighted centre of the face. */
  centroid: Vec3
  /** The outward normal at the middle of a plane (the sign tells a top from
   *  a bottom); the axis of a cylinder, cone or torus, sign made canonical
   *  since an axis has none; the normal at the middle of anything else. */
  dir: Vec3
  area: number
  /** A cylinder's or a sphere's radius. */
  radius?: number
  /** A point on a cylinder's or a cone's axis, a sphere's centre — where
   *  a hole cut along the face's axis starts from. */
  center?: Vec3
  /** The id of the feature whose step first made the face. */
  origin: number
}

export interface EdgeFingerprint {
  kind: EdgeKind
  /** The point halfway along the edge. */
  mid: Vec3
  /** The tangent at the middle of a line, sign made canonical; the axis of
   *  a circle; the tangent at the middle of anything else. */
  dir: Vec3
  length: number
  /** A circle's radius. */
  radius?: number
  /** The faces on either side — kind and direction only, which is what tells
   *  a top edge from a bottom one when both are the same line. */
  faces: { kind: FaceKind; dir: Vec3 }[]
  /** The id of the feature whose step first made the edge's newest face. */
  origin: number
}

/** What onOneSurface reads of a face: its surface, not where on it the
 *  face lies. */
export type FaceSurface = Pick<FaceFingerprint, 'kind' | 'dir' | 'radius' | 'center'>

/** How far a candidate may be from the pick and still be it. */
export interface MatchTolerance {
  /** Millimetres between the middles. */
  position: number
  /** Radians between the directions. */
  angle: number
  /** Relative difference in size (area, length, radius). */
  size: number
}

/** The tolerance for a body of the given diagonal: an earlier dimension
 *  moved by a tenth of the part still lands on the same face, a face
 *  turned by more than ten degrees is another face. */
export function matchTolerance(diagonal: number): MatchTolerance {
  return { position: Math.max(1, diagonal * 0.1), angle: (10 * Math.PI) / 180, size: 0.5 }
}

/** A direction with its sign made canonical — the first component that is
 *  clearly not zero is positive — for the things that have no sign of their
 *  own: an axis, a line's tangent. */
export function canonicalDir(v: Vec3): Vec3 {
  const n = normalize(v) ?? [0, 0, 1]
  for (let k = 0; k < 3; k++) {
    if (Math.abs(n[k]) > 1e-6) return n[k] < 0 ? [0 - n[0], 0 - n[1], 0 - n[2]] : n
  }
  return n
}

/** A face's fingerprint carried through a rigid motion of the part — an
 *  alignment applied after the pick — so it is found again on the bodies
 *  rebuilt in the new frame. A plane's normal keeps its sign; an axis is
 *  made canonical again, as the rebuilt body's will be. */
export function transformFingerprint(face: FaceFingerprint, m: Rigid): FaceFingerprint {
  const out = new Float64Array(3)
  const move = (p: Vec3): Vec3 => {
    rigidApply(m, p[0], p[1], p[2], out)
    return [out[0], out[1], out[2]]
  }
  rigidRotate(m, face.dir[0], face.dir[1], face.dir[2], out)
  const turned: Vec3 = [out[0], out[1], out[2]]
  return {
    ...face,
    centroid: move(face.centroid),
    dir: face.kind === 'cylinder' || face.kind === 'cone' || face.kind === 'torus' ? canonicalDir(turned) : turned,
    ...(face.center ? { center: move(face.center) } : {}),
  }
}

/** An edge's fingerprint carried through a rigid motion of the part, as a
 *  face's is (transformFingerprint): its middle moved, its direction and
 *  its faces' turned, made canonical again where they have no sign. */
/** Whether `o` is a face's fingerprint: a centroid, a direction and an area. */
function isFaceFingerprint(o: Record<string, unknown>): o is FaceFingerprint & Record<string, unknown> {
  return typeof o.kind === 'string' && typeof o.area === 'number' && isVec3(o.centroid) && isVec3(o.dir)
}

/** Whether `o` is an edge's fingerprint: a midpoint, a direction, a length
 *  and the faces beside it. */
function isEdgeFingerprint(o: Record<string, unknown>): o is EdgeFingerprint & Record<string, unknown> {
  return typeof o.kind === 'string' && typeof o.length === 'number' && isVec3(o.mid) && isVec3(o.dir) && Array.isArray(o.faces)
}

const isVec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number')

/**
 * `x` with every face and edge fingerprint in it carried by `m`, wherever
 * it is kept — a fillet's edges, a shell's faces, a draft's, a hole's axis
 * face and the point on it, a cut up to a face, a mirror across one, the
 * found faces of a stored pick, a projected sketch piece's edge — each
 * once, and nothing else touched. A datum alignment moved a few of them by
 * hand and left the rest where the faces used to be, so the next build no
 * longer found them (issue 34).
 */
export function movedFingerprints<T>(x: T, m: Rigid): T {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk)
    if (v === null || typeof v !== 'object' || ArrayBuffer.isView(v)) return v
    const o = v as Record<string, unknown>
    if (isFaceFingerprint(o)) return transformFingerprint(o, m)
    if (isEdgeFingerprint(o)) return transformEdgeFingerprint(o, m)
    const out: Record<string, unknown> = {}
    for (const [k, value] of Object.entries(o)) out[k] = walk(value)
    // A hole started at a point on a face: the point is in the part's
    // frame as the face is.
    if (o.kind === 'point' && 'face' in o && isVec3(o.at)) {
      const p = new Float64Array(3)
      rigidApply(m, o.at[0], o.at[1], o.at[2], p)
      out.at = [p[0], p[1], p[2]]
    }
    return out
  }
  return walk(x) as T
}

export function transformEdgeFingerprint(edge: EdgeFingerprint, m: Rigid): EdgeFingerprint {
  const out = new Float64Array(3)
  const turn = (d: Vec3): Vec3 => {
    rigidRotate(m, d[0], d[1], d[2], out)
    return [out[0], out[1], out[2]]
  }
  rigidApply(m, edge.mid[0], edge.mid[1], edge.mid[2], out)
  const mid: Vec3 = [out[0], out[1], out[2]]
  return {
    ...edge,
    mid,
    dir: canonicalDir(turn(edge.dir)),
    faces: edge.faces.map((f) => ({ kind: f.kind, dir: f.kind === 'cylinder' || f.kind === 'cone' || f.kind === 'torus' ? canonicalDir(turn(f.dir)) : turn(f.dir) })),
  }
}

function angleBetween(a: Vec3, b: Vec3): number {
  const d = Math.max(-1, Math.min(1, dot(a, b) / (Math.max(len(a), 1e-12) * Math.max(len(b), 1e-12))))
  return Math.acos(d)
}

function relativeDifference(a: number, b: number): number {
  const m = Math.max(Math.abs(a), Math.abs(b))
  return m > 1e-12 ? Math.abs(a - b) / m : 0
}

/** How far a candidate face is from the wanted one as a sum of its
 *  distances in position, direction and size, each in units of the
 *  tolerance; null when it is not a candidate at all — another kind of
 *  surface, or past the tolerance on any count. A different creating
 *  feature costs half a tolerance: the same face made by another feature
 *  is still the same face, but the one made by the same feature is the
 *  better bet when two are close. */
export function faceDistance(wanted: FaceFingerprint, candidate: FaceFingerprint, tol: MatchTolerance): number | null {
  if (wanted.kind !== candidate.kind) return null
  const pos = len(sub(wanted.centroid, candidate.centroid)) / tol.position
  const ang = angleBetween(wanted.dir, candidate.dir) / tol.angle
  let size = relativeDifference(wanted.area, candidate.area) / tol.size
  if (wanted.radius !== undefined && candidate.radius !== undefined) size = Math.max(size, relativeDifference(wanted.radius, candidate.radius) / tol.size)
  if (pos > 1 || ang > 1 || size > 1) return null
  return pos + ang + size + (wanted.origin === candidate.origin ? 0 : 0.5)
}

/** The faces of an edge, matched by kind and direction alone: every face
 *  of the wanted edge must find one of the candidate's within the angle. */
function facesAgree(wanted: EdgeFingerprint['faces'], candidate: EdgeFingerprint['faces'], tol: MatchTolerance): number | null {
  if (wanted.length === 0 || candidate.length === 0) return 0
  const taken = new Set<number>()
  let sum = 0
  for (const w of wanted) {
    let best = -1, bestAng = Infinity
    candidate.forEach((c, i) => {
      if (taken.has(i) || c.kind !== w.kind) return
      const ang = angleBetween(w.dir, c.dir)
      if (ang < bestAng) {
        bestAng = ang
        best = i
      }
    })
    if (best < 0 || bestAng > tol.angle) return null
    taken.add(best)
    sum += bestAng / tol.angle
  }
  return sum / wanted.length
}

/** As faceDistance, for an edge: its faces' kinds and directions too. */
export function edgeDistance(wanted: EdgeFingerprint, candidate: EdgeFingerprint, tol: MatchTolerance): number | null {
  if (wanted.kind !== candidate.kind) return null
  const pos = len(sub(wanted.mid, candidate.mid)) / tol.position
  const ang = angleBetween(wanted.dir, candidate.dir) / tol.angle
  let size = relativeDifference(wanted.length, candidate.length) / tol.size
  if (wanted.radius !== undefined && candidate.radius !== undefined) size = Math.max(size, relativeDifference(wanted.radius, candidate.radius) / tol.size)
  if (pos > 1 || ang > 1 || size > 1) return null
  const faces = facesAgree(wanted.faces, candidate.faces, tol)
  if (faces === null) return null
  return pos + ang + size + faces + (wanted.origin === candidate.origin ? 0 : 0.5)
}

/** The tolerance of the second look, for a pick the first found nothing
 *  for: an earlier dimension changed by more than a tenth of the part —
 *  a boss pulled from 7 to 17 mm moves its top face and every edge on it
 *  by 10, and its side edges change length by more than half — is still
 *  the same face or edge, with the same creating feature, the same kind,
 *  facing the same way. The second look is taken only among the
 *  candidates the same feature made, so a face that is truly gone is not
 *  quietly stood in for by a neighbour: position four times as far, the
 *  size hardly counted, the direction as tight as ever. */
function relaxedTolerance(tol: MatchTolerance): MatchTolerance {
  return { position: tol.position * 4, angle: tol.angle, size: 0.9 }
}

/** The index of the candidate nearest the wanted fingerprint within the
 *  tolerance — or, when none is, the nearest of those the same feature
 *  made within the relaxed tolerance — or null when none is near enough. */
export function matchFace(wanted: FaceFingerprint, candidates: readonly FaceFingerprint[], tol: MatchTolerance): number | null {
  const strict = best(candidates, (c) => faceDistance(wanted, c, tol))
  if (strict !== null || wanted.origin < 0) return strict
  const loose = relaxedTolerance(tol)
  return best(candidates, (c) => (c.origin === wanted.origin ? faceDistance(wanted, c, loose) : null))
}

export function matchEdge(wanted: EdgeFingerprint, candidates: readonly EdgeFingerprint[], tol: MatchTolerance): number | null {
  const strict = best(candidates, (c) => edgeDistance(wanted, c, tol))
  if (strict !== null || wanted.origin < 0) return strict
  const loose = relaxedTolerance(tol)
  return best(candidates, (c) => (c.origin === wanted.origin ? edgeDistance(wanted, c, loose) : null))
}

function best<T>(candidates: readonly T[], distance: (c: T) => number | null): number | null {
  let bestIndex: number | null = null
  let bestDistance = Infinity
  candidates.forEach((c, i) => {
    const d = distance(c)
    if (d !== null && d < bestDistance) {
      bestDistance = d
      bestIndex = i
    }
  })
  return bestIndex
}

/** An edge as the chain walk sees it: its two ends and the tangent at
 *  each, whatever else it carries. */
export interface ChainEdge {
  hash: number
  ends: [Vec3, Vec3]
  endTangents: [Vec3, Vec3]
}

const NO_EDGES: ReadonlySet<number> = new Set()

/** The edges tangent-continuous with the seeds: from each seed, every
 *  edge meeting it end to end whose tangent there agrees within `angle`,
 *  and so on along the chain — a fillet picked on one side of a rounded
 *  rectangle runs all the way round it, as CAD fillets do. The seeds are
 *  in the answer; the order is the walk's. The walk never steps onto an
 *  edge in `skip` — the splits (splitEdges) a picked edge can run on into
 *  in a straight line, where a face lying on its neighbour's surface
 *  reaches on past the edge seen. */
export function tangentChain(edges: readonly ChainEdge[], seeds: readonly number[], skip: ReadonlySet<number> = NO_EDGES, angle = (3 * Math.PI) / 180, joinTolerance = 1e-3): number[] {
  const byHash = new Map(edges.map((e) => [e.hash, e]))
  const taken = new Set<number>()
  const out: number[] = []
  const queue: number[] = []
  for (const s of seeds) if (byHash.has(s) && !taken.has(s)) {
    taken.add(s)
    out.push(s)
    queue.push(s)
  }
  const cosLimit = Math.cos(angle)
  while (queue.length > 0) {
    const e = byHash.get(queue.shift()!)!
    for (let k = 0; k < 2; k++) {
      const end = e.ends[k]
      const t = e.endTangents[k]
      for (const other of edges) {
        if (taken.has(other.hash) || skip.has(other.hash)) continue
        for (let j = 0; j < 2; j++) {
          if (len(sub(other.ends[j], end)) > joinTolerance) continue
          if (Math.abs(dot(t, other.endTangents[j])) < cosLimit) continue
          taken.add(other.hash)
          out.push(other.hash)
          queue.push(other.hash)
          break
        }
      }
    }
  }
  return out
}

/** How far apart, in millimetres, two surfaces may lie and still be taken
 *  for one — far looser than the kernel's own ten-millionth, which keeps a
 *  face cut in two where its halves' radii came out a millionth apart. */
const ONE_SURFACE_MM = 1e-3
/** And how far apart their axes may turn, in radians. */
const ONE_SURFACE_ANGLE = 1e-4

/**
 * Whether two faces that meet tangent lie on one surface: the two a
 * boolean leaves either side of where it cut through a plane or a
 * cylinder, which the kernel merges back only when they agree to the last
 * hair. The tangency is the caller's to have found. With it, two planes
 * meeting along an edge are one plane, and two cylinders or cones on one
 * axis are one (a cone's slope agrees where the two meet); two spheres
 * have to share their centre and radius. A torus or a surface of no named
 * kind never is: its fingerprint does not hold enough to tell.
 */
export function onOneSurface(a: FaceSurface, b: FaceSurface): boolean {
  if (a.kind !== b.kind) return false
  switch (a.kind) {
    case 'plane':
      return true
    case 'cylinder':
    case 'cone': {
      if (!a.center || !b.center || Math.abs(dot(a.dir, b.dir)) < Math.cos(ONE_SURFACE_ANGLE)) return false
      // How far the one's axis point lies off the other's axis.
      const d = sub(b.center, a.center)
      if (len(sub(d, scale(a.dir, dot(d, a.dir)))) > ONE_SURFACE_MM) return false
      return a.kind === 'cone' || (a.radius !== undefined && b.radius !== undefined && Math.abs(a.radius - b.radius) <= ONE_SURFACE_MM)
    }
    case 'sphere':
      return a.center !== undefined && b.center !== undefined && a.radius !== undefined && b.radius !== undefined && len(sub(a.center, b.center)) <= ONE_SURFACE_MM && Math.abs(a.radius - b.radius) <= ONE_SURFACE_MM
    default:
      return false
  }
}

/**
 * The edges between two faces of one surface — the lines the viewer neither
 * draws nor picks (edgeLines.ts), where a boolean left a face cut in two or
 * a face lying on its neighbour's surface beside it. They are no edge of
 * the part's shape, so no round or chamfer runs along one. The tangency
 * onOneSurface leaves to its caller is read off the fingerprints: two
 * planes are one where their outward normals agree, and two faces on one
 * cylinder or sphere meet smoothly wherever they meet. Two cones on one
 * axis can meet at an angle, which their fingerprints do not tell, so an
 * edge between cones is kept.
 */
export function splitEdges(topology: { faces: readonly { hash: number; fingerprint: FaceSurface }[]; edges: readonly { hash: number; faces: readonly number[] }[] }): Set<number> {
  const byHash = new Map(topology.faces.map((f) => [f.hash, f.fingerprint]))
  const out = new Set<number>()
  for (const e of topology.edges) {
    const [x, y] = [...new Set(e.faces)]
    const a = byHash.get(x)
    const b = y === undefined ? undefined : byHash.get(y)
    if (!a || !b || a.kind !== b.kind) continue
    const one = a.kind === 'plane' ? dot(a.dir, b.dir) >= Math.cos(ONE_SURFACE_ANGLE) : (a.kind === 'cylinder' || a.kind === 'sphere') && onOneSurface(a, b)
    if (one) out.add(e.hash)
  }
  return out
}

/** A length in a face's or an edge's words: tenths of a millimetre, as the
 *  build has always written them, or the same in the units shown. */
const tenths = (mm: number, units: DisplayUnits) => (units === 'mm' ? mm.toFixed(1) : fmtLen(mm, units, 1, { bare: true }))
const at = (p: Vec3, units: DisplayUnits) => `(${p.map((x) => tenths(x, units)).join(', ')})`

function faceWords(f: FaceFingerprint, units: DisplayUnits): string {
  const size = f.kind === 'cylinder' || f.kind === 'sphere' ? (f.radius !== undefined ? ` Ø${tenths(2 * f.radius, units)}` : '') : ` ${fmtArea(f.area, units, 0)}`
  return `${f.kind === 'other' ? 'face' : f.kind}${size} at ${at(f.centroid, units)}`
}

function edgeWords(e: EdgeFingerprint, units: DisplayUnits): string {
  if (e.kind === 'circle' && e.radius !== undefined) return `circle Ø${tenths(2 * e.radius, units)} at ${at(e.mid, units)}`
  return `${e.kind === 'other' ? 'edge' : e.kind} ${fmtLen(e.length, units, 1)} at ${at(e.mid, units)}`
}

/** A face as a message names it: "cylinder Ø6.0 at (10.0, 10.0, 5.0)". In
 *  millimetres: the build's messages say it so, and the answers with them. */
export function describeFace(f: FaceFingerprint): string {
  // units-ok: build message, also the agent's answer
  return faceWords(f, 'mm')
}

/** An edge as a message names it: "circle Ø6.0 at (10.0, 10.0, 10.0)",
 *  "line 40.0 mm at (20.0, 0.0, 10.0)". In millimetres, as describeFace. */
export function describeEdge(e: EdgeFingerprint): string {
  // units-ok: build message, also the agent's answer
  return edgeWords(e, 'mm')
}

/** describeFace in the units shown, for a page: a function of the face
 *  alone, so it maps over a list of faces as describeFace does. */
export const describeFaceIn = (units: DisplayUnits) => (f: FaceFingerprint): string => faceWords(f, units)

/** describeEdge in the units shown, as describeFaceIn. */
export const describeEdgeIn = (units: DisplayUnits) => (e: EdgeFingerprint): string => edgeWords(e, units)
