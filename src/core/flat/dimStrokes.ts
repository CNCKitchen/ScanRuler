// SPDX-License-Identifier: AGPL-3.0-only
// A dimension on a 2D sheet as a drawing carries it: extension lines off the
// two measured points, a dimension line between them with a filled arrow at
// each end, the number written along the line in a gap left for it; a radius
// as a leader with its arrow on the rim; an angle as an arc between the two
// lines.
//
// Pure: a DimShape says what is measured and where the number sits, in sheet
// millimetres; dimStrokes turns it into lines and arrowheads for one zoom —
// the arrows, the gaps and the overshoot are sized in screen pixels, so the
// strokes are made again when the zoom changes and the shape is not.

import type { Vec2 } from './types'
import { add2, dot2, len2, normalize2, scale2, sub2 } from './vec2'

export type DimShape =
  /** A length or a distance: measured from `p` to `q`, the dimension line
   *  `off` along `n` from them, the number `along` `d` from its middle. */
  | { kind: 'linear'; p: Vec2; q: Vec2; d: Vec2; n: Vec2; off: number; along: number }
  /** A radius: the leader at `angle` about `c`, the number `reach` from the
   *  centre. `span` is the arc's own, for a leader that lands beside it. */
  | { kind: 'radius'; c: Vec2; r: number; angle: number; reach: number; span: { start: number; sweep: number } | null }
  /** An angle: the arc of `radius` about `vertex` from `a0` counter-clockwise
   *  through `sweep`, the number at the angle `at`; the two lines' own
   *  stretches, for the extension an arc end beside its line needs. */
  | { kind: 'angle'; vertex: Vec2; a0: number; sweep: number; radius: number; at: number; lines: [[Vec2, Vec2], [Vec2, Vec2]] }

export interface DimStrokes {
  lines: Vec2[][]
  /** Filled arrowheads: the tip, and the way it points. */
  arrows: { tip: Vec2; dir: Vec2 }[]
  /** The middle of the number, and the angle it is written at — along the
   *  dimension line, turned to read from below or from the right. */
  text: Vec2
  textAngle: number
}

/** Screen pixels. */
const ARROW_PX = 11
const EXT_GAP_PX = 3
const EXT_OVER_PX = 7
const TEXT_PAD_PX = 5
const TAIL_PX = 18

export const polar = (c: Vec2, r: number, a: number): Vec2 => [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]

/** An angle into (-π, π]. */
function wrap(a: number): number {
  let x = a % (2 * Math.PI)
  if (x > Math.PI) x -= 2 * Math.PI
  if (x <= -Math.PI) x += 2 * Math.PI
  return x
}

/** Text is never written upside down: the angle into (-π/2, π/2]. */
function readable(a: number): number {
  let x = wrap(a)
  if (x > Math.PI / 2) x -= Math.PI
  if (x <= -Math.PI / 2) x += Math.PI
  return x
}

/** A stretch [lo, hi] of a line or an arc with the number's gap cut out. */
function withGap(lo: number, hi: number, gapLo: number, gapHi: number): [number, number][] {
  const out: [number, number][] = []
  if (gapLo > lo) out.push([lo, Math.min(hi, gapLo)])
  if (gapHi < hi) out.push([Math.max(lo, gapHi), hi])
  return out.filter(([a, b]) => b - a > 1e-12)
}

function arcPoints(c: Vec2, r: number, from: number, to: number): Vec2[] {
  const steps = Math.max(2, Math.ceil(Math.abs(to - from) / 0.08))
  const pts: Vec2[] = []
  for (let i = 0; i <= steps; i++) pts.push(polar(c, r, from + ((to - from) * i) / steps))
  return pts
}

/**
 * The strokes of a dimension at one zoom. `px` is sheet millimetres per
 * screen pixel, `textPx` the width of the number as written.
 */
