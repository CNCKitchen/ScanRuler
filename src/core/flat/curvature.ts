// SPDX-License-Identifier: AGPL-3.0-only
// How sharply an edge bends, along it — what a curvature comb draws: a tooth
// square to the curve at every few millimetres, as long as the curvature
// there, and a line through the tips. A straight run has no teeth, an arc
// teeth all of one length, and a blend that is no arc teeth that grow and
// shrink; where a flat turns into a round is where the teeth start.
//
// Two kinds of edge, two ways of reading it:
//
// - A chain of points — a section's cut, an image's detected edge — is read
//   *smoothed*. Its noise is larger than its curvature at the scale of its
//   own spacing (0.02 mm of scatter on 0.3 mm steps reads as a radius of a
//   few millimetres at every point), so the chain is resampled evenly by arc
//   length, both coordinates are smoothed along it with a Gaussian of
//   σ = window / 2, and the curvature is read off the smooth curve by its
//   first and second derivatives: κ = (x′y″ − y′x″) / |r′|³, which holds
//   whatever the speed. Smoothing a circle of radius R this way shrinks it
//   to R·e^(−σ²/2R²) — the same factor on every cosine — so the reading is
//   taken back through that factor, and a round reads its own radius
//   however wide the window. What the window does cost is sharpness along
//   the chain: a step in curvature, a flat running into a tangent arc,
//   comes out a ramp about one window wide, its middle where the step is.
//   A ramp much longer than the window is the blend itself — a curvature-
//   continuous fillet rather than an arc. The ends of an open chain, where
//   the window runs off it, are left out: one window at each end.
//
// - A fitted curve — an arc, a circle, a spline, a shadow's lines and arcs —
//   is read *exactly*, from its own geometry: 1/R on an arc, the cubic's own
//   derivatives on a spline.
//
// The sign: a reading is positive where the curve turns left as it runs, and
// a tooth is drawn on the side away from the centre of curvature, so the
// comb crosses the curve where the bend changes hand (an S-curve's waist).
// Where the material side is known (a section's cut carries it) a reading
// also says whether the edge is convex there — a round — or concave — a
// fillet's hollow.
//
// Pure typed-array code: the 2D sheet and the 3D view draw the same runs.

import type { EdgeChains } from './edges'
import { evalSpline, evalSplineDerivative, evalSplineSecondDerivative, splineSegmentCount } from './spline'
import type { FlatFit, Vec2 } from './types'

/** One stretch of curve, sampled: where, which way it is square to, and how
 *  sharply it bends there. */
export interface CurvatureRun {
  /** x,y per sample, on the sheet (mm): on the edge itself. */
  points: Float32Array
  /** x,y per sample: the unit normal to the left of the way the curve runs. */
  normals: Float32Array
  /** Signed curvature per sample, 1/mm — positive where the curve turns
   *  left, toward its normal. */
  kappa: Float32Array
  /** Arc length along the source at each sample, mm, increasing. */
  at: Float32Array
  /** Per sample: 1 convex (the edge bulges out of the material), −1
   *  concave, 0 unknown or straight. Only where the material side is known. */
  convex?: Int8Array
  /** The run comes back round on itself — its last sample joins its first. */
  closed: boolean
  /** Read from a fitted curve's own geometry, rather than smoothed. */
  exact: boolean
  /** Which chain, or which fit in the list given, the run is of. */
  source: number
}

/** The smoothing window a comb opens with, mm. Measured on a 5 mm round
 *  with 0.03 mm of scatter on 0.4 mm steps: 2 mm holds the plateau to 3 %
 *  and reads its radius within 1 %, where 1 mm wobbles by a third — and
 *  a 90° round down to about 3 mm still keeps a plateau. */
export const COMB_WINDOW_DEFAULT = 2
export const COMB_WINDOW_MIN = 0.2
export const COMB_WINDOW_MAX = 20

/** How many samples all the chains of one sheet are read at, at the most —
 *  a flatbed image's edges can run to metres; past this the step widens. */
const MAX_SAMPLES = 1_000_000

/** Curvature below this, 1/mm, is straight for a reading — a radius of
 *  more than a metre. */
const STRAIGHT_KAPPA = 1e-3

