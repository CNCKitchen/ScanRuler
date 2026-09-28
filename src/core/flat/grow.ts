// SPDX-License-Identifier: AGPL-3.0-only
// A fit from one click on a detected edge — the 2D twin of the 3D
// pick-and-grow (fit/fitPlaneFromSeed and friends). A detected chain is the
// whole outline of a part, or the whole rim of a hole, and a click on it
// means "this straight stretch" or "this round one", not the lot: so the fit
// starts from a small window of chain points around the click, and grows
// along the chain in both directions while the next point still lies within
// a noise band of the model, refitting as it goes, until the edge bends away
// — at a corner, or where a fillet runs out into the side it joins. The
// chain's own scatter, measured off it, is what the band and every sanity
// gate are scaled by, so the same rules serve a 600 dpi scan in pixels and a
// section through a mesh in millimetres.
//
// A line resolves itself in a dozen points. A circle does not: the circle
// through a short, nearly straight window is whatever the noise says, so the
// circle search widens the window over a ladder of scales until the window
// bows clearly beyond the scatter and a circle explains it far better than a
// line does, grows from there, and keeps the first result that reads as a
// real arc — enough sweep, a residual the size of the noise. A click on a
// straight stretch finds no such scale, and says so.

import { FitError } from '../fit/errors'
import { fitArcPoints, fitCirclePoints, fitLinePoints } from './fit'
import type { Vec2 } from './types'

/** Points either side of the click the first line fit is taken over. */
const INIT_HALF = 6
/** The window half-widths the circle search tries, in chain points. */
const CIRCLE_SCALES = [6, 10, 16, 25, 40, 64, 100, 160, 250, 400, 640, 1000, 1600, 2500, 4000, 6400]
/** A point belongs while it lies within this many σ of the model… */
const BAND_SIGMAS = 2.5
/** …or within this many chain scatters, whichever is wider — the model's σ
 *  off a dozen points says little. */
const BAND_SCATTERS = 3
/** This many out-of-band points in a row end the growth at that end; fewer
 *  are a stray, and the chain past them is still looked at. */
const STOP_RUN = 3
/** Refit once the region has grown by this factor since the last fit. */
const REFIT_GROWTH = 1.3
/** The chain's local tangent has to agree with the model's within this
 *  angle for a point to belong — the 2D twin of the 3D normal test, and what
 *  stops a line creeping round an arc, whose residual grows only slowly at
 *  first, or a circle running out along a tangent side. */
const COS_TILT_MAX = Math.cos((10 * Math.PI) / 180)
/** Points either side a local tangent is taken over. */
const TANGENT_HALF = 2
/** A finished fit whose σ exceeds this many scatters is not the geometry it
 *  claims — a line on a curve, a circle through a corner. */
const FIT_SCATTERS_MAX = 4
/** A line is refused as an arc when a circle explains its points
 *  significantly better than it does — the variance the circle's one extra
 *  parameter takes up, over all n points, against the circle's own residual
 *  variance, is χ² with one degree of freedom on a straight edge and has to
 *  exceed this (a six-in-a-hundred-thousand chance there) — and that
 *  circle's radius is under LINE_ARC_RADIUS_LENGTHS line lengths: a fillet
 *  or a hole clicked with the line tool. A long edge with a slight bow to
 *  it is measurably curved too, but its circle is hundreds of lengths, and
 *  it is a line with a straightness error all the same. */
const LINE_ARC_F_CRIT = 16
const LINE_ARC_RADIUS_LENGTHS = 20
/** A circle has to cover this much arc to be a circle rather than a straight
 *  edge the noise happened to bow. */
const MIN_SWEEP = (8 * Math.PI) / 180
/** The scatter floor as a fraction of the chain's point spacing, so a
 *  synthetic chain with no noise at all still leaves the band a width. */
const SCATTER_FLOOR = 0.05
/** The scatter is read off the chain by its second differences — the
 *  deviation of each point from the midpoint of its neighbours; noise of σ
 *  per point gives that a spread of σ·√1.5, and the median of the absolute
 *  value is 0.6745 of the spread. */
const SCATTER_FROM_MEDIAN = 1 / (0.6745 * Math.sqrt(1.5))
const SAMPLE = 2048

