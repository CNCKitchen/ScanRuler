// SPDX-License-Identifier: AGPL-3.0-only
// reverse.body.section and reverse.body.probe: the bodies read where they
// stand, with or without a scan — cut by a plane into the kernel's own
// lines and arcs, and measured at points and along rays. What an agent
// building a part from a drawing checks the part against the drawing by:
// a width, a thickness, a radius, an outline. Neither changes anything.

import { invalid } from '../../../src/commands/core/common'
import { arr, num, obj, validate, vec3 } from '../../../src/commands/schema'
import { errorMessage } from '../../../src/commands/types'
import type { Vec2 } from '../../../src/core/flat/types'
import type { SectionFrame } from '../../../src/core/section/frame'
import type { Vec3 } from '../../../src/core/types'
import { dot, len, normalize, sub } from '../../../src/core/vec'
import { type Command, CommandError } from '../../../src/plugins/api'
import type { PlaneRef } from '../core/features'
import type { BodyProbe, CutPiece, RayHit } from '../core/kernelProbe'
import { resolvePlaneFrame } from '../core/resolve'
import { faceLookup } from './reBodyCommands'
import { bodyNamed, type Json, planeOf, re, ready, type Ref } from './reCommandCore'
import { bodyRef, planeIn } from './reSchemas'
import type { ReverseSession } from './reSession'
import { planeAtOffset, planeField } from './reSectionCommands'

/** How many offsets a section takes at most, and points and rays a probe. */
const SECTION_MAX = 60

const PROBE_MAX = 200

/** The chord a curve other than a line or a circle is sampled to, mm. */
const CURVE_CHORD_MM = 0.01

/** How near two ends of the section's edges must lie to join, mm — the
 *  kernel's section shares its vertices, so they meet to its tolerance. */
const JOIN_MM = 1e-5

/** A point that lies within this of the skin is on it, mm. */
const ON_MM = 1e-6

/** Numbers to the millionth of a millimetre — the geometry is exact, and
 *  the float's tail says nothing — with no negative zero. */
const r6 = (x: number) => Math.round(x * 1e6) / 1e6 + 0
const r6s = (p: readonly number[]) => p.map(r6)

const toDeg = (rad: number) => (rad * 180) / Math.PI

/** The bodies a command reads: those named, or the visible solids. */
function bodiesOf(bodies: Ref[] | undefined) {
  const picked = bodies ? bodies.map(bodyNamed) : re().bodies.filter((b) => b.visible && !b.surface)
  if (picked.length === 0) throw new CommandError('invalid_state', bodies ? 'None of the bodies named is built.' : 'There is no visible solid body — build one first, or name the bodies.')
  return picked
}

/** The plane's frame, as a sketch on it takes it. */
function frameOf(s: ReverseSession, ref: PlaneRef): SectionFrame {
  const frame = ref.kind === 'bodyFace' || ref.kind === 'fitted' ? ref.frame : resolvePlaneFrame(ref, s.resolveContext())
  if (!frame) throw new CommandError('not_found', 'That plane is not there any more.')
  return frame
}

/** A piece of a cut on the plane's sheet, running the way its chain runs. */
interface SheetPiece {
  src: CutPiece
  /** Whether it runs against the kernel's own way. */
  reversed: boolean
  kind: 'line' | 'arc' | 'circle' | 'curve'
  a: Vec2
  b: Vec2
  center?: Vec2
  radius?: number
  /** An arc's start angle and signed sweep, radians counter-clockwise
   *  from +u. */
  start?: number
  sweep?: number
  points?: Vec2[]
}

const cross2 = (p: Vec2, q: Vec2) => p[0] * q[1] - p[1] * q[0]

/** A piece of the kernel's section on the sheet, the kernel's way. */
function onSheet(p: CutPiece, frame: SectionFrame): SheetPiece {
  const at = (w: Vec3): Vec2 => {
    const d = sub(w, frame.origin)
    return [dot(d, frame.basisU), dot(d, frame.basisV)]
  }
  const a = at(p.a)
  const b = at(p.b)
  if (p.kind === 'line') return { src: p, reversed: false, kind: 'line', a, b }
  if (p.kind === 'circle' && p.center && p.radius) {
    const c = at(p.center)
    const q = at(p.quarter)
    const way = cross2([a[0] - c[0], a[1] - c[1]], [q[0] - c[0], q[1] - c[1]]) < 0 ? -1 : 1
    return { src: p, reversed: false, kind: p.closed ? 'circle' : 'arc', a, b, center: c, radius: p.radius, start: Math.atan2(a[1] - c[1], a[0] - c[0]), sweep: way * (p.closed ? 2 * Math.PI : p.length / p.radius) }
  }
  return { src: p, reversed: false, kind: 'curve', a, b, points: (p.points ?? [p.a, p.b]).map(at) }
}