export interface ChainCurvatureOptions {
  /** The smoothing window, mm: twice the Gaussian's σ. */
  window: number
  /** Millimetres per chain unit, per axis — an image's chains are in pixels. */
  scale?: { x: number; y: number }
  /** x,y per chain point: the unit direction out of the material, in the
   *  chains' own frame (a section's cut, laid flat). Zero where unknown. */
  normals?: Float32Array | null
  maxSamples?: number
}

/** The smoothed curvature of every chain long enough to carry a reading. */
export function chainCurvature(chains: EdgeChains, opts: ChainCurvatureOptions): CurvatureRun[] {
  const sx = opts.scale?.x ?? 1
  const sy = opts.scale?.y ?? 1
  const sigma = Math.max(opts.window, 1e-6) / 2
  const pts = chains.points
  const chainTotal = Math.max(0, chains.offsets.length - 1)
  let total = 0
  for (let c = 0; c < chainTotal; c++) {
    for (let i = chains.offsets[c]; i + 1 < chains.offsets[c + 1]; i++) {
      total += Math.hypot((pts[i * 2 + 2] - pts[i * 2]) * sx, (pts[i * 2 + 3] - pts[i * 2 + 1]) * sy)
    }
  }
  const step = Math.max(sigma / 4, total / (opts.maxSamples ?? MAX_SAMPLES))
  const normals = opts.normals && opts.normals.length === pts.length ? opts.normals : null
  const runs: CurvatureRun[] = []
  for (let c = 0; c < chainTotal; c++) {
    const run = chainRun(pts, chains.offsets[c], chains.offsets[c + 1], sx, sy, sigma, step, normals)
    if (run) {
      run.source = c
      runs.push(run)
    }
  }
  return runs
}

