// SPDX-License-Identifier: AGPL-3.0-only
// Pieces of one sketch that nearly coincide with pieces of another on a
// parallel plane: a wall fitted again in a second plan sketch, 0.07 mm off
// where the first has it, a round drawn twice at R0.07 and R0.08. Built,
// each is a step between the two features (stepsBetween.ts); said when
// the second sketch is made, it is one piece projected, or one level
// fitted into the sketch that has the wall already.
//
// The other sketch's pieces are laid on this sheet: on parallel planes u
// and v are the same. Only planes the two sketches' extrudes can bring
// together are compared: a slot on one end of a part and a slot on the
// other, 117 mm apart, never meet in a step.

import type { Vec2 } from '../../../src/core/flat/types'
import type { Vec3 } from '../../../src/core/types'
import { cross, dot, len, sub } from '../../../src/core/vec'
import type { Feature, SketchFeature } from './features'
import { liftPoint } from './profiles'
import type { Sketch, SketchArc, SketchEntity, SketchLine } from './sketch'

/** How near two ends lie to be one join, mm. */
const JOIN_MM = 1e-3

const arcEnds = (e: SketchArc): Vec2[] => [0, 1].map((t) => [e.c[0] + e.r * Math.cos(e.start + t * e.sweep), e.c[1] + e.r * Math.sin(e.start + t * e.sweep)])

/** Two lines within this of one direction, degrees, are parallel. */
const LINE_DEG = 0.5
/** Of the shorter line, the share the two must run side by side. */
const LINE_OVERLAP = 0.3
/** Nearer than this is one piece — projected, or drawn on the other. */
const SAME_MM = 1e-4
/** A near miss is up to this far off, mm. */
const NEAR_MM = 0.3
/** Planes within this of parallel, degrees. */
const PLANE_DEG = 0.5
/** How many near misses an answer lists. */
const LISTED = 12
/** How far a sketch a solid is built on otherwise than by an extrude of a
 *  set length — to a face, revolved, swept, lofted — is taken to reach
 *  either way from its plane, mm. */
const REACH_MM = 20

export interface NearMiss {
  /** This sketch's piece, by id. */
  piece: number
  /** The other sketch, by name. */
  sketch: string
  /** Its piece, by id. */
  other: number
  /** How far apart the two lie, mm: a line's offset where they run side
   *  by side; for a round the centres' offset and the radii's difference
   *  together. */
  offMm: number
}

const round5 = (x: number) => Math.round(x * 1e5) / 1e5

const entityKind = (f: SketchFeature, id: number) => f.sketch.entities.find((e) => e.id === id)?.kind

/** A sketch point on another sketch's sheet. */
const onSheet = (from: SketchFeature['frame'], to: SketchFeature['frame'], p: Vec2): Vec2 => {
  const q = sub(liftPoint(from, p), to.origin)
  return [dot(q, to.basisU), dot(q, to.basisV)]
}

const d2 = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1])

/** How far apart two lines on one sheet lie where they run side by side,
 *  or null when they are not near parallel or do not run side by side
 *  enough. */
function lineOff(a: [Vec2, Vec2], b: [Vec2, Vec2]): number | null {
  const la = d2(a[0], a[1]), lb = d2(b[0], b[1])
  if (la < 1e-9 || lb < 1e-9) return null
  const u: Vec2 = [(a[1][0] - a[0][0]) / la, (a[1][1] - a[0][1]) / la]
  const w: Vec2 = [(b[1][0] - b[0][0]) / lb, (b[1][1] - b[0][1]) / lb]
  const sin = Math.abs(u[0] * w[1] - u[1] * w[0])
  if (sin > Math.sin((LINE_DEG * Math.PI) / 180)) return null
  const along = (p: Vec2) => (p[0] - a[0][0]) * u[0] + (p[1] - a[0][1]) * u[1]
  const across = (p: Vec2) => Math.abs((p[0] - a[0][0]) * -u[1] + (p[1] - a[0][1]) * u[0])
  const t0 = along(b[0]), t1 = along(b[1])
  const lo = Math.max(0, Math.min(t0, t1)), hi = Math.min(la, Math.max(t0, t1))
  if (hi - lo < LINE_OVERLAP * Math.min(la, lb)) return null
  // Across, at both ends of the run side by side.
  const at = (t: number): Vec2 => {
    const s = (t - t0) / (t1 - t0)
    return [b[0][0] + (b[1][0] - b[0][0]) * s, b[0][1] + (b[1][1] - b[0][1]) * s]
  }
  return (across(at(lo)) + across(at(hi))) / 2
}

