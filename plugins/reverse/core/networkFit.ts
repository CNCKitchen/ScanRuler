// SPDX-License-Identifier: AGPL-3.0-only
// A patch network's patches fitted to the scan together.
//
// Each four-sided cell is a cubic B-spline patch over the unit square its
// map put the cell's points on (networkMap.ts). Its four boundary rows of
// poles are its sides' curves, fitted first (networkCurve.ts) and faired by
// the same smoothness as the patches: a side that
// is one curve takes that curve's poles, so two neighbours share the poles
// of the curve between them and meet on it exactly. For that their knots
// along it must be the same, and so must a patch's on its opposite sides:
// the sides tied by either rule — opposite in a cell, the same curve in two
// cells — are put together by union-find into strips that run across the
// network, each with one span count, Auto's or the operator's. Auto starts
// every strip at four and grows it only where a patch on it misses its
// points by more than a tolerance beyond their noise (fitNetwork).
//
// The inner poles of all the patches are the unknowns of one system, three
// coordinates each, solved by PN0's conjugate gradient. Its terms:
//
// - the data: each scan point of a cell at its (u, v) on the patch;
// - the fairing: Fit Surface's term — third divided differences of the net
//   along u, along v and mixed (see surfaceFit.ts for why third and not the
//   thin plate's second), weighted the same way for the patch's size, its
//   slider `smoothness`;
// - the pull: net cells with no point within a cell of them (a scan gap)
//   held near the Coons surface of the patch's four sides, where Fit
//   Surface holds them near its plane;
// - tangency across every shared curve not marked a crease: with B a pole
//   of the curve and A and C the first inner poles either side of it, (B −
//   A) − λ (C − B) = 0, λ the ratio of the two cross-spacings, read off a
//   first fit without it. Along the curve it is held exactly — A and C are
//   written as B − d and B + λ d, one unknown d for the two poles — and at
//   the two poles next to each corner, which two curves' rows share, as a
//   heavy weight. At a corner where three, five or six patches meet it is
//   dropped there: G1 cannot be held at such a corner by its poles (the
//   vertex enclosure problem); the angle there is reported instead. Nor
//   can it at a corner of four whose ties do not agree round it — cells
//   drawn askew, a fine scan's noise in the ratios: held by weight, they
//   folded the patches over themselves next to the corner, on a Joy-Con
//   ten patches of seventeen, a point 2.7 mm off. So the ties next to each
//   corner are tried, and let go where a patch there turned more than
//   CORNER_TURN from the first fit's, which no tie bends; the fit is
//   solved again without them, and such a corner is reported as one of
//   three, five or six is. A T-junction's curve — one patch's whole side,
//   a piece of another's — shares no poles with the longer side, and is
//   held tangent by weight, pole by pole, as a body's face holds a patch.
//
// The data's (u, v) come from the map; after each solve every point is
// projected onto its patch (Gauss–Newton from where it was) and the fit
// solved again from the last — three rounds, or fewer once the RMS moves
// less than 1 %. A robust fit leaves out the points beyond three robust
// sigmas of the first pass.

import { symmetricEigen3 } from '../../../src/core/fit/linalg'
import { conjugateGradient, type LinearOperator } from '../../../src/core/fit/sparse'
import type { Vec3 } from '../../../src/core/types'
import type { CellSide, GraphNode, HalfEdge } from './networkCells'
import { autoSpans, type CurveFit, type CurvePoints, curveSamples, type CurveTrace, DEFAULT_TOLERANCE, endTangent, fitCurve, joinTraces, leavingDirection, reversedPoles, SPANS_MAX, SPANS_MIN } from './networkCurve'
import { basisAt, curveDerivative, curvePoint, DEGREE, dividedWeights, grevilleOf, type PatchNet, patchNormal, patchPoint } from './networkSpline'

/** What a slider of 1 means against the data: Fit Surface's own scale. */
const SMOOTHNESS_SCALE = 1e-2
/** The pull toward the Coons surface in a net cell with no points within
 *  PULL_REACH cells: its weight as a share of an average held cell's
 *  points, and the samples a side standing in for points there. */
const PULL = 0.01
const PULL_REACH = 1
const PULL_SAMPLES = 3
/** The weight of the tangency held at the poles next to a corner, as a
 *  multiple of the data's mean diagonal: heavy enough that the angle it
 *  leaves is a hundredth of a degree, light enough to leave the conjugate
 *  gradient its few extra steps. */
const TIE_WEIGHT = 1e4
/** How far a patch next to a corner may turn from the first fit's — free
 *  of the ties, and never folded — before the ties there are taken to
 *  fight each other round the corner and are let go, deg. Ties that agree
 *  turn it a few degrees at most. */
const CORNER_TURN = 30
/** The cross-spacings' ratio λ is held within this factor either way. */
const RATIO_LIMIT = 5
/** The most points a patch is fitted through, per net cell: past it the
 *  points are taken evenly — fifty a cell resolve the patch's noise
 *  within a hundredth of its RMS and the fit takes a tenth of the time. */
const POINTS_PER_CELL = 50
/** Parameter correction: the most rounds, and the RMS's change that ends
 *  them sooner; the Gauss–Newton steps each point takes a round. */
const ROUNDS = 3
const ROUNDS_SETTLE = 0.01
const NEWTON_STEPS = 3
/** Robust: points past this many robust sigmas of the first pass are left
 *  out, never closer than ROBUST_FLOOR mm. */
const ROBUST_SIGMAS = 3
const ROBUST_FLOOR = 0.01
/** Auto's span count is held to a span every this many of the scan's
 *  edges along a side — some ten points a net cell. The noise rule alone
 *  sizes the net by what the points resolve, not by how many there are: on
 *  a scan with a 1.1 mm edge it gave 20 spans over a 20 mm side, a thousand
 *  points for four hundred net cells, and the fairing then shaped the patch
 *  more than they did — 0.04–0.06 mm RMS at 0.02 mm noise. */
const EDGES_PER_SPAN = 3
/** Auto: the spans a strip starts at, how much a round grows one (4, 6, 9,
 *  14, 20), and the most rounds, a round that tried and kept nothing
 *  among them. A patch over the tolerance grows its
 *  strips whose spans are at least AUTO_ALIKE of its longer one's; a
 *  growth is kept where it took a patch over the tolerance to AUTO_HELPS
 *  of where it was, or below. */
const AUTO_START = 4
const AUTO_GROWTH = 1.5
const AUTO_ROUNDS = 8
const AUTO_ALIKE = 0.75
const AUTO_HELPS = 0.8
/** The points a cell of a patch holds on the average where its misfit is
 *  read (misfitOf). */
const MISFIT_POINTS = 8
/** The conjugate gradient's tolerance. */
const SOLVE_TOLERANCE = 1e-8
/** How many points along a shared curve its angle and gap are read at. */
const EDGE_SAMPLES = 24
/** How many worst points a patch's answer names. */
const WORST_POINTS = 3

/** A cell to fit: its four sides in order with it on their left, the
 *  corners, its scan points and their (u, v) from the map. */
export interface PatchInput {
  sides: CellSide[]
  corners: number[]
  xyz: Float64Array
  uv: Float64Array
  seed: Vec3
}

/** A curve to fit: traced, fitted provisionally (the directions it leaves
 *  its nodes by), and whether the patches either side may meet at an
 *  angle on it. */
export interface CurveInput {
  id: number
  from: number
  to: number
  trace: CurveTrace
  fit: CurveFit
  crease: boolean
  /** A curve along a body's edge: the edge's points, fitted in place of
   *  the trace. */
  exact?: CurvePoints
}

export interface NetworkFitInput {
  patches: PatchInput[]
  curves: CurveInput[]
  nodes: GraphNode[]
  /** Strips' span counts, by a curve id in the strip. */
  spans: Record<string, number>
  smoothness: number
  robust?: boolean
  /** How far Auto lets a patch's shape stray from its points beyond their
   *  scatter (FittedPatch.misfit) before it gives its strips more spans,
   *  mm; DEFAULT_TOLERANCE when not given. */
  tolerance?: number
  /** The scan's mean edge, mm: what Auto holds a strip's spans to. */
  spacing?: number
  /** Curves beside a body's face (PN11): the patch on the curve meets the
   *  face on its edge (contact) or tangent to it too, by the face's unit
   *  normals at the points of it nearest those given. */
  bodySides?: { curve: number; mode: 'contact' | 'tangent'; normals: (points: readonly Vec3[]) => Vec3[] | null }[]
}

/** A fitted patch, the curves of its sides, and how it sits on its points. */
export interface FittedPatch {
  net: PatchNet
  /** Per side, the half-edges along it and its row of poles as it runs. */
  sides: { edges: HalfEdge[]; poles: Float64Array; single: boolean }[]
  corners: number[]
  seed: Vec3
  points: number
  rms: number
  max: number
  /** How far the patch's shape strays from its points beyond their
   *  scatter, RMS, mm: its residuals' RMS with their scatter taken out —
   *  0 where that is within what the scatter alone reads (misfitOf). */
  misfit: number
  worst: { at: Vec3; off: number }[]
  dropped?: number
}

/** A curve two patches share. */
export interface SharedCurve {
  curve: number
  patches: [number, number]
  /** How far apart the two patches' edges lie on it, mm: zero where they
   *  share its poles; a T-junction's side, made of more than one curve,
   *  does not. */
  gap: number
  /** The largest angle between the two patches' normals along it, deg. */
  angle: number
  crease: boolean
  /** The curve is the whole side of the first patch and a piece of the
   *  second's: a T-junction's, whose two edges do not share poles — held
   *  tangent by weight, not exactly. */
  tee?: boolean
}

/** A corner where three, five or six patches meet, or one of four whose
 *  ties were let go: the largest angle between two of them across a curve
 *  near it, deg — within the two spans of it where the tie is let go (see
 *  fitNetwork). */
export interface IrregularCorner {
  node: number
  at: Vec3
  patches: number
  angle: number
}

