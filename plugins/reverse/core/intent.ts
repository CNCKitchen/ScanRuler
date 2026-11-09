// SPDX-License-Identifier: AGPL-3.0-only
// What the fitted pieces of a profile nearly are — with the evidence, and
// without the verdict. A wall fitted to a scan comes out 89.7° to the
// floor beside it; whether that is a right angle the scanner blurred or a
// draft the designer drew is not a question the numbers settle alone, and
// an agent (or an operator) with the part in mind settles it better than a
// threshold would. What the numbers do settle is how far the pieces are
// from each relation and how well the scan pins them down, and that is what
// this module hands over: for every piece how well it sits on its points
// and the uncertainty its fit carries, the round figure a designer would
// have drawn beside each measured one, and every relation the pieces come
// within a wide net of — parallel, square, in line, equal, concentric,
// tangent, on a coordinate plane, mirror images — each with how far off
// it is and how many of the fit's own sigmas that is. Under about two the
// relation is within the scan's noise; well above it the pieces were
// measured apart. The caller decides, and the answer carries each relation
// ready to add to the sketch as a constraint.
//
// Tangent, equal radius and a round angle are offered between neighbours
// only: pieces joined at an end, or whose ends lie within a few of their
// scatters. Between pieces apart along the profile they hold by chance — a
// wall's carrier that happens to graze a curve elsewhere, a rim's lip as
// round as the bore's corner — and taken they pull one piece across the
// profile to the other. Equal radius reaches one piece further, to two
// arcs at either end of one side: a slot's two ends, a plate's corners.
// Circles are whole pieces with no ends: one is a neighbour of what ends
// on it or touches it, and two holes may be the same size wherever they
// are.
//
// The uncertainties are the fits' own, from the normal equations of the
// least squares behind each piece (the Gauss–Newton covariance): a line's
// direction is known to σ / √Σt² — tightly on a long side, loosely on a
// stub — and a circle's radius and centre to what the arc it was fitted on
// allows, which on a short arc is little. The per-point σ is the piece's
// own residual, floored at the chain's scatter so a piece that happens to
// sit on its points does not claim certainty the scan does not have.

import type { Vec2 } from '../../../src/core/flat/types'
import { traceLine, traceOffset, type DatumPlane, type DatumTrace } from './datums'
import { nominalOf, nominalStep, type NominalKind } from './nominal'
import { constraintEntities, lineLength, type Constraint, type ConstraintInput, type SketchArc, type SketchCircle, type SketchEntity, type SketchLine } from './sketch'
import { nearestOnSpline, splineCurve } from './sketchSpline'
import { round4 } from '../../../src/core/round'

/** How wide the net is cast: a relation farther off than this is not
 *  offered. Reporting thresholds, not decisions — wide on purpose. */
export interface IntentNet {
  /** Degrees off parallel, square, level or upright. */
  angleDeg: number
  /** Millimetres off in line, concentric, tangent, equal, on a plane, or
   *  mirrored. */
  mm: number
}

export const DEFAULT_NET: IntentNet = { angleDeg: 5, mm: 1 }

/** How many candidates an answer carries unless told otherwise. */
export const DEFAULT_LIMIT = 60

/** A measured figure beside the round one a designer would have drawn. */
export interface Rounding {
  measured: number
  nominal: number
  /** measured − nominal, in the figure's unit. */
  off: number
  /** |off| over the fit's sigma for that figure; null where the fit does
   *  not know one. */
  sigmas: number | null
}

export interface PieceReading {
  id: number
  kind: 'line' | 'arc' | 'circle'
  /** How well the piece sits on its slice points, mm, and how many there
   *  are; null for a piece drawn rather than fitted. */
  residual: { rms: number; max: number; points: number } | null
  /** The fit's own uncertainty: a line's direction (angleDeg, degrees) and
   *  its place across itself (offset, mm); a round piece's radius and its
   *  centre (mm). Null where there are too few points to say. */
  sigma: { angleDeg?: number; offset?: number; radius?: number; center?: number } | null
  /** A line's length and the angle it runs at, a round piece's radius,
   *  each beside its nearest round value. */
  nominal: { length?: Rounding; angleDeg?: Rounding; radius?: Rounding }
}

