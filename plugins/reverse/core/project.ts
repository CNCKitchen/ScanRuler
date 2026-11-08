// SPDX-License-Identifier: AGPL-3.0-only
// Geometry that is already there, brought into a sketch: the edges of a
// body and the pieces of another sketch projected onto the sketch plane as
// pieces of this one — the way Fusion's Project and Onshape's Use bring the
// model into the sketch. A projected piece is an ordinary line, arc or
// circle, fixed where it landed and marked `projected`, so every relation
// and dimension the sketcher has can be hung on it and the solver moves the
// drawn pieces to it, never it to them. A sketch opened on a flat face of a
// body starts with that face's outline projected, which is a closed profile
// the moment the sheet opens.
//
// A projection follows what it was taken from, as CAD's does: the piece
// keeps its source — the edge by its fingerprint, the other sketch's piece
// by its id — and every build takes it again from there before the
// features on the sketch are built (build.ts placeSketch), the drawn
// pieces held to it following through their relations. A source the build
// no longer finds leaves the piece where it last was.
//
// What projects: a straight edge (a line, or a point seen end on), a
// circular edge whose plane is the sketch plane's (a circle or an arc) or
// stands square to it (the line it is seen as), and anything else that
// happens to land on a line. A circle seen at a slant is an ellipse, which
// the sketcher has no piece for; it is not offered.

import type { Vec2 } from '../../../src/core/flat/types'
import { len2, sub2 } from '../../../src/core/flat/vec2'
import type { SectionFrame } from '../../../src/core/section/frame'
import type { Vec3 } from '../../../src/core/types'
import { dot, sub } from '../../../src/core/vec'
import { liftPoint } from './features'
import { arcThrough, entityPolyline, type EntityInput, type SketchEntity } from './sketch'
import type { EdgeFingerprint } from './topo'
import { distToSegment2 } from '../../../src/core/flat/vec2'

/** Something on offer to a sketch's Project tool: the piece it would
 *  become and the polyline a click is tested against, sheet millimetres. */
export interface Projectable {
  entity: EntityInput
  polyline: Vec2[]
  /** What it is, for the status line: "an edge of Extrude 1". */
  source: string
}

/** Shorter than this on the sheet, a projected line is a point. */
const POINT_MM = 1e-6
/** How far off a line the projected points may wander and still be one,
 *  as a share of its length. */
const LINE_FLATNESS = 1e-6

function toSheet(frame: SectionFrame, p: Vec3): Vec2 {
  const d = sub(p, frame.origin)
  return [dot(d, frame.basisU), dot(d, frame.basisV)]
}

function polylineOnSheet(frame: SectionFrame, xyz: ArrayLike<number>): Vec2[] {
  const out: Vec2[] = []
  for (let i = 0; i + 2 < xyz.length; i += 3) out.push(toSheet(frame, [xyz[i], xyz[i + 1], xyz[i + 2]]))
  return out
}

const fixed = { fixed: true, projected: true } as const

/** The line through the two points of a run furthest apart, when every
 *  point of the run lies on it; null when the run bends. */
function asLine(points: readonly Vec2[]): EntityInput | null {
  if (points.length < 2) return null
  let a = points[0]
  let b = points[points.length - 1]
  // A closed run seen edge on starts and ends at the same place: take the
  // extremes along the run's longest direction instead.
  let far = 0
  for (const p of points) {
    const d = len2(sub2(p, points[0]))
    if (d > far) {
      far = d
      b = p
    }
  }
  far = 0
  for (const p of points) {
    const d = len2(sub2(p, b))
    if (d > far) {
      far = d
      a = p
    }
  }
  const length = len2(sub2(b, a))
  if (length < POINT_MM) return { kind: 'point', p: a, ...fixed }
  const nx = -(b[1] - a[1]) / length
  const ny = (b[0] - a[0]) / length
  for (const p of points) if (Math.abs((p[0] - a[0]) * nx + (p[1] - a[1]) * ny) > Math.max(length * LINE_FLATNESS, 1e-7)) return null
  return { kind: 'line', a, b, ...fixed }
}