export interface NetworkFitResult {
  patches: FittedPatch[]
  /** Every curve as fitted at its strip's span count. */
  curves: Map<number, CurveFit>
  shared: SharedCurve[]
  corners: IrregularCorner[]
  /** Each strip: its span count, whether Auto chose it, and its curves. */
  strips: { spans: number; auto: boolean; curves: number[] }[]
  /** Each patch side beside a body's face: the largest angle between the
   *  patch and the face along it (deg) and how far the curve stands off the
   *  body's edge points it was fitted to (mm). */
  bodies: { curve: number; patch: number; mode: 'contact' | 'tangent'; angle: number; gap: number }[]
  rounds: number
  iterations: number
}

/** The sides' strips, by union-find: the strip of each patch's side. */
function stripsOf(patches: readonly PatchInput[]): { of: number[][]; count: number } {
  const n = patches.length * 4
  const parent = Array.from({ length: n }, (_, i) => i)
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]]
    return i
  }
  const join = (a: number, b: number) => {
    const x = find(a)
    const y = find(b)
    if (x !== y) parent[Math.max(x, y)] = Math.min(x, y)
  }
  const byCurve = new Map<number, number>()
  patches.forEach((p, i) => {
    join(i * 4, i * 4 + 2)
    join(i * 4 + 1, i * 4 + 3)
    p.sides.forEach((s, k) => {
      if (s.edges.length !== 1) return
      const c = s.edges[0].curve
      const had = byCurve.get(c)
      if (had !== undefined) join(had, i * 4 + k)
      else byCurve.set(c, i * 4 + k)
    })
  })
  const ids = new Map<number, number>()
  const of = patches.map((_, i) => [0, 1, 2, 3].map((k) => {
    const r = find(i * 4 + k)
    if (!ids.has(r)) ids.set(r, ids.size)
    return ids.get(r)!
  }))
  return { of, count: ids.size }
}

/** Where pole m (from the side's start) of a patch's side k is in its net,
 *  and the first inner pole in from it. */
function sidePole(nu: number, nv: number, k: number, s: number): { boundary: [number, number]; inner: [number, number] } {
  switch (k) {
    case 0:
      return { boundary: [s, 0], inner: [s, 1] }
    case 1:
      return { boundary: [nu + 2, s], inner: [nu + 1, s] }
    case 2:
      return { boundary: [nu + 2 - s, nv + 2], inner: [nu + 2 - s, nv + 1] }
    default:
      return { boundary: [0, nv + 2 - s], inner: [1, nv + 2 - s] }
  }
}

/** The patches fitted together — see above. Auto's strips start at
 *  AUTO_START spans and grow only where a patch strays from its points by
 *  more than the tolerance beyond their scatter (FittedPatch.misfit), and
 *  only while that helps: a net no finer than the shape asks for follows
 *  less of the scan's noise — the Joy-Con's 5 mm patches at Auto's 13–19
 *  spans by the old rule (a span every few of the scan's scatters) rippled
 *  three times what they did at four, 0.004 mm RMS off the scan against
 *  0.0055, in six times the poles. */
export function fitNetwork(input: NetworkFitInput): NetworkFitResult {
  const { patches } = input
  const curveOf = new Map(input.curves.map((c) => [c.id, c]))
  // ---- the strips and their span counts --------------------------------
  const { of, count } = stripsOf(patches)
  const pointsOf = (id: number): CurvePoints => {
    const c = curveOf.get(id)!
    return c.exact ?? c.trace
  }
  const sideTrace = (side: CellSide): CurvePoints => joinTraces(side.edges.map((h) => ({ trace: pointsOf(h.curve), reversed: !h.forward })))
  const strips: Strips = { of, auto: new Array(count).fill(true), curves: Array.from({ length: count }, () => []), sideLength: patches.map(() => [0, 0, 0, 0]) }
  // The most spans a strip takes: what its longest side's points resolve.
  const cap: number[] = new Array(count).fill(SPANS_MIN)
  patches.forEach((p, i) => p.sides.forEach((s, k) => {
    const st = of[i][k]
    for (const h of s.edges) if (!strips.curves[st].includes(h.curve)) strips.curves[st].push(h.curve)
    const length = sideTrace(s).length
    strips.sideLength[i][k] = length
    const dense = input.spacing ? Math.max(SPANS_MIN, Math.floor(length / (EDGES_PER_SPAN * input.spacing))) : SPANS_MAX
    cap[st] = Math.max(cap[st], Math.min(SPANS_MAX, dense))
  }))
  let spans = cap.map((c) => Math.min(AUTO_START, c))
  strips.curves.forEach((curves, st) => {
    const given = [...curves].sort((a, b) => a - b).map((c) => input.spans[String(c)]).find((x) => x !== undefined)
    if (given !== undefined) {
      spans[st] = Math.max(SPANS_MIN, Math.min(SPANS_MAX, Math.round(given)))
      strips.auto[st] = false
    }
  })
  let fit = fitAt(input, strips, spans)
  // ---- Auto's rounds ---------------------------------------------------------
  const tolerance = input.tolerance ?? DEFAULT_TOLERANCE
  const patchesOf: number[][] = Array.from({ length: count }, () => [])
  of.forEach((sides, i) => {
    for (const st of new Set(sides)) patchesOf[st].push(i)
  })
  // A strip whose step did not help leaps the next time — a fillet beside
  // the scooter cover's crest came no nearer at six spans than at four,
  // 0.029 mm against 0.030, and at nine 0.021 — and stays where it was
  // once a leap does not help either.
  const leaps = new Set<number>()
  const stays = new Set<number>()
  const grows = (st: number) => strips.auto[st] && !stays.has(st) && spans[st] < cap[st]
  for (let round = 0; round < AUTO_ROUNDS; round++) {
    // Each patch over the tolerance grows its coarser way — its strip whose
    // spans are the longer — or both, where they are alike; the other way
    // once the coarser stays.
    const grow = new Set<number>()
    fit.patches.forEach((p, i) => {
      if (!(p.misfit > tolerance)) return
      const side = strips.sideLength[i]
      const ways = [
        { st: of[i][0], span: (side[0] + side[2]) / 2 / p.net.nu },
        { st: of[i][1], span: (side[1] + side[3]) / 2 / p.net.nv },
      ].filter((w) => grows(w.st))
      const longest = Math.max(0, ...ways.map((w) => w.span))
      for (const w of ways) if (w.span >= AUTO_ALIKE * longest) grow.add(w.st)
    })
    if (grow.size === 0) break
    const next = spans.slice()
    for (const st of grow) next[st] = Math.min(cap[st], Math.ceil(spans[st] * (leaps.has(st) ? AUTO_GROWTH ** 2 : AUTO_GROWTH)))
    const tried = fitAt(input, strips, next)
    // A strip's growth is kept where it brought a patch of it that was over
    // the tolerance some way down; else the strip goes back, to leap or to
    // stay (above) — a patch the smoothness holds off its points, more
    // spans do not bring nearer.
    const kept = next.slice()
    for (const st of grow) {
      const helped = patchesOf[st].some((i) => fit.patches[i].misfit > tolerance && tried.patches[i].misfit <= AUTO_HELPS * fit.patches[i].misfit)
      if (helped) {
        leaps.delete(st)
        continue
      }
      kept[st] = spans[st]
      if (leaps.has(st)) stays.add(st)
      else leaps.add(st)
    }
    if (kept.every((x, st) => x === next[st])) {
      spans = next
      fit = tried
      continue
    }
    // None helped: the fit stands, and the next round tries the strips
    // that have not been.
    if (kept.every((x, st) => x === spans[st])) continue
    spans = kept
    fit = fitAt(input, strips, spans)
  }
  return fit
}

/** A network's strips: each patch's sides' strips, whether Auto sizes each
 *  strip and its curves, and each patch's sides' lengths, mm. */
interface Strips {
  of: number[][]
  auto: boolean[]
  curves: number[][]
  sideLength: number[][]
}