export type CandidateKind = 'horizontal' | 'vertical' | 'parallel' | 'perpendicular' | 'collinear' | 'angle' | 'equal' | 'concentric' | 'tangent' | 'onDatum' | 'symmetric'

export interface Candidate {
  kind: CandidateKind
  /** The piece, or the two, by id. */
  pieces: number[]
  /** For onDatum and symmetric: which of the part's coordinate planes. */
  datum?: DatumPlane
  /** How far the pieces are from the relation. */
  off: number
  unit: 'deg' | 'mm'
  /** The fit's sigma for that figure, same unit; null where not known. */
  sigma: number | null
  /** off over sigma: under about 2, within the scan's noise. */
  sigmas: number | null
  /** For angle: the round angle between the lines' directions (30, 45,
   *  60 …) the pair is near. */
  nominal?: number
  /** For equal: what is equal. */
  what?: 'length' | 'radius'
  /** For onDatum on a line, the direction's share too, degrees. */
  alsoDeg?: number
  /** The relation as the sketch takes it, ready to add. */
  constraints: ConstraintInput[]
}

const EPS_MM = 1e-6
/** A per-point sigma is never taken under this, mm. */
const SIGMA_FLOOR = 1e-6
/** Round angles between two lines a pair is held near, degrees — besides
 *  0 and 90, which are parallel and perpendicular. */
const ROUND_ANGLES = [15, 30, 45, 60, 75, 105, 120, 135, 150, 165]
/** How near two pieces' ends have to be to make them neighbours when no
 *  relation joins them, in the larger of their scatters — and never under
 *  NEAR_FLOOR_MM, for pieces drawn rather than fitted. */
const NEAR_SCATTERS = 4
const NEAR_FLOOR_MM = 1e-3

const toDeg = (r: number) => (r * 180) / Math.PI
const hyp = (...v: (number | null)[]): number | null => (v.some((x) => x === null || !Number.isFinite(x)) ? null : Math.hypot(...(v as number[])))
const over = (off: number, sigma: number | null): number | null => (sigma === null || !(sigma > 0) ? null : round4(off / sigma))

// ---- the fits' own statistics -------------------------------------------------------

interface LineStats {
  rms: number
  max: number
  n: number
  /** Radians. */
  sigmaAngle: number | null
  sigmaOffset: number | null
  /** The per-point sigma the uncertainties rest on. */
  sigmaPoint: number
}

interface RoundStats {
  rms: number
  max: number
  n: number
  sigmaRadius: number | null
  sigmaCenter: number | null
  sigmaPoint: number
}

/** The residuals of a line's points and the covariance of its fit: the
 *  direction is known to σ/√Σ(t − t̄)², the offset to σ/√n. */
export function lineStats(l: SketchLine): LineStats | null {
  const pts = l.points
  if (!pts || pts.length === 0) return null
  const dx = l.b[0] - l.a[0]
  const dy = l.b[1] - l.a[1]
  const L = Math.hypot(dx, dy)
  if (L < EPS_MM) return null
  const ux = dx / L, uy = dy / L
  const n = pts.length
  let sumSq = 0, max = 0, st = 0
  const ts = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const px = pts[i][0] - l.a[0], py = pts[i][1] - l.a[1]
    const r = -uy * px + ux * py
    sumSq += r * r
    if (Math.abs(r) > max) max = Math.abs(r)
    ts[i] = ux * px + uy * py
    st += ts[i]
  }
  const rms = Math.sqrt(sumSq / n)
  if (n < 3) return { rms, max, n, sigmaAngle: null, sigmaOffset: null, sigmaPoint: Math.max(rms, l.scatter ?? 0, SIGMA_FLOOR) }
  const mean = st / n
  let stt = 0
  for (let i = 0; i < n; i++) stt += (ts[i] - mean) ** 2
  const sigmaPoint = Math.max(Math.sqrt(sumSq / (n - 2)), l.scatter ?? 0, SIGMA_FLOOR)
  return { rms, max, n, sigmaAngle: stt > 1e-12 ? sigmaPoint / Math.sqrt(stt) : null, sigmaOffset: sigmaPoint / Math.sqrt(n), sigmaPoint }
}

/** The residuals of a round piece's points and the covariance of its fit,
 *  from the normal matrix of the radial residuals: on a full circle the
 *  radius is known to σ/√n, on a short arc to far less. */
