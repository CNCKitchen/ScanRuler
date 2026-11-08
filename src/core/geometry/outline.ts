// SPDX-License-Identifier: AGPL-3.0-only
// The outline of a part seen square onto a plane: where a grid of rays
// meets the scan and where it does not, the line between traced round by
// marching squares, and each loop read as a CAD sketch would draw it —
// straight sides fitted as lines and met at their corners, the rounds
// between them fitted as circles, a whole loop as one circle where it is
// round. A flange's plan, a bezel's opening, a gasket's shape, read in one
// call instead of guessed from a coarse height map.
//
// The traced line steps from cell to cell, so it is good to half a cell;
// the lines and circles are least-squares fits over many of its points,
// and come out much closer than that.

import { fitCircle2d } from '../fit/circle2d'
import { simplifyRun } from '../flat/simplify'

export type Pt = [number, number]

/** A loop of the outline in the grid's own coordinates (u, v, mm), with
 *  whether it is a hole in another and the area it closes. */
export interface MaskLoop {
  points: Pt[]
  hole: boolean
  area: number
}

/** The grid a mask lies on: cell (c, r) has its centre at
 *  u0 + (c + ½)·cell, v0 + (r + ½)·cell. */
export interface MaskGrid {
  cols: number
  rows: number
  cell: number
  u0: number
  v0: number
}

/**
 * The loops round the cells that are set in `mask` (row-major, row 0 at
 * the low v), by marching squares over the cell centres: each loop runs
 * through the midpoints between a set cell and an unset one. Two set cells
 * that touch only at a corner are kept apart. Loops closing less than
 * `minArea` (mm²) are left out — specks of a ray that grazed an edge.
 * The largest first.
 */
export function maskLoops(mask: Uint8Array, g: MaskGrid, minArea = 0): MaskLoop[] {
  const { cols, rows } = g
  const at = (c: number, r: number) => (c >= 0 && r >= 0 && c < cols && r < rows ? mask[r * cols + c] !== 0 : false)
  // A crossing's key: the cell edge it lies on, horizontal (between (c, r)
  // and (c + 1, r)) or vertical (between (c, r) and (c, r + 1)), with the
  // padding of one cell all round counted in.
  const W = cols + 2
  const H = rows + 2
  const hKey = (c: number, r: number) => (r + 1) * W + (c + 1)
  const vKey = (c: number, r: number) => W * H + (r + 1) * W + (c + 1)
  const place = (k: number): Pt => {
    const vertical = k >= W * H
    const i = vertical ? k - W * H : k
    const c = (i % W) - 1
    const r = Math.floor(i / W) - 1
    return vertical ? [c, r + 0.5] : [c + 0.5, r]
  }
  const next = new Map<number, number[]>()
  const link = (a: number, b: number) => {
    const la = next.get(a) ?? []
    la.push(b)
    next.set(a, la)
    const lb = next.get(b) ?? []
    lb.push(a)
    next.set(b, lb)
  }
  for (let r = -1; r < rows; r++) {
    for (let c = -1; c < cols; c++) {
      const a = at(c, r), b = at(c + 1, r), cc = at(c + 1, r + 1), d = at(c, r + 1)
      const bottom = hKey(c, r), top = hKey(c, r + 1), left = vKey(c, r), right = vKey(c + 1, r)
      const cross: number[] = []
      if (a !== b) cross.push(bottom)
      if (b !== cc) cross.push(right)
      if (d !== cc) cross.push(top)
      if (a !== d) cross.push(left)
      if (cross.length === 2) link(cross[0], cross[1])
      else if (cross.length === 4) {
        // A saddle: the two set corners cut off each on its own.
        if (a) {
          link(bottom, left)
          link(right, top)
        } else {
          link(bottom, right)
          link(top, left)
        }
      }
    }
  }
  const done = new Set<number>()
  const loops: Pt[][] = []
  for (const start of next.keys()) {
    if (done.has(start)) continue
    const keys = [start]
    done.add(start)
    let prev = -1
    let cur = start
    for (;;) {
      const ns = next.get(cur)!
      const to = ns[0] !== prev ? ns[0] : ns[1]
      if (to === undefined || to === start) break
      if (done.has(to)) break
      done.add(to)
      keys.push(to)
      prev = cur
      cur = to
    }
    if (keys.length < 3) continue
    loops.push(keys.map((k) => {
      const [x, y] = place(k)
      return [g.u0 + (x + 0.5) * g.cell, g.v0 + (y + 0.5) * g.cell]
    }))
  }
  const out = loops.map((points) => ({ points, area: Math.abs(signedArea(points)) })).filter((l) => l.area >= minArea)
  // A loop inside an odd number of others is a hole.
  return out
    .map((l) => ({ ...l, hole: out.filter((o) => o !== l && o.area > l.area && inside(l.points[0], o.points)).length % 2 === 1 }))
    .sort((a, b) => b.area - a.area)
}