/** A chain as the growing sees it: its points with a loop's closing
 *  duplicate dropped, whether it closes on itself, and the two numbers the
 *  band is scaled by. */
interface ChainView {
  points: readonly Vec2[]
  closed: boolean
  spacing: number
  scatter: number
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = values.slice().sort((a, b) => a - b)
  return sorted[sorted.length >> 1]
}

function viewChain(chain: readonly Vec2[]): ChainView {
  const n0 = chain.length
  const step = Math.max(1, Math.floor(n0 / SAMPLE))
  const gaps: number[] = []
  for (let i = step; i < n0; i += step) {
    gaps.push(Math.hypot(chain[i][0] - chain[i - step][0], chain[i][1] - chain[i - step][1]) / step)
  }
  const spacing = median(gaps) || 1

  let points = chain
  let closed = false
  if (n0 >= 4) {
    const gap = Math.hypot(chain[0][0] - chain[n0 - 1][0], chain[0][1] - chain[n0 - 1][1])
    if (gap <= 2 * spacing) {
      closed = true
      // A section's loop comes back onto its own first point.
      if (gap < 0.01 * spacing) points = chain.slice(0, n0 - 1)
    }
  }

  const n = points.length
  const seconds: number[] = []
  const step2 = Math.max(1, Math.floor(n / SAMPLE))
  for (let i = 1; i + 1 < n; i += step2) {
    const ax = points[i + 1][0] - points[i - 1][0]
    const ay = points[i + 1][1] - points[i - 1][1]
    const len = Math.hypot(ax, ay)
    if (len < 1e-9) continue
    const bx = points[i][0] - points[i - 1][0]
    const by = points[i][1] - points[i - 1][1]
    seconds.push(Math.abs(ax * by - ay * bx) / len)
  }
  const scatter = Math.max(median(seconds) * SCATTER_FROM_MEDIAN, SCATTER_FLOOR * spacing)
  return { points, closed, spacing, scatter }
}

/** The point at an index that may run past either end of a closed chain. */
function at(view: ChainView, i: number): Vec2 {
  const n = view.points.length
  return view.points[view.closed ? ((i % n) + n) % n : i]
}

function slice(view: ChainView, lo: number, hi: number): Vec2[] {
  const out: Vec2[] = []
  for (let i = lo; i <= hi; i++) out.push(at(view, i))
  return out
}

/** The chain's direction at a point, over a few points either side (fewer
 *  at an open chain's ends); null where the neighbours coincide. */
function tangentAt(view: ChainView, i: number): Vec2 | null {
  const n = view.points.length
  const lo = view.closed ? i - TANGENT_HALF : Math.max(0, i - TANGENT_HALF)
  const hi = view.closed ? i + TANGENT_HALF : Math.min(n - 1, i + TANGENT_HALF)
  const a = at(view, lo)
  const b = at(view, hi)
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len = Math.hypot(dx, dy)
  return len > 1e-9 ? [dx / len, dy / len] : null
}

/** The window of `half` points either side of the seed, kept on the chain:
 *  clipped at an open chain's ends, at most the whole of a closed one. */
function windowAround(view: ChainView, seed: number, half: number): [number, number] {
  const n = view.points.length
  if (!view.closed) return [Math.max(0, seed - half), Math.min(n - 1, seed + half)]
  if (2 * half + 1 >= n) {
    const lo = seed - Math.floor((n - 1) / 2)
    return [lo, lo + n - 1]
  }
  return [seed - half, seed + half]
}

function covers(view: ChainView, lo: number, hi: number): boolean {
  return view.closed ? hi - lo + 1 >= view.points.length : lo === 0 && hi === view.points.length - 1
}

interface GrowSpec<M> {
  fit: (points: Vec2[]) => { model: M; sigma: number } | null
  residual: (m: M, p: Vec2) => number
  /** |cos| between the chain's tangent at a point and the model's there. */
  align: (m: M, p: Vec2, tangent: Vec2) => number
}

interface GrowResult<M> {
  members: Vec2[]
  model: M
  sigma: number
}

/** A flat fit, or null where it refuses — the refusal is the growing's to
 *  handle, not the user's to see. */
function tryFit<R>(fit: (points: readonly Vec2[]) => R, points: Vec2[]): R | null {
  try {
    return fit(points)
  } catch (e) {
    if (e instanceof FitError) return null
    throw e
  }
}