export function roundStats(e: SketchArc | SketchCircle): RoundStats | null {
  const pts = e.points
  if (!pts || pts.length === 0) return null
  const n = pts.length
  let sumSq = 0, max = 0
  let scc = 0, sss = 0, scs = 0, sc = 0, ss = 0
  for (const p of pts) {
    const dx = p[0] - e.c[0], dy = p[1] - e.c[1]
    const rho = Math.hypot(dx, dy)
    const r = rho - e.r
    sumSq += r * r
    if (Math.abs(r) > max) max = Math.abs(r)
    if (rho < EPS_MM) continue
    const c = dx / rho, s = dy / rho
    scc += c * c
    sss += s * s
    scs += c * s
    sc += c
    ss += s
  }
  const rms = Math.sqrt(sumSq / n)
  const sigmaPoint = Math.max(n > 3 ? Math.sqrt(sumSq / (n - 3)) : rms, e.scatter ?? 0, SIGMA_FLOOR)
  if (n < 4) return { rms, max, n, sigmaRadius: null, sigmaCenter: null, sigmaPoint }
  // The normal matrix [[Σc², Σcs, Σc], [Σcs, Σs², Σs], [Σc, Σs, n]] inverted.
  const a = scc, b = scs, c = sc, d = sss, f = ss, g = n
  const det = a * (d * g - f * f) - b * (b * g - f * c) + c * (b * f - d * c)
  if (!(Math.abs(det) > 1e-14 * n * n * n)) return { rms, max, n, sigmaRadius: null, sigmaCenter: null, sigmaPoint }
  const i00 = (d * g - f * f) / det
  const i11 = (a * g - c * c) / det
  const i22 = (a * d - b * b) / det
  const v = sigmaPoint * sigmaPoint
  return { rms, max, n, sigmaRadius: i22 > 0 ? Math.sqrt(v * i22) : null, sigmaCenter: i00 + i11 > 0 ? Math.sqrt(v * (i00 + i11)) : null, sigmaPoint }
}

/** A fitted piece's residual against its points — rms and worst miss, mm —
 *  or null for a piece without points. */
function pieceResidual(e: SketchEntity): { rms: number; max: number; points: number } | null {
  if (e.kind === 'line') {
    const s = lineStats(e)
    return s && { rms: s.rms, max: s.max, points: s.n }
  }
  if (e.kind === 'arc' || e.kind === 'circle') {
    const s = roundStats(e)
    return s && { rms: s.rms, max: s.max, points: s.n }
  }
  if (e.kind === 'spline' && e.points && e.points.length > 0) {
    const fit = splineCurve(e)
    const miss = e.points.map((p) => nearestOnSpline(fit, p, 8).dist)
    return { rms: Math.sqrt(miss.reduce((s, m) => s + m * m, 0) / miss.length), max: Math.max(...miss), points: miss.length }
  }
  return null
}

/** The per-point sigma a fitted piece's uncertainties rest on, mm — its own
 *  residual floored at its chain's scatter, as the candidates take it — or
 *  null for a piece drawn rather than fitted. */
export function pointSigma(e: SketchEntity): number | null {
  if (e.kind === 'line') return lineStats(e)?.sigmaPoint ?? null
  if (e.kind === 'arc' || e.kind === 'circle') return roundStats(e)?.sigmaPoint ?? null
  const r = pieceResidual(e)
  return r && Math.max(r.rms, ('scatter' in e ? e.scatter : undefined) ?? 0, SIGMA_FLOOR)
}

/** The residual over every fitted piece of a sketch: rms and worst miss,
 *  and which piece misses worst. Null when nothing was fitted. */
export function sketchResidual(entities: readonly SketchEntity[]): { rms: number; max: number; worst: { piece: number; mm: number }; pieces: number } | null {
  let sumSq = 0, n = 0, max = 0, worst = -1, pieces = 0
  for (const e of entities) {
    const r = pieceResidual(e)
    if (!r) continue
    pieces++
    sumSq += r.rms * r.rms * r.points
    n += r.points
    if (r.max > max) {
      max = r.max
      worst = e.id
    }
  }
  if (n === 0) return null
  return { rms: round4(Math.sqrt(sumSq / n)), max: round4(max), worst: { piece: worst, mm: round4(max) }, pieces }
}