/** The patches fitted together at the strips' span counts. */
function fitAt(input: NetworkFitInput, strips: Strips, stripSpans: readonly number[]): NetworkFitResult {
  const { patches } = input
  const { sideLength } = strips
  const curveOf = new Map(input.curves.map((c) => [c.id, c]))
  const nodeOf = new Map(input.nodes.map((n) => [n.id, n]))
  // A curve's span count is its strip's where it is a side of one cell;
  // one that is no cell's whole side keeps its own Auto.
  const curveSpans = new Map<number, number>()
  patches.forEach((p, i) => p.sides.forEach((s, k) => {
    if (s.edges.length === 1) curveSpans.set(s.edges[0].curve, stripSpans[strips.of[i][k]])
  }))

  // ---- the curves, held tangent where they go on through a node ---------
  // At each node the curves leaving it nearly straight on from each other
  // are paired, and each pair is given one tangent line there.
  // The way each curve leaves each of its nodes, read off its points near
  // the node (leavingDirection); every end is held to it, unless it goes on
  // straight through the node with another, or the node's tangent plane or
  // a body's face holds it otherwise (below).
  const leaving = new Map<number, { curve: number; end: 0 | 1; dir: Vec3 }[]>()
  const held = new Map<string, Vec3>()
  for (const c of input.curves) {
    const own = c.exact ?? c.trace
    const out = input.spacing ? leavingDirection(own, 0, input.spacing) : endTangent(c.fit, 0)
    const back = input.spacing ? leavingDirection(own, 1, input.spacing) : ((t: Vec3) => [-t[0], -t[1], -t[2]] as Vec3)(endTangent(c.fit, 1))
    const at = (node: number, x: { curve: number; end: 0 | 1; dir: Vec3 }) => leaving.set(node, [...(leaving.get(node) ?? []), x])
    at(c.from, { curve: c.id, end: 0, dir: out })
    at(c.to, { curve: c.id, end: 1, dir: back })
    held.set(`${c.id}:0`, out)
    held.set(`${c.id}:1`, back)
  }
  const straightOn = Math.cos((30 * Math.PI) / 180)
  // At a node on a crease only the crease's own pieces go on through it:
  // two curves either side of the fold meet at its angle, and held to one
  // tangent line they flattened the fold — a 30° fold's corner tangents
  // made level carried a level cross slope along the whole crease into the
  // Coons surface, and one patch read 0.8° across it instead of 30°.
  const onCrease = new Set<number>()
  for (const c of input.curves) {
    if (!c.crease) continue
    onCrease.add(c.from)
    onCrease.add(c.to)
  }
  for (const [node, list] of leaving) {
    const pairs: { a: number; b: number; cos: number }[] = []
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        if (list[a].curve === list[b].curve) continue
        if (onCrease.has(node) && !(curveOf.get(list[a].curve)?.crease && curveOf.get(list[b].curve)?.crease)) continue
        const cos = -(list[a].dir[0] * list[b].dir[0] + list[a].dir[1] * list[b].dir[1] + list[a].dir[2] * list[b].dir[2])
        if (cos > straightOn) pairs.push({ a, b, cos })
      }
    }
    pairs.sort((x, y) => y.cos - x.cos)
    const taken = new Set<number>()
    for (const { a, b } of pairs) {
      if (taken.has(a) || taken.has(b)) continue
      taken.add(a)
      taken.add(b)
      const d = list[a].dir
      const e = list[b].dir
      const l: Vec3 = [d[0] - e[0], d[1] - e[1], d[2] - e[2]]
      const n = Math.hypot(l[0], l[1], l[2]) || 1
      const line: Vec3 = [l[0] / n, l[1] / n, l[2] / n]
      held.set(`${list[a].curve}:${list[a].end}`, line)
      held.set(`${list[b].curve}:${list[b].end}`, [-line[0], -line[1], -line[2]])
    }
  }
  // Where three curves or more meet and none of them is a crease, every
  // one leaves in one tangent plane — the plane through their directions
  // nearest them all — so the patches meeting there have one normal there.
  // Left to each curve's own end, the noise in each tilts them apart: the
  // centre of a pentagon split from it read 4.5° between its patches.
  for (const [node, list] of leaving) {
    if (list.length < 3 || onCrease.has(node)) continue
    const dirs = list.map((x) => held.get(`${x.curve}:${x.end}`) ?? x.dir)
    const m = new Float64Array(9)
    for (const d of dirs) for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) m[a * 3 + b] += d[a] * d[b]
    const normal = symmetricEigen3(m).vectors[0]
    list.forEach((x, i) => {
      const d = dirs[i]
      const s = d[0] * normal[0] + d[1] * normal[1] + d[2] * normal[2]
      const p: Vec3 = [d[0] - s * normal[0], d[1] - s * normal[1], d[2] - s * normal[2]]
      const l = Math.hypot(p[0], p[1], p[2])
      if (l > 1e-9) held.set(`${x.curve}:${x.end}`, [p[0] / l, p[1] / l, p[2] / l])
    })
  }
  // Where a curve runs beside a body's face held tangent to it, every curve
  // leaving its two nodes leaves in the face's tangent plane there: the
  // patches' corners on the body's edge then meet the face tangent.
  const tangentTo = new Map((input.bodySides ?? []).filter((b) => b.mode === 'tangent').map((b) => [b.curve, b]))
  for (const [curve, side] of tangentTo) {
    const c = curveOf.get(curve)
    if (!c) continue
    for (const node of [c.from, c.to]) {
      const at = nodeOf.get(node)?.at
      const normal = at ? side.normals([at])?.[0] : undefined
      if (!normal) continue
      for (const x of leaving.get(node) ?? []) {
        const d = held.get(`${x.curve}:${x.end}`) ?? x.dir
        const s = d[0] * normal[0] + d[1] * normal[1] + d[2] * normal[2]
        const p: Vec3 = [d[0] - s * normal[0], d[1] - s * normal[1], d[2] - s * normal[2]]
        const l = Math.hypot(p[0], p[1], p[2])
        if (l > 1e-9) held.set(`${x.curve}:${x.end}`, [p[0] / l, p[1] / l, p[2] / l])
      }
    }
  }
  // The smoothness fairs the curves as well, as hard as the patches beside
  // them: each patch is held to its sides, so their noise was carried
  // across it — on a Joy-Con's 5 mm patches from 0.001 to 10 the patches'
  // ripple did not move, the curves' fairing being a fixed whisper. A
  // patch's fairing against its points stands at s A² ∫ |∂³P|² dA over
  // N points on its area A; a curve's against its trace's n points over
  // its length L flattens the same waves at s A³ n / (N L) (fairingOf). A
  // curve on two patches takes their mean; a body's edge, no scan noise in
  // it, none.
  const smoothness = Math.max(0, input.smoothness) * SMOOTHNESS_SCALE
  const patchFairing = patches.map((p, i) => {
    const area = ((sideLength[i][0] + sideLength[i][2]) / 2) * ((sideLength[i][1] + sideLength[i][3]) / 2)
    const points = Math.min(p.uv.length / 2, POINTS_PER_CELL * stripSpans[strips.of[i][0]] * stripSpans[strips.of[i][1]])
    return (smoothness * area ** 3) / Math.max(1, points)
  })
  const onPatches = new Map<number, number[]>()
  patches.forEach((p, i) => {
    for (const s of p.sides) for (const h of s.edges) onPatches.set(h.curve, [...(onPatches.get(h.curve) ?? []), i])
  })
  const fairingOf = (trace: CurvePoints, on: readonly number[]) => {
    if (!(smoothness > 0) || on.length === 0 || !(trace.length > 0)) return 0
    return ((trace.points.length / 3) / trace.length) * (on.reduce((sum, i) => sum + patchFairing[i], 0) / on.length)
  }
  const fits = new Map<number, CurveFit>()
  for (const c of input.curves) {
    const own = c.exact ?? c.trace
    const spans = curveSpans.get(c.id) ?? Math.min(autoSpans(own), input.spacing ? Math.max(SPANS_MIN, Math.floor(own.length / (EDGES_PER_SPAN * input.spacing))) : SPANS_MAX)
    const out = held.get(`${c.id}:0`)
    const back = held.get(`${c.id}:1`)
    const fairing = c.exact ? 0 : fairingOf(own, onPatches.get(c.id) ?? [])
    fits.set(c.id, fitCurve(own, spans, { ...(out ? { startTangent: out } : {}), ...(back ? { endTangent: [-back[0], -back[1], -back[2]] as Vec3 } : {}) }, fairing))
  }

  // ---- the nets: boundary rows from the sides -----------------------------
  const nets: PatchNet[] = []
  const sideRows: FittedPatch['sides'][] = []
  const poleBase: number[] = []
  let poleCount = 0
  patches.forEach((p, i) => {
    const nu = stripSpans[strips.of[i][0]]
    const nv = stripSpans[strips.of[i][1]]
    const net: PatchNet = { nu, nv, poles: new Float64Array((nu + 3) * (nv + 3) * 3) }
    const rows: FittedPatch['sides'] = []
    p.sides.forEach((s, k) => {
      const spans = k % 2 === 0 ? nu : nv
      let poles: Float64Array
      if (s.edges.length === 1) {
        const f = fits.get(s.edges[0].curve)!
        poles = s.edges[0].forward ? f.poles : reversedPoles(f.poles)
      } else {
        // A side of more than one curve — a T-junction's — fitted to its
        // curves as fitted, not to their traces: faired by the smoothness,
        // the curves left the traces, and a side fitted to the traces stood
        // 50 µm off them.
        poles = fitCurve(joinTraces(s.edges.map((h) => ({ trace: curveSamples(fits.get(h.curve)!), reversed: !h.forward }))), spans).poles
      }
      rows.push({ edges: s.edges, poles, single: s.edges.length === 1 })
      for (let m = 0; m < spans + 3; m++) {
        const [bi, bj] = sidePole(nu, nv, k, m).boundary
        net.poles.set(poles.subarray(m * 3, m * 3 + 3), (bi * (nv + 3) + bj) * 3)
      }
    })
    // The inner poles start on the Coons surface of the four rows.
    net.poles.set(coonsPoles(net))
    nets.push(net)
    sideRows.push(rows)
    poleBase.push(poleCount)
    poleCount += (nu + 3) * (nv + 3)
  })

  // ---- the data ------------------------------------------------------------
  // The map puts the cell's boundary vertices on the square's sides, though
  // they lie up to a triangle off the curves — so near a side its (u, v)
  // are squeezed by a row of the scan's triangles, and a cylinder's strip
  // fitted at them was 0.12 mm off at eight spans. Each point is taken from
  // where the map put it onto the Coons surface of the patch's four sides,
  // which the sides parameterise: the map keeps it in the right place on a
  // cell that folds back, the Coons surface makes its (u, v) the sides'.
  const data = patches.map((p, i) => takeEvenly(p, POINTS_PER_CELL * nets[i].nu * nets[i].nv))
  project(nets, data)

  // ---- the shared curves, the ties across them, and the corners -------------
  const sharedBy = new Map<number, { patch: number; side: number; forward: boolean }[]>()
  patches.forEach((p, i) => p.sides.forEach((s, k) => {
    if (s.edges.length !== 1) return
    const h = s.edges[0]
    sharedBy.set(h.curve, [...(sharedBy.get(h.curve) ?? []), { patch: i, side: k, forward: h.forward }])
  }))
  const cornerPatches = new Map<number, number>()
  for (const p of patches) for (const c of p.corners) cornerPatches.set(c, (cornerPatches.get(c) ?? 0) + 1)
  // A node all round which patches stand, with three, five or six of them.
  const surrounded = (node: number) => {
    const list = leaving.get(node) ?? []
    return list.every((x) => (sharedBy.get(x.curve)?.length ?? 0) === 2)
  }
  const irregular = new Set<number>()
  for (const [node, count] of cornerPatches) if (count !== 4 && count >= 3 && surrounded(node)) irregular.add(node)

  interface Tie {
    curve: number
    /** The two inner poles, global, and the boundary pole between. */
    a: number
    c: number
    b: number
    exact: boolean
    ratio: number
    /** Next to a corner: its node. */
    node: number | null
  }
  const ties: Tie[] = []
  const shared: { curve: number; patches: [number, number]; crease: boolean; sides: [number, number] }[] = []
  for (const [curve, users] of sharedBy) {
    if (users.length !== 2) continue
    const c = curveOf.get(curve)!
    shared.push({ curve, patches: [users[0].patch, users[1].patch], crease: c.crease, sides: [users[0].side, users[1].side] })
    if (c.crease) continue
    const n = fits.get(curve)!.spans + 3
    const [P, Q] = users
    for (let m = 1; m <= n - 2; m++) {
      // Next to a corner the tie is the twist pole's, which two rows share.
      const nearFrom = m === 1
      const nearTo = m === n - 2
      if ((nearFrom && irregular.has(c.from)) || (nearTo && irregular.has(c.to))) continue
      const at = (u: { patch: number; side: number; forward: boolean }) => {
        const net = nets[u.patch]
        const s = u.forward ? m : n - 1 - m
        const { boundary, inner } = sidePole(net.nu, net.nv, u.side, s)
        return { b: poleBase[u.patch] + boundary[0] * (net.nv + 3) + boundary[1], i: poleBase[u.patch] + inner[0] * (net.nv + 3) + inner[1] }
      }
      const p = at(P)
      const q = at(Q)
      ties.push({ curve, a: p.i, c: q.i, b: p.b, exact: !(nearFrom || nearTo), ratio: 1, node: nearFrom ? c.from : nearTo ? c.to : null })
    }
  }

  // ---- the patches beside a body's face, tangent to it --------------------------
  // With A a pole of the first inner row and B the pole of the side's row
  // beside it, n · (A − B) = 0, n the face's normal by the curve there: the
  // patch leaves its side along the face. One row a pole, by weight; it
  // ties x, y and z together, which is why the fit is one system of all
  // three rather than three of one.
  interface FaceRow {
    pole: number
    n: Vec3
    rhs: number
  }
  const faceRows: FaceRow[] = []
  for (const [curve, side] of tangentTo) {
    const users = sharedBy.get(curve) ?? []
    const f = fits.get(curve)
    if (!f) continue
    const n = f.spans + 3
    const gr = grevilleOf(f.spans)
    const at = Array.from({ length: n }, (_, m) => curvePoint(f.poles, f.spans, gr[m]))
    const normals = side.normals(at)
    if (!normals) continue
    for (const u of users) {
      const net = nets[u.patch]
      for (let m = 1; m <= n - 2; m++) {
        const s = u.forward ? m : n - 1 - m
        const { boundary, inner } = sidePole(net.nu, net.nv, u.side, s)
        const b = (boundary[0] * (net.nv + 3) + boundary[1]) * 3
        const a = poleBase[u.patch] + inner[0] * (net.nv + 3) + inner[1]
        const nm = normals[m]
        faceRows.push({ pole: a, n: nm, rhs: nm[0] * net.poles[b] + nm[1] * net.poles[b + 1] + nm[2] * net.poles[b + 2] })
      }
    }
  }

  // ---- the system -------------------------------------------------------------
  const allPoles = new Float64Array(poleCount * 3)
  const isInner = new Uint8Array(poleCount)
  nets.forEach((net, i) => {
    allPoles.set(net.poles, poleBase[i] * 3)
    for (let a = 1; a <= net.nu + 1; a++) for (let b = 1; b <= net.nv + 1; b++) isInner[poleBase[i] + a * (net.nv + 3) + b] = 1
  })
  const patchOfPole = new Int32Array(poleCount)
  nets.forEach((net, i) => patchOfPole.fill(i, poleBase[i], poleBase[i] + (net.nu + 3) * (net.nv + 3)))

  /** The poles as unknowns: each pole's coordinates a constant and up to
   *  one unknown times a factor (a free inner pole; a pole tied to its
   *  partner across a curve through a shared d). */
  interface Layout {
    count: number
    base: Float64Array
    z: Int32Array
    coef: Float64Array
    /** The ties held by weight: global poles a and c, and b. */
    soft: Tie[]
  }
  const layout = (tied: boolean): Layout => {
    const base = Float64Array.from(allPoles)
    const z = new Int32Array(poleCount * 3).fill(-1)
    const coef = new Float64Array(poleCount * 3)
    let k = 0
    const soft: Tie[] = []
    if (tied) {
      for (const t of ties) {
        if (!t.exact) {
          soft.push(t)
          continue
        }
        for (let c = 0; c < 3; c++) {
          const zi = k++
          base[t.a * 3 + c] = allPoles[t.b * 3 + c]
          base[t.c * 3 + c] = allPoles[t.b * 3 + c]
          z[t.a * 3 + c] = zi
          coef[t.a * 3 + c] = -1
          z[t.c * 3 + c] = zi
          coef[t.c * 3 + c] = t.ratio
        }
      }
    }
    for (let g = 0; g < poleCount; g++) {
      if (!isInner[g]) continue
      for (let c = 0; c < 3; c++) {
        if (z[g * 3 + c] >= 0) continue
        base[g * 3 + c] = 0
        z[g * 3 + c] = k++
        coef[g * 3 + c] = 1
      }
    }
    return { count: k, base, z, coef, soft }
  }

  // Each patch's normal equations over its own poles: a band of 7 × 7 a
  // pole, the data, the fairing and the pull, and the data's right-hand
  // side, three coordinates.
  const BAND = 49
  const band = (net: PatchNet) => new Float64Array((net.nu + 3) * (net.nv + 3) * BAND)
  const hessians = nets.map(band)
  const rhs = nets.map((net) => new Float64Array((net.nu + 3) * (net.nv + 3) * 3))
  const fairings = nets.map((net, i) => fairingBand(net, input.smoothness, sideRows[i]))
  // The fairing is of the patch's departure from its sides' Coons surface,
  // not of the patch: a circle's poles have third differences of their own,
  // and faired toward none a strip round a cylinder was pulled 0.05 mm in.
  // The Coons surface carries the sides' bend across; what is faired is the
  // shape the points add to it. Its right-hand side: H_fair times the Coons
  // poles.
  const fairingRhs = nets.map((net, i) => {
    const out = new Float64Array((net.nu + 3) * (net.nv + 3) * 3)
    bandMultiply(fairings[i], net, coonsPoles(net), out)
    return out
  })
  const assemble = () => {
    nets.forEach((net, i) => {
      const H = hessians[i]
      const g = rhs[i]
      H.set(fairings[i])
      g.set(fairingRhs[i])
      const d = data[i]
      const cols = net.nv + 3
      const bu = new Float64Array(4)
      const bv = new Float64Array(4)
      const held = new Uint8Array(net.nu * net.nv)
      for (let k = 0; k < d.count; k++) {
        if (!d.keep[k]) continue
        const su = basisAt(net.nu, d.uv[k * 2], bu)
        const sv = basisAt(net.nv, d.uv[k * 2 + 1], bv)
        held[(su - DEGREE) * net.nv + (sv - DEGREE)] = 1
        addPoint(H, g, cols, su, sv, bu, bv, d.xyz[k * 3], d.xyz[k * 3 + 1], d.xyz[k * 3 + 2], 1)
      }
      addPull(H, g, net, held, d.kept)
    })
  }

  let tiesWeight = 0
  const solve = (lay: Layout, start: Float64Array | null): { z: Float64Array; iterations: number } => {
    // The tie weight against the data's mean diagonal.
    let diagSum = 0
    let diagCount = 0
    hessians.forEach((H) => {
      for (let p = 0; p < H.length / BAND; p++) {
        diagSum += H[p * BAND + 24]
        diagCount++
      }
    })
    tiesWeight = TIE_WEIGHT * (diagSum / Math.max(1, diagCount))
    const y = new Float64Array(poleCount * 3)
    const G = new Float64Array(poleCount * 3)
    const toPoles = (zv: Float64Array, withBase: boolean) => {
      for (let i = 0; i < poleCount * 3; i++) {
        const zi = lay.z[i]
        y[i] = (withBase ? lay.base[i] : 0) + (zi >= 0 ? lay.coef[i] * zv[zi] : 0)
      }
    }
    const applyPoles = (withConstants: boolean) => {
      G.fill(0)
      nets.forEach((net, p) => bandMultiply(hessians[p], net, y.subarray(poleBase[p] * 3, (poleBase[p] + (net.nu + 3) * (net.nv + 3)) * 3), G.subarray(poleBase[p] * 3)))
      // The tie as the exact layout holds it — C − B = λ (B − A), so A =
      // B − d and C = B + λ d — weighed as λ A + C − (1 + λ) B. It was
      // A + λ C − (1 + λ) B, which holds C − B = (B − A) / λ: the soft ties
      // next to a corner pulled the cross-spacings the other way round from
      // the ties along the curve (issue 34).
      for (const t of lay.soft) {
        const w = tiesWeight / (1 + t.ratio * t.ratio)
        for (let c = 0; c < 3; c++) {
          const r = t.ratio * y[t.a * 3 + c] + y[t.c * 3 + c] - (withConstants ? (1 + t.ratio) * allPoles[t.b * 3 + c] : 0)
          G[t.a * 3 + c] += w * t.ratio * r
          G[t.c * 3 + c] += w * r
        }
      }
      for (const row of faceRows) {
        const p = row.pole * 3
        const r = row.n[0] * y[p] + row.n[1] * y[p + 1] + row.n[2] * y[p + 2] - (withConstants ? row.rhs : 0)
        G[p] += tiesWeight * row.n[0] * r
        G[p + 1] += tiesWeight * row.n[1] * r
        G[p + 2] += tiesWeight * row.n[2] * r
      }
    }
    const fromPoles = (out: Float64Array) => {
      out.fill(0)
      for (let i = 0; i < poleCount * 3; i++) {
        const zi = lay.z[i]
        if (zi >= 0) out[zi] += lay.coef[i] * G[i]
      }
    }
    // The right-hand side: the data's, less what the constants do.
    const zero = new Float64Array(lay.count)
    toPoles(zero, true)
    applyPoles(true)
    for (let i = 0; i < poleCount * 3; i++) G[i] = -G[i]
    rhs.forEach((g, p) => {
      for (let i = 0; i < g.length; i++) G[poleBase[p] * 3 + i] += g[i]
    })
    const b = new Float64Array(lay.count)
    fromPoles(b)
    // The diagonal, for the preconditioner.
    const diagonal = new Float64Array(lay.count)
    for (let i = 0; i < poleCount * 3; i++) {
      const zi = lay.z[i]
      if (zi < 0) continue
      const g = Math.floor(i / 3)
      const p = patchOfPole[g]
      diagonal[zi] += lay.coef[i] * lay.coef[i] * hessians[p][(g - poleBase[p]) * BAND + 24]
    }
    for (const t of lay.soft) {
      const w = tiesWeight / (1 + t.ratio * t.ratio)
      for (let c = 0; c < 3; c++) {
        const za = lay.z[t.a * 3 + c]
        const zc = lay.z[t.c * 3 + c]
        if (za >= 0) diagonal[za] += w * (t.ratio * lay.coef[t.a * 3 + c]) ** 2
        if (zc >= 0) diagonal[zc] += w * lay.coef[t.c * 3 + c] ** 2
      }
    }
    for (const row of faceRows) {
      for (let c = 0; c < 3; c++) {
        const z = lay.z[row.pole * 3 + c]
        if (z >= 0) diagonal[z] += tiesWeight * (row.n[c] * lay.coef[row.pole * 3 + c]) ** 2
      }
    }
    const op: LinearOperator = {
      n: lay.count,
      diagonal,
      apply: (x, out) => {
        toPoles(x, false)
        applyPoles(false)
        fromPoles(out)
      },
    }
    const r = conjugateGradient(op, b, { tolerance: SOLVE_TOLERANCE, maxIterations: 20000, ...(start ? { x0: start } : {}) })
    return { z: r.x, iterations: r.iterations }
  }
  const polesOf = (lay: Layout, zv: Float64Array) => {
    for (let i = 0; i < poleCount * 3; i++) {
      const zi = lay.z[i]
      allPoles[i] = lay.base[i] + (zi >= 0 ? lay.coef[i] * zv[zi] : 0)
    }
    nets.forEach((net, p) => net.poles.set(allPoles.subarray(poleBase[p] * 3, (poleBase[p] + (net.nu + 3) * (net.nv + 3)) * 3)))
  }
  /** The unknowns of a layout read off the poles as they stand. */
  const zOf = (lay: Layout): Float64Array => {
    const zv = new Float64Array(lay.count)
    const seen = new Uint8Array(lay.count)
    for (let i = 0; i < poleCount * 3; i++) {
      const zi = lay.z[i]
      if (zi < 0) continue
      const v = (allPoles[i] - lay.base[i]) / lay.coef[i]
      zv[zi] = seen[zi] ? 0.5 * (zv[zi] + v) : v
      seen[zi] = 1
    }
    return zv
  }

  // ---- the first fit, free of the ties: the cross-spacings' ratios --------
  assemble()
  const free = layout(false)
  let iterations = 0
  const first = solve(free, null)
  iterations += first.iterations
  polesOf(free, first.z)
  for (const t of ties) {
    let num = 0
    let den = 0
    for (let c = 0; c < 3; c++) {
      num += (allPoles[t.c * 3 + c] - allPoles[t.b * 3 + c]) ** 2
      den += (allPoles[t.b * 3 + c] - allPoles[t.a * 3 + c]) ** 2
    }
    t.ratio = den > 0 ? Math.sqrt(num / den) : 1
  }
  smoothRatios(ties)
  for (const t of ties) t.ratio = Math.min(RATIO_LIMIT, Math.max(1 / RATIO_LIMIT, t.ratio))
  const freePoles = Float64Array.from(allPoles)

  // ---- tangency across a T-junction ---------------------------------------------
  // A curve that is one patch's whole side and a piece of another's — a
  // split cell's middle on its neighbour's side — shares no poles with that
  // side, so no tie holds the two tangent across it: on a Joy-Con they met
  // at up to 14°. Each is held as a body's face holds a patch (above): its
  // first inner row leaves its side square to one normal there — the two
  // patches' normals in the first fit, met halfway and made square to the
  // curve. The poles beside a corner are left to the ties round it.
  sideRows.forEach((rows, qi) => rows.forEach((side, k) => {
    if (side.single) return
    const Q = nets[qi]
    const qSpans = k % 2 === 0 ? Q.nu : Q.nv
    const gq = grevilleOf(qSpans)
    for (const h of side.edges) {
      const p = sharedBy.get(h.curve)?.find((u) => u.patch !== qi)
      if (!p || curveOf.get(h.curve)!.crease) continue
      const f = fits.get(h.curve)!
      const n = f.spans + 3
      /** The normal both are held to at t on the curve, s on Q's side. */
      const normalAt = (t: number, s: number): Vec3 => {
        const a = patchNormal(nets[p.patch], ...onSide(p.side, p.forward ? t : 1 - t))
        const b = patchNormal(Q, ...onSide(k, s))
        const sign = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] < 0 ? -1 : 1
        const m: Vec3 = [a[0] + sign * b[0], a[1] + sign * b[1], a[2] + sign * b[2]]
        const d = curveDerivative(f.poles, f.spans, t)
        const along = (m[0] * d[0] + m[1] * d[1] + m[2] * d[2]) / Math.max(1e-30, d[0] * d[0] + d[1] * d[1] + d[2] * d[2])
        for (let c = 0; c < 3; c++) m[c] -= along * d[c]
        const l = Math.hypot(m[0], m[1], m[2]) || 1
        return [m[0] / l, m[1] / l, m[2] / l]
      }
      const hold = (patch: number, sideOf: number, at: number, normal: Vec3) => {
        const net = nets[patch]
        const { boundary, inner } = sidePole(net.nu, net.nv, sideOf, at)
        const b = (boundary[0] * (net.nv + 3) + boundary[1]) * 3
        faceRows.push({ pole: poleBase[patch] + inner[0] * (net.nv + 3) + inner[1], n: normal, rhs: normal[0] * net.poles[b] + normal[1] * net.poles[b + 1] + normal[2] * net.poles[b + 2] })
      }
      // The whole side's poles: the curve's own.
      const gp = grevilleOf(f.spans)
      for (let m = 2; m <= n - 3; m++) {
        const x = curvePoint(f.poles, f.spans, gp[m])
        hold(p.patch, p.side, p.forward ? m : n - 1 - m, normalAt(gp[m], nearestOn(side.poles, qSpans, x)))
      }
      // The other's along the piece of its side the curve is.
      const ends = [0, 1].map((t) => nearestOn(side.poles, qSpans, curvePoint(f.poles, f.spans, t)))
      const lo = Math.min(ends[0], ends[1])
      const hi = Math.max(ends[0], ends[1])
      for (let m = 2; m <= qSpans; m++) {
        if (!(gq[m] > lo && gq[m] < hi)) continue
        const y = curvePoint(side.poles, qSpans, gq[m])
        hold(qi, k, m, normalAt(nearestOn(f.poles, f.spans, y), gq[m]))
      }
    }
  }))

  // ---- tied, and the parameters corrected -------------------------------------
  let lay = layout(ties.length > 0)
  let { rms, res } = residualRms(nets, data)
  let rounds = 0
  for (; rounds < ROUNDS; rounds++) {
    const r = solve(lay, zOf(lay))
    iterations += r.iterations
    polesOf(lay, r.z)
    if (rounds === 0) {
      // The corners whose ties could not be held (see above): let go,
      // and the fit solved again from the first.
      const torn = tornCorners(nets, freePoles, poleBase, patches, new Set(ties.flatMap((t) => (t.node !== null ? [t.node] : []))))
      if (torn.size > 0) {
        ties.splice(0, ties.length, ...ties.filter((t) => t.node === null || !torn.has(t.node)))
        for (const node of torn) irregular.add(node)
        allPoles.set(freePoles)
        lay = layout(ties.length > 0)
        const again = solve(lay, zOf(lay))
        iterations += again.iterations
        polesOf(lay, again.z)
      }
    }
    if (rounds === 0 && input.robust) dropOutliers(nets, data)
    project(nets, data)
    // The last round's residuals are the answers': nothing moves after.
    const next = residualRms(nets, data)
    res = next.res
    const settled = Math.abs(next.rms - rms) <= ROUNDS_SETTLE * Math.max(rms, 1e-9)
    rms = next.rms
    if (settled && rounds > 0) {
      rounds++
      break
    }
    if (rounds < ROUNDS - 1) assemble()
  }

  // ---- the answers ------------------------------------------------------------
  const fitted: FittedPatch[] = nets.map((net, i) => {
    const d = data[i]
    const r = res[i]
    let sq = 0
    let max = 0
    let n = 0
    // The worst few kept in a pass, not found by sorting them all: in the
    // sort's order, the earlier of two alike first.
    const order: number[] = []
    for (let k = 0; k < d.count; k++) {
      if (!d.keep[k]) continue
      const off = Math.abs(r[k])
      sq += r[k] * r[k]
      max = Math.max(max, off)
      n++
      let at = order.length
      while (at > 0 && off > Math.abs(r[order[at - 1]])) at--
      if (at < WORST_POINTS) {
        order.splice(at, 0, k)
        if (order.length > WORST_POINTS) order.pop()
      }
    }
    const worst = order.map((k) => ({ at: [d.xyz[k * 3], d.xyz[k * 3 + 1], d.xyz[k * 3 + 2]] as Vec3, off: r[k] }))
    return { net, sides: sideRows[i], corners: patches[i].corners, seed: patches[i].seed, points: n, rms: n > 0 ? Math.sqrt(sq / n) : 0, max, misfit: misfitOf(d, r, (sideLength[i][0] + sideLength[i][2]) / Math.max(1e-9, sideLength[i][1] + sideLength[i][3])), worst, ...(input.robust ? { dropped: d.count - n } : {}) }
  })
  // Within two spans of an irregular corner — or one whose ties were let
  // go — the tie was let go: the angle there is the corner's, read at the
  // corner, not the curve's.
  const nearCorner = new Map<number, number>()
  const sharedOut: SharedCurve[] = shared.map((s) => {
    const c = curveOf.get(s.curve)!
    const reach = 2 / fits.get(s.curve)!.spans
    const { nearFrom, nearTo, ...reading } = edgeReading(s, fitted, irregular.has(c.from) ? reach : 0, irregular.has(c.to) ? reach : 0)
    if (irregular.has(c.from) && !s.crease) nearCorner.set(c.from, Math.max(nearCorner.get(c.from) ?? 0, nearFrom))
    if (irregular.has(c.to) && !s.crease) nearCorner.set(c.to, Math.max(nearCorner.get(c.to) ?? 0, nearTo))
    return reading
  })
  // A curve that is one patch's whole side and a piece of another's — the
  // side through a T-node a split cell's middle made: read by the nearest
  // point of the other's side to each of the curve's.
  fitted.forEach((q, qi) => q.sides.forEach((side, k) => {
    if (side.single) return
    for (const h of side.edges) {
      const p = sharedBy.get(h.curve)?.find((u) => u.patch !== qi)
      if (!p) continue
      sharedOut.push(teeReading(h.curve, fits.get(h.curve)!, fitted, [p.patch, qi], [p.side, k], p.forward, curveOf.get(h.curve)?.crease ?? false))
    }
  }))
  // An irregular corner's angle: the most between two patches across one of
  // its curves within the two spans next to it, where the tie was let go —
  // at the corner itself the curves' common tangent plane holds them alike.
  const corners: IrregularCorner[] = [...irregular].map((node) => {
    const at = cornerReading(node, nodeOf.get(node)!.at, fitted)
    return { ...at, angle: Math.max(at.angle, nearCorner.get(node) ?? 0) }
  })
  // Each patch side beside a body's face: the angle to the face along it,
  // and the curve's stand-off from the edge it was fitted to.
  const bodiesOut: NetworkFitResult['bodies'] = []
  for (const side of input.bodySides ?? []) {
    const f = fits.get(side.curve)
    if (!f) continue
    for (const u of sharedBy.get(side.curve) ?? []) {
      const ts = Array.from({ length: EDGE_SAMPLES - 1 }, (_, k) => (k + 1) / EDGE_SAMPLES)
      const normals = side.normals(ts.map((t) => curvePoint(f.poles, f.spans, t))) ?? []
      let angle = 0
      ts.forEach((t, k) => {
        const nf = normals[k]
        if (!nf) return
        const [uu, vv] = onSide(u.side, u.forward ? t : 1 - t)
        const np = patchNormal(fitted[u.patch].net, uu, vv)
        const cos = Math.min(1, Math.abs(np[0] * nf[0] + np[1] * nf[1] + np[2] * nf[2]))
        angle = Math.max(angle, (Math.acos(cos) * 180) / Math.PI)
      })
      bodiesOut.push({ curve: side.curve, patch: u.patch, mode: side.mode, angle, gap: f.max })
    }
  }
  return {
    patches: fitted,
    curves: fits,
    shared: sharedOut,
    bodies: bodiesOut,
    corners,
    strips: strips.curves.map((curves, st) => ({ spans: stripSpans[st], auto: strips.auto[st], curves })),
    rounds,
    iterations,
  }
}

