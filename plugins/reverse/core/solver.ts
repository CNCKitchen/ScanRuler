// SPDX-License-Identifier: AGPL-3.0-only
// One solver for the sketch: constrained least squares.
//
// A fitted piece keeps the slice points it was segmented from, and they are
// soft data — the residual of every point off its line or arc, weighted by
// the chain's scatter, is what the solver minimises. A relation or a typed
// dimension is a hard equation. Rather than eliminate the hard equations,
// which would need a different elimination for every combination of
// relations, they go into the same least squares at a weight so far above
// the soft data that they are met to a fraction of a micron while the soft
// data settles the rest; afterwards their residuals are read back, and one
// that could not be met — a dimension that fights another, a relation the
// geometry cannot satisfy — is reported as such rather than split down the
// middle. Free geometry, with no points behind it, gets a weak wish to stay
// where it was drawn, so a rectangle sketched by hand keeps its size unless
// a dimension says otherwise, and no parameter is ever left to float.
//
// Levenberg–Marquardt on the stacked residual, with the Jacobian taken by
// finite differences piece by piece: every residual block names the few
// parameters it depends on, so a sketch of a hundred pieces costs a hundred
// small blocks rather than one dense wall. The normal equations are solved
// directly — a sketch has a few hundred parameters at most.

import { choleskySolve, solveLinear, symmetricEigenN } from '../../../src/core/fit/linalg'
import type { Vec2 } from '../../../src/core/flat/types'
import { dot2, len2, normalize2, perp2, sub2 } from '../../../src/core/flat/vec2'
import { traceLine, traceOf, traceOffset, type DatumPlane, type DatumTrace } from './datums'
import {
  anchorPoint,
  arcPoint,
  distanceAlong,
  splineJoint,
  type Anchor,
  type DistanceAxis,
  type Constraint,
  type Sketch,
  type SketchArc,
  type SketchEntity,
  type SketchSpline,
} from './sketch'
import { isClosed, nearestOnSpline, splineAt, splineCurve, splineDirAt, splineEnd } from './sketchSpline'

/** How the hard equations outweigh the soft data, whose weight is 1/σ — a
 *  few tens for a scan. Squared in the normal equations, so the span from
 *  the weakest term to this one is what the solve's conditioning has to
 *  carry; the columns are scaled to unit diagonal before every solve, which
 *  is what lets a constraint be met to well under a micron against slice
 *  points scattered by a tenth of a millimetre. */
const HARD_WEIGHT = 1e4
/** The stay-put weight of free geometry, against soft data of weight 1/σ. */
const FREE_WEIGHT = 1e-1
/** The pull of a dragged point towards the cursor: well above the stay-put
 *  and the soft data, so the point follows the hand and the rest of the
 *  sketch gives way — but under the hard equations, so a point dragged off
 *  its horizontal slides along it rather than breaking it. A hand that
 *  fights a relation still bends it by a ten-thousandth of the drag, which
 *  a long drag takes past the tolerance below: so a pulled solve ends with
 *  the pull let go and the relations closed exactly from where it got to. */
const PULL_WEIGHT = 1e2
/** The iterations the let-go pass is allowed: it starts within microns of
 *  its answer, and one or two steps are all it takes. */
const RELEASE_ITERATIONS = 6
/** A hard residual over this, in millimetres, after convergence is a
 *  constraint the solver could not meet. */
const UNMET_TOLERANCE = 1e-3
/** A relation held open by more than this against fitted pieces is closed
 *  by a pass without the slice points. */
const CLOSE_FROM = 1e-7
/** Slice points per piece the residuals are taken over — more buys nothing a
 *  fit at this scale can use. */
const MAX_POINTS = 240
const MAX_ITERATIONS = 60
/** The iterations a quick solve is allowed — one step of a drag, run
 *  again next frame from where this one got to, and run in full when the
 *  hand lets go. Every iteration is a dense solve over the whole sketch,
 *  and a dozen pieces of a real part make that tens of milliseconds. */
const QUICK_ITERATIONS = 4
/** The most times a fitted spline's points find their feet on the curve
 *  again within one solve. */
const REFIT_ROUNDS = 24

/** A point being dragged: the anchor and where the hand is. */
export interface Pull {
  anchor: Anchor
  to: Vec2
}

export interface SolveOptions {
  /** Points being dragged, pulled to the cursor while everything else
   *  follows the constraints. */
  pull?: readonly Pull[]
  /** A step of a drag: a few iterations from where the sketch stands and
   *  a looser stop, so a frame is not held up — the full solve follows
   *  when the hand lets go. */
  quick?: boolean
  /** The part's coordinate planes as lines in this sketch's sheet — what a
   *  dimension to a plane is held against. They follow from the sketch's
   *  frame (datums.ts), which the solver never sees; a dimension to a plane
   *  with no trace given holds nothing. */
  datums?: readonly DatumTrace[]
}

export interface SolveReport {
  /** Whether every hard equation was met. */
  ok: boolean
  /** How many Levenberg–Marquardt steps were taken. */
  iterations: number
  /** Constraints that were not met, with how far off they ended. */
  unmet: { id: number; residual: number }[]
  /** How many hard equations say nothing new — the same relation put twice,
   *  a horizontal on a line already fixed. Zero on a healthy sketch. */
  redundant: number
  /** How many hard equations there are, the redundant ones counted — so
   *  what a relation added says itself: the equations it brought less the
   *  redundant ones it made. Zero on a drag's quick step. */
  equations: number
  /** The RMS of the soft residuals — how well the pieces still sit on their
   *  slice points, millimetres. */
  softRms: number
  /** The pieces that can still move: those with a parameter no relation
   *  or dimension pins down — what a CAD sketcher draws in the loose
   *  colour. A fixed or projected piece is held, and so is a fitted one:
   *  the scan holds it. Empty on a drag's quick step, where it is not
   *  worked out. */
  underConstrained: number[]
}

/** A residual block: a few parameters in, a few residuals out. */
interface Block {
  params: number[]
  weight: number
  /** The constraint this block stands for, for the report; absent for soft
   *  data and stay-put terms. */
  constraintId?: number
  /** A bound rather than an equation (a pointOn held within its piece):
   *  met or not, as any relation, but no row of the constraint Jacobian. */
  bound?: boolean
  eval: (x: Float64Array) => number[]
  /** Takes the block's linearisation again where the solve has got to — a
   *  fitted spline's points finding their feet on the curve as it moved —
   *  and says how far the feet went, in the curve's own parameter. */
  refresh?: (x: Float64Array) => number
}

