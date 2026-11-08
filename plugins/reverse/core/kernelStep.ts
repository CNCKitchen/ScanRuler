// SPDX-License-Identifier: AGPL-3.0-only
// The STEP writer gets the loop of one kind of round wrong, and the file is
// mended after it; a round's curve that ends a hair off its corner reads
// back as a hole, and the file is mended there too: the part of ReKernel's
// exportStep (kernel.ts) that is more than one call to the kernel.

import type { Vec3 } from '../../../src/core/types'
import { add, cross, dot, len, scale, sub } from '../../../src/core/vec'
import { vec } from './kernelMath'
import type { Shape } from './kernelTypes'
import type { OcctLike } from './occtTypes'

/** The step, in radians, a torus's parameters are stepped by to tell its
 *  hand: small enough to stay on one side of the tube, large enough that
 *  the tube's curve across two steps stands far above rounding. */
const HAND_STEP = 0.01

/** Points an edge is sampled at to unroll a loop: enough that the loop's
 *  area comes out right to far better than its sign. */
const EDGE_SAMPLES = 64

/** Whether a face lies on a torus parametrised left-handed: its own normal,
 *  u × v, pointing in to the tube's centre rather than out. A fillet's
 *  round is one wherever the faces beside it came to the fillet the other
 *  way round — a revolve the other way about its axis, a mirror, a concave
 *  edge — so a project gets some of its rounds one way and some the other. */
export function leftHandedTorus(occt: OcctLike, face: number): boolean {
  if (occt.surfaceType(face) !== 'torus') return false
  const b = occt.uvBounds(face)
  const u = (b.uMin + b.uMax) / 2
  const v = (b.vMin + b.vMax) / 2
  const at = (du: number, dv: number) => vec(occt.pointOnSurface(face, u + du, v + dv))
  const p = at(0, 0)
  const alongU = sub(at(HAND_STEP, 0), p)
  const up = sub(at(0, HAND_STEP), p)
  const down = sub(at(0, -HAND_STEP), p)
  // v runs round the tube, so a step either way along it curves back
  // toward the tube's centre: the two steps' sum points there.
  return dot(cross(alongU, up), add(up, down)) > 0
}

/** Whether any face of a shape lies on a left-handed torus — whether its
 *  STEP file can need mendTorusLoops. */
export function hasLeftHandedTorus(occt: OcctLike, shape: Shape): boolean {
  const faces = occt.getSubShapes(shape, 'face')
  try {
    return faces.some((f) => leftHandedTorus(occt, f))
  } finally {
    for (const f of faces) occt.release(f)
  }
}

/**
 * A STEP file with every torus face's loops turned to run anticlockwise
 * about the face's outward normal, as STEP has them.
 *
 * OCCT's writer (8.0.1) writes some faces on a left-handed torus with
 * their loops clockwise about the face's outward normal: rounds that go
 * all the way round between two circles, as a fillet along a circular
 * edge makes. One cut back by another face it gets right, and a
 * right-handed torus always. Read by its loop, the face is the rest of
 * the ring — three quarters of the tube where a fillet's quarter was.
 * OCCT's reader mends such a loop by the face's curves in (u, v), and so
 * does meshstep, so nothing that reads the file here shows it; Parasolid
 * (Onshape, SolidWorks) takes the loop at its word and draws the round as
 * a cove.
 *
 * Each torus face's loops are unrolled onto the torus's (u, v) as the file
 * places it, and where their signed area against the face's normal comes
 * out negative, the face's bounds are turned (their orientation flag) —
 * nothing else in the file changes. A face with an edge on a curve this
 * does not unroll is left as it is. Reading the body back from the file
 * instead would mend the loops too, but carries everything else through
 * the reader, which on a body with loose edges (a cut by a large tilted
 * cylinder) moves faces by hundredths of a millimetre.
 * reStepExport.test.ts checks that the writer still needs this; when it
 * no longer does, this can go.
 */