/** Whether two sketches lie on parallel planes. */
function parallel(a: SketchFeature['frame'], b: SketchFeature['frame']): boolean {
  return len(cross(a.normal, b.normal)) <= Math.sin((PLANE_DEG * Math.PI) / 180)
}

/**
 * The pieces of `sketch` that nearly coincide with a piece of another
 * sketch on a parallel plane, laid on this sheet: lines within half a
 * degree of each other that run side by side for 30 % of the shorter or
 * more, 1e-4 < offset ≤ 0.3 mm; arcs and circles with centres within 0.3
 * mm and radii within 0.3 mm of each other, not one. Construction pieces
 * are left out on both sides. With the part's features given, only a
 * sketch whose solids can reach this one's (along) is compared. The nearest
 * first, and how many in all.
 */
export function sketchNearMisses(sketch: SketchFeature, others: readonly SketchFeature[], features?: readonly Feature[]): { misses: NearMiss[]; found: number } {
  const out: NearMiss[] = []
  const mine = sketch.sketch.entities.filter((e) => !e.construction)
  const own = features ? along(sketch, sketch.frame.normal, features) : null
  for (const o of others) {
    if (o.id === sketch.id || !parallel(sketch.frame, o.frame)) continue
    if (own) {
      const theirs = along(o, sketch.frame.normal, features!)
      if (theirs[0] > own[1] + NEAR_MM || own[0] > theirs[1] + NEAR_MM) continue
    }
    for (const e of o.sketch.entities) {
      if (e.construction) continue
      if (e.kind === 'line') {
        const b: [Vec2, Vec2] = [onSheet(o.frame, sketch.frame, e.a), onSheet(o.frame, sketch.frame, e.b)]
        for (const m of mine) {
          if (m.kind !== 'line') continue
          const off = lineOff([m.a, m.b], b)
          if (off !== null && off > SAME_MM && off <= NEAR_MM) out.push({ piece: m.id, sketch: o.name, other: e.id, offMm: round5(off) })
        }
      } else if (e.kind === 'arc' || e.kind === 'circle') {
        const c = onSheet(o.frame, sketch.frame, e.c)
        for (const m of mine) {
          if (m.kind !== 'arc' && m.kind !== 'circle') continue
          const dc = d2(m.c, c), dr = Math.abs(m.r - e.r)
          if (dc > NEAR_MM || dr > NEAR_MM || (dc <= SAME_MM && dr <= SAME_MM)) continue
          out.push({ piece: m.id, sketch: o.name, other: e.id, offMm: round5(dc + dr) })
        }
      }
    }
  }
  out.sort((a, b) => a.offMm - b.offMm)
  return { misses: out.slice(0, LISTED), found: out.length }
}

/** The stretch along `normal` the solids built on a sketch can fill:
 *  from its plane, each extrude of a set length on it (distance,
 *  symmetric) as far as it goes; an extrude to a plane or a face, a
 *  revolve, a sweep or a loft on it are taken to reach REACH_MM either
 *  way. A sketch nothing is built on yet is its plane alone: one just
 *  drawn is compared with the sketches whose solids reach its plane, and
 *  what its own extrude brings near later stepsBetween finds. */
function along(f: SketchFeature, normal: Vec3, features: readonly Feature[]): [number, number] {
  const at = dot(f.frame.origin, normal)
  const way = dot(f.frame.normal, normal) < 0 ? -1 : 1
  let lo = 0
  let hi = 0
  let set = false
  for (const x of features) {
    if (x.suppressed) continue
    if (x.kind !== 'extrude' && x.kind !== 'sketch' && builtOn(x, f.id)) return [at - REACH_MM, at + REACH_MM]
    if (x.kind === 'extrude' && x.sketchId === f.id) {
      const e = x.extent
      const span = e.kind === 'distance' ? [e.from, e.to] : e.kind === 'symmetric' ? [-e.total / 2, e.total / 2] : null
      if (!span) return [at - REACH_MM, at + REACH_MM]
      lo = Math.min(lo, ...span)
      hi = Math.max(hi, ...span)
      set = true
    }
  }
  if (!set) return [at, at]
  const ends = [at + way * lo, at + way * hi]
  return [Math.min(...ends), Math.max(...ends)]
}