/** How far a patch strays from its points beyond their scatter (above).
 *  The scatter is read inside cells of the patch's (u, v) so small — a
 *  few points each, MISFIT_POINTS on the average, as square as the sides'
 *  lengths make them — that a shape the net cannot follow hardly changes
 *  across one: the residuals' variance about their cell's mean, σ². What
 *  is left of their mean square past it is the misfit's: M² = RMS² − σ².
 *  Read off the means of cells half a span wide instead, it missed most of
 *  it: what a net cannot follow swings to and fro within each span, and a
 *  270° strip of a cylinder at four spans read 0.004 mm where it stood
 *  0.045 off. */
function misfitOf(d: PatchData, r: Float64Array, aspect: number): number {
  let n = 0
  let sq = 0
  for (let k = 0; k < d.count; k++) {
    if (!d.keep[k]) continue
    sq += r[k] * r[k]
    n++
  }
  if (n === 0) return 0
  const cells = n / MISFIT_POINTS
  const bu = Math.max(1, Math.round(Math.sqrt(cells * aspect)))
  const bv = Math.max(1, Math.round(Math.sqrt(cells / aspect)))
  const sum = new Float64Array(bu * bv)
  const sumSq = new Float64Array(bu * bv)
  const count = new Int32Array(bu * bv)
  for (let k = 0; k < d.count; k++) {
    if (!d.keep[k]) continue
    const c = Math.min(bu - 1, Math.max(0, Math.floor(d.uv[k * 2] * bu))) * bv + Math.min(bv - 1, Math.max(0, Math.floor(d.uv[k * 2 + 1] * bv)))
    sum[c] += r[k]
    sumSq[c] += r[k] * r[k]
    count[c]++
  }
  let within = 0
  let free = 0
  for (let c = 0; c < sum.length; c++) {
    if (count[c] < 2) continue
    within += sumSq[c] - (sum[c] * sum[c]) / count[c]
    free += count[c] - 1
  }
  if (free === 0) return Math.sqrt(sq / n)
  // The estimate scatters too: on noise alone it reads some (8 / n)^¼ of
  // σ at twice its spread — 0.002 mm on a sheet with 0.02 of noise — and
  // a tolerance under that had Auto chase it to twenty spans. Within it,
  // the misfit is read as none.
  const scatter = within / free
  const misfit = Math.sqrt(Math.max(0, sq / n - scatter))
  return misfit > Math.sqrt(scatter) * (8 / n) ** 0.25 ? misfit : 0
}