/** The same piece run the other way. */
function reversedPiece(p: SheetPiece): SheetPiece {
  const out: SheetPiece = { ...p, reversed: !p.reversed, a: p.b, b: p.a }
  if (p.start !== undefined && p.sweep !== undefined) {
    out.start = p.start + p.sweep
    out.sweep = -p.sweep
  }
  if (p.points) out.points = [...p.points].reverse()
  return out
}

/** A piece's ends in the world, the way it runs. */
const worldEnds = (p: SheetPiece): [Vec3, Vec3] => (p.reversed ? [p.src.b, p.src.a] : [p.src.a, p.src.b])

/** The pieces of a body's cut joined end to end into chains — a closed
 *  chain counter-clockwise on the sheet — each piece running the way its
 *  chain does. */
export function chainPieces(pieces: readonly CutPiece[], frame: SectionFrame): { pieces: SheetPiece[]; closed: boolean }[] {
  const sheet = pieces.map((p) => onSheet(p, frame))
  const used = new Set<number>()
  const chains: { pieces: SheetPiece[]; closed: boolean }[] = []
  const near = (p: Vec3, q: Vec3) => len(sub(p, q)) <= JOIN_MM
  // The unused piece with an end at `at`, run so that end is its start
  // (`from`) or its end (to).
  const take = (at: Vec3, end: 'start' | 'end'): SheetPiece | null => {
    let best: { i: number; d: number; flip: boolean } | null = null
    sheet.forEach((p, i) => {
      if (used.has(i) || p.src.closed) return
      for (const flip of [false, true]) {
        const [s, e] = flip ? [p.src.b, p.src.a] : [p.src.a, p.src.b]
        const d = len(sub(end === 'start' ? s : e, at))
        if (d <= JOIN_MM && (!best || d < best.d)) best = { i, d, flip }
      }
    })
    if (!best) return null
    const { i, flip } = best as { i: number; flip: boolean }
    used.add(i)
    return flip ? reversedPiece(sheet[i]) : sheet[i]
  }
  sheet.forEach((first, i) => {
    if (used.has(i)) return
    used.add(i)
    if (first.src.closed) {
      chains.push({ pieces: [first], closed: true })
      return
    }
    const run = [first]
    const startAt = () => worldEnds(run[0])[0]
    const endAt = () => worldEnds(run[run.length - 1])[1]
    for (let next = take(endAt(), 'start'); next && !near(endAt(), startAt()); next = near(endAt(), startAt()) ? null : take(endAt(), 'start')) run.push(next)
    if (!near(endAt(), startAt())) for (let prev = take(startAt(), 'end'); prev; prev = take(startAt(), 'end')) run.unshift(prev)
    chains.push({ pieces: run, closed: near(endAt(), startAt()) })
  })
  // Closed chains counter-clockwise on the sheet.
  return chains.map((c) => (c.closed && signedArea(c.pieces) < 0 ? { closed: true, pieces: [...c.pieces].reverse().map(reversedPiece) } : c))
}

/** The area a closed chain encloses on the sheet, counter-clockwise
 *  positive: half the integral of u dv − v du round it, exact on lines and
 *  arcs, on a curve's samples. */
export function signedArea(pieces: readonly SheetPiece[]): number {
  let twice = 0
  for (const p of pieces) {
    if ((p.kind === 'arc' || p.kind === 'circle') && p.center && p.radius !== undefined && p.start !== undefined && p.sweep !== undefined) {
      const [cx, cy] = p.center
      const r = p.radius
      const t0 = p.start
      const t1 = p.start + p.sweep
      twice += r * cx * (Math.sin(t1) - Math.sin(t0)) - r * cy * (Math.cos(t1) - Math.cos(t0)) + r * r * p.sweep
    } else {
      const pts = p.points ?? [p.a, p.b]
      for (let i = 0; i + 1 < pts.length; i++) twice += cross2(pts[i], pts[i + 1])
    }
  }
  return twice / 2
}