function chainRun(
  pts: Float32Array,
  a: number,
  b: number,
  sx: number,
  sy: number,
  sigma: number,
  h: number,
  normals: Float32Array | null,
): CurvatureRun | null {
  // The chain in millimetres, a point repeated in place dropped.
  const xs: number[] = []
  const ys: number[] = []
  const src: number[] = []
  for (let i = a; i < b; i++) {
    const x = pts[i * 2] * sx
    const y = pts[i * 2 + 1] * sy
    const m = xs.length
    if (m > 0 && Math.hypot(x - xs[m - 1], y - ys[m - 1]) < 1e-9) continue
    xs.push(x)
    ys.push(y)
    src.push(i)
  }
  let m = xs.length
  if (m < 3) return null
  let len = 0
  for (let i = 0; i + 1 < m; i++) len += Math.hypot(xs[i + 1] - xs[i], ys[i + 1] - ys[i])
  // A loop: written with its first point again at the end (a section's), or
  // ending a step short of it (a detected edge that came all the way round).
  const gap = Math.hypot(xs[m - 1] - xs[0], ys[m - 1] - ys[0])
  let closed = false
  if (gap <= 1e-6) {
    closed = true
    xs.pop()
    ys.pop()
    src.pop()
    m--
  } else if (gap <= (1.5 * len) / (m - 1) && len > 20 * gap) {
    closed = true
  }
  if (m < 3) return null

  const segs = closed ? m : m - 1
  const cum = new Float64Array(segs + 1)
  for (let j = 0; j < segs; j++) {
    const k = (j + 1) % m
    cum[j + 1] = cum[j] + Math.hypot(xs[k] - xs[j], ys[k] - ys[j])
  }
  const L = cum[segs]
  const trim = closed ? 0 : 2 * sigma
  if (!(L > 0) || (!closed && L <= 2 * trim + 2 * h)) return null

  // Resampled evenly along it.
  const N = closed ? Math.max(8, Math.round(L / h)) : Math.max(3, Math.floor(L / h) + 1)
  const step = closed ? L / N : L / (N - 1)
  const rx = new Float64Array(N)
  const ry = new Float64Array(N)
  const rsrc = new Int32Array(N)
  let j = 0
  for (let k = 0; k < N; k++) {
    const s = k * step
    while (j < segs - 1 && cum[j + 1] < s) j++
    const d = cum[j + 1] - cum[j]
    const t = d > 0 ? Math.min(1, Math.max(0, (s - cum[j]) / d)) : 0
    const q = (j + 1) % m
    rx[k] = xs[j] + (xs[q] - xs[j]) * t
    ry[k] = ys[j] + (ys[q] - ys[j]) * t
    rsrc[k] = src[t < 0.5 ? j : q]
  }

  // Smoothed along it.
  const R = Math.max(1, Math.ceil((3 * sigma) / step))
  const w = new Float64Array(R + 1)
  for (let r = 0; r <= R; r++) w[r] = Math.exp(-((r * step) ** 2) / (2 * sigma * sigma))
  const gx = new Float64Array(N)
  const gy = new Float64Array(N)
  for (let k = 0; k < N; k++) {
    let ax = 0
    let ay = 0
    let ws = 0
    for (let r = -R; r <= R; r++) {
      let idx = k + r
      if (closed) idx = ((idx % N) + N) % N
      else if (idx < 0 || idx >= N) continue
      const wr = w[r < 0 ? -r : r]
      ax += wr * rx[idx]
      ay += wr * ry[idx]
      ws += wr
    }
    gx[k] = ax / ws
    gy[k] = ay / ws
  }

  const i0 = closed ? 0 : Math.max(1, Math.ceil(trim / step))
  const i1 = closed ? N - 1 : N - 1 - i0
  if (i1 < i0) return null
  const count = i1 - i0 + 1
  const points = new Float32Array(count * 2)
  const nrm = new Float32Array(count * 2)
  const kappa = new Float32Array(count)
  const at = new Float32Array(count)
  const convex = normals ? new Int8Array(count) : undefined
  for (let k = i0; k <= i1; k++) {
    const prev = closed ? (k - 1 + N) % N : k - 1
    const next = closed ? (k + 1) % N : k + 1
    const dx = (gx[next] - gx[prev]) / (2 * step)
    const dy = (gy[next] - gy[prev]) / (2 * step)
    const ddx = (gx[next] - 2 * gx[k] + gx[prev]) / (step * step)
    const ddy = (gy[next] - 2 * gy[k] + gy[prev]) / (step * step)
    const sp = Math.hypot(dx, dy)
    const o = k - i0
    points[o * 2] = rx[k]
    points[o * 2 + 1] = ry[k]
    at[o] = k * step
    if (!(sp > 1e-12)) continue
    const nx = -dy / sp
    const ny = dx / sp
    nrm[o * 2] = nx
    nrm[o * 2 + 1] = ny
    const ks = unshrink((dx * ddy - dy * ddx) / (sp * sp * sp), sigma)
    kappa[o] = ks
    if (convex && normals) convex[o] = convexity(ks, nx, ny, normals[rsrc[k] * 2], normals[rsrc[k] * 2 + 1])
  }
  return { points, normals: nrm, kappa, at, ...(convex ? { convex } : {}), closed, exact: false, source: 0 }
}

/** The curvature of a circle that, smoothed by a Gaussian of σ along it,
 *  reads `k`: smoothing scales a circle by e^(−σ²κ²/2), so k = κ·e^(σ²κ²/2),
 *  solved for κ by Newton from above — the left side is convex and rising. */
export function unshrink(k: number, sigma: number): number {
  const t = Math.abs(k)
  const a = (sigma * sigma) / 2
  if (!(t > 0) || a * t * t > 30) return k
  let x = t
  for (let it = 0; it < 30; it++) {
    const e = Math.exp(a * x * x)
    const dx = (x * e - t) / (e * (1 + 2 * a * x * x))
    x -= dx
    if (Math.abs(dx) <= 1e-12 * t) break
  }
  return k < 0 ? -x : x
}

/** Whether a reading is a round (1) or a hollow (−1): the centre of
 *  curvature lies on the normal's side for a left turn, and a round has it
 *  inside the material, against the outward direction. */
function convexity(k: number, nx: number, ny: number, ox: number, oy: number): number {
  if (Math.abs(k) < STRAIGHT_KAPPA) return 0
  const d = nx * ox + ny * oy
  if (Math.abs(d) < 0.5) return 0
  return k * d < 0 ? 1 : -1
}

/** The exact curvature of fitted curves, sampled about every `step` mm:
 *  arcs, circles and splines. A line has none, and a point no curve. */