export function mendTorusLoops(step: string): string {
  const file = stepEntities(step)
  const turn = new Set<number>()
  for (const id of file.ids) {
    if (!file.raw(id).startsWith('ADVANCED_FACE')) continue
    const [, bounds, surface, sameSense] = file.get(id).args
    if (file.get(surface).type !== 'TOROIDAL_SURFACE') continue
    const area = loopArea(file, bounds as Ref[], file.get(surface))
    if (area !== null && area * (sameSense ? 1 : -1) < 0) for (const b of bounds as Ref[]) turn.add(b.ref)
  }
  if (turn.size === 0) return step
  return step.replace(/(#(\d+)\s*=\s*FACE(?:_OUTER)?_BOUND\s*\(\s*'[^']*'\s*,\s*#\d+\s*,\s*)\.([TF])\./g, (whole, head: string, id: string, flag: string) =>
    turn.has(Number(id)) ? `${head}.${flag === 'T' ? 'F' : 'T'}.` : whole,
  )
}

/**
 * A STEP file with the B-spline curves of the edges at the given places
 * made to end on their corners: each such edge's first and last pole (a
 * clamped B-spline runs through them) moved onto the nearer of the edge's
 * two vertices where it lies off it by under `maxMm` — and nothing else.
 *
 * A round that runs out at a corner of three faces can leave an edge whose
 * curve ends nanometres to micrometres off its vertex. In memory that is
 * within the vertex's tolerance and the body is closed and valid; the
 * file carries no tolerances, and OCCT's reader closes the gap in one face
 * with an edge of its own — a free edge a hair long, the body read back
 * open (the rumble pak's nose corner: 8.7 nm off with the nose in two
 * rounds, while the mirrored corner, 2.9 nm off, read back whole; 3.4 µm
 * with the nose in one round). Only
 * the edges with a vertex within `radius` of a place are touched: the
 * places the read-back found open. What it did is checked by reading the
 * file back (ReKernel.exportStepMended), not here.
 */
export function snapCurveEnds(step: string, places: readonly Vec3[], { radius = 0.05, maxMm = 0.01 }: { radius?: number; maxMm?: number } = {}): { text: string; moved: number; offMax: number } {
  const file = stepEntities(step)
  const near = (p: Vec3) => places.some((q) => len(sub(p, q)) <= radius)
  const to = new Map<number, Vec3>()
  let offMax = 0
  for (const id of file.ids) {
    if (!file.raw(id).startsWith('EDGE_CURVE')) continue
    try {
      const [, start, end, curveRef] = file.get(id).args
      const a = point(file, file.get(start as Ref).args[1])
      const b = point(file, file.get(end as Ref).args[1])
      if (!near(a) && !near(b)) continue
      const poles = curvePoles(file, curveRef)
      if (!poles || poles.length < 2) continue
      for (const pole of [poles[0], poles[poles.length - 1]]) {
        const p = point(file, pole)
        const da = len(sub(p, a))
        const db = len(sub(p, b))
        const [v, d] = da <= db ? [a, da] : [b, db]
        if (!(d > 1e-9 && d < maxMm)) continue
        to.set(pole.ref, v)
        offMax = Math.max(offMax, d)
      }
    } catch (e) {
      if (!(e instanceof NotUnrolled)) throw e
    }
  }
  if (to.size === 0) return { text: step, moved: 0, offMax: 0 }
  const text = step.replace(/(#(\d+)\s*=\s*CARTESIAN_POINT\s*\(\s*'[^']*'\s*,\s*)\([^)]*\)/g, (whole, head: string, id: string) => {
    const v = to.get(Number(id))
    return v ? `${head}(${v.map(real).join(',')})` : whole
  })
  return { text, moved: to.size, offMax }
}

/** A number as a STEP real: always with its point. */
function real(x: number): string {
  const t = String(x).toUpperCase()
  return /[.E]/.test(t) ? (t.includes('.') ? t : t.replace('E', '.E')) : `${t}.`
}

/** Under this a conic's smallest size — a hyperbola's or an ellipse's
 *  shorter semi-axis, a parabola's focal distance — is no size a part has,
 *  mm: the gap the file's check holds a file to its body by. */
export const SMALL_CONIC_MM = 1e-3
/** An edge on a small conic that lies within this of the line through
 *  its two ends is written as that line, mm. */
const STRAIGHT_MM = 1e-6
/** Points an edge on a small conic is read at to tell whether it runs
 *  straight. */
const STRAIGHT_SAMPLES = 32

/** A conic of a STEP file under SMALL_CONIC_MM (smallConics). */
export interface SmallConic {
  kind: 'hyperbola' | 'parabola' | 'ellipse'
  /** Its smallest size, mm: see SMALL_CONIC_MM. */
  size: number
  /** Its centre — a parabola's vertex — mm. */
  centre: Vec3
  /** The middle of the edge on it, where one edge is; else its centre. */
  at: Vec3
  /** The edge on it runs straight within STRAIGHT_MM: straightConics
   *  writes it as a line. */
  straight: boolean
}

/**
 * The conics of a STEP file under SMALL_CONIC_MM, with the edge on each.
 *
 * A plane that misses a cone's apex by a hair — a wedge's side meant to
 * pass through a revolve's axis, its sketch's corners rounded — cuts the
 * cone in a hyperbola with semi-axes of that hair, centred on the apex,
 * however far off the part that is. The edge lies far out along the
 * hyperbola, where it runs as straight as its asymptote, and OCCT's reader
 * takes it so; Fusion drew a spike from the part to the apex (issue 97,
 * semi-axes 2e-5 mm). Nothing else in the file's check sees it: the part
 * reads back closed and on its body.
 */
export function smallConics(step: string): SmallConic[] {
  if (!/HYPERBOLA|PARABOLA|ELLIPSE/.test(step)) return []
  return conicEdges(stepEntities(step)).map(({ conic }) => conic)
}

/**
 * The file with every edge on a small conic that runs straight
 * (smallConics) written as the line through its two vertices: its
 * surface curve, or the conic where the edge names it alone, becomes that
 * line, and the conic and the edge's curves on its faces go — a reader
 * works those out from the line and the faces, as it does for a file
 * written without them. The line lies within STRAIGHT_MM of the conic, so
 * on the plane and the cone alike. An edge on a conic another edge
 * shares, or that does not run straight, is left as it is for the check
 * to name.
 */
export function straightConics(step: string): { text: string; straightened: number } {
  if (!/HYPERBOLA|PARABOLA/.test(step)) return { text: step, straightened: 0 }
  const file = stepEntities(step)
  const lines = conicEdges(file).flatMap(({ conic, edge }) => (conic.straight && edge ? [edge] : []))
  if (lines.length === 0) return { text: step, straightened: 0 }
  let next = Math.max(...file.ids) + 1
  const rewrite = new Map<number, string>()
  const added: string[] = []
  const gone: number[] = []
  for (const { curve, from, to } of lines) {
    const d = sub(to, from)
    const dir = scale(d, 1 / len(d))
    const [p, v, n] = [next, next + 1, next + 2]
    next += 3
    added.push(`#${p} = CARTESIAN_POINT('',(${from.map(real).join(',')}));`, `#${v} = VECTOR('',#${n},1.);`, `#${n} = DIRECTION('',(${dir.map(real).join(',')}));`)
    rewrite.set(curve, `LINE('',#${p},#${v})`)
    gone.push(...refsIn(file.raw(curve)))
  }
  // What the old curves alone named goes with them: each entity nothing
  // names any more, from what they named on down.
  const users = new Map<number, number>()
  for (const id of file.ids) for (const r of refsIn(rewrite.get(id) ?? file.raw(id))) users.set(r, (users.get(r) ?? 0) + 1)
  const dropped = new Set<number>()
  while (gone.length > 0) {
    const id = gone.pop()!
    if (dropped.has(id) || rewrite.has(id) || (users.get(id) ?? 0) > 0) continue
    dropped.add(id)
    for (const r of refsIn(file.raw(id))) {
      users.set(r, (users.get(r) ?? 0) - 1)
      gone.push(r)
    }
  }
  let text = step.replace(/#(\d+)\s*=\s*[\s\S]*?;[ \t]*(\r?\n|$)/g, (whole, id: string, end: string) => {
    const n = Number(id)
    if (dropped.has(n)) return ''
    const line = rewrite.get(n)
    return line ? `#${n} = ${line};${end}` : whole
  })
  const data = text.indexOf('DATA;')
  const close = data < 0 ? -1 : text.indexOf('ENDSEC;', data)
  if (close < 0) return { text: step, straightened: 0 }
  const eol = step.includes('\r\n') ? '\r\n' : '\n'
  text = text.slice(0, close) + added.join(eol) + eol + text.slice(close)
  return { text, straightened: lines.length }
}