const LINE_SPEC: GrowSpec<{ center: Vec2; dir: Vec2 }> = {
  fit: (points) => {
    const fit = tryFit(fitLinePoints, points)
    return fit && { model: { center: fit.center, dir: fit.dir }, sigma: fit.sigma }
  },
  residual: (m, p) => -(p[0] - m.center[0]) * m.dir[1] + (p[1] - m.center[1]) * m.dir[0],
  align: (m, _p, t) => Math.abs(t[0] * m.dir[0] + t[1] * m.dir[1]),
}

const CIRCLE_SPEC: GrowSpec<{ center: Vec2; radius: number }> = {
  fit: (points) => {
    const fit = tryFit(fitCirclePoints, points)
    return fit && { model: { center: fit.center, radius: fit.radius }, sigma: fit.sigma }
  },
  residual: (m, p) => Math.hypot(p[0] - m.center[0], p[1] - m.center[1]) - m.radius,
  align: (m, p, t) => {
    const rx = p[0] - m.center[0]
    const ry = p[1] - m.center[1]
    const r = Math.hypot(rx, ry)
    // The circle's tangent is square to the radius.
    return r > 1e-9 ? Math.abs((rx * t[1] - ry * t[0]) / r) : 0
  },
}

/** Whether the chain point at `i` belongs to the model: within the band,
 *  and running the model's way there. */
function belongs<M>(view: ChainView, i: number, model: M, band: number, spec: GrowSpec<M>): boolean {
  const p = at(view, i)
  if (!(Math.abs(spec.residual(model, p)) <= band)) return false
  const t = tangentAt(view, i)
  return t === null || spec.align(model, p, t) >= COS_TILT_MAX
}

/** Grow the model along the chain from the window around the seed. The
 *  region is a contiguous run of chain indices, [lo, hi], and each end
 *  advances while the next point lies within the band and runs the model's
 *  way; a stray inside a run of good points is carried along, a run of
 *  STOP_RUN strays ends that end without them. The model is refit whenever the region has grown by
 *  REFIT_GROWTH, and once more at the end, when what lies outside the final
 *  band is let go. */
function grow<M>(view: ChainView, seed: number, half: number, spec: GrowSpec<M>): GrowResult<M> | null {
  let [lo, hi] = windowAround(view, seed, half)
  let fit = spec.fit(slice(view, lo, hi))
  if (!fit) return null
  let { model, sigma } = fit
  let lastCount = hi - lo + 1
  let hiDone = covers(view, lo, hi)
  let loDone = hiDone
  let hiRun = 0
  let loRun = 0

  while (!hiDone || !loDone) {
    const band = Math.max(BAND_SIGMAS * sigma, BAND_SCATTERS * view.scatter)
    const refitAt = Math.ceil(lastCount * REFIT_GROWTH)
    while (!hiDone && hi - lo + 1 < refitAt) {
      if (covers(view, lo, hi) || (!view.closed && hi >= view.points.length - 1)) {
        hiDone = true
        break
      }
      if (belongs(view, hi + 1, model, band, spec)) {
        hi++
        hiRun = 0
      } else if (++hiRun >= STOP_RUN) {
        hi -= hiRun - 1
        hiDone = true
      } else {
        hi++
      }
    }
    while (!loDone && hi - lo + 1 < refitAt) {
      if (covers(view, lo, hi) || (!view.closed && lo <= 0)) {
        loDone = true
        break
      }
      if (belongs(view, lo - 1, model, band, spec)) {
        lo--
        loRun = 0
      } else if (++loRun >= STOP_RUN) {
        lo += loRun - 1
        loDone = true
      } else {
        lo--
      }
    }
    if (covers(view, lo, hi)) hiDone = loDone = true
    if (hi - lo + 1 >= refitAt) {
      const next = spec.fit(slice(view, lo, hi))
      if (!next) break
      ;({ model, sigma } = next)
      lastCount = hi - lo + 1
    }
  }

  // Strays carried along at either end were never confirmed by a good
  // point after them.
  if (hiRun > 0 && hiRun < STOP_RUN) hi -= hiRun
  if (loRun > 0 && loRun < STOP_RUN) lo += loRun
  let members = slice(view, lo, hi)
  fit = spec.fit(members)
  if (!fit) return null
  ;({ model, sigma } = fit)
  const band = Math.max(BAND_SIGMAS * sigma, BAND_SCATTERS * view.scatter)
  const m = model
  const kept = members.filter((p) => Math.abs(spec.residual(m, p)) <= band)
  if (kept.length < members.length) {
    const refit = spec.fit(kept)
    if (!refit) return null
    members = kept
    ;({ model, sigma } = refit)
  }
  return { members: members.map((p) => [p[0], p[1]]), model, sigma }
}