export function fitCurvature(fits: readonly FlatFit[], step: number): CurvatureRun[] {
  const runs: CurvatureRun[] = []
  const h = Math.max(step, 1e-6)
  fits.forEach((fit, source) => {
    if (fit.kind === 'circle' || fit.kind === 'arc') {
      const full = fit.kind === 'circle' || fit.sweep >= 2 * Math.PI - 1e-6
      const start = fit.kind === 'arc' ? fit.start : 0
      const sweep = full ? 2 * Math.PI : (fit as { sweep: number }).sweep
      const r = fit.radius
      if (!(r > 0) || !(sweep > 0)) return
      const spans = Math.min(20000, Math.max(full ? 64 : 8, Math.ceil((r * sweep) / h)))
      const n = full ? spans : spans + 1
      const run = blankRun(n, full, source)
      for (let i = 0; i < n; i++) {
        const th = start + (sweep * i) / spans
        const c = Math.cos(th)
        const s = Math.sin(th)
        run.points[i * 2] = fit.center[0] + r * c
        run.points[i * 2 + 1] = fit.center[1] + r * s
        // Counter-clockwise, so the left normal points at the centre.
        run.normals[i * 2] = -c
        run.normals[i * 2 + 1] = -s
        run.kappa[i] = 1 / r
        run.at[i] = (r * sweep * i) / spans
      }
      runs.push(run)
    } else if (fit.kind === 'spline') {
      const segments = splineSegmentCount(fit.points.length, fit.closed)
      const xs: number[] = []
      const ys: number[] = []
      const ns: number[] = []
      const ks: number[] = []
      for (let k = 0; k < segments; k++) {
        const a = fit.points[k]
        const b = fit.points[(k + 1) % fit.points.length]
        const per = Math.min(2000, Math.max(8, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / h)))
        const last = !fit.closed && k === segments - 1
        for (let i = 0; i < per + (last ? 1 : 0); i++) {
          const u = i / per
          const p = evalSpline(fit, k, u)
          const d1 = evalSplineDerivative(fit, k, u)
          const d2 = evalSplineSecondDerivative(fit, k, u)
          const sp = Math.hypot(d1[0], d1[1])
          xs.push(p[0])
          ys.push(p[1])
          if (sp > 1e-12) {
            ns.push(-d1[1] / sp, d1[0] / sp)
            ks.push((d1[0] * d2[1] - d1[1] * d2[0]) / (sp * sp * sp))
          } else {
            ns.push(0, 0)
            ks.push(0)
          }
        }
      }
      const n = xs.length
      if (n < 2) return
      const run = blankRun(n, fit.closed, source)
      let s = 0
      for (let i = 0; i < n; i++) {
        if (i > 0) s += Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1])
        run.points[i * 2] = xs[i]
        run.points[i * 2 + 1] = ys[i]
        run.normals[i * 2] = ns[i * 2]
        run.normals[i * 2 + 1] = ns[i * 2 + 1]
        run.kappa[i] = ks[i]
        run.at[i] = s
      }
      runs.push(run)
    }
  })
  return runs
}

function blankRun(n: number, closed: boolean, source: number): CurvatureRun {
  return {
    points: new Float32Array(n * 2),
    normals: new Float32Array(n * 2),
    kappa: new Float32Array(n),
    at: new Float32Array(n),
    closed,
    exact: true,
    source,
  }
}

// ---- drawing ----------------------------------------------------------------

/** How long the teeth are drawn: mm of tooth per 1/mm of curvature, and the
 *  longest a tooth is drawn before it is cut short (a corner's spike). */
export interface CombReach {
  perCurvature: number
  cap: number
}

/** The usual bend's tooth: this much of its radius, at most this much of the
 *  sheet's diagonal; and the longest tooth, in those. See combReach. */
const REACH_OF_RADIUS = 0.6
const REACH_OF_SHEET = 0.05
const CAP_OF_REACH = 2.5

/** The diagonal of everything the runs cover, mm — 0 for none. */
export function runsDiagonal(runs: readonly CurvatureRun[]): number {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const r of runs) {
    for (let i = 0; i < r.points.length; i += 2) {
      const x = r.points[i]
      const y = r.points[i + 1]
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }
  return x1 >= x0 ? Math.hypot(x1 - x0, y1 - y0) : 0
}