/** The ids an entity's text names. */
const refsIn = (raw: string): number[] => [...raw.matchAll(/#(\d+)/g)].map((m) => Number(m[1]))

interface ConicEdge {
  conic: SmallConic
  /** The one edge on the conic — the edge, the curve it names (the conic,
   *  or a surface curve on it) and its ends in that curve's direction — or
   *  null where none or more than one is. */
  edge: { id: number; curve: number; from: Vec3; to: Vec3 } | null
}

/** The small conics of a file (see smallConics), each with its edge. */
function conicEdges(file: StepFile): ConicEdge[] {
  const named = new Map<number, number[]>()
  for (const id of file.ids) {
    const raw = file.raw(id)
    const edge = raw.startsWith('EDGE_CURVE')
    if (!edge && !raw.startsWith('SURFACE_CURVE') && !raw.startsWith('SEAM_CURVE')) continue
    // An edge names its two vertices, then its curve; a surface curve its
    // 3D curve first.
    const curve = refsIn(raw)[edge ? 2 : 0]
    if (curve !== undefined) named.set(curve, [...(named.get(curve) ?? []), id])
  }
  const out: ConicEdge[] = []
  for (const id of file.ids) {
    const raw = file.raw(id)
    const kind = raw.startsWith('HYPERBOLA') ? 'hyperbola' : raw.startsWith('PARABOLA') ? 'parabola' : raw.startsWith('ELLIPSE') ? 'ellipse' : null
    if (!kind) continue
    let shape: ConicShape
    try {
      const c = file.get(id)
      // A conic in a face's (u, v) is placed in 2D: no edge's own curve.
      if (!file.raw((c.args[1] as Ref).ref).startsWith('AXIS2_PLACEMENT_3D')) continue
      shape = conicShape(kind, placement(file, c.args[1]), c.args.slice(2) as number[])
    } catch (e) {
      if (e instanceof NotUnrolled) continue
      throw e
    }
    if (!(shape.size < SMALL_CONIC_MM)) continue
    const edges: { id: number; curve: number }[] = []
    for (const by of named.get(id) ?? []) {
      if (file.raw(by).startsWith('EDGE_CURVE')) edges.push({ id: by, curve: id })
      else for (const e of named.get(by) ?? []) if (file.raw(e).startsWith('EDGE_CURVE')) edges.push({ id: e, curve: by })
    }
    let edge: ConicEdge['edge'] = null
    let straight = false
    let at = shape.centre
    if (edges.length === 1) {
      try {
        const [, start, end, , sense] = file.get(edges[0].id).args
        const a = point(file, file.get(start as Ref).args[1])
        const b = point(file, file.get(end as Ref).args[1])
        const [from, to] = sense === false ? [b, a] : [a, b]
        at = scale(add(a, b), 0.5)
        straight = kind !== 'ellipse' && len(sub(to, from)) > 0 && offChord(shape, from, to) <= STRAIGHT_MM
        edge = { ...edges[0], from, to }
      } catch (e) {
        if (!(e instanceof NotUnrolled)) throw e
      }
    }
    out.push({ conic: { kind, size: shape.size, centre: shape.centre, at, straight }, edge })
  }
  return out
}

/** A conic as STEP places it: a hyperbola at (a cosh t, b sinh t) in its
 *  frame, a parabola at (t² / 4f, t), an ellipse at (a cos t, b sin t);
 *  the parameter of a point on it, and whether a point is on the branch
 *  it runs along. */
interface ConicShape {
  size: number
  centre: Vec3
  at(t: number): Vec3
  param(p: Vec3): number
  branch(p: Vec3): boolean
}

function conicShape(kind: SmallConic['kind'], f: ReturnType<typeof placement>, sizes: number[]): ConicShape {
  const local = (p: Vec3): [number, number] => [dot(sub(p, f.o), f.x), dot(sub(p, f.o), f.y)]
  const at = (x: number, y: number) => add(f.o, add(scale(f.x, x), scale(f.y, y)))
  if (kind === 'hyperbola') {
    const [a, b] = sizes
    return { size: Math.min(a, b), centre: f.o, at: (t) => at(a * Math.cosh(t), b * Math.sinh(t)), param: (p) => Math.asinh(local(p)[1] / b), branch: (p) => local(p)[0] > 0 }
  }
  if (kind === 'parabola') {
    const [focal] = sizes
    return { size: focal, centre: f.o, at: (t) => at((t * t) / (4 * focal), t), param: (p) => local(p)[1], branch: () => true }
  }
  const [a, b] = sizes
  return { size: Math.min(a, b), centre: f.o, at: (t) => at(a * Math.cos(t), b * Math.sin(t)), param: (p) => Math.atan2(local(p)[1] / b, local(p)[0] / a), branch: () => true }
}

/** How far a conic between two of its points strays from the line through
 *  them, mm: Infinity where either is off the branch the conic runs on. */
function offChord(c: ConicShape, from: Vec3, to: Vec3): number {
  if (!c.branch(from) || !c.branch(to)) return Infinity
  const [t0, t1] = [c.param(from), c.param(to)]
  const d = sub(to, from)
  const along = scale(d, 1 / len(d))
  let off = 0
  for (let s = 0; s <= STRAIGHT_SAMPLES; s++) {
    const q = sub(c.at(t0 + ((t1 - t0) * s) / STRAIGHT_SAMPLES), from)
    off = Math.max(off, len(sub(q, scale(along, dot(q, along)))))
  }
  return off
}

/** The edges of a STEP file not going round two faces — what a reader may
 *  close and a stricter one may not: where each starts. In a solid's file
 *  every edge is used twice, a seam twice in one loop. */
export function filesOpenEdges(step: string): Vec3[] {
  const uses = new Map<number, number>()
  for (const m of step.matchAll(/ORIENTED_EDGE\s*\(\s*'[^']*'\s*,\s*\*\s*,\s*\*\s*,\s*#(\d+)/g)) uses.set(Number(m[1]), (uses.get(Number(m[1])) ?? 0) + 1)
  const once = [...uses].filter(([, n]) => n === 1)
  if (once.length === 0) return []
  const file = stepEntities(step)
  return once.map(([id]) => point(file, file.get(file.get(id).args[1]).args[1]))
}

/** The poles of a B-spline curve, through a surface curve to its 3D one;
 *  null for any other curve — a line or a conic ends where its edge's
 *  vertices put it. */
function curvePoles(file: StepFile, r: Arg): Ref[] | null {
  const c = file.get(r) as Entity & { parts?: Entity[] }
  if (c.type === 'SURFACE_CURVE' || c.type === 'SEAM_CURVE') return curvePoles(file, c.args[1])
  if (c.type === 'B_SPLINE_CURVE_WITH_KNOTS') return c.args[2] as Ref[]
  const curve = c.type === 'COMPLEX' ? c.parts?.find((p) => p.type === 'B_SPLINE_CURVE') : undefined
  return curve ? (curve.args[1] as Ref[]) : null
}

// ---- reading the file --------------------------------------------------------

interface Ref {
  ref: number
}
type Arg = number | string | boolean | null | Ref | Arg[]
interface Entity {
  type: string
  args: Arg[]
}

/** A curve this does not unroll a loop along. */
class NotUnrolled extends Error {}

/** A STEP file's entities by id, each parsed when first asked for. */
function stepEntities(step: string) {
  const text = new Map<number, string>()
  for (const m of step.matchAll(/#(\d+)\s*=\s*([\s\S]*?);\s*(?:\r?\n|$)/g)) text.set(Number(m[1]), m[2].replace(/\s+/g, ' '))
  const parsed = new Map<number, Entity>()
  return {
    ids: [...text.keys()],
    raw: (id: number) => text.get(id) ?? '',
    get(r: Arg | number): Entity {
      const id = typeof r === 'number' ? r : (r as Ref).ref
      let e = parsed.get(id)
      if (!e) {
        e = parseEntity(text.get(id) ?? '')
        parsed.set(id, e)
      }
      return e
    },
  }
}
type StepFile = ReturnType<typeof stepEntities>

/** One entity's text as its type and its arguments; a complex entity —
 *  a rational B-spline, a unit — as its parts, each a type of its own. */
function parseEntity(s: string): Entity & { parts?: Entity[] } {
  let i = 0
  const skip = () => {
    while (s[i] === ' ') i++
  }
  const value = (): Arg => {
    skip()
    const c = s[i]
    if (c === '(') {
      i++
      const list: Arg[] = []
      skip()
      if (s[i] === ')') {
        i++
        return list
      }
      for (;;) {
        list.push(value())
        skip()
        if (s[i++] === ')') return list
      }
    }
    if (c === "'") {
      let end = i + 1
      while (end < s.length && !(s[end] === "'" && s[end + 1] !== "'")) end += s[end] === "'" ? 2 : 1
      const v = s.slice(i + 1, end)
      i = end + 1
      return v
    }
    if (c === '#') {
      const m = /^#(\d+)/.exec(s.slice(i))!
      i += m[0].length
      return { ref: Number(m[1]) }
    }
    if (c === '.' && /[A-Z_]/.test(s[i + 1] ?? '')) {
      const end = s.indexOf('.', i + 1)
      const v = s.slice(i + 1, end)
      i = end + 1
      return v === 'T' ? true : v === 'F' ? false : v
    }
    if (c === '*' || c === '$') {
      i++
      return null
    }
    if (/[A-Z]/.test(c ?? '')) {
      const m = /^[A-Z_0-9]+/.exec(s.slice(i))!
      i += m[0].length
      skip()
      return [m[0], value()]
    }
    const m = /^[-+0-9.E]+/.exec(s.slice(i))
    if (!m) throw new NotUnrolled(`unreadable entity ${s.slice(0, 40)}`)
    i += m[0].length
    return Number(m[0])
  }
  const head = /^([A-Z_0-9]+)\s*\(/.exec(s)
  if (head) {
    i = head[0].length - 1
    return { type: head[1], args: value() as Arg[] }
  }
  // ( A(...) B(...) ... ): each part a typed entity of its own.
  const parts: Entity[] = []
  i = 1
  skip()
  while (i < s.length && s[i] !== ')') {
    const [type, args] = value() as [string, Arg[]]
    parts.push({ type, args })
    skip()
  }
  return { type: 'COMPLEX', args: [], parts }
}

// ---- unrolling a loop ----------------------------------------------------------

/** An AXIS2_PLACEMENT_3D as an origin and a right-handed frame. */
function placement(file: StepFile, r: Arg) {
  const [, at, axis, ref] = file.get(r).args
  const z = direction(file, axis)
  const seed: Vec3 = ref ? direction(file, ref) : Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]
  const along = sub(seed, scale(z, dot(seed, z)))
  const x = scale(along, 1 / len(along))
  return { o: point(file, at), x, y: cross(z, x), z }
}
const point = (file: StepFile, r: Arg): Vec3 => file.get(r).args[1] as Vec3
function direction(file: StepFile, r: Arg): Vec3 {
  const d = file.get(r).args[1] as Vec3
  return scale(d, 1 / len(d))
}

/** A curve as a point at each parameter and the parameter nearest a point. */
interface Curve {
  at(t: number): Vec3
  param(p: Vec3): number
  /** Whether the parameter goes round — a conic's angle — or runs between
   *  ends, as a B-spline's does. */
  periodic: boolean
  ends?: [number, number]
}

function curveOf(file: StepFile, r: Arg): Curve {
  const c = file.get(r) as Entity & { parts?: Entity[] }
  if (c.type === 'SURFACE_CURVE' || c.type === 'SEAM_CURVE') return curveOf(file, c.args[1])
  if (c.type === 'LINE') {
    const p = point(file, c.args[1])
    const [, dir, magnitude] = file.get(c.args[2]).args
    const d = scale(direction(file, dir), magnitude as number)
    return { at: (t) => add(p, scale(d, t)), param: (q) => dot(sub(q, p), d) / dot(d, d), periodic: false }
  }
  if (c.type === 'CIRCLE' || c.type === 'ELLIPSE') {
    const f = placement(file, c.args[1])
    const a = c.args[2] as number
    const b = c.type === 'ELLIPSE' ? (c.args[3] as number) : a
    return {
      at: (t) => add(f.o, add(scale(f.x, a * Math.cos(t)), scale(f.y, b * Math.sin(t)))),
      param: (q) => Math.atan2(dot(sub(q, f.o), f.y) / b, dot(sub(q, f.o), f.x) / a),
      periodic: true,
    }
  }
  if (c.type === 'B_SPLINE_CURVE_WITH_KNOTS') {
    const [, degree, poles, , , , mults, knots] = c.args
    return bspline(file, degree as number, poles as Arg[], mults as number[], knots as number[], null)
  }
  if (c.type === 'COMPLEX' && c.parts) {
    const part = (t: string) => c.parts!.find((p) => p.type === t)
    const curve = part('B_SPLINE_CURVE')
    const withKnots = part('B_SPLINE_CURVE_WITH_KNOTS')
    const rational = part('RATIONAL_B_SPLINE_CURVE')
    if (curve && withKnots) {
      return bspline(file, curve.args[0] as number, curve.args[1] as Arg[], withKnots.args[0] as number[], withKnots.args[1] as number[], rational ? (rational.args[0] as number[]) : null)
    }
  }
  throw new NotUnrolled(c.type)
}

function bspline(file: StepFile, degree: number, poleRefs: Arg[], mults: number[], knots: number[], weights: number[] | null): Curve {
  const poles = poleRefs.map((r) => point(file, r))
  const w = weights ?? poles.map(() => 1)
  const U: number[] = []
  mults.forEach((m, k) => {
    for (let j = 0; j < m; j++) U.push(knots[k])
  })
  const t0 = U[degree]
  const t1 = U[U.length - degree - 1]
  const at = (t: number): Vec3 => {
    // de Boor, in homogeneous coordinates.
    let k = degree
    while (k < poles.length - 1 && t >= U[k + 1]) k++
    const d = Array.from({ length: degree + 1 }, (_, j) => {
      const p = poles[k - degree + j]
      const wt = w[k - degree + j]
      return [p[0] * wt, p[1] * wt, p[2] * wt, wt]
    })
    for (let r = 1; r <= degree; r++) {
      for (let j = degree; j >= r; j--) {
        const i = k - degree + j
        const a = (t - U[i]) / (U[i + degree - r + 1] - U[i])
        d[j] = d[j].map((x, q) => (1 - a) * d[j - 1][q] + a * x)
      }
    }
    const h = d[degree]
    return [h[0] / h[3], h[1] / h[3], h[2] / h[3]]
  }
  const param = (q: Vec3) => {
    // The nearest of many samples, then halved in on either side.
    const n = 256
    let best = t0
    let gap = Infinity
    for (let s = 0; s <= n; s++) {
      const t = t0 + ((t1 - t0) * s) / n
      const g = len(sub(at(t), q))
      if (g < gap) [best, gap] = [t, g]
    }
    let step = (t1 - t0) / n
    for (let it = 0; it < 30; it++) {
      for (const t of [best - step, best + step]) {
        if (t < t0 || t > t1) continue
        const g = len(sub(at(t), q))
        if (g < gap) [best, gap] = [t, g]
      }
      step /= 2
    }
    return best
  }
  return { at, param, periodic: false, ends: [t0, t1] }
}

/** An edge's points from its start vertex to its end. */
function edgePoints(file: StepFile, r: Arg): Vec3[] {
  const [, start, end, curveRef, sense] = file.get(r).args
  const curve = curveOf(file, curveRef)
  const a = point(file, file.get(start).args[1])
  const b = point(file, file.get(end).args[1])
  let t0 = curve.param(a)
  let t1 = curve.param(b)
  if (curve.periodic) {
    // A conic runs anticlockwise about its axis; the edge goes along it or
    // against it to its end — once round when it closes on itself.
    if (sense) while (t1 <= t0 + 1e-9) t1 += 2 * Math.PI
    else while (t1 >= t0 - 1e-9) t1 -= 2 * Math.PI
  } else if (curve.ends && (start as Ref).ref === (end as Ref).ref) {
    // A B-spline that closes on itself: the whole of it, its own way or back.
    ;[t0, t1] = sense ? curve.ends : [curve.ends[1], curve.ends[0]]
  }
  return Array.from({ length: EDGE_SAMPLES + 1 }, (_, s) => curve.at(t0 + ((t1 - t0) * s) / EDGE_SAMPLES))
}

/** The signed area of a torus face's loops unrolled onto the torus's own
 *  (u, v) — positive when they run anticlockwise about its normal, away
 *  from the tube's centre — or null when an edge is on a curve this does
 *  not unroll. */
function loopArea(file: StepFile, bounds: Ref[], torus: Entity): number | null {
  const f = placement(file, torus.args[1])
  const major = torus.args[2] as number
  const unroll = (p: Vec3): [number, number] => {
    const d = sub(p, f.o)
    const x = dot(d, f.x)
    const y = dot(d, f.y)
    return [Math.atan2(y, x), Math.atan2(dot(d, f.z), Math.hypot(x, y) - major)]
  }
  const near = (previous: number | undefined, a: number) => {
    if (previous === undefined) return a
    while (a - previous > Math.PI) a -= 2 * Math.PI
    while (a - previous < -Math.PI) a += 2 * Math.PI
    return a
  }
  try {
    let area = 0
    for (const bound of bounds) {
      const [, loop, boundSense] = file.get(bound).args
      let points: Vec3[] = []
      for (const r of file.get(loop).args[1] as Ref[]) {
        const [, , , edge, edgeSense] = file.get(r).args
        const p = edgePoints(file, edge)
        points.push(...(edgeSense ? p : p.reverse()))
      }
      if (!boundSense) points = points.reverse()
      // Both angles unwrapped along the loop, so a loop once round the
      // axis spans 2π in u rather than jumping back.
      let pu: number | undefined
      let pv: number | undefined
      const flat = points.map((p) => {
        const [u, v] = unroll(p)
        pu = near(pu, u)
        pv = near(pv, v)
        return [pu, pv]
      })
      for (let k = 0; k < flat.length; k++) {
        const [x1, y1] = flat[k]
        const [x2, y2] = flat[(k + 1) % flat.length]
        area += (x1 * y2 - x2 * y1) / 2
      }
    }
    return area
  } catch (e) {
    if (e instanceof NotUnrolled) return null
    throw e
  }
}