/** A body's edge as it is offered for projection: the kernel's drawing of
 *  it, its fingerprint saying what it is, and — from a body's topology —
 *  its two ends as the kernel has them. */
export interface ProjectedEdge {
  fingerprint: EdgeFingerprint
  polyline: ArrayLike<number>
  ends?: readonly [Vec3, Vec3]
}

/**
 * A body's edge as a piece of a sketch on `frame`, or null when it does not
 * project to a line, an arc or a circle. The edge comes as the kernel drew
 * it — a polyline — with its fingerprint saying what it is.
 *
 * The polyline is a drawing, in 32-bit floats: good to a hundredth of a
 * micron, which is further than the kernel lets two faces lie apart and
 * still be one plane. So what the polyline decides is only what the edge
 * projects to; where a line or an arc lands is taken from the edge's own
 * ends and middle, and a body pulled out of a face's outline has walls
 * that merge with the ones they continue.
 */
export function projectEdge(edge: ProjectedEdge, frame: SectionFrame): EntityInput | null {
  const drawn = projectDrawn(edge, frame)
  if (!drawn || !edge.ends) return drawn
  const a = toSheet(frame, edge.ends[0])
  const b = toSheet(frame, edge.ends[1])
  if (drawn.kind === 'line' && edge.fingerprint.kind === 'line') return len2(sub2(b, a)) < POINT_MM ? drawn : { ...drawn, a, b }
  if (drawn.kind === 'arc') {
    const arc = arcThrough(a, b, toSheet(frame, edge.fingerprint.mid))
    return arc ? { ...drawn, c: arc.c, r: arc.r, start: arc.start, sweep: arc.sweep } : drawn
  }
  return drawn
}

function projectDrawn(edge: ProjectedEdge, frame: SectionFrame): EntityInput | null {
  const points = polylineOnSheet(frame, edge.polyline)
  if (points.length < 2) return null
  const fp = edge.fingerprint
  if (fp.kind === 'circle') {
    const along = Math.abs(dot(fp.dir, frame.normal))
    if (along > 1 - 1e-9) {
      const first = points[0]
      const last = points[points.length - 1]
      const mid = points[points.length >> 1]
      const radius = fp.radius ?? 0
      if (len2(sub2(first, last)) < Math.max(radius, 1) * 1e-6) {
        // All the way round: the centre is opposite-point arithmetic away.
        const c: Vec2 = [(first[0] + mid[0]) / 2, (first[1] + mid[1]) / 2]
        const quarter = points[points.length >> 2]
        const arc = arcThrough(first, mid, quarter)
        return { kind: 'circle', c: arc ? arc.c : c, r: arc ? arc.r : len2(sub2(first, c)), ...fixed }
      }
      const arc = arcThrough(first, last, mid)
      return arc ? { kind: 'arc', c: arc.c, r: arc.r, start: arc.start, sweep: arc.sweep, ...fixed } : null
    }
    // Seen edge on it is the line it spans; at a slant, an ellipse.
    return along < 1e-6 ? asLine(points) : null
  }
  return asLine(points)
}

/** A piece of another sketch as a piece of this one, or null — the same
 *  rules, the other sketch's piece taken as the curve it is. */