/**
 * How long to draw the teeth: the bends that matter — three quarters of the
 * curved samples read at or under their curvature — reach 0.6 of their own
 * radius, but never more than 5 % of the sheet `diagonal` mm across; times
 * the `scale` asked for. Sized to the edge's own rounds rather than to the
 * section's length, so a 3 mm fillet wears the same comb on a long section
 * as on a short one, and the comb stays inside the part's walls. Teeth past
 * two and a half times that are cut short, which is a corner and not a
 * round. The same runs give the same comb on the sheet and on the part.
 */
export function combReach(runs: readonly CurvatureRun[], diagonal: number, scale = 1): CombReach {
  const d = diagonal > 0 ? diagonal : 1
  const floor = 4 / d
  let total = 0
  for (const r of runs) total += r.kappa.length
  const stride = Math.max(1, Math.floor(total / 50000))
  const curved: number[] = []
  let seen = 0
  for (const r of runs) {
    for (let i = 0; i < r.kappa.length; i++, seen++) {
      if (seen % stride !== 0) continue
      const k = Math.abs(r.kappa[i])
      if (k > floor) curved.push(k)
    }
  }
  curved.sort((a, b) => a - b)
  const ref = curved.length > 0 ? Math.max(floor, curved[Math.floor(0.75 * (curved.length - 1))]) : floor
  const reach = Math.min(REACH_OF_SHEET * d, REACH_OF_RADIUS / ref) * scale
  return { perCurvature: reach / ref, cap: CAP_OF_REACH * reach }
}

export interface CombStrokes {
  /** x0,y0,x1,y1 per tooth, from the curve to its tip. */
  teeth: Float32Array
  /** The same for teeth cut short at the cap. */
  capped: Float32Array
  /** The line through the tips, x,y per vertex — one per run, a closed run's
   *  back at its start. */
  envelopes: Float32Array[]
  /** The area between each curve and its envelope, as triangles: x,y per
   *  corner, three corners each — split where the curve turns the other way,
   *  so a fill never crosses over the curve. */
  fill: Float32Array
}

/** The comb of the runs: a tooth every `spacing` mm along each, and the
 *  line through the tips about four times as finely. */
export function combStrokes(runs: readonly CurvatureRun[], reach: CombReach, spacing: number): CombStrokes {
  const teeth: number[] = []
  const capped: number[] = []
  const envelopes: Float32Array[] = []
  const fill: number[] = []
  const gap = Math.max(spacing, 1e-6)
  const tip = (r: CurvatureRun, i: number): [number, number, boolean] => {
    const k = r.kappa[i]
    let len = Math.abs(k) * reach.perCurvature
    const cut = len > reach.cap
    if (cut) len = reach.cap
    // Away from the centre of curvature: against the normal on a left turn.
    const sgn = k > 0 ? -1 : 1
    return [r.points[i * 2] + sgn * len * r.normals[i * 2], r.points[i * 2 + 1] + sgn * len * r.normals[i * 2 + 1], cut]
  }
  for (const r of runs) {
    const n = r.kappa.length
    if (n === 0) continue
    let next = r.at[0]
    for (let i = 0; i < n; i++) {
      if (r.at[i] + 1e-9 < next) continue
      next = r.at[i] + gap
      if (Math.abs(r.kappa[i]) * reach.perCurvature < 1e-9) continue
      const [tx, ty, cut] = tip(r, i)
      ;(cut ? capped : teeth).push(r.points[i * 2], r.points[i * 2 + 1], tx, ty)
    }
    const env: number[] = []
    const at: number[] = []
    let nextEnv = r.at[0]
    for (let i = 0; i < n; i++) {
      if (r.at[i] + 1e-9 < nextEnv && i !== n - 1) continue
      nextEnv = r.at[i] + gap / 4
      const [tx, ty] = tip(r, i)
      env.push(tx, ty)
      at.push(i)
    }
    if (r.closed && env.length >= 4) {
      env.push(env[0], env[1])
      at.push(at[0])
    }
    if (env.length >= 4) envelopes.push(new Float32Array(env))
    for (let j = 0; j + 1 < at.length; j++) fillBetween(fill, r, at[j], at[j + 1], env, j)
  }
  return { teeth: new Float32Array(teeth), capped: new Float32Array(capped), envelopes, fill: new Float32Array(fill) }
}