// ---- the pieces, read ------------------------------------------------------------

export function rounding(measured: number, kind: NominalKind, sigma: number | null): Rounding {
  const step = nominalStep(measured, kind)
  const nominal = nominalOf(measured, kind) ?? Math.round(measured / step) * step
  const off = measured - nominal
  return { measured: round4(measured), nominal: round4(nominal), off: round4(off), sigmas: over(Math.abs(off), sigma) }
}

/** The direction a line runs at, degrees from +u, 0 to 180. */
export function lineAngleDeg(l: SketchLine): number {
  return ((toDeg(Math.atan2(l.b[1] - l.a[1], l.b[0] - l.a[0])) % 180) + 180) % 180
}

/** Every line, arc and circle of the sketch read: residual, uncertainty
 *  and nominal figures. Construction pieces are left out. */
export function readPieces(entities: readonly SketchEntity[]): PieceReading[] {
  const out: PieceReading[] = []
  for (const e of entities) {
    if (e.construction) continue
    if (e.kind === 'line') {
      const s = lineStats(e)
      const angleSigma = s?.sigmaAngle === null || s?.sigmaAngle === undefined ? null : toDeg(s.sigmaAngle)
      const L = lineLength(e)
      out.push({
        id: e.id,
        kind: 'line',
        residual: s ? { rms: round4(s.rms), max: round4(s.max), points: s.n } : null,
        sigma: s && s.sigmaAngle !== null ? { angleDeg: round4(toDeg(s.sigmaAngle)), offset: round4(s.sigmaOffset!) } : null,
        nominal: {
          length: rounding(L, 'length', s ? Math.SQRT2 * s.sigmaPoint : null),
          angleDeg: rounding(lineAngleDeg(e), 'angle', angleSigma),
        },
      })
    } else if (e.kind === 'arc' || e.kind === 'circle') {
      const s = roundStats(e)
      out.push({
        id: e.id,
        kind: e.kind,
        residual: s ? { rms: round4(s.rms), max: round4(s.max), points: s.n } : null,
        sigma: s && s.sigmaRadius !== null ? { radius: round4(s.sigmaRadius), center: round4(s.sigmaCenter!) } : null,
        nominal: { radius: rounding(e.r, 'radius', s?.sigmaRadius ?? null) },
      })
    }
  }
  return out
}

// ---- the candidates --------------------------------------------------------------------

interface LineRead {
  id: number
  a: Vec2
  b: Vec2
  u: Vec2
  theta: number
  length: number
  mid: Vec2
  sigmaAngleDeg: number | null
  sigmaOffset: number | null
  sigmaPoint: number | null
}

interface RoundRead {
  id: number
  kind: 'arc' | 'circle'
  c: Vec2
  r: number
  ends: Vec2[] | null
  sigmaRadius: number | null
  sigmaCenter: number | null
  sigmaPoint: number | null
}

const d2 = (p: Vec2, q: Vec2) => Math.hypot(p[0] - q[0], p[1] - q[1])

/** A point's signed distance from a line's carrier, and where along it
 *  the foot lies, from the line's start. */
function acrossLine(l: LineRead, p: Vec2): { off: number; t: number } {
  const px = p[0] - l.a[0], py = p[1] - l.a[1]
  return { off: -l.u[1] * px + l.u[0] * py, t: l.u[0] * px + l.u[1] * py }
}

/** The undirected angle between two lines' directions, degrees 0 to 90. */
function between(a: LineRead, b: LineRead): number {
  const d = Math.abs(a.theta - b.theta)
  return d > 90 ? 180 - d : d
}

/** A point's mirror image in a datum trace. */
function mirrored(t: DatumTrace, p: Vec2): Vec2 {
  const off = traceOffset(t, p)
  return [p[0] - 2 * off * t.n[0], p[1] - 2 * off * t.n[1]]
}

/** The key a relation goes by, to tell one already in the sketch from a
 *  candidate: kind, the pieces, and the datum where there is one. */
function relationKey(kind: string, pieces: readonly number[], datum?: string): string {
  return `${kind}:${[...pieces].sort((x, y) => x - y).join(',')}${datum ? `:${datum}` : ''}`
}