export function projectSketchEntity(e: SketchEntity, from: SectionFrame, onto: SectionFrame): EntityInput | null {
  if (e.kind === 'point') return { kind: 'point', p: toSheet(onto, liftPoint(from, e.p)), ...fixed }
  if (e.kind === 'spline') {
    // Onto a parallel plane the sheet is carried rigidly — turned, moved,
    // perhaps mirrored — and the curve through the points carried is the
    // curve carried. At a slant it is stretched, and the curve through the
    // stretched points another curve: not offered.
    if (Math.abs(dot(from.normal, onto.normal)) < 1 - 1e-9) return null
    const dirOf = (angle: number) => {
      const d = sub(liftPoint(from, [Math.cos(angle), Math.sin(angle)]), from.origin)
      return Math.atan2(dot(d, onto.basisV), dot(d, onto.basisU))
    }
    return {
      kind: 'spline',
      pts: e.pts.map((p) => toSheet(onto, liftPoint(from, p))),
      ...(e.closed ? { closed: true } : {}),
      ...(e.startDir !== undefined ? { startDir: dirOf(e.startDir) } : {}),
      ...(e.endDir !== undefined ? { endDir: dirOf(e.endDir) } : {}),
      ...fixed,
    }
  }
  const lifted = entityPolyline(e, 64).flatMap((p) => liftPoint(from, p))
  if (e.kind === 'line') return asLine(polylineOnSheet(onto, lifted))
  const fingerprint: EdgeFingerprint = { kind: 'circle', mid: [0, 0, 0], dir: from.normal, length: 0, radius: e.r, faces: [], origin: -1 }
  return projectEdge({ fingerprint, polyline: lifted }, onto)
}

/** The outline of a body's face as pieces of a sketch on the face: every
 *  edge bounding it that projects, and how many did not — a spline's edge
 *  leaves the outline open, and the caller says so. Given the body, each
 *  piece keeps its edge as its source and follows it. */
export function projectFaceOutline(edges: readonly ProjectedEdge[], frame: SectionFrame, body?: number): { entities: EntityInput[]; skipped: number } {
  const entities: EntityInput[] = []
  let skipped = 0
  for (const edge of edges) {
    const e = projectEdge(edge, frame)
    if (e && e.kind !== 'point') entities.push(body === undefined ? e : { ...e, source: { body, edge: edge.fingerprint } })
    else if (!e) skipped++
  }
  return { entities, skipped }
}

/** A projected piece taken again: the piece, its id, flags and source
 *  kept, where the fresh projection of its source puts it — or null when
 *  the source no longer projects to a piece of the same kind (a line seen
 *  end on now, a circle at a slant), which leaves it where it was. An arc
 *  keeps the end its relations hang on: the fresh one is turned to start
 *  where it started. */
export function retake(piece: SketchEntity, fresh: EntityInput | null): SketchEntity | null {
  if (!fresh || fresh.kind !== piece.kind) return null
  switch (fresh.kind) {
    case 'line': {
      if (piece.kind !== 'line') return null
      // The ends as they were: a and b swapped would swap the relations.
      const kept = len2(sub2(fresh.a, piece.a)) + len2(sub2(fresh.b, piece.b))
      const swapped = len2(sub2(fresh.b, piece.a)) + len2(sub2(fresh.a, piece.b))
      return swapped < kept ? { ...piece, a: fresh.b, b: fresh.a } : { ...piece, a: fresh.a, b: fresh.b }
    }
    case 'arc':
      return piece.kind === 'arc' ? { ...piece, c: fresh.c, r: fresh.r, start: fresh.start, sweep: fresh.sweep } : null
    case 'circle':
      return piece.kind === 'circle' ? { ...piece, c: fresh.c, r: fresh.r } : null
    case 'spline': {
      // Another sketch's spline, its fit points as many as before — the
      // relations hang on them by their place.
      if (piece.kind !== 'spline' || fresh.pts.length !== piece.pts.length) return null
      const { startDir: _s, endDir: _e, ...rest } = piece
      void _s
      void _e
      return { ...rest, pts: fresh.pts, ...(fresh.startDir !== undefined ? { startDir: fresh.startDir } : {}), ...(fresh.endDir !== undefined ? { endDir: fresh.endDir } : {}) }
    }
    case 'point':
      return piece.kind === 'point' ? { ...piece, p: fresh.p } : null
  }
}