/** The mean length of a spline's chords — what an angle of its is read in
 *  millimetres by. */
function meanChord(s: SketchSpline): number {
  let sum = 0
  const n = s.pts.length
  const segments = isClosed(s) ? n : n - 1
  for (let i = 0; i < segments; i++) sum += len2(sub2(s.pts[(i + 1) % n], s.pts[i]))
  return segments > 0 ? sum / segments : 1
}

/** Where each entity's parameters live in x, and how to read the entity
 *  back. */
interface Slot {
  entity: SketchEntity
  offset: number
  count: number
}

function paramsOf(e: SketchEntity): number[] {
  switch (e.kind) {
    case 'line':
      return [e.a[0], e.a[1], e.b[0], e.b[1]]
    case 'arc':
      return [e.c[0], e.c[1], e.r, e.start, e.sweep]
    case 'circle':
      return [e.c[0], e.c[1], e.r]
    case 'spline':
      // The fit points, then the end directions a tangent relation holds.
      return [...e.pts.flat(), ...(e.startDir !== undefined ? [e.startDir] : []), ...(e.endDir !== undefined ? [e.endDir] : [])]
    case 'point':
      return [e.p[0], e.p[1]]
  }
}

function withParams(e: SketchEntity, x: ArrayLike<number>, at: number): SketchEntity {
  switch (e.kind) {
    case 'line':
      return { ...e, a: [x[at], x[at + 1]], b: [x[at + 2], x[at + 3]] }
    case 'arc':
      return { ...e, c: [x[at], x[at + 1]], r: x[at + 2], start: x[at + 3], sweep: x[at + 4] }
    case 'circle':
      return { ...e, c: [x[at], x[at + 1]], r: x[at + 2] }
    case 'spline': {
      const n = e.pts.length
      const pts = e.pts.map((_, i): [number, number] => [x[at + 2 * i], x[at + 2 * i + 1]])
      let k = at + 2 * n
      const out: SketchSpline = { ...e, pts }
      if (e.startDir !== undefined) out.startDir = x[k++]
      if (e.endDir !== undefined) out.endDir = x[k++]
      return out
    }
    case 'point':
      return { ...e, p: [x[at], x[at + 1]] }
  }
}

/** The unit direction a spline runs at one of its ends: the one the solver
 *  holds where a tangent relation holds the end, the curve's own elsewhere. */
function splineEndDir(s: SketchSpline, end: 'a' | 'b'): Vec2 {
  const angle = end === 'a' ? s.startDir : s.endDir
  if (angle !== undefined) return [Math.cos(angle), Math.sin(angle)]
  const fit = splineCurve(s)
  return splineDirAt(fit, end === 'a' ? 0 : splineEnd(fit))
}

/** A spline with an end direction to solve for at each end a tangent
 *  relation holds — taken from the curve as it runs there now — and none
 *  at an end nothing holds, which is natural again. */
function withHeldEnds(s: SketchSpline, sketch: Sketch): SketchSpline {
  const held = new Set<'a' | 'b'>()
  if (!isClosed(s)) {
    for (const c of sketch.constraints) {
      if (c.kind !== 'tangent' || (c.a !== s.id && c.b !== s.id)) continue
      const joint = splineJoint(sketch, s.id, c.a === s.id ? c.b : c.a)
      if (joint) held.add(joint.end)
    }
  }
  const has = (end: 'a' | 'b') => (end === 'a' ? s.startDir : s.endDir) !== undefined
  if (held.has('a') === has('a') && held.has('b') === has('b')) return s
  const fit = splineCurve(s)
  const out: SketchSpline = { ...s }
  delete out.startDir
  delete out.endDir
  const dir = (t: number) => {
    const d = splineDirAt(fit, t)
    return Math.atan2(d[1], d[0])
  }
  if (held.has('a')) out.startDir = s.startDir ?? dir(0)
  if (held.has('b')) out.endDir = s.endDir ?? dir(splineEnd(fit))
  return out
}

/** Subsample a piece's points evenly to the cap. */
function thin(points: readonly Vec2[]): readonly Vec2[] {
  if (points.length <= MAX_POINTS) return points
  const step = points.length / MAX_POINTS
  const out: Vec2[] = []
  for (let i = 0; i < MAX_POINTS; i++) out.push(points[Math.floor(i * step)])
  return out
}

/**
 * Solve the sketch in place: every entity's parameters are moved to the
 * least-squares optimum under its constraints, and the report says how it
 * went. Fixed entities keep their parameters; entities with points are
 * pulled to them; free ones stay near where they were.
 */