function heldKeys(constraints: readonly Constraint[]): Set<string> {
  const keys = new Set<string>()
  for (const c of constraints) {
    const datum = 'on' in c && typeof c.on === 'object' && 'datum' in c.on ? c.on.datum : c.kind === 'symmetric' && typeof c.about === 'object' && 'datum' in c.about ? c.about.datum : undefined
    keys.add(relationKey(c.kind, constraintEntities(c), datum))
  }
  return keys
}

/** Whether two pieces are neighbours along the profile: an end of one
 *  joined to the other by a relation the sketch holds (coincident, or an
 *  end held on it), or their ends within a few scatters — for a circle, an
 *  end of the other on its rim, or the two rims touching. */
function neighbours(lines: readonly LineRead[], rounds: readonly RoundRead[], held: readonly Constraint[]): (x: LineRead | RoundRead, y: LineRead | RoundRead) => boolean {
  const joined = new Set<string>()
  const pair = (p: number, q: number) => (p < q ? `${p}:${q}` : `${q}:${p}`)
  const isEnd = (at: string) => at === 'a' || at === 'b'
  for (const c of held) {
    if (c.kind === 'coincident' && c.p.entity !== c.q.entity && isEnd(c.p.at) && isEnd(c.q.at)) joined.add(pair(c.p.entity, c.q.entity))
    if (c.kind === 'pointOn' && isEnd(c.p.at) && 'line' in c.on) joined.add(pair(c.p.entity, c.on.line))
    if (c.kind === 'pointOn' && isEnd(c.p.at) && 'curve' in c.on) joined.add(pair(c.p.entity, c.on.curve))
  }
  const ends = new Map<number, Vec2[] | null>()
  for (const l of lines) ends.set(l.id, [l.a, l.b])
  for (const r of rounds) ends.set(r.id, r.ends)
  const onRim = (r: RoundRead, p: Vec2) => Math.abs(d2(r.c, p) - r.r)
  // How far a circle's rim is from touching another piece.
  const apart = (r: RoundRead, o: LineRead | RoundRead): number => {
    if ('c' in o) {
      const dc = d2(r.c, o.c)
      return Math.min(Math.abs(dc - (r.r + o.r)), Math.abs(dc - Math.abs(r.r - o.r)))
    }
    const t = Math.max(0, Math.min(o.length, acrossLine(o, r.c).t))
    return Math.abs(d2(r.c, [o.a[0] + t * o.u[0], o.a[1] + t * o.u[1]]) - r.r)
  }
  return (x, y) => {
    if (joined.has(pair(x.id, y.id))) return true
    const near = Math.max(NEAR_SCATTERS * Math.max(x.sigmaPoint ?? 0, y.sigmaPoint ?? 0), NEAR_FLOOR_MM)
    const ex = ends.get(x.id) ?? null
    const ey = ends.get(y.id) ?? null
    if (ex && ey) return ex.some((p) => ey.some((q) => d2(p, q) <= near))
    // A circle: the other's end on its rim, or the two touching.
    if ('c' in y && !ey) return (ex !== null && ex.some((p) => onRim(y, p) <= near)) || apart(y, x) <= near
    if ('c' in x && !ex) return (ey !== null && ey.some((p) => onRim(x, p) <= near)) || apart(x, y) <= near
    return false
  }
}

const candidateKey = (c: Candidate): string => relationKey(c.constraints[0]?.kind ?? c.kind, c.pieces, c.datum)

/**
 * The relations the pieces come within the net of, each with the
 * evidence, nearest the mark first. Relations the sketch already holds
 * (`held`) are left out, and so are the pairs an axis relation on both
 * pieces already says: two level lines are parallel without being told.
 */
