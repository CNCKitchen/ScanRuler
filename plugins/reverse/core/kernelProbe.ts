// SPDX-License-Identifier: AGPL-3.0-only
// A body read where it stands, without the scan: cut by a plane into the
// kernel's own section edges — a line a line, a round's cut a true circle
// with its centre and radius — and measured at points and along rays: the
// nearest point of the skin, how far it lies and on which side, and where a
// line runs into the body and out of it. What reverse.body.section and
// reverse.body.probe read (reBodyProbe.ts). The part of ReKernel's
// sectionPieces and probe (kernel.ts) that is more than one call to the
// kernel.

import type { Vec3 } from '../../../src/core/types'
import { add, dot, len, normalize, scale, sub } from '../../../src/core/vec'
import { circleThrough, vec, xyz } from './kernelMath'
import { HASH_BOUND, KernelError } from './kernelOps'
import type { Shape } from './kernelTypes'
import type { OcctLike } from './occtTypes'

/** One edge of a body's section, as the kernel holds it. */
export interface CutPiece {
  /** A straight, a circle or an arc of one, or another curve (an
   *  ellipse where a plane cuts a cylinder aslant, a spline). */
  kind: 'line' | 'circle' | 'curve'
  /** The kernel's own name for the curve. */
  curve: string
  /** Its ends, the way the kernel runs it — one point twice for a whole
   *  circle. */
  a: Vec3
  b: Vec3
  length: number
  /** Whether it closes on itself: a whole circle, a closed spline. */
  closed: boolean
  /** A circle's centre and radius. */
  center?: Vec3
  radius?: number
  /** The point a quarter of the way along — which way an arc turns. */
  quarter: Vec3
  /** A curve's points, sampled to the deflection. */
  points?: Vec3[]
  /** The face of the body it lies on, by hash; null where none was
   *  found. */
  face: number | null
}

/** The faces of a shape, each with its box, for the face nearest a point
 *  found without measuring them all: the distance to a face is never less
 *  than the distance to its box, so the faces are measured nearest box
 *  first and the search stops at the first box farther than the best face
 *  so far. */
function faceFinder(occt: OcctLike, shape: Shape) {
  const faces = occt.getSubShapes(shape, 'face')
  const boxes = faces.map((f) => occt.getBoundingBox(f))
  const hashes = new Map<number, number>()
  const hashOf = (i: number) => {
    let h = hashes.get(i)
    if (h === undefined) hashes.set(i, (h = occt.hashCode(faces[i], HASH_BOUND)))
    return h
  }
  const toBox = (p: Vec3, i: number) => {
    const b = boxes[i]
    const dx = Math.max(b.xmin - p[0], 0, p[0] - b.xmax)
    const dy = Math.max(b.ymin - p[1], 0, p[1] - b.ymax)
    const dz = Math.max(b.zmin - p[2], 0, p[2] - b.zmax)
    return Math.hypot(dx, dy, dz)
  }
  return {
    faces,
    hashOf,
    /** The face nearest a point: its index among the faces, its hash and
     *  how far the point lies from it. Null for a shape with no faces. */
    nearest(p: Vec3): { index: number; hash: number; distance: number } | null {
      if (faces.length === 0) return null
      const order = faces.map((_, i) => ({ i, d: toBox(p, i) })).sort((x, y) => x.d - y.d)
      const v = occt.makeVertex(p[0], p[1], p[2])
      try {
        let best: { index: number; distance: number } | null = null
        for (const { i, d } of order) {
          if (best && d > best.distance) break
          const at = occt.distanceBetween(v, faces[i])
          if (!best || at < best.distance) best = { index: i, distance: at }
        }
        return best && { index: best.index, hash: hashOf(best.index), distance: best.distance }
      } finally {
        occt.release(v)
      }
    },
    release() {
      for (const f of faces) occt.release(f)
    },
  }
}

/** A circle's centre and radius from three points of it, in doubles off
 *  the curve itself — exact as the curve is. */
function circleOf(a: Vec3, b: Vec3, c: Vec3): { center: Vec3; radius: number } | null {
  const circle = circleThrough(a, b, c)
  return circle && { center: circle.center, radius: circle.radius }
}