export function solveSketch(sketch: Sketch, options: SolveOptions = {}): SolveReport {
  if (sketch.entities.some((e) => e.kind === 'spline')) sketch.entities = sketch.entities.map((e) => (e.kind === 'spline' ? withHeldEnds(e, sketch) : e))
  const slots = new Map<number, Slot>()
  const x0: number[] = []
  for (const e of sketch.entities) {
    const p = paramsOf(e)
    slots.set(e.id, { entity: e, offset: x0.length, count: p.length })
    x0.push(...p)
  }
  const n = x0.length
  const x = Float64Array.from(x0)
  if (n === 0) return { ok: true, iterations: 0, unmet: [], redundant: 0, equations: 0, softRms: 0, underConstrained: [] }

  // Which parameters may move: a fixed entity's stay put by being left out
  // of the unknowns (their columns are never perturbed or updated).
  const free = new Uint8Array(n).fill(1)
  for (const e of sketch.entities) {
    if (e.fixed) {
      const s = slots.get(e.id)!
      for (let i = 0; i < s.count; i++) free[s.offset + i] = 0
    }
  }

  const blocks: Block[] = []
  const range = (s: Slot) => Array.from({ length: s.count }, (_, i) => s.offset + i)
  const read = (id: number, xs: Float64Array): SketchEntity => {
    const s = slots.get(id)!
    return withParams(s.entity, xs, s.offset)
  }

  // ---- soft data and stay-put terms -----------------------------------------
  // Every piece keeps a weak wish to stay where it is: on free geometry it is
  // all that holds the piece, on a fitted piece it settles what the points
  // cannot — where along its line a segment's ends lie, which way round an
  // arc's ends sit — so nothing drifts along a direction the data is blind
  // to. Angles are scaled by the radius so the term reads in millimetres.
  let softCount = 0
  // Where each stay-put term wants its piece: where the solve started, or,
  // for the let-go pass, where the pulled solve left it.
  const rests: { at: number; init: Float64Array }[] = []
  for (const e of sketch.entities) {
    const s = slots.get(e.id)!
    if (e.fixed) continue
    const at = s.offset
    const init = Float64Array.from(x0.slice(at, at + s.count))
    rests.push({ at, init })
    // A spline's end directions read as the chord they swing.
    const unit = Array.from(init, (_, i) =>
      e.kind === 'arc' && i >= 3 ? Math.max(Math.abs(e.r), 1e-3) : e.kind === 'spline' && i >= 2 * e.pts.length ? Math.max(meanChord(e), 1e-3) : 1,
    )
    blocks.push({
      params: range(s),
      weight: FREE_WEIGHT,
      eval: (xs) => Array.from(init, (v, i) => (xs[at + i] - v) * unit[i]),
    })
    const points = 'points' in e && e.points && e.points.length > 0 ? thin(e.points) : null
    if (!points || e.kind === 'point') continue
    const scatter = Math.max(('scatter' in e && e.scatter) || 0, 1e-3)
    softCount += points.length
    // The points as two flat arrays, and the residuals written out in
    // plain arithmetic: these run for every point, for every parameter,
    // twice, on every iteration — the vector helpers' little arrays were
    // most of what a solve spent its time on.
    const count = points.length
    const px = new Float64Array(count)
    const py = new Float64Array(count)
    for (let i = 0; i < count; i++) {
      px[i] = points[i][0]
      py[i] = points[i][1]
    }
    const o = s.offset
    if (e.kind === 'line') {
      blocks.push({
        params: range(s),
        weight: 1 / scatter,
        eval: (xs) => {
          const ax = xs[o]
          const ay = xs[o + 1]
          let dx = xs[o + 2] - ax
          let dy = xs[o + 3] - ay
          const l = Math.hypot(dx, dy)
          if (l > 0) {
            dx /= l
            dy /= l
          } else {
            dx = 1
            dy = 0
          }
          // Signed distance off the carrier: the point against the left
          // normal (−dy, dx).
          const out = new Array<number>(count)
          for (let i = 0; i < count; i++) out[i] = (py[i] - ay) * dx - (px[i] - ax) * dy
          return out
        },
      })
    } else if (e.kind === 'spline') {
      // Each point against the place on the curve it lay nearest when the
      // solve began — both ways, not only off the curve: measured along the
      // normal alone, a fit point could slide along the curve for nothing,
      // and an open curve's tip runs off past its points. The feet are then
      // found again where the curve has got to and the curve settled again
      // (see refresh below), until they stay where they are.
      const fit0 = splineCurve(e)
      const foot = Float64Array.from(points, (p) => nearestOnSpline(fit0, p, 8).t)
      const id = e.id
      blocks.push({
        params: range(s),
        weight: 1 / scatter,
        refresh: (xs) => {
          const fit = splineCurve(read(id, xs) as SketchSpline)
          let moved = 0
          for (let i = 0; i < count; i++) {
            const t = nearestOnSpline(fit, [px[i], py[i]], 8).t
            moved = Math.max(moved, Math.abs(t - foot[i]))
            foot[i] = t
          }
          return moved
        },
        eval: (xs) => {
          const fit = splineCurve(read(id, xs) as SketchSpline)
          const out = new Array<number>(2 * count)
          for (let i = 0; i < count; i++) {
            const c = splineAt(fit, foot[i])
            out[2 * i] = px[i] - c[0]
            out[2 * i + 1] = py[i] - c[1]
          }
          return out
        },
      })
    } else {
      blocks.push({
        params: range(s),
        weight: 1 / scatter,
        eval: (xs) => {
          const cx = xs[o]
          const cy = xs[o + 1]
          const r = xs[o + 2]
          const out = new Array<number>(count)
          for (let i = 0; i < count; i++) out[i] = Math.hypot(px[i] - cx, py[i] - cy) - r
          return out
        },
      })
    }
  }

  // ---- hard equations ---------------------------------------------------------
  const anchorAt = (xs: Float64Array, a: Anchor): Vec2 => anchorPoint(read(a.entity, xs), a.at)

  // ---- the hand ----------------------------------------------------------------
  const pulls: Block[] = []
  for (const pull of options.pull ?? []) {
    const s = slots.get(pull.anchor.entity)
    if (!s) continue
    pulls.push({
      params: range(s),
      weight: PULL_WEIGHT,
      eval: (xs) => {
        const p = anchorAt(xs, pull.anchor)
        return [p[0] - pull.to[0], p[1] - pull.to[1]]
      },
    })
  }
  blocks.push(...pulls)
  const dirOf = (xs: Float64Array, id: number): Vec2 => {
    const l = read(id, xs)
    if (l.kind !== 'line') return [1, 0]
    return normalize2(sub2(l.b, l.a)) ?? [1, 0]
  }
  const lineOf = (xs: Float64Array, id: number) => {
    const l = read(id, xs)
    return l.kind === 'line' ? l : null
  }
  const paramsFor = (ids: number[]) => {
    const out: number[] = []
    for (const id of new Set(ids)) {
      const s = slots.get(id)
      if (s) out.push(...range(s))
    }
    return out
  }
  const hard = (c: Constraint, ids: number[], evalFn: (xs: Float64Array) => number[]) => {
    blocks.push({ params: paramsFor(ids), weight: HARD_WEIGHT, constraintId: c.id, eval: evalFn })
  }
  const scaleOf = () => {
    // A typical size, so angle equations weigh like length equations.
    let s = 0
    for (const e of sketch.entities) {
      if (e.kind === 'line') s = Math.max(s, len2(sub2(e.b, e.a)))
      else if (e.kind === 'spline') {
        for (const p of e.pts) for (const q of e.pts) s = Math.max(s, len2(sub2(p, q)))
      } else if (e.kind !== 'point') s = Math.max(s, 2 * e.r)
    }
    return Math.max(s, 1)
  }
  const L = scaleOf()

  // Where two pieces are held end to end: the ends of `a` and `b` a
  // coincidence joins, or null. A tangency at such a joint is held as the
  // radius there square to the line (or along the other's radius) — an
  // equation in the angle, met to the solve's precision — rather than as
  // the line's distance from the centre, which a joint sliding off the
  // tangent point changes only by the square of the slide: met to a tenth
  // of a micron, that one still leaves a kink of a few hundredths of a
  // degree at a small round.
  const jointOf = (a: number, b: number): { a: 'a' | 'b'; b: 'a' | 'b' } | null => {
    for (const k of sketch.constraints) {
      if (k.kind !== 'coincident') continue
      const p = k.p.at
      const q = k.q.at
      if ((p !== 'a' && p !== 'b') || (q !== 'a' && q !== 'b')) continue
      if (k.p.entity === a && k.q.entity === b) return { a: p, b: q }
      if (k.p.entity === b && k.q.entity === a) return { a: q, b: p }
    }
    return null
  }
  /** The unit radius of an arc at one of its ends. */
  const radialAt = (arc: SketchArc, at: 'a' | 'b'): Vec2 => {
    const t = at === 'a' ? arc.start : arc.start + arc.sweep
    return [Math.cos(t), Math.sin(t)]
  }

  for (const c of sketch.constraints) {
    if (c.kind === 'coincident') {
      hard(c, [c.p.entity, c.q.entity], (xs) => {
        const p = anchorAt(xs, c.p)
        const q = anchorAt(xs, c.q)
        return [p[0] - q[0], p[1] - q[1]]
      })
    } else if (c.kind === 'horizontal') {
      hard(c, [c.entity], (xs) => {
        const l = lineOf(xs, c.entity)
        return l ? [l.b[1] - l.a[1]] : [0]
      })
    } else if (c.kind === 'vertical') {
      hard(c, [c.entity], (xs) => {
        const l = lineOf(xs, c.entity)
        return l ? [l.b[0] - l.a[0]] : [0]
      })
    } else if (c.kind === 'parallel') {
      hard(c, [c.a, c.b], (xs) => {
        const da = dirOf(xs, c.a)
        const db = dirOf(xs, c.b)
        return [(da[0] * db[1] - da[1] * db[0]) * L]
      })
    } else if (c.kind === 'perpendicular') {
      hard(c, [c.a, c.b], (xs) => [dot2(dirOf(xs, c.a), dirOf(xs, c.b)) * L])
    } else if (c.kind === 'angle') {
      const target = (c.value * Math.PI) / 180
      hard(c, [c.a, c.b], (xs) => {
        const da = dirOf(xs, c.a)
        const db = dirOf(xs, c.b)
        const angle = Math.atan2(da[0] * db[1] - da[1] * db[0], dot2(da, db))
        // Directions have a sign the angle should not: fold to 0–π.
        const folded = ((angle % Math.PI) + Math.PI) % Math.PI
        let diff = folded - target
        if (diff > Math.PI / 2) diff -= Math.PI
        if (diff < -Math.PI / 2) diff += Math.PI
        return [diff * L]
      })
    } else if (c.kind === 'tangent') {
      const kinds = [slots.get(c.a)?.entity.kind, slots.get(c.b)?.entity.kind]
      if (kinds.includes('spline')) {
        // Where the spline's end meets the other piece: the direction it
        // runs there along the line, square to the arc's radius, along the
        // other spline's end. Off the joint a spline has no one direction
        // to hold, and the relation holds nothing.
        const spline = kinds[0] === 'spline' ? c.a : c.b
        const other = spline === c.a ? c.b : c.a
        const joint = splineJoint(sketch, spline, other)
        if (!joint) continue
        hard(c, [c.a, c.b], (xs) => {
          const s = read(spline, xs)
          const o = read(other, xs)
          if (s.kind !== 'spline') return [0]
          const u = splineEndDir(s, joint.end)
          if (o.kind === 'line') {
            const d = normalize2(sub2(o.b, o.a)) ?? [1, 0]
            return [(u[0] * d[1] - u[1] * d[0]) * L]
          }
          if (o.kind === 'arc' && (joint.at === 'a' || joint.at === 'b')) return [dot2(radialAt(o, joint.at), u) * L]
          if (o.kind === 'spline' && (joint.at === 'a' || joint.at === 'b')) {
            const v = splineEndDir(o, joint.at)
            return [(u[0] * v[1] - u[1] * v[0]) * L]
          }
          return [0]
        })
        continue
      }
      const joint = jointOf(c.a, c.b)
      if (joint && kinds.includes('arc') && (kinds.includes('line') || (kinds[0] === 'arc' && kinds[1] === 'arc'))) {
        hard(c, [c.a, c.b], (xs) => {
          const ea = read(c.a, xs)
          const eb = read(c.b, xs)
          if (ea.kind === 'arc' && eb.kind === 'arc') {
            const ua = radialAt(ea, joint.a)
            const ub = radialAt(eb, joint.b)
            return [(ua[0] * ub[1] - ua[1] * ub[0]) * Math.min(Math.abs(ea.r), Math.abs(eb.r))]
          }
          const arc = ea.kind === 'arc' ? ea : eb
          const line = ea.kind === 'arc' ? eb : ea
          if (line.kind !== 'line' || arc.kind !== 'arc') return [0]
          const d = normalize2(sub2(line.b, line.a)) ?? [1, 0]
          return [dot2(radialAt(arc, ea.kind === 'arc' ? joint.a : joint.b), d) * Math.abs(arc.r)]
        })
        continue
      }
      hard(c, [c.a, c.b], (xs) => {
        const ea = read(c.a, xs)
        const eb = read(c.b, xs)
        const line = ea.kind === 'line' ? ea : eb.kind === 'line' ? eb : null
        const round = ea.kind === 'line' ? eb : ea
        if (round.kind === 'line' || round.kind === 'point' || round.kind === 'spline') return [0]
        if (line) {
          const d = normalize2(sub2(line.b, line.a)) ?? [1, 0]
          const off = dot2(sub2(round.c, line.a), perp2(d))
          return [Math.abs(off) - round.r]
        }
        if (ea.kind === 'point' || eb.kind === 'point' || ea.kind === 'line' || eb.kind === 'line' || ea.kind === 'spline' || eb.kind === 'spline') return [0]
        // Two round pieces: externally or internally tangent, whichever the
        // geometry is nearer to.
        const dist = len2(sub2(ea.c, eb.c))
        const external = Math.abs(dist - (ea.r + eb.r))
        const internal = Math.abs(dist - Math.abs(ea.r - eb.r))
        return [external <= internal ? dist - (ea.r + eb.r) : dist - Math.abs(ea.r - eb.r)]
      })
    } else if (c.kind === 'equal') {
      hard(c, [c.a, c.b], (xs) => {
        const size = (e: SketchEntity) => (e.kind === 'line' ? len2(sub2(e.b, e.a)) : e.kind === 'point' || e.kind === 'spline' ? 0 : e.r)
        return [size(read(c.a, xs)) - size(read(c.b, xs))]
      })
    } else if (c.kind === 'concentric') {
      hard(c, [c.a, c.b], (xs) => {
        const ea = read(c.a, xs)
        const eb = read(c.b, xs)
        const centre = (e: SketchEntity): Vec2 => (e.kind === 'point' ? e.p : e.kind === 'line' ? e.a : e.kind === 'spline' ? e.pts[0] : e.c)
        const ca = centre(ea)
        const cb = centre(eb)
        return [ca[0] - cb[0], ca[1] - cb[1]]
      })
    } else if (c.kind === 'symmetric') {
      const about = c.about
      const ids = [c.p.entity, c.q.entity]
      if (typeof about === 'object' && 'line' in about) ids.push(about.line)
      // A coordinate plane's line is read off the frame, as a dimension to
      // the plane is; with no trace given the relation holds nothing.
      const trace = typeof about === 'object' && 'datum' in about ? traceOf(options.datums, about.datum) : null
      const axis = trace ? traceLine(trace) : null
      if (typeof about !== 'object' || 'line' in about || axis) {
        hard(c, ids, (xs) => {
          const p = anchorAt(xs, c.p)
          const q = anchorAt(xs, c.q)
          if (about === 'x') return [p[1] + q[1], p[0] - q[0]]
          if (about === 'y') return [p[0] + q[0], p[1] - q[1]]
          // The mirror line as a point and a direction: a sketch line's own,
          // or the plane's trace.
          const line = 'line' in about ? lineOf(xs, about.line) : null
          const a = line ? line.a : axis?.a
          const d = line ? (normalize2(sub2(line.b, line.a)) ?? [1, 0]) : axis?.d
          if (!a || !d) return [0, 0]
          const mid: Vec2 = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]
          // The midpoint on the line, the join square to it.
          return [dot2(sub2(mid, a), perp2(d)), dot2(sub2(q, p), d)]
        })
      }
    } else if (c.kind === 'length') {
      hard(c, [c.entity], (xs) => {
        const l = lineOf(xs, c.entity)
        return l ? [len2(sub2(l.b, l.a)) - c.value] : [0]
      })
    } else if (c.kind === 'radius' || c.kind === 'diameter') {
      hard(c, [c.entity], (xs) => {
        const e = read(c.entity, xs)
        return e.kind === 'arc' || e.kind === 'circle' ? [e.r - (c.kind === 'radius' ? c.value : c.value / 2)] : [0]
      })
    } else if (c.kind === 'distance') {
      const q = c.q
      if ('line' in q) {
        hard(c, [c.p.entity, q.line], (xs) => {
          const p = anchorAt(xs, c.p)
          const l = lineOf(xs, q.line)
          if (!l) return [0]
          const d = normalize2(sub2(l.b, l.a)) ?? [1, 0]
          return [Math.abs(dot2(sub2(p, l.a), perp2(d))) - c.value]
        })
      } else if ('datum' in q) {
        const trace = traceOf(options.datums, q.datum)
        if (trace) hard(c, [c.p.entity], (xs) => [Math.abs(traceOffset(trace, anchorAt(xs, c.p))) - c.value])
      } else {
        // Along an axis the two points' ΔX or ΔY, unsigned as every
        // distance is; straight across otherwise.
        const axis = c.axis
        hard(c, [c.p.entity, q.entity], (xs) => [distanceAlong(anchorAt(xs, c.p), anchorAt(xs, q), axis) - c.value])
      }
    } else if (c.kind === 'pointOn') {
      // Signed distance off the carrier — zero on it.
      const on = c.on
      if ('line' in on) {
        hard(c, [c.p.entity, on.line], (xs) => {
          const l = lineOf(xs, on.line)
          if (!l) return [0]
          const d = normalize2(sub2(l.b, l.a)) ?? [1, 0]
          return [dot2(sub2(anchorAt(xs, c.p), l.a), perp2(d))]
        })
      } else if ('curve' in on) {
        hard(c, [c.p.entity, on.curve], (xs) => {
          const e = read(on.curve, xs)
          const p = anchorAt(xs, c.p)
          if (e.kind === 'spline') {
            // The distance to the curve, signed by the side it lies on: zero
            // on it, and never on the line a tip runs on along past its end.
            const near = nearestOnSpline(splineCurve(e), p, 8)
            const d = splineDirAt(splineCurve(e), near.t)
            const side = (p[1] - near.point[1]) * d[0] - (p[0] - near.point[0]) * d[1]
            return [side < 0 ? -near.dist : near.dist]
          }
          return e.kind === 'arc' || e.kind === 'circle' ? [len2(sub2(p, e.c)) - e.r] : [0]
        })
      } else {
        const trace = traceOf(options.datums, on.datum)
        if (trace) hard(c, [c.p.entity], (xs) => [traceOffset(trace, anchorAt(xs, c.p))])
      }
      if (c.bounded && !('datum' in on)) {
        // Held within the piece: how far past an end the point lies along
        // it, mm — nothing while it lies within. An inequality, not an
        // equation, so its row counts in neither the rank nor the loose
        // pieces (bound).
        const id = 'line' in on ? on.line : on.curve
        blocks.push({
          params: paramsFor([c.p.entity, id]),
          weight: HARD_WEIGHT,
          constraintId: c.id,
          bound: true,
          eval: (xs) => {
            const e = read(id, xs)
            const p = anchorAt(xs, c.p)
            if (e.kind === 'line') {
              const d = sub2(e.b, e.a)
              const l = len2(d)
              if (!(l > 0)) return [0]
              const s = dot2(sub2(p, e.a), d) / l
              return [s < 0 ? s : s > l ? s - l : 0]
            }
            if (e.kind !== 'arc') return [0]
            // The arc as it comes out of the solve: a sweep walked negative
            // runs the other way from its other end.
            const start = e.sweep < 0 ? e.start + e.sweep : e.start
            const sweep = Math.abs(e.sweep)
            const two = 2 * Math.PI
            const along = (((Math.atan2(p[1] - e.c[1], p[0] - e.c[0]) - start) % two) + two) % two
            if (sweep >= two || along <= sweep) return [0]
            // Past the end, or short of the start: whichever is nearer.
            const r = Math.abs(e.r)
            return [along - sweep <= two - along ? (along - sweep) * r : -(two - along) * r]
          },
        })
      }
    } else if (c.kind === 'collinear') {
      // Both ends of the line off the carrier.
      const on = c.on
      if ('line' in on) {
        hard(c, [c.line, on.line], (xs) => {
          const l = lineOf(xs, c.line)
          const m = lineOf(xs, on.line)
          if (!l || !m) return [0, 0]
          const n = perp2(normalize2(sub2(m.b, m.a)) ?? [1, 0])
          return [dot2(sub2(l.a, m.a), n), dot2(sub2(l.b, m.a), n)]
        })
      } else {
        const trace = traceOf(options.datums, on.datum)
        if (trace)
          hard(c, [c.line], (xs) => {
            const l = lineOf(xs, c.line)
            return l ? [traceOffset(trace, l.a), traceOffset(trace, l.b)] : [0, 0]
          })
      }
    }
  }

  // ---- Levenberg–Marquardt ----------------------------------------------------
  const freeIndex = new Int32Array(n).fill(-1)
  let m = 0
  for (let i = 0; i < n; i++) if (free[i]) freeIndex[i] = m++
  if (m === 0) return finish(sketch, slots, x, blocks, 0, softCount, false)

  const cost = (rs: number[][]) => {
    let c = 0
    for (const r of rs) for (const v of r) c += v * v
    return c
  }

  const JtJ = new Float64Array(m * m)
  const Jtr = new Float64Array(m)
  const xt = new Float64Array(n)
  let iterations = 0

  /** Descend over `active` from where x stands, for at most `maxIterations`
   *  or until a step or its gain is under the tolerances. */
  const descend = (active: Block[], maxIterations: number, stepTolerance: number, gainTolerance: number) => {
    const residuals = (xs: Float64Array): number[][] => active.map((b) => b.eval(xs).map((r) => r * b.weight))
    let lambda = 1e-3
    let converged = false
    let rs = residuals(x)
    let current = cost(rs)

    for (let it = 0; it < maxIterations && !converged; it++, iterations++) {
      JtJ.fill(0)
      Jtr.fill(0)
      xt.set(x)
      // Block by block: perturb each of the block's parameters, read its
      // residuals, and scatter the products into the normal equations.
      for (let bi = 0; bi < active.length; bi++) {
        const b = active[bi]
        const r0 = rs[bi]
        const cols = b.params.filter((p) => free[p])
        if (cols.length === 0) continue
        // Central differences, one parameter perturbed at a time in a copy
        // of x taken once per iteration and put back after each.
        const J: number[][] = []
        for (const p of cols) {
          const h = 1e-6 * Math.max(1, Math.abs(x[p]))
          xt[p] = x[p] + h
          const rp = b.eval(xt)
          xt[p] = x[p] - h
          const rm = b.eval(xt)
          xt[p] = x[p]
          const w = b.weight / (2 * h)
          J.push(rp.map((v, i) => (v - rm[i]) * w))
        }
        for (let i = 0; i < cols.length; i++) {
          const ci = freeIndex[cols[i]]
          let g = 0
          for (let k = 0; k < r0.length; k++) g += J[i][k] * r0[k]
          Jtr[ci] += g
          for (let j = 0; j < cols.length; j++) {
            const cj = freeIndex[cols[j]]
            let s = 0
            for (let k = 0; k < r0.length; k++) s += J[i][k] * J[j][k]
            JtJ[ci * m + cj] += s
          }
        }
      }
      let gradNorm = 0
      for (let i = 0; i < m; i++) gradNorm = Math.max(gradNorm, Math.abs(Jtr[i]))
      if (gradNorm < 1e-9) break

      let improved = false
      for (let attempt = 0; attempt < 12; attempt++) {
        // Damped normal equations, scaled to unit diagonal: the hard rows put
        // entries a million times the stay-put terms' on the diagonal, and the
        // elimination's pivot test would take the small ones for zeros.
        const S = new Float64Array(m)
        for (let i = 0; i < m; i++) S[i] = 1 / Math.sqrt(JtJ[i * m + i] * (1 + lambda) + 1e-30)
        const A = new Float64Array(m * m)
        for (let i = 0; i < m; i++) {
          for (let j = 0; j < m; j++) A[i * m + j] = JtJ[i * m + j] * S[i] * S[j]
          A[i * m + i] += lambda * JtJ[i * m + i] * S[i] * S[i]
        }
        const rhs = new Float64Array(m)
        for (let i = 0; i < m; i++) rhs[i] = -Jtr[i] * S[i]
        // Symmetric and, damped, positive definite: Cholesky, at half the
        // cost of elimination — with elimination behind it for the rare
        // matrix that rounding has left short of definite.
        const scaled = choleskySolve(m, A, rhs) ?? solveLinear(m, A, rhs)
        if (!scaled) {
          lambda *= 10
          continue
        }
        xt.set(x)
        let stepNorm = 0
        for (let i = 0; i < n; i++) {
          if (free[i]) {
            const d = scaled[freeIndex[i]] * S[freeIndex[i]]
            xt[i] += d
            stepNorm = Math.max(stepNorm, Math.abs(d))
          }
        }
        const rt = residuals(xt)
        const ct = cost(rt)
        if (ct < current) {
          x.set(xt)
          rs = rt
          const gain = current - ct
          current = ct
          lambda = Math.max(lambda / 3, 1e-12)
          improved = true
          if (stepNorm < stepTolerance || gain < gainTolerance * Math.max(1, current)) converged = true
          break
        }
        lambda *= 4
      }
      if (!improved) break
    }
  }

  const quick = Boolean(options.quick)
  descend(blocks, quick ? QUICK_ITERATIONS : MAX_ITERATIONS, quick ? 1e-6 : 1e-9, quick ? 1e-8 : 1e-12)
  // A fitted spline's points found their feet on the curve where it began;
  // where it has moved they are found again and the curve settled to them,
  // until the feet stay put — a drawn curve pulled onto the slice moves the
  // most on the first round, and each after it less.
  const refreshed = blocks.filter((b) => b.refresh)
  for (let round = 0; !quick && refreshed.length > 0 && round < REFIT_ROUNDS; round++) {
    let moved = 0
    for (const b of refreshed) moved = Math.max(moved, b.refresh!(x))
    if (moved < 1e-7) break
    descend(blocks, MAX_ITERATIONS, 1e-9, 1e-12)
  }
  if (pulls.length > 0) {
    // The hand let go: every piece now wishes to stay where the pull left
    // it, and the relations close the last microns the pull held open.
    for (const r of rests) for (let i = 0; i < r.init.length; i++) r.init[i] = x[r.at + i]
    descend(blocks.filter((b) => !pulls.includes(b)), RELEASE_ITERATIONS, 1e-9, 1e-12)
  }
  if (!quick && softCount > 0 && worstHard(blocks, x) > CLOSE_FROM) {
    // Slice points a few microns apart on a clean cut weigh as much as the
    // relations, and hold them a micron or two open: the pieces settled
    // where the data put them, now stay there and let the relations close.
    for (const r of rests) for (let i = 0; i < r.init.length; i++) r.init[i] = x[r.at + i]
    descend(blocks.filter((b) => !pulls.includes(b) && (b.constraintId !== undefined || b.weight === FREE_WEIGHT)), RELEASE_ITERATIONS, 1e-9, 1e-12)
  }

  return finish(sketch, slots, x, blocks, iterations, softCount, quick)
}