function signedArea(p: readonly Pt[]): number {
  let s = 0
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) s += p[j][0] * p[i][1] - p[i][0] * p[j][1]
  return s / 2
}

function inside(q: Pt, p: readonly Pt[]): boolean {
  let x = false
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    if (p[i][1] > q[1] !== p[j][1] > q[1] && q[0] < ((p[j][0] - p[i][0]) * (q[1] - p[i][1])) / (p[j][1] - p[i][1]) + p[i][0]) x = !x
  }
  return x
}

/** A loop read as a sketch: its corners in order; each round on a corner
 *  where two straight sides meet (at: the corner's index in points); each
 *  other side that is an arc, not a straight line (from: the index of the
 *  point it starts at, running to the next); or one circle where the whole
 *  loop is round. */
export interface LoopShape {
  points: Pt[]
  rounds: { at: number; radius: number; center: Pt }[]
  /** mid: the point halfway along the arc, which says which way it bulges
   *  where the centre lies near its chord, as a slot's half-round end. */
  arcs: { from: number; radius: number; center: Pt; mid: Pt }[]
  circle?: { center: Pt; radius: number; rms: number }
  /** The worst distance of the traced loop from the shape, mm, and where
   *  on the loop it is. */
  worst: number
  worstAt?: Pt
}

interface Circle {
  center: Pt
  radius: number
  rms: number
  max: number
}

function circleThrough(pts: readonly Pt[]): Circle | null {
  if (pts.length < 3) return null
  const c = fitCircle2d(pts.map((p) => p[0]), pts.map((p) => p[1]))
  if (!c) return null
  let s = 0
  let max = 0
  for (const p of pts) {
    const d = Math.abs(Math.hypot(p[0] - c.cu, p[1] - c.cv) - c.r)
    s += d * d
    max = Math.max(max, d)
  }
  return { center: [c.cu, c.cv], radius: c.r, rms: Math.sqrt(s / pts.length), max }
}

interface Line {
  at: Pt
  dir: Pt
  rms: number
  max: number
}

/** The total-least-squares line through the points. */
function lineThrough(pts: readonly Pt[]): Line {
  let mx = 0, my = 0
  for (const p of pts) {
    mx += p[0]
    my += p[1]
  }
  mx /= pts.length
  my /= pts.length
  let sxx = 0, sxy = 0, syy = 0
  for (const p of pts) {
    const x = p[0] - mx, y = p[1] - my
    sxx += x * x
    sxy += x * y
    syy += y * y
  }
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy)
  const dir: Pt = [Math.cos(angle), Math.sin(angle)]
  let s = 0
  let max = 0
  for (const p of pts) {
    const d = (p[0] - mx) * dir[1] - (p[1] - my) * dir[0]
    s += d * d
    max = Math.max(max, Math.abs(d))
  }
  return { at: [mx, my], dir, rms: Math.sqrt(s / pts.length), max }
}

/** Where two lines meet; null when they run within a few degrees of
 *  parallel. */
function meet(a: Line, b: Line): Pt | null {
  const den = a.dir[0] * b.dir[1] - a.dir[1] * b.dir[0]
  if (Math.abs(den) < Math.sin((4 * Math.PI) / 180)) return null
  const t = ((b.at[0] - a.at[0]) * b.dir[1] - (b.at[1] - a.at[1]) * b.dir[0]) / den
  return [a.at[0] + t * a.dir[0], a.at[1] + t * a.dir[1]]
}