/** A shape cut by the plane through `origin` square to `normal`: each
 *  edge of the kernel's section — exact, not sampled — with what kind of
 *  curve it is, its ends, its length, a circle's centre and radius, and
 *  the face of the shape it lies on. Empty where the plane misses. */
export function cutPieces(occt: OcctLike, shape: Shape, origin: Vec3, normal: Vec3, deflection: number): CutPiece[] {
  const n = normalize(normal)
  if (!n) throw new KernelError('the section needs a normal.')
  const cut = occt.sectionPlane(shape, xyz(origin), xyz(n))
  const finder = faceFinder(occt, shape)
  try {
    if (occt.isNull(cut)) return []
    const edges = occt.getSubShapes(cut, 'edge')
    try {
      return edges.flatMap((e): CutPiece[] => {
        const length = occt.curveLength(e)
        if (!(length > 1e-9)) return []
        const curve = String(occt.curveType(e))
        const { first, last } = occt.curveParameters(e)
        const at = (t: number) => vec(occt.curvePointAtParam(e, first + (last - first) * t))
        const a = at(0)
        const b = at(1)
        const closed = len(sub(a, b)) < 1e-9
        const mid = at(0.5)
        const piece: CutPiece = { kind: 'curve', curve, a, b, length, closed, quarter: at(0.25), face: finder.nearest(mid)?.hash ?? null }
        if (curve === 'line') piece.kind = 'line'
        else if (curve === 'circle') {
          // Three points a third of the way apart: a whole circle's ends
          // are one point.
          const c = circleOf(a, at(1 / 3), at(2 / 3))
          if (c) {
            piece.kind = 'circle'
            piece.center = c.center
            piece.radius = c.radius
          }
        }
        if (piece.kind === 'curve') {
          const wire = occt.wireframe(e, deflection)
          const pts: Vec3[] = []
          for (let i = 0; i + 2 < wire.points.length; i += 3) pts.push([wire.points[i], wire.points[i + 1], wire.points[i + 2]])
          piece.points = pts.length >= 2 ? pts : [a, mid, b]
        }
        return [piece]
      })
    } finally {
      for (const e of edges) occt.release(e)
    }
  } finally {
    finder.release()
    occt.release(cut)
  }
}

/** A point read against a body: how far the skin lies, whether the point
 *  is inside (a solid only), the nearest point of the skin and the face it
 *  lies on, by hash. */
export interface PointReading {
  distance: number
  inside: boolean
  nearest: Vec3
  face: number
}

/** How near the nearest point found must come to the distance measured,
 *  mm, to be taken as the nearest — the kernel measures both in doubles. */
const SAME_MM = 1e-6

/** The point of a face nearest `p`, `d` away: the foot on its surface
 *  where that lies on the face, else the nearest point of its edges (the
 *  foot of a face's surface may lie past the face's edge). */
function nearestOnFace(occt: OcctLike, face: number, p: Vec3, d: number): Vec3 {
  const foot = vec(occt.projectPointOnFace(face, xyz(p)))
  if (Math.abs(len(sub(foot, p)) - d) <= SAME_MM + 1e-9 * d) return foot
  const edges = occt.getSubShapes(face, 'edge')
  const v = occt.makeVertex(p[0], p[1], p[2])
  try {
    let best: { at: Vec3; d: number } = { at: foot, d: len(sub(foot, p)) }
    for (const e of edges) {
      if (occt.distanceBetween(v, e) > best.d) continue
      const on = vec(occt.projectPointOnEdge(e, xyz(p)).point)
      const { first, last } = occt.curveParameters(e)
      for (const q of [on, vec(occt.curvePointAtParam(e, first)), vec(occt.curvePointAtParam(e, last))]) {
        const dq = len(sub(q, p))
        if (dq < best.d) best = { at: q, d: dq }
      }
    }
    return best.at
  } finally {
    occt.release(v)
    for (const e of edges) occt.release(e)
  }
}

/** Points read against a shape (PointReading); null for each where the
 *  shape has no faces. `solid` says whether it has an inside. */