/** The fill between samples `a` and `b` of a run, whose tips are the
 *  envelope's vertices `j` and `j + 1`: a quad of the curve and the tips, or
 *  two triangles meeting on the curve where the curvature changes sign. */
function fillBetween(out: number[], r: CurvatureRun, a: number, b: number, env: readonly number[], j: number): void {
  const ax = r.points[a * 2]
  const ay = r.points[a * 2 + 1]
  const bx = r.points[b * 2]
  const by = r.points[b * 2 + 1]
  const tax = env[j * 2]
  const tay = env[j * 2 + 1]
  const tbx = env[j * 2 + 2]
  const tby = env[j * 2 + 3]
  const ka = r.kappa[a]
  const kb = r.kappa[b]
  if (ka * kb < 0) {
    const f = Math.abs(ka) / (Math.abs(ka) + Math.abs(kb))
    const zx = ax + f * (bx - ax)
    const zy = ay + f * (by - ay)
    out.push(ax, ay, tax, tay, zx, zy, zx, zy, tbx, tby, bx, by)
    return
  }
  out.push(ax, ay, tax, tay, tbx, tby, ax, ay, tbx, tby, bx, by)
}

// ---- reading ----------------------------------------------------------------

export interface CurvatureReading {
  /** Signed curvature, 1/mm — see CurvatureRun.kappa. */
  kappa: number
  /** 1/|κ|, mm, or null where the edge is straight. */
  radius: number | null
  /** 1 convex, −1 concave, 0 unknown or straight. */
  convex: number
  exact: boolean
  /** The sample read, on the sheet. */
  at: Vec2
  /** How far `p` is from it, mm. */
  distance: number
  /** Which run, and which sample on it. */
  run: number
  index: number
}

/** The reading at the sample nearest `p`, within `reach` mm — or null. */
export function curvatureNear(runs: readonly CurvatureRun[], p: Vec2, reach: number): CurvatureReading | null {
  let best: [number, number] | null = null
  let bestSq = reach * reach
  for (let ri = 0; ri < runs.length; ri++) {
    const r = runs[ri]
    for (let i = 0; i < r.kappa.length; i++) {
      const dx = r.points[i * 2] - p[0]
      const dy = r.points[i * 2 + 1] - p[1]
      const sq = dx * dx + dy * dy
      if (sq > bestSq) continue
      bestSq = sq
      best = [ri, i]
    }
  }
  return best ? readingOf(runs[best[0]], best[1], best[0], Math.sqrt(bestSq)) : null
}

function readingOf(r: CurvatureRun, i: number, run: number, distance: number): CurvatureReading {
  const k = r.kappa[i]
  const straight = Math.abs(k) < STRAIGHT_KAPPA
  return {
    kappa: k,
    radius: straight ? null : 1 / Math.abs(k),
    convex: straight ? 0 : (r.convex?.[i] ?? 0),
    exact: r.exact,
    at: [r.points[i * 2], r.points[i * 2 + 1]],
    distance,
    run,
    index: i,
  }
}

// ---- stretches --------------------------------------------------------------

/** A stretch of a run that reads one way: straight, an arc of one radius,
 *  or the transition between. */
export interface CurvatureStretch {
  kind: 'straight' | 'arc' | 'transition'
  /** Arc length along the source, mm. */
  from: number
  to: number
  /** Its ends on the sheet. */
  start: Vec2
  end: Vec2
  /** An arc's: the radius its median curvature gives, and the least and
   *  most any sample read — how near to one radius it holds. */
  radius?: number
  radiusMin?: number
  radiusMax?: number
  /** An arc's, where the material side is known: whether it bulges out of
   *  the material (a round) or into it (a fillet's hollow). */
  convex?: boolean
}

export interface StretchOptions {
  /** Curvature under this is straight, 1/mm. By default four times the
   *  run's own scatter, and never under 0.002 — a radius of 500 mm. */
  straightBelow?: number
  /** How far, as a share, an arc's samples may read from its mean — 0.1 —
   *  or three times the run's scatter, whichever is more. */
  tolerance?: number
  /** A stretch shorter than this, mm, is a transition: the window it was
   *  smoothed over, or 0.5 mm on an exact run. */
  minLength?: number
}