/** The largest residual of any relation, unweighted, in millimetres. */
function worstHard(blocks: Block[], x: Float64Array): number {
  let worst = 0
  for (const b of blocks) if (b.constraintId !== undefined) for (const v of b.eval(x)) worst = Math.max(worst, Math.abs(v))
  return worst
}

function finish(
  sketch: Sketch,
  slots: Map<number, Slot>,
  x: Float64Array,
  blocks: Block[],
  iterations: number,
  softCount: number,
  quick: boolean,
): SolveReport {
  // Write the parameters back.
  sketch.entities = sketch.entities.map((e) => {
    const s = slots.get(e.id)!
    const out = withParams(e, x, s.offset)
    if (out.kind === 'arc' || out.kind === 'circle') out.r = Math.abs(out.r)
    if (out.kind === 'arc') {
      if (out.sweep < 0) {
        out.start += out.sweep
        out.sweep = -out.sweep
      }
      // An arc's end is periodic in its sweep, so the solver may have walked
      // the sweep round by whole turns on its way to the same end point; the
      // arc is the one within a turn. A sweep that lands on a whole turn is a
      // whole turn, not nothing.
      const two = 2 * Math.PI
      const wrapped = ((out.sweep % two) + two) % two
      out.sweep = wrapped < 1e-9 && out.sweep > 1e-9 ? two : wrapped
      out.start = ((out.start % two) + two) % two
    }
    return out
  })

  // The report: which hard equations were not met, how many said nothing
  // new, and how the soft data sits.
  const unmet: { id: number; residual: number }[] = []
  let softSq = 0
  const hardRows: number[][] = []
  const hardCols: number[][] = []
  for (const b of blocks) {
    const r = b.eval(x)
    if (b.constraintId === undefined) {
      if (b.weight !== FREE_WEIGHT) for (const v of r) softSq += v * v
      continue
    }
    const worst = Math.max(...r.map(Math.abs))
    if (worst > UNMET_TOLERANCE) {
      const had = unmet.find((u) => u.id === b.constraintId)
      if (had) had.residual = Math.max(had.residual, worst)
      else unmet.push({ id: b.constraintId, residual: worst })
    }
    // Rows of the constraint Jacobian, unweighted, for the rank — not on a
    // drag's step, where nothing reads the count and the eigenvalues of
    // the Gram matrix cost as much as the solve.
    if (quick || b.bound) continue
    const xt = new Float64Array(x)
    const cols = b.params
    const rows: number[][] = r.map(() => new Array<number>(cols.length).fill(0))
    cols.forEach((p, ci) => {
      const h = 1e-6 * Math.max(1, Math.abs(x[p]))
      xt.set(x)
      xt[p] += h
      const rp = b.eval(xt)
      xt[p] -= 2 * h
      const rm = b.eval(xt)
      for (let k = 0; k < r.length; k++) rows[k][ci] = (rp[k] - rm[k]) / (2 * h)
    })
    for (const row of rows) {
      hardRows.push(row)
      hardCols.push(cols)
    }
  }
  const redundant = quick ? 0 : redundantRows(hardRows, hardCols, x.length, sketch)
  return {
    ok: unmet.length === 0,
    iterations,
    unmet,
    redundant,
    equations: hardRows.length,
    softRms: softCount > 0 ? Math.sqrt(softSq / softCount) : 0,
    underConstrained: quick ? [] : looseEntities(hardRows, hardCols, x.length, sketch),
  }
}