/** Whether `x` builds a solid on sketch `id`: its profile, its path, one
 *  of its sections. */
function builtOn(x: Feature, id: number): boolean {
  const y = x as { sketchId?: number | null; profile?: number | null; path?: number | null; sketches?: readonly number[] }
  return y.sketchId === id || y.profile === id || y.path === id || (y.sketches?.includes(id) ?? false)
}

/** The fix in one line: the other sketch's pieces projected into this
 *  one, or this level fitted into the other sketch (fit.level, mm along its
 *  normal from its plane). */
/** How far off one line two lines may run and still be said to be one, as
 *  a sine: about 0.05°. */
const ONE_LINE_SIN = 1e-3

/** Lines of a sketch that lie end to end on one line, with nothing else
 *  meeting at the join (a third piece there makes the join a junction, kept
 *  for the regions). Each is two faces of a profile where the viewer, which
 *  hides a split of one surface, draws one. */
export function collinearPieces(sketch: Sketch): { pieces: [number, number]; at: Vec2 }[] {
  const drawn = sketch.entities.filter((e) => !e.construction)
  const lines = drawn.filter((e): e is SketchLine => e.kind === 'line')
  const near = (p: Vec2, q: Vec2) => Math.hypot(p[0] - q[0], p[1] - q[1]) < JOIN_MM
  const endsAt = (e: SketchEntity, p: Vec2) => (e.kind === 'line' ? [e.a, e.b] : e.kind === 'arc' ? arcEnds(e) : []).some((q) => near(q, p))
  const out: { pieces: [number, number]; at: Vec2 }[] = []
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const a = lines[i]
      const b = lines[j]
      for (const [p, far] of [[a.a, a.b], [a.b, a.a]] as const) {
        const other = near(b.a, p) ? b.b : near(b.b, p) ? b.a : null
        if (!other) continue
        const u: Vec2 = [far[0] - p[0], far[1] - p[1]]
        const v: Vec2 = [other[0] - p[0], other[1] - p[1]]
        const lu = Math.hypot(u[0], u[1])
        const lv = Math.hypot(v[0], v[1])
        if (lu < JOIN_MM || lv < JOIN_MM) continue
        // Opposite ways from the join, on one line; a fold back is no run.
        const onOne = Math.abs(u[0] * v[1] - u[1] * v[0]) / (lu * lv) < ONE_LINE_SIN && u[0] * v[0] + u[1] * v[1] < 0
        if (!onOne) continue
        if (drawn.some((e) => e.id !== a.id && e.id !== b.id && endsAt(e, p))) continue
        out.push({ pieces: [a.id, b.id], at: [Math.round(p[0] * 1e4) / 1e4, Math.round(p[1] * 1e4) / 1e4] })
      }
    }
  }
  return out
}

/** Under this turn, degrees, a join is a line drawn straight; over it, up
 *  to KINK_MAX_DEG, a crease the fit left. */
const KINK_MIN_DEG = 0.2
/** Over this, a corner someone meant, degrees — as far as a round's failure
 *  names a shallow crease (diagnose.ts). */
const KINK_MAX_DEG = 5

/** A join of two pieces that turns a little: which, by how much, where. */
export interface Kink {
  pieces: [number, number]
  deg: number
  at: Vec2
}

/** The way a line or an arc leaves one of its ends, along itself. */
function awayFrom(e: SketchLine | SketchArc, end: 0 | 1): Vec2 {
  if (e.kind === 'line') {
    const [p, far] = end === 0 ? [e.a, e.b] : [e.b, e.a]
    const l = Math.hypot(far[0] - p[0], far[1] - p[1]) || 1
    return [(far[0] - p[0]) / l, (far[1] - p[1]) / l]
  }
  const t = e.start + end * e.sweep
  const way = (end === 0 ? 1 : -1) * Math.sign(e.sweep || 1)
  return [-Math.sin(t) * way, Math.cos(t) * way]
}

/** Joins of two lines or arcs of a sketch that turn between KINK_MIN_DEG and
 *  KINK_MAX_DEG, with nothing else meeting there: nearly straight, and no
 *  tangent chain runs on across them, so a fillet along the wall stops or
 *  fails there. An angle dimensioned between the two is meant. */