/** The seed as an index into the view, which may have dropped the chain's
 *  closing duplicate. */
function seedIndex(view: ChainView, seed: number): number {
  const n = view.points.length
  return Math.max(0, Math.min(n - 1, seed)) % n
}

/**
 * The straight stretch of the chain the click landed on: every chain point
 * the line grows over from there, in chain order, ready to be the picks of
 * a line element. Throws FitError, with a message to show, when there is no
 * straight edge under the click.
 */
export function growLineFromSeed(chain: readonly Vec2[], seed: number): Vec2[] {
  const view = viewChain(chain)
  if (view.points.length < 4) throw new FitError('Too few edge points here for a line.')
  const run = grow(view, seedIndex(view, seed), INIT_HALF, LINE_SPEC)
  if (!run || run.members.length < 4) {
    throw new FitError("Couldn't fit a line at this point — too little straight edge under the click.")
  }
  const curved = "Couldn't fit a line at this point — the edge here is curved. Click on a straight stretch of it."
  if (run.sigma > FIT_SCATTERS_MAX * view.scatter) throw new FitError(curved)
  // A short line on a tight arc has a σ the noise could explain; what gives
  // it away is a circle that explains its points significantly better, at
  // a radius on the scale of the line itself.
  const circle = CIRCLE_SPEC.fit(run.members)
  if (circle) {
    const n = run.members.length
    const noise = Math.max(circle.sigma, 0.5 * view.scatter)
    const gain = n * (run.sigma * run.sigma - circle.sigma * circle.sigma)
    if (gain > LINE_ARC_F_CRIT * noise * noise) {
      const line = fitLinePoints(run.members)
      if (circle.model.radius < LINE_ARC_RADIUS_LENGTHS * line.length) throw new FitError(curved)
    }
  }
  return run.members
}

/**
 * The round stretch of the chain the click landed on — a fillet, an arc, or
 * a whole hole's rim — as the picks of a circle element. Throws FitError
 * when the edge under the click is straight or not round.
 */
export function growCircleFromSeed(chain: readonly Vec2[], seed: number): Vec2[] {
  const view = viewChain(chain)
  const n = view.points.length
  if (n < 6) throw new FitError('Too few edge points here for a circle.')
  const s = seedIndex(view, seed)
  const maxSigma = FIT_SCATTERS_MAX * view.scatter
  for (const half of CIRCLE_SCALES) {
    const [lo, hi] = windowAround(view, s, half)
    const window = slice(view, lo, hi)
    const circle = CIRCLE_SPEC.fit(window)
    const line = LINE_SPEC.fit(window)
    // The window has to bow clearly beyond the noise, and the circle has to
    // explain it far better than a line does, before its circle means
    // anything.
    const resolved =
      circle !== null &&
      circle.sigma <= maxSigma &&
      (line === null || line.sigma >= 3 * circle.sigma + 3 * view.scatter)
    if (resolved) {
      const run = grow(view, s, half, CIRCLE_SPEC)
      if (run && run.members.length >= 6 && run.sigma <= maxSigma) {
        const arc = tryFit(fitArcPoints, run.members)
        if (arc && arc.sweep >= MIN_SWEEP) return run.members
      }
    }
    if (covers(view, lo, hi)) break
  }
  throw new FitError(
    "Couldn't fit a circle at this point — the edge here is straight or not round. Click on the round part of the edge.",
  )
}

/** The growth for a kind — what the store dispatches a click on. */
export function growFromSeed(kind: 'line' | 'circle', chain: readonly Vec2[], seed: number): Vec2[] {
  return kind === 'circle' ? growCircleFromSeed(chain, seed) : growLineFromSeed(chain, seed)
}