/** How much a run's curvature scatters, 1/mm: the spread of the change from
 *  each sample to the one `lag` samples on — robust, so the bends, where it
 *  changes for real, do not count. 0 on an exact run. */
export function curvatureScatter(r: CurvatureRun, lag: number): number {
  if (r.exact) return 0
  const n = r.kappa.length
  const d = Math.max(1, Math.round(lag))
  if (n <= d) return 0
  const stride = Math.max(1, Math.floor((n - d) / 20000))
  const diffs: number[] = []
  for (let i = 0; i + d < n; i += stride) diffs.push(Math.abs(r.kappa[i + d] - r.kappa[i]))
  diffs.sort((a, b) => a - b)
  return (1.4826 * diffs[Math.floor(diffs.length / 2)]) / Math.SQRT2
}

/**
 * A run told as stretches — "straight 0–12.4, R 5.07 over 12.4–20.3, …" —
 * for whoever reads the comb in words. Samples are taken in order, each
 * joining the stretch it continues: straight while it stays under
 * `straightBelow`, an arc while it stays within `tolerance` of the mean so far
 * and bends the same way. What is left too short between is a transition.
 */
export function curvatureStretches(r: CurvatureRun, opts: StretchOptions = {}): CurvatureStretch[] {
  const n = r.kappa.length
  if (n === 0) return []
  const minLength = opts.minLength ?? 0.5
  const spacing = n > 1 ? (r.at[n - 1] - r.at[0]) / (n - 1) : 1
  const scatter = curvatureScatter(r, minLength / Math.max(spacing, 1e-9))
  const straightBelow = opts.straightBelow ?? Math.max(0.002, 4 * scatter)
  const tol = opts.tolerance ?? 0.1
  type Raw = { kind: 'straight' | 'arc'; i0: number; i1: number; sum: number }
  const raw: Raw[] = []
  let cur: Raw | null = null
  for (let i = 0; i < n; i++) {
    const k = r.kappa[i]
    const straight = Math.abs(k) < straightBelow
    if (cur) {
      const mean = cur.sum / (cur.i1 - cur.i0 + 1)
      const fits = straight
        ? cur.kind === 'straight'
        : cur.kind === 'arc' &&
          Math.sign(k) === Math.sign(mean) &&
          Math.abs(k - mean) <= Math.max(tol * Math.abs(mean), 3 * scatter)
      if (fits) {
        cur.i1 = i
        cur.sum += k
        continue
      }
    }
    cur = { kind: straight ? 'straight' : 'arc', i0: i, i1: i, sum: k }
    raw.push(cur)
  }
  // Stretches too short to be anything are transitions; neighbouring
  // transitions are one.
  const out: CurvatureStretch[] = []
  const pt = (i: number): Vec2 => [r.points[i * 2], r.points[i * 2 + 1]]
  for (const s of raw) {
    const from = r.at[s.i0]
    const to = r.at[s.i1]
    const short = to - from < minLength
    const kind = short ? 'transition' : s.kind
    const last = out[out.length - 1]
    if (last && last.kind === 'transition' && kind === 'transition') {
      last.to = to
      last.end = pt(s.i1)
      continue
    }
    const stretch: CurvatureStretch = { kind, from, to, start: pt(s.i0), end: pt(s.i1) }
    if (kind === 'arc') {
      // The radius the middle reading gives: the stretch's ends lean into
      // the ramps either side of it.
      const ks: number[] = []
      for (let i = s.i0; i <= s.i1; i++) ks.push(Math.abs(r.kappa[i]))
      ks.sort((a, b) => a - b)
      stretch.radius = 1 / ks[Math.floor(ks.length / 2)]
      stretch.radiusMin = 1 / ks[ks.length - 1]
      stretch.radiusMax = 1 / ks[0]
      if (r.convex) {
        let votes = 0
        for (let i = s.i0; i <= s.i1; i++) votes += r.convex[i]
        if (votes !== 0) stretch.convex = votes > 0
      }
    }
    out.push(stretch)
  }
  return out
}