/** A patch's points to fit: up to `cap` of them, taken evenly. */
interface PatchData {
  count: number
  xyz: Float64Array
  uv: Float64Array
  keep: Uint8Array
  kept: number
}

function takeEvenly(p: PatchInput, cap: number): PatchData {
  const all = p.uv.length / 2
  const step = Math.max(1, all / Math.max(1, cap))
  const count = Math.min(all, Math.ceil(all / step))
  const xyz = new Float64Array(count * 3)
  const uv = new Float64Array(count * 2)
  // Copied, never shared even when all are taken: the caller keeps the
  // input's arrays, and the fit moves its points' (u, v).
  for (let k = 0; k < count; k++) {
    const i = Math.min(all - 1, Math.floor(k * step))
    xyz[k * 3] = p.xyz[i * 3]
    xyz[k * 3 + 1] = p.xyz[i * 3 + 1]
    xyz[k * 3 + 2] = p.xyz[i * 3 + 2]
    uv[k * 2] = p.uv[i * 2]
    uv[k * 2 + 1] = p.uv[i * 2 + 1]
  }
  return { count, xyz, uv, keep: new Uint8Array(count).fill(1), kept: count }
}

/** A point's terms added to a patch's band and right-hand side, for the
 *  cubic: four by four poles, each pair's term (w bu[a1] bv[b1] bu[a2])
 *  bv[b2], its first factors taken once for the four of a row — the
 *  products the general loop formed, in its order, so the band is the
 *  same to the bit. Every point comes through here every assembly. */