/** Whether a piece is held by something other than the relations: fixed
 *  where it is, projected from a body, or fitted to the slice — the scan
 *  holds a fitted piece as surely as a dimension would. */
function heldByItself(e: SketchEntity): boolean {
  return Boolean(e.fixed || e.projected || ('points' in e && e.points && e.points.length > 0))
}

/**
 * The pieces a relation or dimension does not pin down. The hard rows are
 * the constraint Jacobian over the parameters; a direction the sketch can
 * still move in is a null vector of it. Brought to reduced row echelon
 * form, every column without a pivot is such a direction of its own, and
 * a pivot column moves along with a free column whenever its row has an
 * entry there — so a parameter is loose when its column has no pivot, or
 * its pivot's row reaches a column that has none. The parameters of
 * pieces held by themselves are left out: they are not free to move.
 */
function looseEntities(rows: number[][], cols: number[][], n: number, sketch: Sketch): number[] {
  const held = new Uint8Array(n)
  const owner = new Int32Array(n)
  let at = 0
  for (const e of sketch.entities) {
    const count = paramsOf(e).length
    for (let i = 0; i < count; i++) {
      owner[at + i] = e.id
      if (heldByItself(e)) held[at + i] = 1
    }
    at += count
  }
  const column = new Int32Array(n).fill(-1)
  const param: number[] = []
  for (let p = 0; p < n; p++) {
    if (held[p]) continue
    column[p] = param.length
    param.push(p)
  }
  const m = param.length
  if (m === 0) return []
  // Dense rows over the loose parameters, each brought to unit length so
  // one tolerance serves every equation.
  const dense: Float64Array[] = []
  rows.forEach((r, i) => {
    const row = new Float64Array(m)
    let norm = 0
    cols[i].forEach((p, ci) => {
      if (column[p] >= 0) {
        row[column[p]] = r[ci]
        norm += r[ci] * r[ci]
      }
    })
    norm = Math.sqrt(norm)
    if (norm > 1e-9) {
      for (let j = 0; j < m; j++) row[j] /= norm
      dense.push(row)
    }
  })
  // Reduced row echelon form by partial pivoting; an entry under this is
  // finite-difference noise.
  const EPS = 1e-6
  const pivotOf = new Int32Array(m).fill(-1)
  let rank = 0
  for (let j = 0; j < m && rank < dense.length; j++) {
    let best = rank
    for (let i = rank + 1; i < dense.length; i++) if (Math.abs(dense[i][j]) > Math.abs(dense[best][j])) best = i
    if (Math.abs(dense[best][j]) < EPS) continue
    ;[dense[rank], dense[best]] = [dense[best], dense[rank]]
    const pivot = dense[rank]
    const scale = 1 / pivot[j]
    for (let k = 0; k < m; k++) pivot[k] *= scale
    for (let i = 0; i < dense.length; i++) {
      if (i === rank) continue
      const f = dense[i][j]
      if (Math.abs(f) < EPS) continue
      for (let k = 0; k < m; k++) dense[i][k] -= f * pivot[k]
    }
    pivotOf[j] = rank
    rank++
  }
  const loose = new Set<number>()
  for (let j = 0; j < m; j++) {
    if (pivotOf[j] < 0) {
      loose.add(owner[param[j]])
      continue
    }
    const row = dense[pivotOf[j]]
    for (let k = 0; k < m; k++) {
      if (pivotOf[k] < 0 && Math.abs(row[k]) > EPS) {
        loose.add(owner[param[j]])
        break
      }
    }
  }
  return [...loose]
}