export function kinkedJoins(sketch: Sketch): Kink[] {
  const drawn = sketch.entities.filter((e) => !e.construction)
  const pieces = drawn.filter((e): e is SketchLine | SketchArc => e.kind === 'line' || e.kind === 'arc')
  const endOf = (e: SketchLine | SketchArc, end: 0 | 1): Vec2 => (e.kind === 'line' ? (end === 0 ? e.a : e.b) : arcEnds(e)[end])
  const near = (p: Vec2, q: Vec2) => Math.hypot(p[0] - q[0], p[1] - q[1]) < JOIN_MM
  const meets = (e: SketchEntity, p: Vec2) => (e.kind === 'line' ? [e.a, e.b] : e.kind === 'arc' ? arcEnds(e) : []).some((q) => near(q, p))
  const meant = (a: number, b: number) => sketch.constraints.some((c) => c.kind === 'angle' && ((c.a === a && c.b === b) || (c.a === b && c.b === a)))
  const out: Kink[] = []
  for (let i = 0; i < pieces.length; i++) {
    for (let j = i + 1; j < pieces.length; j++) {
      const [a, b] = [pieces[i], pieces[j]]
      for (const ea of [0, 1] as const) {
        for (const eb of [0, 1] as const) {
          const p = endOf(a, ea)
          if (!near(p, endOf(b, eb))) continue
          const [u, v] = [awayFrom(a, ea), awayFrom(b, eb)]
          // Straight on, the two leave the join opposite ways.
          const deg = (Math.atan2(Math.abs(u[0] * v[1] - u[1] * v[0]), -(u[0] * v[0] + u[1] * v[1])) * 180) / Math.PI
          if (deg < KINK_MIN_DEG || deg > KINK_MAX_DEG || meant(a.id, b.id)) continue
          if (drawn.some((e) => e.id !== a.id && e.id !== b.id && meets(e, p))) continue
          out.push({ pieces: [a.id, b.id], deg: Math.round(deg * 100) / 100, at: [Math.round(p[0] * 1e4) / 1e4, Math.round(p[1] * 1e4) / 1e4] })
        }
      }
    }
  }
  return out
}

/** What a kink does and the fix, in one line, by the first of them. */
export function kinkFix(sketch: SketchFeature, kinks: readonly Kink[]): string {
  const [a, b] = kinks[0].pieces
  const line = (id: number) => entityKind(sketch, id) === 'line'
  const straight = line(a) && line(b) ? `{ kind: "collinear", line: ${a}, on: { line: ${b} } }` : `{ kind: "tangent", a: ${a}, b: ${b} }`
  return `A join that turns this little is a crease in the wall: a tangent chain stops at it, so a fillet along the wall breaks there (“a crease of ${kinks[0].deg}°”). Round it — reverse.sketch.edit { sketch: ${JSON.stringify(sketch.name)}, add: { rounds: [{ a: ${a}, b: ${b}, radius }] } }, with a radius you give, wider than the fillet to come: a join this shallow has no round for the scan to read. Or, meant straight, hold it: add.constraints ${straight}. Leave it only if the crease is the part's.`
}

export function nearMissFix(sketch: SketchFeature, misses: readonly NearMiss[], others: readonly SketchFeature[]): string {
  const bySketch = new Map<string, number[]>()
  for (const m of misses) {
    const ids = bySketch.get(m.sketch) ?? []
    if (!ids.includes(m.other)) ids.push(m.other)
    bySketch.set(m.sketch, ids)
  }
  const project = [...bySketch].map(([name, pieces]) => `{ sketch: ${JSON.stringify(name)}, pieces: [${pieces.join(', ')}] }`).join(', ')
  const own = [...new Set(misses.map((m) => m.piece))]
  const [first] = bySketch.keys()
  const other = others.find((o) => o.name === first)
  const level = other ? Math.round(dot(sub(sketch.frame.origin, other.frame.origin) as Vec3, other.frame.normal) * 1000) / 1000 : null
  const fit = other && level !== null ? `reverse.sketch.edit { sketch: ${JSON.stringify(other.name)}, add: { fit: { level: ${level} } } }` : `fit.level into ${first}`
  return `a piece drawn twice is a step when built: project the other sketch’s in place of yours (reverse.sketch.edit { sketch: ${JSON.stringify(sketch.name)}, remove: { pieces: [${own.join(', ')}] }, add: { project: [${project}] } }), or fit this level into ${first} instead (${fit})`
}