function addPoint(H: Float64Array, g: Float64Array, cols: number, su: number, sv: number, bu: Float64Array, bv: Float64Array, x: number, y: number, z: number, weight: number): void {
  const bv0 = bv[0], bv1 = bv[1], bv2 = bv[2], bv3 = bv[3]
  for (let a1 = 0; a1 < 4; a1++) {
    const wa = weight * bu[a1]
    for (let b1 = 0; b1 < 4; b1++) {
      const w1 = wa * bv[b1]
      if (w1 === 0) continue
      const p1 = (su - 3 + a1) * cols + sv - 3 + b1
      g[p1 * 3] += w1 * x
      g[p1 * 3 + 1] += w1 * y
      g[p1 * 3 + 2] += w1 * z
      // Row a2 − a1 + 3 of the pole's 7 × 7, from column 3 − b1.
      const row = p1 * 49 + 3 - b1
      for (let a2 = 0; a2 < 4; a2++) {
        const w = w1 * bu[a2]
        const at = row + (a2 - a1 + 3) * 7
        H[at] += w * bv0
        H[at + 1] += w * bv1
        H[at + 2] += w * bv2
        H[at + 3] += w * bv3
      }
    }
  }
}

/** out = H y over a patch's poles, three coordinates, H the 7 × 7 band.
 *  The conjugate gradient spends most of its time here. Each pole's band
 *  rows and columns inside the net are found once, as offsets 0 … 6 —
 *  from −3 … 3 the first is −0 at the net's edge, which keeps the loop's
 *  counters off the integers — and a zero entry is added, not tested for:
 *  a sum begun at +0 is the same to the bit for it. */
function bandMultiply(H: Float64Array, net: PatchNet, y: Float64Array, out: Float64Array): void {
  const rows = net.nu + 3
  const cols = net.nv + 3
  for (let i = 0; i < rows; i++) {
    const a0 = Math.max(0, 3 - i)
    const a1 = Math.min(6, rows + 2 - i)
    for (let j = 0; j < cols; j++) {
      const b0 = Math.max(0, 3 - j)
      const b1 = Math.min(6, cols + 2 - j)
      const p = i * cols + j
      const row = p * 49
      let sx = 0
      let sy = 0
      let sz = 0
      for (let a = a0; a <= a1; a++) {
        const h0 = row + a * 7
        const q0 = (p + (a - 3) * cols - 3) * 3
        for (let b = b0; b <= b1; b++) {
          const h = H[h0 + b]
          const q = q0 + b * 3
          sx += h * y[q]
          sy += h * y[q + 1]
          sz += h * y[q + 2]
        }
      }
      out[p * 3] += sx
      out[p * 3 + 1] += sy
      out[p * 3 + 2] += sz
    }
  }
}

/** The fairing's band for a patch: Fit Surface's third divided differences
 *  over the Greville abscissae, along u, along v and mixed, each weighted
 *  by its net cell's area and by the patch's sides' lengths for its size —
 *  in the patch's [0, 1]² a third derivative along u stands for one along
 *  the side scaled by its length cubed, so a slider of 1 means here what it
 *  means to Fit Surface over the same region. */