const segDist = (p: Pt, a: Pt, b: Pt): number => {
  const dx = b[0] - a[0], dy = b[1] - a[1]
  const l2 = dx * dx + dy * dy
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)
}

/** Where a line and an arc that runs on from it meet: the foot of the
 *  arc's centre on the line, where the line is tangent to it within the
 *  tolerance; null otherwise. */
function touch(a: Piece, b: Piece, tolerance: number): Pt | null {
  const line = a.kind === 'line' ? a.line : b.kind === 'line' ? b.line : null
  const arc = a.kind === 'arc' ? a.circle : b.kind === 'arc' ? b.circle : null
  if (!line || !arc) return null
  const t = (arc.center[0] - line.at[0]) * line.dir[0] + (arc.center[1] - line.at[1]) * line.dir[1]
  const foot: Pt = [line.at[0] + t * line.dir[0], line.at[1] + t * line.dir[1]]
  return Math.abs(Math.hypot(arc.center[0] - foot[0], arc.center[1] - foot[1]) - arc.radius) <= tolerance ? foot : null
}

/** A traced loop's steps evened out a little: each point with its two
 *  neighbours, ¼ ½ ¼ round the loop. */
export function smoothTrace(traced: readonly Pt[]): Pt[] {
  const n = traced.length
  return traced.map((p, i) => {
    const a = traced[(i + n - 1) % n]
    const b = traced[(i + 1) % n]
    return [(a[0] + 2 * p[0] + b[0]) / 4, (a[1] + 2 * p[1] + b[1]) / 4]
  })
}

/** The most thinned sides one line or arc may span. */
const SPAN_MAX = 40

type Piece = { kind: 'line'; line: Line; from: number; to: number } | { kind: 'arc'; circle: Circle; from: number; to: number }

/**
 * A traced loop read as a sketch, to within `tolerance` (mm): as few lines
 * and arcs as follow it that closely, a line taken over an arc that fits
 * as well. The loop is thinned (Ramer–Douglas–Peucker, to half the
 * tolerance) to the places a piece may start, and the fewest pieces are
 * found over them (dynamic programming, from its sharpest corner round);
 * each piece is fitted over the traced points it spans. Two lines meet at
 * a sharp corner; an arc between two lines that meet is that corner's
 * round — so a rounded rectangle comes back as its four corners, each with
 * its round. `cell` is the grid's, the size of the tracing's steps.
 */