/** How far a piece taken again moved, millimetres: the most any of its
 *  defining points went. An arc is measured on its curve — its ends and its
 *  middle — not by its centre: a near-flat arc's centre swings tens of
 *  millimetres while the curve itself hardly shifts. */
export function retakeMoved(was: SketchEntity, now: SketchEntity): number {
  const d = (p: Vec2, q: Vec2) => len2(sub2(p, q))
  if (was.kind === 'line' && now.kind === 'line') return Math.max(d(was.a, now.a), d(was.b, now.b))
  if (was.kind === 'point' && now.kind === 'point') return d(was.p, now.p)
  if (was.kind === 'spline' && now.kind === 'spline') return was.pts.length === now.pts.length ? Math.max(0, ...was.pts.map((p, i) => d(p, now.pts[i]))) : Infinity
  if (was.kind === 'arc' && now.kind === 'arc') {
    const at = (e: typeof was, t: number): Vec2 => [e.c[0] + e.r * Math.cos(e.start + t * e.sweep), e.c[1] + e.r * Math.sin(e.start + t * e.sweep)]
    return Math.max(d(at(was, 0), at(now, 0)), d(at(was, 0.5), at(now, 0.5)), d(at(was, 1), at(now, 1)))
  }
  if (was.kind === 'circle' && now.kind === 'circle') return Math.max(d(was.c, now.c), Math.abs(was.r - now.r))
  return Infinity
}

/** How far a piece's own curve moved, mm, what its ends did aside: a line
 *  cut back along itself or an arc trimmed on its circle moved nothing, as a
 *  corner rounded does to them. Infinity for a piece of another kind. */
export function curveMoved(was: SketchEntity, now: SketchEntity): number {
  if (was.kind === 'line' && now.kind === 'line') {
    const dx = was.b[0] - was.a[0]
    const dy = was.b[1] - was.a[1]
    const l = Math.hypot(dx, dy)
    // Collapsed to a point, it has moved however it lies.
    if (l < 1e-9 || Math.hypot(now.b[0] - now.a[0], now.b[1] - now.a[1]) < 1e-6) return retakeMoved(was, now)
    const off = (p: Vec2) => Math.abs((p[0] - was.a[0]) * dy - (p[1] - was.a[1]) * dx) / l
    return Math.max(off(now.a), off(now.b))
  }
  if (was.kind === 'arc' && now.kind === 'arc') {
    // The new arc's points against the old circle, as a line's ends against
    // the old line: a near-flat arc's centre swings millimetres while the
    // curve itself hardly shifts (R115.6 to R119.9 read 8.6 mm by the
    // centre, under 0.1 on the curve).
    let far = 0
    for (let i = 0; i <= ARC_SAMPLES; i++) {
      const t = now.start + (i / ARC_SAMPLES) * now.sweep
      const p: Vec2 = [now.c[0] + now.r * Math.cos(t), now.c[1] + now.r * Math.sin(t)]
      far = Math.max(far, Math.abs(len2(sub2(p, was.c)) - was.r))
    }
    return far
  }
  return retakeMoved(was, now)
}

/** How many spans an arc is sampled in for curveMoved. */
const ARC_SAMPLES = 16

/** The projectable nearest a sheet point within reach, or null. */
export function projectableAt(candidates: readonly Projectable[], spot: Vec2, radius: number): Projectable | null {
  let best: Projectable | null = null
  let bestD = radius
  for (const c of candidates) {
    const p = c.polyline
    if (p.length === 1) {
      const d = len2(sub2(p[0], spot))
      if (d <= bestD) {
        bestD = d
        best = c
      }
      continue
    }
    for (let i = 0; i + 1 < p.length; i++) {
      const d = distToSegment2(spot, p[i], p[i + 1])
      if (d <= bestD) {
        bestD = d
        best = c
      }
    }
  }
  return best
}