/** A chain's box on the sheet: a line's ends, an arc's ends and the
 *  quarter turns it passes, a curve's samples. */
function boundsOf(pieces: readonly SheetPiece[]): { min: Vec2; max: Vec2 } {
  const min: Vec2 = [Infinity, Infinity]
  const max: Vec2 = [-Infinity, -Infinity]
  const take = (p: Vec2) => {
    for (const k of [0, 1]) {
      min[k] = Math.min(min[k], p[k])
      max[k] = Math.max(max[k], p[k])
    }
  }
  for (const p of pieces) {
    take(p.a)
    take(p.b)
    if (p.points) p.points.forEach(take)
    if (p.center && p.radius !== undefined && p.start !== undefined && p.sweep !== undefined) {
      const lo = Math.min(p.start, p.start + p.sweep)
      const hi = Math.max(p.start, p.start + p.sweep)
      for (let k = Math.ceil(lo / (Math.PI / 2)); k * (Math.PI / 2) <= hi; k++) take([p.center[0] + p.radius * Math.cos((k * Math.PI) / 2), p.center[1] + p.radius * Math.sin((k * Math.PI) / 2)])
    }
  }
  return { min, max }
}

/** A piece as the answer gives it — as reverse.section.fit gives a fitted
 *  one — with the face of the body it lies on. */
function pieceOut(p: SheetPiece, id: number, face: Json | null): Json {
  const [wa, wb] = worldEnds(p)
  const length = r6(p.src.length)
  const on = face ? { face } : {}
  if (p.kind === 'line') {
    const angle = ((toDeg(Math.atan2(p.b[1] - p.a[1], p.b[0] - p.a[0])) % 180) + 180) % 180
    return { id, kind: 'line', a: r6s(p.a), b: r6s(p.b), length, angleDeg: r6(angle), leanDeg: r6(Math.min(angle % 90, 90 - (angle % 90))), world: { a: r6s(wa), b: r6s(wb) }, ...on }
  }
  if (p.kind === 'circle' || p.kind === 'arc') {
    const center = r6s(p.center!)
    const world = { center: r6s(p.src.center!) }
    if (p.kind === 'circle') return { id, kind: 'circle', center, radius: r6(p.radius!), diameter: r6(2 * p.radius!), length, world, ...on }
    return { id, kind: 'arc', center, radius: r6(p.radius!), diameter: r6(2 * p.radius!), start: r6(p.start!), sweep: r6(p.sweep!), sweepDeg: r6(toDeg(p.sweep!)), a: r6s(p.a), b: r6s(p.b), length, world: { ...world, a: r6s(wa), b: r6s(wb) }, ...on }
  }
  return { id, kind: 'curve', curve: p.src.curve, a: r6s(p.a), b: r6s(p.b), length, points: (p.points ?? []).map((q) => r6s(q)), world: { a: r6s(wa), b: r6s(wb) }, ...on }
}