export function loopShape(traced: readonly Pt[], tolerance: number, cell: number): LoopShape {
  const n = traced.length
  const loop = smoothTrace(traced)
  const fine = Math.max(tolerance / 2, 0.3 * cell)
  const whole = circleThrough(loop)
  if (whole && whole.rms <= fine && whole.max <= tolerance) {
    return { points: [], rounds: [], arcs: [], circle: { center: whole.center, radius: whole.radius, rms: whole.rms }, worst: whole.max }
  }
  // Thinned, as a closed run from the point farthest from the first.
  const d0 = (i: number) => Math.hypot(loop[i][0] - loop[0][0], loop[i][1] - loop[0][1])
  let far = 0
  for (let i = 1; i < n; i++) if (d0(i) > d0(far)) far = i
  const flat = new Float64Array((n + 1) * 2)
  for (let i = 0; i <= n; i++) {
    flat[i * 2] = loop[i % n][0]
    flat[i * 2 + 1] = loop[i % n][1]
  }
  const thinned = [...simplifyRun(flat, 0, far + 1, fine), ...simplifyRun(flat, far, n + 1, fine).slice(1, -1)]
  const m = thinned.length
  if (m < 3) return { points: thinned.map((i) => [...loop[i]] as Pt), rounds: [], arcs: [], worst: 0 }
  // Started in the middle of the longest side, which is part of a line, so
  // no corner and no arc is cut in two where the loop closes: the places a
  // piece may start, as running indices from there once round.
  const end = (k: number) => (k + 1 < m ? thinned[k + 1] : thinned[0] + n)
  const sideLen = (k: number) => Math.hypot(loop[end(k) % n][0] - loop[thinned[k]][0], loop[end(k) % n][1] - loop[thinned[k]][1])
  let longest = 0
  for (let k = 1; k < m; k++) if (sideLen(k) > sideLen(longest)) longest = k
  const start = Math.round((thinned[longest] + end(longest)) / 2) % n
  const kept = [start, ...thinned.map((i) => (i <= start ? i + n : i)).sort((x, y) => x - y), start + n].filter((i, k, all) => k === 0 || i !== all[k - 1])
  const M = kept.length - 1
  const pointsOf = (i: number, j: number): Pt[] => {
    const out: Pt[] = []
    for (let k = kept[i]; k <= kept[j]; k++) out.push(loop[k % n])
    return out
  }
  const us = loop.map((p) => p[0])
  const vs = loop.map((p) => p[1])
  const size = Math.max(Math.max(...us) - Math.min(...us), Math.max(...vs) - Math.min(...vs))
  // A line where one holds; an arc where one holds and a line does not,
  // or where it follows the points much more closely than the line does —
  // a small round is within the tolerance of a chamfer, and is still a
  // round. An arc is held to the tracing's own scatter, a line only to the
  // tolerance: a gently curving side is drawn straight.
  const tight = Math.max(fine / 2, 0.3 * cell)
  const pieceOf = (i: number, j: number): Piece | null => {
    const pts = pointsOf(i, j)
    const line = lineThrough(pts)
    const straight = line.rms <= fine && line.max <= tolerance
    if (pts.length >= 5 && !(straight && line.rms <= tight)) {
      const circle = circleThrough(pts)
      if (circle && circle.rms <= tight && circle.max <= tolerance && circle.radius < size / 2 && (!straight || circle.rms < line.rms / 2)) return { kind: 'arc', circle, from: i, to: j }
    }
    return straight ? { kind: 'line', line, from: i, to: j } : null
  }
  // The fewest pieces from the start to each place. Going back from a
  // place, a piece that fits neither way stops the search a little later:
  // a longer one will not fit either.
  const best = new Float64Array(M + 1).fill(Infinity)
  const back: (Piece | null)[] = new Array(M + 1).fill(null)
  best[0] = 0
  for (let j = 1; j <= M; j++) {
    let misses = 0
    for (let i = j - 1; i >= Math.max(0, j - SPAN_MAX) && misses < 3; i--) {
      const p = pieceOf(i, j)
      if (!p) {
        misses++
        continue
      }
      misses = 0
      if (best[i] + 1 < best[j]) {
        best[j] = best[i] + 1
        back[j] = p
      }
    }
  }
  const pieces: Piece[] = []
  for (let j = M; j > 0; ) {
    const p = back[j]
    if (!p) return { points: kept.slice(0, M).map((k) => [...loop[k % n]] as Pt), rounds: [], arcs: [], worst: fine }
    pieces.unshift(p)
    j = p.from
  }
  // The start cut a line in two: one again, where one line holds them.
  if (pieces.length > 2 && pieces[0].kind === 'line' && pieces[pieces.length - 1].kind === 'line') {
    const last = pieces[pieces.length - 1]
    const line = lineThrough([...pointsOf(last.from, M), ...pointsOf(0, pieces[0].to)])
    if (line.rms <= fine && line.max <= tolerance) {
      pieces.pop()
      pieces[0] = { kind: 'line', line, from: last.from - M, to: pieces[0].to }
    }
  }
  // Each line fitted again over the middle of its points, away from its
  // ends, where the tracing has begun to turn into what comes next — kept
  // where it still follows all of them within the tolerance.
  for (let k = 0; k < pieces.length; k++) {
    const p = pieces[k]
    if (p.kind !== 'line') continue
    const pts = p.from < 0 ? [...pointsOf(p.from + M, M), ...pointsOf(0, p.to)] : pointsOf(p.from, p.to)
    const trim = Math.floor(pts.length * 0.2)
    if (pts.length - 2 * trim < 5) continue
    const line = lineThrough(pts.slice(trim, pts.length - trim))
    const off = Math.max(...pts.map((q) => Math.abs((q[0] - line.at[0]) * line.dir[1] - (q[1] - line.at[1]) * line.dir[0])))
    if (off <= tolerance) pieces[k] = { ...p, line }
  }
  // Each piece's start, in order: where two lines meet, a round's corner
  // where the lines either side of it meet, and anywhere else the place it
  // starts from. A round is an arc between two lines whose corner lies
  // near it, outside the circle, about where the arc's middle points — not
  // a slot's end between two lines that never meet, nor a turn so far round
  // that the lines meet behind it.
  const P = pieces.length
  const at = (k: number) => pieces[((k % P) + P) % P]
  const roundOn = (k: number): Pt | null => {
    const p = at(k), a = at(k - 1), b = at(k + 1)
    if (p.kind !== 'arc' || P < 3 || a.kind !== 'line' || b.kind !== 'line') return null
    const corner = meet(a.line, b.line)
    if (!corner) return null
    const c = p.circle.center
    const out = Math.hypot(corner[0] - c[0], corner[1] - c[1])
    const arc = pointsOf(p.from, p.to)
    const mid = arc[arc.length >> 1]
    const toward = ((mid[0] - c[0]) * (corner[0] - c[0]) + (mid[1] - c[1]) * (corner[1] - c[1])) / (Math.hypot(mid[0] - c[0], mid[1] - c[1]) * out)
    return toward > 0.95 && out > p.circle.radius && out < 4 * p.circle.radius ? corner : null
  }
  const points: Pt[] = []
  const rounds: LoopShape['rounds'] = []
  const arcs: LoopShape['arcs'] = []
  for (let k = 0; k < P; k++) {
    const p = at(k)
    const corner = roundOn(k)
    if (corner && p.kind === 'arc') {
      rounds.push({ at: points.length, radius: p.circle.radius, center: p.circle.center })
      points.push(corner)
      continue
    }
    // A line after a round starts at the round's corner, given already.
    if (p.kind === 'line' && roundOn(k - 1)) continue
    const prev = at(k - 1)
    const met = p.kind === 'line' && prev.kind === 'line' ? meet(prev.line, p.line) : p.kind !== prev.kind ? touch(p, prev, tolerance) : null
    if (p.kind === 'arc') {
      const arc = pointsOf(p.from, p.to)
      arcs.push({ from: points.length, radius: p.circle.radius, center: p.circle.center, mid: arc[arc.length >> 1] })
    }
    points.push(met ?? ([...loop[(kept[(p.from + M) % M] ?? kept[0]) % n]] as Pt))
  }
  // Each arc's mid-point: halfway round from its start to its end the way
  // the trace runs — the side its traced middle (held for now in mid) is
  // on — put on its circle.
  for (const a of arcs) {
    const angle = (q: Pt) => Math.atan2(q[1] - a.center[1], q[0] - a.center[0])
    const a0 = angle(points[a.from])
    const turn = (x: number) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
    const ccw = turn(angle(points[(a.from + 1) % points.length]) - a0)
    const sweep = turn(angle(a.mid) - a0) < ccw ? ccw : ccw - 2 * Math.PI
    const m = a0 + sweep / 2
    a.mid = [a.center[0] + a.radius * Math.cos(m), a.center[1] + a.radius * Math.sin(m)]
  }
  // How far the traced loop strays from the shape drawn: its sides, a
  // round or an arc taken as its circle.
  let worst = 0
  let worstAt: Pt | undefined
  for (const p of traced) {
    let d = Infinity
    for (let i = 0; i < points.length; i++) d = Math.min(d, segDist(p, points[i], points[(i + 1) % points.length]))
    for (const r of [...rounds, ...arcs]) d = Math.min(d, Math.abs(Math.hypot(p[0] - r.center[0], p[1] - r.center[1]) - r.radius))
    if (d > worst) {
      worst = d
      worstAt = p
    }
  }
  return { points, rounds, arcs, worst, ...(worstAt ? { worstAt } : {}) }
}