export function dimStrokes(shape: DimShape, px: number, textPx: number): DimStrokes {
  const arrow = ARROW_PX * px
  const tail = TAIL_PX * px
  const half = (textPx / 2 + TEXT_PAD_PX) * px
  const lines: Vec2[][] = []
  const arrows: { tip: Vec2; dir: Vec2 }[] = []

  if (shape.kind === 'linear') {
    const { p, q, d, n, off, along } = shape
    const L = len2(sub2(q, p))
    const p1 = add2(p, scale2(n, off))
    const mid = add2(scale2(add2(p, q), 0.5), scale2(n, off))
    if (Math.abs(off) > (EXT_GAP_PX + 1) * px) {
      const s = Math.sign(off)
      for (const from of [p, q]) lines.push([add2(from, scale2(n, s * EXT_GAP_PX * px)), add2(from, scale2(n, off + s * EXT_OVER_PX * px))])
    }
    // The arrows stand inside the stretch while they and the number fit
    // there; on a short one they point in at it from outside.
    const textInside = Math.abs(along) < L / 2
    const outside = L < 2.4 * arrow || (textInside && L < 2 * half + 2.2 * arrow)
    let lo = -L / 2
    let hi = L / 2
    if (outside) {
      lo -= tail
      hi += tail
    }
    lo = Math.min(lo, along - half)
    hi = Math.max(hi, along + half)
    for (const [a, b] of withGap(lo, hi, along - half, along + half)) lines.push([add2(mid, scale2(d, a)), add2(mid, scale2(d, b))])
    const back = scale2(d, -1)
    arrows.push({ tip: p1, dir: outside ? d : back }, { tip: add2(p1, scale2(d, L)), dir: outside ? back : d })
    return { lines, arrows, text: add2(mid, scale2(d, along)), textAngle: readable(Math.atan2(d[1], d[0])) }
  }

  if (shape.kind === 'radius') {
    const { c, r, angle, reach, span } = shape
    const u: Vec2 = [Math.cos(angle), Math.sin(angle)]
    const rim = polar(c, r, angle)
    if (reach > r) {
      // The number outside: the leader comes in to the rim.
      if (reach - half > r) lines.push([rim, polar(c, reach - half, angle)])
      arrows.push({ tip: rim, dir: scale2(u, -1) })
    } else {
      for (const [a, b] of withGap(0, r, reach - half, reach + half)) lines.push([polar(c, a, angle), polar(c, b, angle)])
      arrows.push({ tip: rim, dir: u })
    }
    if (span) {
      // A leader landing beside the arc meets the arc carried on to it.
      const rel = wrap(angle - (span.start + span.sweep / 2))
      const over = Math.abs(rel) - span.sweep / 2
      if (over > 0) {
        const end = rel > 0 ? span.start + span.sweep : span.start
        lines.push(arcPoints(c, r, end, end + Math.sign(rel) * (over + (EXT_OVER_PX * px) / Math.max(r, 1e-9))))
      }
    }
    return { lines, arrows, text: polar(c, reach, angle), textAngle: readable(angle) }
  }

  const { vertex, radius: R, lines: measured } = shape
  let { a0 } = shape
  const { sweep } = shape
  // The number dragged into the sector across the vertex takes the arc with
  // it: the same angle, read between the lines' other halves.
  let rel = wrap(shape.at - (a0 + sweep / 2))
  const across = wrap(rel - Math.PI)
  if (Math.abs(across) < Math.abs(rel)) {
    a0 += Math.PI
    rel = across
  }
  const at = sweep / 2 + rel
  const halfA = half / R
  const arrowA = arrow / R
  const textInside = at > 0 && at < sweep
  const outside = sweep < 2.4 * arrowA || (textInside && sweep < 2 * halfA + 2.2 * arrowA)
  let lo = 0
  let hi = sweep
  if (outside) {
    lo -= tail / R
    hi += tail / R
  }
  lo = Math.min(lo, at - halfA)
  hi = Math.max(hi, at + halfA)
  for (const [a, b] of withGap(lo, hi, at - halfA, at + halfA)) lines.push(arcPoints(vertex, R, a0 + a, a0 + b))
  // An arrowhead is straight and the arc is not: it is laid along the chord
  // of the stretch of arc it covers, so its tail sits on the arc too.
  const head = (end: number, inward: number) => {
    const chord = end + (inward * arrowA) / 2
    const t: Vec2 = [-Math.sin(a0 + chord), Math.cos(a0 + chord)]
    arrows.push({ tip: polar(vertex, R, a0 + end), dir: scale2(t, -inward) })
  }
  head(0, outside ? -1 : 1)
  head(sweep, outside ? 1 : -1)
  // An arc end that lies off its line is met by the line carried on to it.
  const ends: [number, [Vec2, Vec2]][] = [[a0, measured[0]], [a0 + sweep, measured[1]]]
  for (const [angle, [la, lb]] of ends) {
    const e = polar(vertex, R, angle)
    const dir = normalize2(sub2(lb, la))
    if (!dir) continue
    const t = dot2(sub2(e, la), dir)
    const length = len2(sub2(lb, la))
    if (t >= 0 && t <= length) continue
    const from = t < 0 ? la : lb
    const out = normalize2(sub2(e, from))
    if (out) lines.push([add2(from, scale2(out, EXT_GAP_PX * px)), add2(e, scale2(out, EXT_OVER_PX * px))])
  }
  return { lines, arrows, text: polar(vertex, R, a0 + at), textAngle: readable(a0 + at + Math.PI / 2) }
}