/** How many of the constraint equations are linearly dependent on the
 *  others at the solution, the parameters of fixed entities left out: the
 *  Gram matrix of the rows has one zero eigenvalue per dependency. */
function redundantRows(rows: number[][], cols: number[][], n: number, sketch: Sketch): number {
  const k = rows.length
  if (k === 0) return 0
  const fixed = new Uint8Array(n)
  let at = 0
  for (const e of sketch.entities) {
    const count = paramsOf(e).length
    if (e.fixed) for (let i = 0; i < count; i++) fixed[at + i] = 1
    at += count
  }
  // Dense rows over every parameter, each brought to unit length — a
  // coincidence on a large arc has derivatives the size of its radius, and
  // left unscaled it would set the eigenvalue threshold for every other row
  // — then the Gram matrix.
  const dense = rows.map((r, i) => {
    const row = new Float64Array(n)
    cols[i].forEach((p, ci) => {
      if (!fixed[p]) row[p] = r[ci]
    })
    let norm = 0
    for (const v of row) norm += v * v
    norm = Math.sqrt(norm)
    if (norm > 0) for (let p = 0; p < n; p++) row[p] /= norm
    return row
  })
  const gram = new Float64Array(k * k)
  let largest = 0
  for (let i = 0; i < k; i++) {
    for (let j = i; j < k; j++) {
      let s = 0
      for (let p = 0; p < n; p++) s += dense[i][p] * dense[j][p]
      gram[i * k + j] = s
      gram[j * k + i] = s
      if (i === j) largest = Math.max(largest, s)
    }
  }
  if (largest === 0) return k
  const eig = symmetricEigenN(k, gram)
  // The rows are finite differences, good to some eight digits, and the
  // Gram matrix carries that noise into its small eigenvalues at about
  // 1e-7 of the largest. A dependency is an eigenvalue that is zero but for
  // that noise; a genuinely independent equation stands orders above it.
  let zero = 0
  for (const v of eig.values) if (v < 1e-6 * largest) zero++
  return zero
}