function fairingBand(net: PatchNet, smoothness: number, rows: FittedPatch['sides']): Float64Array {
  const rowsN = net.nu + 3
  const cols = net.nv + 3
  const H = new Float64Array(rowsN * cols * 49)
  if (!(smoothness > 0)) return H
  const lengthOf = (poles: Float64Array) => {
    let l = 0
    for (let m = 1; m < poles.length / 3; m++) l += Math.hypot(poles[m * 3] - poles[m * 3 - 3], poles[m * 3 + 1] - poles[m * 3 - 2], poles[m * 3 + 2] - poles[m * 3 - 1])
    return l
  }
  const Lu = Math.max(1e-6, (lengthOf(rows[0].poles) + lengthOf(rows[2].poles)) / 2)
  const Lv = Math.max(1e-6, (lengthOf(rows[1].poles) + lengthOf(rows[3].poles)) / 2)
  const s = smoothness * SMOOTHNESS_SCALE
  const area = (1 / Math.max(1, rowsN - 1)) * (1 / Math.max(1, cols - 1))
  const xu = grevilleOf(net.nu)
  const xv = grevilleOf(net.nv)
  const add = (idx: number[], w: number[], weight: number) => {
    for (let a = 0; a < idx.length; a++) {
      const ia = Math.floor(idx[a] / cols)
      const ja = idx[a] % cols
      for (let b = 0; b < idx.length; b++) {
        const ib = Math.floor(idx[b] / cols)
        const jb = idx[b] % cols
        H[idx[a] * 49 + (ib - ia + 3) * 7 + (jb - ja + 3)] += weight * w[a] * w[b]
      }
    }
  }
  const cross = (i: number, j: number, wu: number[], wv: number[], weight: number) => {
    const idx: number[] = []
    const w: number[] = []
    for (let a = 0; a < wu.length; a++) {
      for (let b = 0; b < wv.length; b++) {
        idx.push((i + a) * cols + j + b)
        w.push(wu[a] * wv[b])
      }
    }
    add(idx, w, weight)
  }
  for (let i = 0; i < rowsN; i++) {
    for (let j = 0; j < cols; j++) {
      if (i + 3 < rowsN) cross(i, j, dividedWeights(xu, i, 3), [1], s * area * (Lv / Lu) ** 3)
      if (j + 3 < cols) cross(i, j, [1], dividedWeights(xv, j, 3), s * area * (Lu / Lv) ** 3)
      if (i + 2 < rowsN && j + 1 < cols) cross(i, j, dividedWeights(xu, i, 2), dividedWeights(xv, j, 1), 3 * s * area * (Lv / Lu))
      if (i + 1 < rowsN && j + 2 < cols) cross(i, j, dividedWeights(xu, i, 1), dividedWeights(xv, j, 2), 3 * s * area * (Lu / Lv))
    }
  }
  return H
}

/** The pull: net cells further than PULL_REACH cells from any held one
 *  get PULL_SAMPLES² samples on the Coons surface of the patch's four
 *  boundary rows, weighing a share of an average held cell's points. */
function addPull(H: Float64Array, g: Float64Array, net: PatchNet, held: Uint8Array, points: number): void {
  let heldCount = 0
  for (const x of held) heldCount += x
  const near = (a: number, b: number) => {
    for (let i = Math.max(0, a - PULL_REACH); i <= Math.min(net.nu - 1, a + PULL_REACH); i++) {
      for (let j = Math.max(0, b - PULL_REACH); j <= Math.min(net.nv - 1, b + PULL_REACH); j++) if (held[i * net.nv + j]) return true
    }
    return false
  }
  const weight = (PULL * Math.max(1, points)) / Math.max(1, heldCount) / (PULL_SAMPLES * PULL_SAMPLES)
  const cols = net.nv + 3
  const bu = new Float64Array(4)
  const bv = new Float64Array(4)
  for (let a = 0; a < net.nu; a++) {
    for (let b = 0; b < net.nv; b++) {
      if (near(a, b)) continue
      for (let s = 0; s < PULL_SAMPLES; s++) {
        for (let t = 0; t < PULL_SAMPLES; t++) {
          const u = (a + (s + 0.5) / PULL_SAMPLES) / net.nu
          const v = (b + (t + 0.5) / PULL_SAMPLES) / net.nv
          const target = coonsPoint(net, u, v)
          const su = basisAt(net.nu, u, bu)
          const sv = basisAt(net.nv, v, bv)
          addPoint(H, g, cols, su, sv, bu, bv, target[0], target[1], target[2], weight)
        }
      }
    }
  }
}

/** The Coons surface of a net's four boundary rows at (u, v). */
function coonsPoint(net: PatchNet, u: number, v: number): Vec3 {
  const rows = net.nu + 3
  const cols = net.nv + 3
  const row = (j: number) => {
    const out = new Float64Array(rows * 3)
    for (let i = 0; i < rows; i++) out.set(net.poles.subarray((i * cols + j) * 3, (i * cols + j) * 3 + 3), i * 3)
    return out
  }
  const col = (i: number) => net.poles.subarray(i * cols * 3, (i + 1) * cols * 3)
  const a = curvePoint(row(0), net.nu, u)
  const c = curvePoint(row(cols - 1), net.nu, u)
  const d = curvePoint(col(0), net.nv, v)
  const e = curvePoint(col(rows - 1), net.nv, v)
  const corner = (i: number, j: number) => net.poles.subarray((i * cols + j) * 3, (i * cols + j) * 3 + 3)
  const p00 = corner(0, 0), p10 = corner(rows - 1, 0), p01 = corner(0, cols - 1), p11 = corner(rows - 1, cols - 1)
  const out: Vec3 = [0, 0, 0]
  for (let k = 0; k < 3; k++) {
    out[k] = (1 - v) * a[k] + v * c[k] + (1 - u) * d[k] + u * e[k] - ((1 - u) * (1 - v) * p00[k] + u * (1 - v) * p10[k] + (1 - u) * v * p01[k] + u * v * p11[k])
  }
  return out
}

/** The poles of a net's Coons surface: the bilinearly blended surface of
 *  its four boundary rows, which a B-spline over the same knots holds
 *  exactly — the blend's linear factors are reproduced by poles at the
 *  Greville abscissae — so its boundary poles are the rows themselves. */
function coonsPoles(net: PatchNet): Float64Array {
  const rows = net.nu + 3
  const cols = net.nv + 3
  const gu = grevilleOf(net.nu)
  const gv = grevilleOf(net.nv)
  const P = net.poles
  const out = Float64Array.from(P)
  const at = (i: number, j: number, k: number) => P[(i * cols + j) * 3 + k]
  for (let i = 1; i < rows - 1; i++) {
    const u = gu[i]
    for (let j = 1; j < cols - 1; j++) {
      const v = gv[j]
      for (let k = 0; k < 3; k++) {
        out[(i * cols + j) * 3 + k] =
          (1 - v) * at(i, 0, k) + v * at(i, cols - 1, k) + (1 - u) * at(0, j, k) + u * at(rows - 1, j, k) -
          ((1 - u) * (1 - v) * at(0, 0, k) + u * (1 - v) * at(rows - 1, 0, k) + (1 - u) * v * at(0, cols - 1, k) + u * v * at(rows - 1, cols - 1, k))
      }
    }
  }
  return out
}

/** The ratios of the ties along each curve smoothed over their neighbours:
 *  a ratio read off one pole pair is that pair's noise as well. */
function smoothRatios(ties: { ratio: number; curve: number }[]): void {
  const r = ties.map((t) => t.ratio)
  for (let i = 0; i < ties.length; i++) {
    let s = r[i]
    let n = 1
    for (const j of [i - 1, i + 1]) {
      if (j < 0 || j >= ties.length || ties[j].curve !== ties[i].curve) continue
      s += r[j]
      n++
    }
    ties[i].ratio = s / n
  }
}

/** The corners, of those with ties next to them, where a patch turned more
 *  than CORNER_TURN from the first fit's within its two spans of the
 *  corner — read on a few samples there, the free fit's poles `free`. */
function tornCorners(nets: readonly PatchNet[], free: Float64Array, poleBase: readonly number[], patches: readonly PatchInput[], tied: ReadonlySet<number>): Set<number> {
  const torn = new Set<number>()
  const cos = Math.cos((CORNER_TURN * Math.PI) / 180)
  const a: Vec3 = [0, 0, 0]
  const b: Vec3 = [0, 0, 0]
  const SAMPLES = 4
  patches.forEach((p, i) => {
    const net = nets[i]
    const was: PatchNet = { nu: net.nu, nv: net.nv, poles: free.subarray(poleBase[i] * 3, (poleBase[i] + (net.nu + 3) * (net.nv + 3)) * 3) }
    p.corners.forEach((node, k) => {
      if (!tied.has(node) || torn.has(node)) return
      // Corner k is at (0, 0), (1, 0), (1, 1), (0, 1) in turn.
      const cu = k === 1 || k === 2 ? 1 : 0
      const cv = k >= 2 ? 1 : 0
      for (let s = 0; s <= SAMPLES; s++) {
        for (let t = 0; t <= SAMPLES; t++) {
          const du = ((2 / net.nu) * s) / SAMPLES
          const dv = ((2 / net.nv) * t) / SAMPLES
          const u = cu ? 1 - du : du
          const v = cv ? 1 - dv : dv
          patchNormal(net, u, v, a)
          patchNormal(was, u, v, b)
          if (a[0] * b[0] + a[1] * b[1] + a[2] * b[2] < cos) {
            torn.add(node)
            return
          }
        }
      }
    })
  })
  return torn
}

/** Each point projected onto its patch: Gauss–Newton from its (u, v),
 *  held inside the square. */
function project(nets: readonly PatchNet[], data: PatchData[]): void {
  const p: Vec3 = [0, 0, 0]
  const du: Vec3 = [0, 0, 0]
  const dv: Vec3 = [0, 0, 0]
  nets.forEach((net, i) => {
    const d = data[i]
    for (let k = 0; k < d.count; k++) {
      let u = d.uv[k * 2]
      let v = d.uv[k * 2 + 1]
      for (let step = 0; step < NEWTON_STEPS; step++) {
        patchPoint(net, u, v, p, du, dv)
        const rx = d.xyz[k * 3] - p[0], ry = d.xyz[k * 3 + 1] - p[1], rz = d.xyz[k * 3 + 2] - p[2]
        const a = du[0] * du[0] + du[1] * du[1] + du[2] * du[2]
        const b = du[0] * dv[0] + du[1] * dv[1] + du[2] * dv[2]
        const c = dv[0] * dv[0] + dv[1] * dv[1] + dv[2] * dv[2]
        const gu = du[0] * rx + du[1] * ry + du[2] * rz
        const gv = dv[0] * rx + dv[1] * ry + dv[2] * rz
        const det = a * c - b * b
        if (!(det > 1e-300)) break
        u = Math.min(1, Math.max(0, u + (c * gu - b * gv) / det))
        v = Math.min(1, Math.max(0, v + (a * gv - b * gu) / det))
      }
      d.uv[k * 2] = u
      d.uv[k * 2 + 1] = v
    }
  })
}