export const bodySection: Command<{ plane: Json | string; offsets?: number[]; bodies?: Ref[] }> = {
  name: 'section',
  title: 'Cut the bodies at a plane',
  description:
    'The bodies cut at a plane as exact geometry — the kernel’s own section edges, not a fit: a straight is a line, a round’s cut a circle with its true centre and radius — the check of a part built from a drawing, with or without a scan. plane is what a sketch and reverse.section.stack take: a coordinate plane ("XY", { kind: "world", axis }), a section, a measured plane, or a flat face of a body; offsets as reverse.section.stack takes them — the coordinate on a coordinate plane, else mm along the plane’s normal — each a level of its own; without offsets, the plane as given. Per level and per body, each chain: closed, area (a closed chain’s; every closed chain runs counter-clockwise on the sheet, a hole’s too), length, bounds and size on the sheet, and its pieces in order, as reverse.section.fit gives a fitted one — a line by a, b, length, angleDeg (from +u) and leanDeg; an arc by center, radius, diameter, start and sweep (radians counter-clockwise from +u), a, b and length; a whole circle by center, radius, diameter; another curve (an ellipse, a spline) by its ends and points — each also in world [x, y, z] and with the face it lies on (index as reverse.body.describe gives it, kind, madeBy). [u, v] are the plane’s sheet as a sketch on it counts them (reverse.plane.describe gives the frame). The visible solid bodies by default, or those named — a sheet gives open chains. Changes nothing.',
  input: obj(
    {
      plane: planeField('The plane as a sketch takes it ({ kind: "world" | "section" | "plane" | "bodyFace", … }); on a coordinate plane the offsets are the coordinate, else mm along its normal.'),
      offsets: arr(num('mm'), `The offsets, in any order; ${SECTION_MAX} at most. Without them, the plane as given.`, { minItems: 1, maxItems: SECTION_MAX }),
      bodies: arr(bodyRef, 'The bodies; the visible solid ones by default.', { minItems: 1 }),
    },
    ['plane'],
  ),
  readOnly: true,
  run: async ({ plane, offsets, bodies }) => {
    const errors = validate(planeIn, plane, 'input.plane')
    if (errors.length > 0) invalid(errors.join('; '))
    const s = await ready()
    const picked = bodiesOf(bodies)
    const client = s.client()
    if (!client) throw new CommandError('unavailable', 'The CAD kernel is not running.')
    const { bodyName, faceOf } = faceLookup(s)
    const levels = offsets ? [...offsets].sort((a, b) => a - b).map((o) => ({ offset: o as number | undefined, ref: planeAtOffset(s, plane, o) })) : [{ offset: undefined, ref: planeOf(s, plane) }]
    let first: SectionFrame | null = null
    const out = []
    for (const { offset, ref } of levels) {
      const frame = frameOf(s, ref)
      first ??= frame
      const cut = await client.bodySection(picked.map((b) => b.id), frame.origin, frame.normal, CURVE_CHORD_MM).catch((e) => {
        throw new CommandError('failed', errorMessage(e))
      })
      const chains = cut.flatMap(({ id, pieces }) =>
        chainPieces(pieces, frame).map((c, index) => {
          const bounds = boundsOf(c.pieces)
          const area = c.closed ? signedArea(c.pieces) : null
          return {
            body: { id, name: bodyName(id) },
            index,
            closed: c.closed,
            ...(area !== null ? { area: r6(area) } : {}),
            length: r6(c.pieces.reduce((sum, p) => sum + p.src.length, 0)),
            bounds: { min: r6s(bounds.min), max: r6s(bounds.max) },
            size: [r6(bounds.max[0] - bounds.min[0]), r6(bounds.max[1] - bounds.min[1])],
            pieces: c.pieces.map((p, i) => pieceOut(p, i + 1, p.src.face !== null ? faceOf(id, p.src.face) : null)),
          }
        }),
      )
      out.push({ ...(offset !== undefined ? { offset } : {}), origin: r6s(frame.origin), chains, ...(chains.length === 0 ? { missed: 'the plane misses the bodies here' } : {}) })
    }
    return {
      plane: { origin: r6s(first!.origin), normal: r6s(first!.normal), basisU: r6s(first!.basisU), basisV: r6s(first!.basisV) },
      read: 'exact: the kernel’s section edges',
      bodies: picked.map((b) => ({ id: b.id, name: b.name })),
      levels: out,
    }
  },
}

/** A ray as the probe takes it. */
interface RayIn {
  from: Vec3
  dir: Vec3
}