export function candidatesOf(entities: readonly SketchEntity[], datums: readonly DatumTrace[], net: IntentNet = DEFAULT_NET, held: readonly Constraint[] = [], limit = DEFAULT_LIMIT): Candidate[] {
  const lines: LineRead[] = []
  const rounds: RoundRead[] = []
  for (const e of entities) {
    if (e.construction) continue
    if (e.kind === 'line') {
      const L = lineLength(e)
      if (L < EPS_MM) continue
      const s = lineStats(e)
      lines.push({
        id: e.id,
        a: e.a,
        b: e.b,
        u: [(e.b[0] - e.a[0]) / L, (e.b[1] - e.a[1]) / L],
        theta: lineAngleDeg(e),
        length: L,
        mid: [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2],
        sigmaAngleDeg: s?.sigmaAngle === null || s?.sigmaAngle === undefined ? null : toDeg(s.sigmaAngle),
        sigmaOffset: s?.sigmaOffset ?? null,
        sigmaPoint: s?.sigmaPoint ?? null,
      })
    } else if (e.kind === 'arc' || e.kind === 'circle') {
      const s = roundStats(e)
      const ends: Vec2[] | null = e.kind === 'arc' ? [[e.c[0] + e.r * Math.cos(e.start), e.c[1] + e.r * Math.sin(e.start)], [e.c[0] + e.r * Math.cos(e.start + e.sweep), e.c[1] + e.r * Math.sin(e.start + e.sweep)]] : null
      rounds.push({ id: e.id, kind: e.kind, c: e.c, r: e.r, ends, sigmaRadius: s?.sigmaRadius ?? null, sigmaCenter: s?.sigmaCenter ?? null, sigmaPoint: s?.sigmaPoint ?? null })
    }
  }
  const out: Candidate[] = []
  const add = (c: Omit<Candidate, 'sigmas'>) => out.push({ ...c, off: round4(c.off), sigma: c.sigma === null ? null : round4(c.sigma), sigmas: over(c.off, c.sigma) })

  const adjacent = neighbours(lines, rounds, held)

  // Lines along the sheet's axes. `squarely`: so near their axis that a
  // pair's parallel or perpendicular says nothing horizontal and vertical do
  // not. Only near — a sketch drawn a degree or two turned — the pair's
  // relation is offered as well: it is the one that holds if the axes are
  // turned down, and dropped it left a turned sketch with no square
  // relations at all (issue 34).
  const squarely = new Set<number>()
  for (const l of lines) {
    const level = Math.min(l.theta, 180 - l.theta)
    const upright = Math.abs(l.theta - 90)
    if (Math.min(level, upright) <= net.angleDeg / 4) squarely.add(l.id)
    if (level <= net.angleDeg) {
      add({ kind: 'horizontal', pieces: [l.id], off: level, unit: 'deg', sigma: l.sigmaAngleDeg, constraints: [{ kind: 'horizontal', entity: l.id }] })
    } else if (upright <= net.angleDeg) {
      add({ kind: 'vertical', pieces: [l.id], off: upright, unit: 'deg', sigma: l.sigmaAngleDeg, constraints: [{ kind: 'vertical', entity: l.id }] })
    }
  }

  // Pairs of lines.
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const a = lines[i], b = lines[j]
      const d = between(a, b)
      const sigmaAngle = hyp(a.sigmaAngleDeg, b.sigmaAngleDeg)
      const both = squarely.has(a.id) && squarely.has(b.id)
      if (d <= net.angleDeg) {
        // In line as well as parallel?
        const offB = Math.abs(acrossLine(a, b.mid).off)
        const offA = Math.abs(acrossLine(b, a.mid).off)
        const off = Math.max(offA, offB)
        if (off <= net.mm) {
          const gap = d2(a.mid, b.mid)
          const rad = (deg: number | null) => (deg === null ? null : (deg * Math.PI) / 180)
          const sigma = hyp(a.sigmaOffset, b.sigmaOffset, rad(a.sigmaAngleDeg) === null ? null : gap * rad(a.sigmaAngleDeg)!, rad(b.sigmaAngleDeg) === null ? null : gap * rad(b.sigmaAngleDeg)!)
          // units-ok: the candidate's unit field, of the agent's answer
          add({ kind: 'collinear', pieces: [a.id, b.id], off, unit: 'mm', sigma, constraints: [{ kind: 'collinear', line: b.id, on: { line: a.id } }] })
        } else if (!both) add({ kind: 'parallel', pieces: [a.id, b.id], off: d, unit: 'deg', sigma: sigmaAngle, constraints: [{ kind: 'parallel', a: a.id, b: b.id }] })
      } else if (Math.abs(d - 90) <= net.angleDeg) {
        if (!both) add({ kind: 'perpendicular', pieces: [a.id, b.id], off: Math.abs(d - 90), unit: 'deg', sigma: sigmaAngle, constraints: [{ kind: 'perpendicular', a: a.id, b: b.id }] })
      } else {
        // A round angle between neighbours — the directed angle, as the
        // sketch's angle dimension reads it.
        if (adjacent(a, b)) {
          const phi = toDeg(Math.acos(Math.max(-1, Math.min(1, a.u[0] * b.u[0] + a.u[1] * b.u[1]))))
          let best: number | null = null
          for (const n of ROUND_ANGLES) if (best === null || Math.abs(phi - n) < Math.abs(phi - best)) best = n
          if (best !== null && Math.abs(phi - best) <= net.angleDeg) {
            add({ kind: 'angle', pieces: [a.id, b.id], nominal: best, off: Math.abs(phi - best), unit: 'deg', sigma: sigmaAngle, constraints: [{ kind: 'angle', a: a.id, b: b.id, value: best }] })
          }
        }
      }
      // Equal lengths: the ends are corners the fit put there, so the
      // sigma is rough — the noise of a point at each end.
      const dl = Math.abs(a.length - b.length)
      if (dl <= net.mm) {
        const sl = (l: LineRead) => (l.sigmaPoint === null ? null : Math.SQRT2 * l.sigmaPoint)
        // units-ok: the candidate's unit field, of the agent's answer
        add({ kind: 'equal', what: 'length', pieces: [a.id, b.id], off: dl, unit: 'mm', sigma: hyp(sl(a), sl(b)), constraints: [{ kind: 'equal', a: a.id, b: b.id }] })
      }
    }
  }

  // Pairs of round pieces.
  for (let i = 0; i < rounds.length; i++) {
    for (let j = i + 1; j < rounds.length; j++) {
      const a = rounds[i], b = rounds[j]
      const dc = d2(a.c, b.c)
      const dr = Math.abs(a.r - b.r)
      // Two holes alike anywhere; two arcs of an outline side by side, or
      // at either end of one piece.
      const besides = (a.kind === 'circle' && b.kind === 'circle') || adjacent(a, b) || [...lines, ...rounds].some((m) => m.id !== a.id && m.id !== b.id && adjacent(a, m) && adjacent(m, b))
      // units-ok: the candidate's unit field, of the agent's answer
      if (dr <= net.mm && besides) add({ kind: 'equal', what: 'radius', pieces: [a.id, b.id], off: dr, unit: 'mm', sigma: hyp(a.sigmaRadius, b.sigmaRadius), constraints: [{ kind: 'equal', a: a.id, b: b.id }] })
      if (dc <= net.mm) {
        // units-ok: the candidate's unit field, of the agent's answer
        add({ kind: 'concentric', pieces: [a.id, b.id], off: dc, unit: 'mm', sigma: hyp(a.sigmaCenter, b.sigmaCenter), constraints: [{ kind: 'concentric', a: a.id, b: b.id }] })
        continue
      }
      const touch = Math.min(Math.abs(dc - (a.r + b.r)), Math.abs(dc - Math.abs(a.r - b.r)))
      // units-ok: the candidate's unit field, of the agent's answer
      if (touch <= net.mm && adjacent(a, b)) add({ kind: 'tangent', pieces: [a.id, b.id], off: touch, unit: 'mm', sigma: hyp(a.sigmaCenter, b.sigmaCenter, a.sigmaRadius, b.sigmaRadius), constraints: [{ kind: 'tangent', a: a.id, b: b.id }] })
    }
  }

  // A line tangent to a round piece — where the round piece lies beside
  // the line, not somewhere far along its carrier, and meets it.
  for (const l of lines) {
    for (const r of rounds) {
      const { off, t } = acrossLine(l, r.c)
      if (t < -r.r || t > l.length + r.r || !adjacent(l, r)) continue
      const touch = Math.abs(Math.abs(off) - r.r)
      // units-ok: the candidate's unit field, of the agent's answer
      if (touch <= net.mm) add({ kind: 'tangent', pieces: [l.id, r.id], off: touch, unit: 'mm', sigma: hyp(l.sigmaOffset, r.sigmaCenter, r.sigmaRadius), constraints: [{ kind: 'tangent', a: l.id, b: r.id }] })
    }
  }

  // On a coordinate plane, and mirror images across one.
  for (const t of datums) {
    const dir = traceLine(t).d
    for (const l of lines) {
      const lean = toDeg(Math.acos(Math.min(1, Math.abs(l.u[0] * dir[0] + l.u[1] * dir[1]))))
      const off = Math.abs(traceOffset(t, l.mid))
      if (lean <= net.angleDeg && off <= net.mm) {
        // units-ok: the candidate's unit field, of the agent's answer
        add({ kind: 'onDatum', pieces: [l.id], datum: t.plane, off, unit: 'mm', sigma: l.sigmaOffset, alsoDeg: round4(lean), constraints: [{ kind: 'collinear', line: l.id, on: { datum: t.plane } }] })
      }
    }
    for (const r of rounds) {
      const off = Math.abs(traceOffset(t, r.c))
      // units-ok: the candidate's unit field, of the agent's answer
      if (off <= net.mm) add({ kind: 'onDatum', pieces: [r.id], datum: t.plane, off, unit: 'mm', sigma: r.sigmaCenter, constraints: [{ kind: 'pointOn', p: { entity: r.id, at: 'center' }, on: { datum: t.plane } }] })
    }
    for (let i = 0; i < lines.length; i++) {
      for (let j = i + 1; j < lines.length; j++) {
        const a = lines[i], b = lines[j]
        const ma = mirrored(t, a.a), mb = mirrored(t, a.b)
        const straight = Math.max(d2(ma, b.a), d2(mb, b.b))
        const crossed = Math.max(d2(ma, b.b), d2(mb, b.a))
        const off = Math.min(straight, crossed)
        if (off > net.mm) continue
        const q: ['a' | 'b', 'a' | 'b'] = straight <= crossed ? ['a', 'b'] : ['b', 'a']
        add({
          kind: 'symmetric',
          pieces: [a.id, b.id],
          datum: t.plane,
          off,
          // units-ok: the candidate's unit field, of the agent's answer
          unit: 'mm',
          sigma: hyp(a.sigmaPoint, b.sigmaPoint),
          constraints: [
            { kind: 'symmetric', p: { entity: a.id, at: 'a' }, q: { entity: b.id, at: q[0] }, about: { datum: t.plane } },
            { kind: 'symmetric', p: { entity: a.id, at: 'b' }, q: { entity: b.id, at: q[1] }, about: { datum: t.plane } },
          ],
        })
      }
    }
    for (let i = 0; i < rounds.length; i++) {
      for (let j = i + 1; j < rounds.length; j++) {
        const a = rounds[i], b = rounds[j]
        if (a.kind !== b.kind) continue
        let off = Math.max(d2(mirrored(t, a.c), b.c), Math.abs(a.r - b.r))
        if (a.ends && b.ends) {
          const ma = mirrored(t, a.ends[0]), mb = mirrored(t, a.ends[1])
          off = Math.max(off, Math.min(Math.max(d2(ma, b.ends[0]), d2(mb, b.ends[1])), Math.max(d2(ma, b.ends[1]), d2(mb, b.ends[0]))))
        }
        if (off > net.mm) continue
        add({
          kind: 'symmetric',
          pieces: [a.id, b.id],
          datum: t.plane,
          off,
          // units-ok: the candidate's unit field, of the agent's answer
          unit: 'mm',
          sigma: hyp(a.sigmaCenter, b.sigmaCenter, a.sigmaRadius, b.sigmaRadius),
          constraints: [{ kind: 'symmetric', p: { entity: a.id, at: 'center' }, q: { entity: b.id, at: 'center' }, about: { datum: t.plane } }, { kind: 'equal', a: a.id, b: b.id }],
        })
      }
    }
  }

  const have = heldKeys(held)
  const kept = out.filter((c) => !c.constraints.every((k) => have.has(relationKey(k.kind, constraintEntities(k as Constraint), 'on' in k && typeof k.on === 'object' && 'datum' in k.on ? k.on.datum : k.kind === 'symmetric' && typeof k.about === 'object' && 'datum' in k.about ? k.about.datum : undefined))))
  // Nearest the mark first, by sigmas where known, by the plain offset
  // where not — then capped.
  kept.sort((x, y) => (x.sigmas ?? Infinity) - (y.sigmas ?? Infinity) || x.off - y.off)
  const seen = new Set<string>()
  const unique: Candidate[] = []
  for (const c of kept) {
    const k = candidateKey(c)
    if (seen.has(k)) continue
    seen.add(k)
    unique.push(c)
  }
  return unique.slice(0, limit)
}