export function probePoints(occt: OcctLike, shape: Shape, points: readonly Vec3[], solid: boolean): (PointReading | null)[] {
  if (points.length === 0) return []
  const finder = faceFinder(occt, shape)
  try {
    return points.map((p) => {
      const near = finder.nearest(p)
      if (!near) return null
      const inside = solid && near.distance > SAME_MM && occt.containsPoint(shape, xyz(p), 1e-7)
      return { distance: near.distance, inside, nearest: nearestOnFace(occt, finder.faces[near.index], p, near.distance), face: near.hash }
    })
  } finally {
    finder.release()
  }
}

/** Where a ray meets a shape's skin: how far along the ray, the point,
 *  the face by hash, and which way it goes there — into a solid (enter),
 *  out of it (leave), through a sheet (cross), or only touching it. */
export interface RayHit {
  t: number
  at: Vec3
  face: number | null
  way: 'enter' | 'leave' | 'cross' | 'touch'
}

/** Points and rays read against one body, as the builder hands them on
 *  (Builder.probe): `solid`, whether it has an inside. */
export interface BodyProbe {
  id: number
  solid: boolean
  points: (PointReading | null)[]
  rays: { hits: RayHit[]; startsInside: boolean }[]
}

/** Two crossings closer than this along a ray, mm, are one — a ray
 *  through an edge meets both its faces there. */
const SAME_HIT_MM = 1e-7

/** A ray from `from` along `dir` read against a shape: every place it
 *  meets the skin, nearest first, and whether it starts inside. The ray is
 *  a line edge from `from` to past the far side of the shape's box, cut by
 *  the shape (the kernel's section of the edge by the faces); a solid's
 *  inside is told by a point between each two crossings. */
export function probeRay(occt: OcctLike, shape: Shape, from: Vec3, dir: Vec3, solid: boolean): { hits: RayHit[]; startsInside: boolean } {
  const d = normalize(dir)
  if (!d) throw new KernelError('a ray needs a direction.')
  const box = occt.getBoundingBox(shape)
  let reach = 0
  for (const x of [box.xmin, box.xmax]) for (const y of [box.ymin, box.ymax]) for (const z of [box.zmin, box.zmax]) reach = Math.max(reach, len(sub([x, y, z], from)))
  const far = reach + 1
  const isInside = (p: Vec3) => occt.containsPoint(shape, xyz(p), 1e-7)
  const startsInside = solid && isInside(from)
  const line = occt.makeLineEdge(xyz(from), xyz(add(from, scale(d, far))))
  const ts: number[] = []
  try {
    const cut = occt.section(line, shape)
    try {
      if (!occt.isNull(cut)) {
        for (const v of occt.getSubShapes(cut, 'vertex')) {
          ts.push(dot(sub(vec(occt.vertexPosition(v)), from), d))
          occt.release(v)
        }
      }
    } finally {
      occt.release(cut)
    }
  } finally {
    occt.release(line)
  }
  ts.sort((x, y) => x - y)
  const along = ts.filter((t, i) => t >= -SAME_HIT_MM && (i === 0 || t - ts[i - 1] > SAME_HIT_MM)).map((t) => Math.max(0, t))
  if (along.length === 0) return { hits: [], startsInside }
  const point = (t: number) => add(from, scale(d, t))
  // Inside or not on each stretch between two crossings, read at its
  // middle; before the first, where the ray starts; past the last, the
  // ray is outside the box.
  const inside: boolean[] = [startsInside]
  for (let i = 0; i < along.length; i++) inside.push(solid && i + 1 < along.length && isInside(point((along[i] + along[i + 1]) / 2)))
  const finder = faceFinder(occt, shape)
  try {
    const hits: RayHit[] = along.map((t, i) => {
      const at = point(t)
      const before = inside[i]
      const after = inside[i + 1]
      const way: RayHit['way'] = !solid ? 'cross' : !before && after ? 'enter' : before && !after ? 'leave' : 'touch'
      return { t, at, face: finder.nearest(at)?.hash ?? null, way }
    })
    // A ray that starts on the skin crosses nothing there.
    return { hits: hits.filter((h) => !(h.t === 0 && h.way === 'touch')), startsInside }
  } finally {
    finder.release()
  }
}