/** Each point's distance from its patch at its (u, v), signed along the
 *  patch's normal. */
function residuals(net: PatchNet, d: PatchData): Float64Array {
  const out = new Float64Array(d.count)
  const p: Vec3 = [0, 0, 0]
  const du: Vec3 = [0, 0, 0]
  const dv: Vec3 = [0, 0, 0]
  for (let k = 0; k < d.count; k++) {
    patchPoint(net, d.uv[k * 2], d.uv[k * 2 + 1], p, du, dv)
    const nx = du[1] * dv[2] - du[2] * dv[1]
    const ny = du[2] * dv[0] - du[0] * dv[2]
    const nz = du[0] * dv[1] - du[1] * dv[0]
    const rx = d.xyz[k * 3] - p[0]
    const ry = d.xyz[k * 3 + 1] - p[1]
    const rz = d.xyz[k * 3 + 2] - p[2]
    const dist = Math.hypot(rx, ry, rz)
    // Where the normal is zero so is the product: the sign is then +.
    out[k] = rx * nx + ry * ny + rz * nz < 0 ? -dist : dist
  }
  return out
}

/** Each patch's residuals (above), and their RMS over the points kept. */
function residualRms(nets: readonly PatchNet[], data: readonly PatchData[]): { rms: number; res: Float64Array[] } {
  let sq = 0
  let n = 0
  const res = nets.map((net, i) => {
    const r = residuals(net, data[i])
    for (let k = 0; k < r.length; k++) {
      if (!data[i].keep[k]) continue
      sq += r[k] * r[k]
      n++
    }
    return r
  })
  return { rms: n > 0 ? Math.sqrt(sq / n) : 0, res }
}

/** The points past ROBUST_SIGMAS robust sigmas of the fit left out. */
function dropOutliers(nets: readonly PatchNet[], data: PatchData[]): void {
  nets.forEach((net, i) => {
    const d = data[i]
    const r = residuals(net, d)
    const sorted = Float64Array.from(r).sort()
    const med = sorted[sorted.length >> 1] ?? 0
    const dev = Float64Array.from(r, (x) => Math.abs(x - med)).sort()
    const limit = Math.max(ROBUST_SIGMAS * 1.4826 * (dev[dev.length >> 1] ?? 0), ROBUST_FLOOR)
    let kept = 0
    for (let k = 0; k < d.count; k++) {
      d.keep[k] = Math.abs(r[k] - med) <= limit ? 1 : 0
      kept += d.keep[k]
    }
    d.kept = kept
  })
}

/** The (u, v) on a patch of the point a fraction f along its side k. */
function onSide(k: number, f: number): [number, number] {
  switch (k) {
    case 0:
      return [f, 0]
    case 1:
      return [1, f]
    case 2:
      return [1 - f, 1]
    default:
      return [0, 1 - f]
  }
}

/** A shared curve's angle and gap, read at EDGE_SAMPLES points along it on
 *  both patches. */
function edgeReading(s: { curve: number; patches: [number, number]; crease: boolean; sides: [number, number] }, fitted: readonly FittedPatch[], skipFrom = 0, skipTo = 0): SharedCurve & { nearFrom: number; nearTo: number } {
  const [P, Q] = s.patches.map((i) => fitted[i])
  const forwardP = P.sides[s.sides[0]].edges[0].forward
  const forwardQ = Q.sides[s.sides[1]].edges[0].forward
  let angle = 0
  let gap = 0
  let sum = 0
  let count = 0
  // Near an irregular corner the angle is read apart, for the corner's:
  // finer there, where it changes fastest.
  let nearFrom = 0
  let nearTo = 0
  const np: Vec3 = [0, 0, 0]
  const nq: Vec3 = [0, 0, 0]
  const pp: Vec3 = [0, 0, 0]
  const pq: Vec3 = [0, 0, 0]
  const angleAt = (t: number) => {
    const [up, vp] = onSide(s.sides[0], forwardP ? t : 1 - t)
    const [uq, vq] = onSide(s.sides[1], forwardQ ? t : 1 - t)
    patchNormal(P.net, up, vp, np)
    patchNormal(Q.net, uq, vq, nq)
    const cos = Math.max(-1, Math.min(1, np[0] * nq[0] + np[1] * nq[1] + np[2] * nq[2]))
    return (Math.acos(cos) * 180) / Math.PI
  }
  for (let k = 0; k <= EDGE_SAMPLES; k++) {
    const t = k / EDGE_SAMPLES
    const [up, vp] = onSide(s.sides[0], forwardP ? t : 1 - t)
    const [uq, vq] = onSide(s.sides[1], forwardQ ? t : 1 - t)
    patchPoint(P.net, up, vp, pp)
    patchPoint(Q.net, uq, vq, pq)
    gap = Math.max(gap, Math.hypot(pp[0] - pq[0], pp[1] - pq[1], pp[2] - pq[2]))
    // The normals a hair inside the corners: at a corner a side's normal
    // is its cross curve's as much as its own. Near an irregular corner,
    // not at all: that is the corner's reading.
    if (k === 0 || k === EDGE_SAMPLES || t < skipFrom || t > 1 - skipTo) continue
    const a = angleAt(t)
    angle = Math.max(angle, a)
    sum += a
    count++
  }
  // A crease's fold is its mean: each patch's slope at a side nothing holds
  // is read off the points within a span of it, and wanders by their noise
  // — at 20 spans over 0.02 mm of noise, a 30° fold read 26–35° along its
  // length, its largest 34.6°. A tangent curve's is its largest: that is
  // what has to stay under half a degree.
  if (s.crease && count > 0) angle = sum / count
  for (let k = 1; k <= EDGE_SAMPLES; k++) {
    if (skipFrom > 0) nearFrom = Math.max(nearFrom, angleAt((skipFrom * k) / EDGE_SAMPLES))
    if (skipTo > 0) nearTo = Math.max(nearTo, angleAt(1 - (skipTo * k) / EDGE_SAMPLES))
  }
  return { curve: s.curve, patches: s.patches, gap, angle, crease: s.crease, nearFrom, nearTo }
}

/** The parameter of a curve's point nearest x: the nearest of a few
 *  samples, then Gauss–Newton along it. */
function nearestOn(poles: Float64Array, spans: number, x: Vec3): number {
  const y: Vec3 = [0, 0, 0]
  const d: Vec3 = [0, 0, 0]
  let s = 0
  let best = Infinity
  for (let j = 0; j <= 64; j++) {
    curvePoint(poles, spans, j / 64, y)
    const dist = Math.hypot(y[0] - x[0], y[1] - x[1], y[2] - x[2])
    if (dist < best) [best, s] = [dist, j / 64]
  }
  for (let step = 0; step < 4; step++) {
    curvePoint(poles, spans, s, y)
    curveDerivative(poles, spans, s, d)
    const dd = d[0] * d[0] + d[1] * d[1] + d[2] * d[2]
    if (!(dd > 0)) break
    s = Math.min(1, Math.max(0, s + ((x[0] - y[0]) * d[0] + (x[1] - y[1]) * d[1] + (x[2] - y[2]) * d[2]) / dd))
  }
  return s
}

/** A T-junction's curve read along its length: at each sample of it, the
 *  first patch's edge there (the curve itself) against the nearest point of
 *  the second patch's side — the gap between them, and the angle between
 *  the two patches' normals. */
function teeReading(curve: number, fit: CurveFit, fitted: readonly FittedPatch[], patches: [number, number], sides: [number, number], forwardP: boolean, crease: boolean): SharedCurve {
  const [P, Q] = patches.map((i) => fitted[i])
  const row = Q.sides[sides[1]].poles
  const spans = sides[1] % 2 === 0 ? Q.net.nu : Q.net.nv
  const x: Vec3 = [0, 0, 0]
  const y: Vec3 = [0, 0, 0]
  const np: Vec3 = [0, 0, 0]
  const nq: Vec3 = [0, 0, 0]
  let gap = 0
  let angle = 0
  for (let k = 1; k < EDGE_SAMPLES; k++) {
    const t = k / EDGE_SAMPLES
    curvePoint(fit.poles, fit.spans, t, x)
    const s = nearestOn(row, spans, x)
    curvePoint(row, spans, s, y)
    gap = Math.max(gap, Math.hypot(y[0] - x[0], y[1] - x[1], y[2] - x[2]))
    const [up, vp] = onSide(sides[0], forwardP ? t : 1 - t)
    const [uq, vq] = onSide(sides[1], s)
    patchNormal(P.net, up, vp, np)
    patchNormal(Q.net, uq, vq, nq)
    const cos = Math.max(-1, Math.min(1, np[0] * nq[0] + np[1] * nq[1] + np[2] * nq[2]))
    angle = Math.max(angle, (Math.acos(cos) * 180) / Math.PI)
  }
  return { curve, patches, gap, angle, crease, tee: true }
}

/** The largest angle between the normals of two patches meeting at an
 *  irregular corner, read at the corner. */
function cornerReading(node: number, at: Vec3, fitted: readonly FittedPatch[]): IrregularCorner {
  const normals: Vec3[] = []
  for (const p of fitted) {
    const k = p.corners.indexOf(node)
    if (k < 0) continue
    const [u, v] = onSide(k, 0)
    normals.push(patchNormal(p.net, u, v))
  }
  let angle = 0
  for (let a = 0; a < normals.length; a++) {
    for (let b = a + 1; b < normals.length; b++) {
      const cos = Math.max(-1, Math.min(1, normals[a][0] * normals[b][0] + normals[a][1] * normals[b][1] + normals[a][2] * normals[b][2]))
      angle = Math.max(angle, (Math.acos(cos) * 180) / Math.PI)
    }
  }
  return { node, at, patches: normals.length, angle }
}