export const bodyProbe: Command<{ points?: Vec3[]; rays?: RayIn[]; bodies?: Ref[] }> = {
  name: 'probe',
  title: 'Measure on the bodies',
  description:
    'The bodies measured at points and along rays, exactly, with or without a scan — how a part built from a drawing is checked against it: "at y = −60 the width is 84.10", "the thickness at (40, −60) is 11.30". Each point: the nearest point of the bodies’ skin (nearest), its distance — signed, negative inside a solid — and side (inside, outside or on; off for a sheet), the body and the face it lies on (index as reverse.body.describe gives it, kind, madeBy). Each ray { from, dir }: every crossing with the skin along it, nearest first — t (mm from from), at, way (enter, leave; touch where it only grazes; cross for a sheet), body and face — then span, from the first entry to the last exit (from, to, length, and the two points: a width or a thickness read directly), and material, the length of the ray inside the solids (span less any holes it crosses); startsInside when from lies inside a solid, its span then starting at 0. A ray runs one way from from; start it outside the part to read a whole width. The visible solid bodies by default, or those named. Changes nothing.',
  input: obj({
    points: arr(vec3('A point, [x, y, z] mm.'), `Points to read; ${PROBE_MAX} at most.`, { minItems: 1, maxItems: PROBE_MAX }),
    rays: arr(obj({ from: vec3('Where the ray starts, [x, y, z] mm.'), dir: vec3('The way it runs, any length.') }, ['from', 'dir']), `Rays to cast; ${PROBE_MAX} at most.`, { minItems: 1, maxItems: PROBE_MAX }),
    bodies: arr(bodyRef, 'The bodies; the visible solid ones by default.', { minItems: 1 }),
  }),
  readOnly: true,
  run: async ({ points = [], rays = [], bodies }) => {
    if (points.length === 0 && rays.length === 0) invalid('Give points, rays, or both.')
    rays.forEach((r, i) => {
      if (!normalize(r.dir)) invalid(`rays[${i}].dir: a ray needs a direction — give one of some length.`)
    })
    const s = await ready()
    const picked = bodiesOf(bodies)
    const client = s.client()
    if (!client) throw new CommandError('unavailable', 'The CAD kernel is not running.')
    const read: BodyProbe[] = await client.bodyProbe(picked.map((b) => b.id), points, rays).catch((e) => {
      throw new CommandError('failed', errorMessage(e))
    })
    const { bodyName, faceOf } = faceLookup(s)
    const pointsOut = points.map((at, i) => {
      // The body whose skin lies nearest.
      let best: { body: BodyProbe; r: NonNullable<BodyProbe['points'][number]> } | null = null
      for (const body of read) {
        const r = body.points[i]
        if (r && (!best || r.distance < best.r.distance)) best = { body, r }
      }
      if (!best) return { at, nearest: null }
      const { body, r } = best
      const side = r.distance <= ON_MM ? 'on' : !body.solid ? 'off' : r.inside ? 'inside' : 'outside'
      return { at, distance: r6(r.inside ? -r.distance : r.distance), side, nearest: r6s(r.nearest), body: { id: body.id, name: bodyName(body.id) }, face: faceOf(body.id, r.face) }
    })
    const raysOut = rays.map((ray, i) => {
      const dir = normalize(ray.dir)!
      const hits = read.flatMap((body) => body.rays[i].hits.map((h) => ({ h, body })))
      hits.sort((x, y) => x.h.t - y.h.t)
      const startsInside = read.some((body) => body.solid && body.rays[i].startsInside)
      // The length inside each solid, walked along its own crossings.
      let material = 0
      for (const body of read) {
        if (!body.solid) continue
        let from: number | null = body.rays[i].startsInside ? 0 : null
        for (const h of body.rays[i].hits) {
          if (h.way === 'enter' && from === null) from = h.t
          else if (h.way === 'leave' && from !== null) {
            material += h.t - from
            from = null
          }
        }
      }
      const enters = hits.filter((x) => x.h.way === 'enter')
      const leaves = hits.filter((x) => x.h.way === 'leave')
      const spanFrom = startsInside ? 0 : enters[0]?.h.t
      const spanTo = leaves[leaves.length - 1]?.h.t
      const at = (t: number) => r6s(ray.from.map((c, k) => c + dir[k] * t))
      const span = spanFrom !== undefined && spanTo !== undefined && spanTo > spanFrom ? { from: r6(spanFrom), to: r6(spanTo), length: r6(spanTo - spanFrom), a: at(spanFrom), b: at(spanTo) } : null
      const hitOut = ({ h, body }: { h: RayHit; body: BodyProbe }) => ({ t: r6(h.t), at: r6s(h.at), way: h.way, body: { id: body.id, name: bodyName(body.id) }, face: h.face !== null ? faceOf(body.id, h.face) : null })
      return { from: ray.from, dir: r6s(dir), ...(startsInside ? { startsInside: true } : {}), hits: hits.map(hitOut), span, material: r6(material) }
    })
    return { bodies: picked.map((b) => ({ id: b.id, name: b.name })), ...(points.length > 0 ? { points: pointsOut } : {}), ...(rays.length > 0 ? { rays: raysOut } : {}) }
  },
}