/** The measured value a dimension of this kind would read on the sketch as
 *  it stands — what the panel offers as the default when one is added. */
export function measureDimension(
  sketch: Sketch,
  kind: 'length' | 'radius' | 'diameter' | 'angle' | 'distance',
  a: SketchEntity | Anchor,
  b?: SketchEntity | Anchor | { line: number } | { datum: DatumPlane },
  datums?: readonly DatumTrace[],
  axis?: DistanceAxis,
): number | null {
  const ent = (id: number) => sketch.entities.find((e) => e.id === id)
  const pointOf = (x: SketchEntity | Anchor): Vec2 | null => {
    if ('at' in x) {
      const e = ent(x.entity)
      return e ? anchorPoint(e, x.at) : null
    }
    return x.kind === 'point' ? x.p : x.kind === 'line' || x.kind === 'spline' ? null : x.c
  }
  if (kind === 'length') {
    return 'kind' in a && a.kind === 'line' ? len2(sub2(a.b, a.a)) : null
  }
  if (kind === 'radius' || kind === 'diameter') {
    return 'kind' in a && (a.kind === 'arc' || a.kind === 'circle') ? (kind === 'radius' ? a.r : 2 * a.r) : null
  }
  if (kind === 'angle') {
    if (!('kind' in a) || a.kind !== 'line' || !b || !('kind' in b) || b.kind !== 'line') return null
    const da = normalize2(sub2(a.b, a.a))
    const db = normalize2(sub2(b.b, b.a))
    if (!da || !db) return null
    const angle = Math.atan2(da[0] * db[1] - da[1] * db[0], dot2(da, db))
    return ((((angle % Math.PI) + Math.PI) % Math.PI) * 180) / Math.PI
  }
  const p = pointOf(a)
  if (!p || !b) return null
  if ('datum' in b) {
    const trace = traceOf(datums, b.datum)
    return trace ? Math.abs(traceOffset(trace, p)) : null
  }
  if ('line' in b) {
    const l = ent(b.line)
    if (!l || l.kind !== 'line') return null
    const d = normalize2(sub2(l.b, l.a))
    return d ? Math.abs(dot2(sub2(p, l.a), perp2(d))) : null
  }
  const q = pointOf(b)
  return q ? distanceAlong(p, q, axis) : null
}

export { arcPoint }
