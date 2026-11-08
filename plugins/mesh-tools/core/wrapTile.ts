// SPDX-License-Identifier: AGPL-3.0-only
// Wrap's work on one tile of the grid (see wrap.ts for the whole): each a
// function of plain arrays, so a tile can be handed to a worker and its
// answer handed back. A tile is TILE³ grid points; it reads a halo round
// them, and every value at a point is worked out by the tile that point
// belongs to alone — a neighbour that needs it reads it from there — so two
// tiles never disagree about which side of the wrap a point lies.
//
// Distances are in cells throughout, and a tile's points are numbered
// i + T·(j + T·k) — its "core" — while a box with a halo of H points round
// it is numbered a + n·(b + n·c), n = T + 2H, its point (H, H, H) the core's
// first.

import { FAR, featureScratch, featureTransform, type FeatureScratch } from './distanceGrid'
import { CUBE_EDGE_DIR, CUBE_EDGE_FROM, CUBE_TRIANGLES, Grow } from './marching'
import { closestOnTriangle } from '../../../src/core/deviation/surface'

/** Grid points along each side of a tile. */
export const TILE = 64

/** The grid a wrap is worked out on, and the distances that matter on it. */
export interface WrapPlan {
  /** The cell, mm. */
  h: number
  /** Where grid point (0, 0, 0) lies, mm. */
  ox: number
  oy: number
  oz: number
  /** Tiles along each axis; the grid has TILE times as many points. */
  tx: number
  ty: number
  tz: number
  /** The gap's radius r, in cells: free space is further than this from the
   *  part. */
  rc: number
  /** The wrap's level in cells, t − r: it is where the signed field (see
   *  tilePassC) reaches this. */
  lc: number
  /** How far the distance to the part is worked out, cells: past this a
   *  point is just far. */
  dmaxS: number
  /** How far the distance from the outside is worked out, cells. */
  dmaxF: number
  /** The halo each pass reads round a tile, points. */
  hS: number
  hF: number
}

/** A tile's free space, as runs along X: for each line (j + T·k) of the
 *  core, its runs of points further than r from the part, each the piece of
 *  free space within the tile it belongs to. */
export interface TileRuns {
  /** Where each line's runs start in `runX` (by twos) and `runComp`;
   *  T² + 1 of them. */
  lineStart: Uint32Array
  /** First and last X of each run. */
  runX: Uint8Array
  runComp: Int32Array
  comps: number
}

/** What the first pass leaves of a tile. */
export interface TileA extends TileRuns {
  /** Where free space begins next to the part: a point within r of it (by
   *  its number in the core), the direction to a free neighbour (0 −X, 1 +X,
   *  2 −Y, 3 +Y, 4 −Z, 5 +Z), and the nearest point to each of the two
   *  where the distance to the part is r — six offsets from them, in
   *  cells times FOOT_SCALE: the point first, the neighbour after. */
  crossQ: Uint32Array
  crossDir: Uint8Array
  crossFoot: Int16Array
  /** The free points of the core within reach of the part, by number, and
   *  their distance to it in cells. */
  bandIdx: Uint32Array
  bandDS: Float32Array
}

/** What the second pass leaves of a tile: the signed field Ψ — the distance
 *  to the part less r where it is outside (free and joined to infinity),
 *  and minus the distance to the outside elsewhere — at every point of the
 *  core where it was worked out, by number. Every other point is far: out
 *  if it is outside, in if not. */
export interface TilePsi {
  idx: Uint32Array
  psi: Float32Array
}

/** A tile's piece of the wrap: its vertices, the global key of those that lie
 *  on a face it shares with a neighbour (−1 for the rest), and its triangles
 *  by its own vertex numbers. */
export interface TileMesh {
  positions: Float32Array
  keys: Float64Array
  indices: Uint32Array
}

/** What a crossing's offsets are multiplied by: a 8192th of a cell, as far
 *  as four cells. */
export const FOOT_SCALE = 8192

/** The directions a crossing steps, in the order crossDir numbers them. */
export const STEPS: readonly (readonly [number, number, number])[] = [
  [-1, 0, 0],
  [1, 0, 0],
  [0, -1, 0],
  [0, 1, 0],
  [0, 0, -1],
  [0, 0, 1],
]

/** Scratch a worker keeps and uses again tile after tile. */
export interface TileScratch {
  n: number
  f: Float32Array
  src: Int32Array
  sx: Float32Array
  sy: Float32Array
  sz: Float32Array
  occX: Uint8Array
  /** For the sweeps: where on each X line anything was reached. */
  lineFrom: Int32Array
  lineTo: Int32Array
  /** Pass A's squared distances at the core and a layer round it. */
  d2: Float32Array
  feature: FeatureScratch
}

export function tileScratch(plan: WrapPlan): TileScratch {
  const n = TILE + 2 * Math.max(plan.hS, plan.hF)
  const total = n * n * n
  return {
    n,
    f: new Float32Array(total),
    src: new Int32Array(total),
    sx: new Float32Array(total),
    sy: new Float32Array(total),
    sz: new Float32Array(total),
    occX: new Uint8Array(n * n),
    lineFrom: new Int32Array(n * n),
    lineTo: new Int32Array(n * n),
    d2: new Float32Array((TILE + 2) ** 3),
    feature: featureScratch(n),
  }
}

/** Clear the first `n³` of the scratch for a box `n` a side. */
function clearBox(ws: TileScratch, n: number): void {
  ws.f.fill(FAR, 0, n * n * n)
  ws.src.fill(-1, 0, n * n * n)
  ws.occX.fill(0, 0, n * n)
}

// ---- pass A: distance to the part, free space, where it begins ------------------------------

/**
 * The first pass over a tile (I, J, K): the distance from its points to the
 * part — the triangles that reach it, nine floats each in `tri` — its free
 * space as runs, joined into pieces within the tile, and where free space
 * begins next to the part.
 */
export function tilePassA(plan: WrapPlan, I: number, J: number, K: number, tri: Float32Array, ws: TileScratch): TileA {
  const T = TILE
  const H = plan.hS
  const n = T + 2 * H
  clearBox(ws, n)
  const { f, src, sx, sy, sz, occX } = ws
  // The box's point 0, in global cells.
  const bx = I * T - H, by = J * T - H, bz = K * T - H
  const inv = 1 / plan.h
  const ox = plan.ox + bx * plan.h, oy = plan.oy + by * plan.h, oz = plan.oz + bz * plan.h
  for (let t = 0; t < tri.length; t += 9) {
    seedTriangle(
      (tri[t] - ox) * inv, (tri[t + 1] - oy) * inv, (tri[t + 2] - oz) * inv,
      (tri[t + 3] - ox) * inv, (tri[t + 4] - oy) * inv, (tri[t + 5] - oz) * inv,
      (tri[t + 6] - ox) * inv, (tri[t + 7] - oy) * inv, (tri[t + 8] - oz) * inv,
      n, ws,
    )
  }
  featureTransform(f, src, n, plan.dmaxS * plan.dmaxS, occX, ws.feature)

  // The squared distance at the core's points and one layer round them,
  // cells² — Infinity past reach. The seeds are the part's own points, a
  // cell apart and each next to its grid point, and a look at the
  // neighbours' is enough to find the nearest to a cell or two of the
  // threshold: no sweeps.
  const w = T + 2
  const d2 = ws.d2
  const reached = ws.feature.occOut
  for (let c = 0; c < w; c++) {
    for (let b = 0; b < w; b++) {
      const row = w * (b + w * c)
      if (!reached[b + H - 1 + n * (c + H - 1)]) {
        d2.fill(Infinity, row, row + w)
        continue
      }
      const boxRow = n * (b + H - 1 + n * (c + H - 1)) + H - 1
      for (let a = 0; a < w; a++) {
        if (src[boxRow + a] < 0) d2[row + a] = Infinity
        else {
          nearestAround(ws, n, a + H - 1, b + H - 1, c + H - 1)
          d2[row + a] = nearestD2[0]
        }
      }
    }
  }
  const stepIn = [-1, 1, -w, w, -w * w, w * w]

  const rc = plan.rc
  const lineStart = new Uint32Array(T * T + 1)
  const runX = new Grow(new Uint8Array(2 * T * T + 64))
  const parent = new Grow(new Uint32Array(T * T + 64))
  const crossQ = new Grow(new Uint32Array(1024))
  const crossDir = new Grow(new Uint8Array(1024))
  const crossFoot = new Grow(new Float32Array(6 * 1024))
  // The nearest point to a box point where the distance to the part is r,
  // as an offset from it: from the nearest point of the part out along the
  // line through it — or, on the part itself, along the step.
  const footOf = (a: number, b: number, c: number, ex: number, ey: number, ez: number) => {
    const s = nearestAround(ws, n, a, b, c)
    const d = Math.sqrt(nearestD2[0])
    if (s < 0 || !(d > 1e-6)) {
      crossFoot.push(ex * rc)
      crossFoot.push(ey * rc)
      crossFoot.push(ez * rc)
      return
    }
    const k = rc / d - 1
    crossFoot.push((a - sx[s]) * k)
    crossFoot.push((b - sy[s]) * k)
    crossFoot.push((c - sz[s]) * k)
  }
  const bandIdx = new Grow(new Uint32Array(1024))
  const bandDS = new Grow(new Float32Array(1024))
  const find = (x: number): number => {
    const p = parent.data
    while (p[x] !== x) {
      p[x] = p[p[x]]
      x = p[x]
    }
    return x
  }
  const union = (a: number, b: number) => {
    const ra = find(a), rb = find(b)
    // The lower root wins, so the pieces are numbered the same every time.
    if (ra < rb) parent.data[rb] = ra
    else if (rb < ra) parent.data[ra] = rb
  }
  const rc2 = rc * rc
  const dmax2 = plan.dmaxS * plan.dmaxS
  for (let k = 0; k < T; k++) {
    for (let j = 0; j < T; j++) {
      const L = j + T * k
      lineStart[L] = parent.length
      const b = j + H, c = k + H
      const row = 1 + w * (j + 1 + w * (k + 1))
      let runStart = -1
      if (!reached[b + n * c]) {
        // Nothing within reach along the line: one run, all of it free.
        runX.push(0)
        runX.push(T - 1)
        parent.push(parent.length)
      } else for (let i = 0; i < T; i++) {
        const dd = d2[row + i]
        const free = dd > rc2
        if (free) {
          if (dd < dmax2) {
            bandIdx.push(i + T * L)
            bandDS.push(Math.sqrt(dd))
          }
          if (runStart < 0) runStart = i
        } else {
          if (runStart >= 0) {
            runX.push(runStart)
            runX.push(i - 1)
            parent.push(parent.length)
            runStart = -1
          }
          // Where free space begins next to this point.
          for (let dir = 0; dir < 6; dir++) {
            if (d2[row + i + stepIn[dir]] > rc2) {
              const [ex, ey, ez] = STEPS[dir]
              crossQ.push(i + T * L)
              crossDir.push(dir)
              footOf(i + H, b, c, ex, ey, ez)
              footOf(i + H + ex, b + ey, c + ez, -ex, -ey, -ez)
            }
          }
        }
      }
      if (runStart >= 0) {
        runX.push(runStart)
        runX.push(T - 1)
        parent.push(parent.length)
      }
      // Joined to the runs they overlap on the line before in Y and in Z.
      const from = lineStart[L], to = parent.length
      if (j > 0) joinLines(runX.data, lineStart[L - 1], from, from, to, union)
      if (k > 0) joinLines(runX.data, lineStart[L - T], lineStart[L - T + 1], from, to, union)
    }
  }
  const runs = parent.length
  lineStart[T * T] = runs
  // The pieces, numbered in the order their first run comes.
  const runComp = new Int32Array(runs)
  const compOf = new Int32Array(runs).fill(-1)
  let comps = 0
  for (let r = 0; r < runs; r++) {
    const root = find(r)
    if (compOf[root] < 0) compOf[root] = comps++
    runComp[r] = compOf[root]
  }
  return {
    lineStart,
    runX: runX.done(),
    runComp,
    comps,
    crossQ: crossQ.done(),
    crossDir: crossDir.done(),
    crossFoot: Int16Array.from(crossFoot.done(), (x) => Math.max(-32767, Math.min(32767, Math.round(x * FOOT_SCALE)))),
    bandIdx: bandIdx.done(),
    bandDS: bandDS.done(),
  }
}

/** Every run of [a0, a1) joined to each of [b0, b1) it overlaps along X —
 *  both lists in order. */
function joinLines(runX: Uint8Array, a0: number, a1: number, b0: number, b1: number, union: (a: number, b: number) => void): void {
  let a = a0, b = b0
  while (a < a1 && b < b1) {
    const as = runX[2 * a], ae = runX[2 * a + 1]
    const bs = runX[2 * b], be = runX[2 * b + 1]
    if (as <= be && bs <= ae) union(a, b)
    if (ae < be) a++
    else b++
  }
}

/** How far apart the points spread over the part are, cells: the nearest
 *  of them to the nearest point of the part to any grid point is at most
 *  six-tenths of a cell from it, which puts the distance out by about a
 *  twentieth of a cell where it is judged, r out — three cells. */
const SAMPLE = 1

/** A point of the part, (u, v, w) in box cells, seeded at the eight grid
 *  points round it — each keeps the nearest such point. */
function seedAt(u: number, v: number, w: number, n: number, ws: TileScratch): void {
  const { f, src, sx, sy, sz, occX } = ws
  const i0 = Math.floor(u), j0 = Math.floor(v), k0 = Math.floor(w)
  for (let dk = 0; dk < 2; dk++) {
    const k = k0 + dk
    if (k < 0 || k >= n) continue
    const ez = (k - w) * (k - w)
    for (let dj = 0; dj < 2; dj++) {
      const j = j0 + dj
      if (j < 0 || j >= n) continue
      const ey = ez + (j - v) * (j - v)
      const row = n * (j + n * k)
      let marked = false
      for (let di = 0; di < 2; di++) {
        const i = i0 + di
        if (i < 0 || i >= n) continue
        const d = ey + (i - u) * (i - u)
        const at = i + row
        if (d < f[at]) {
          f[at] = d
          src[at] = at
          sx[at] = u
          sy[at] = v
          sz[at] = w
          marked = true
        }
      }
      if (marked) occX[j + n * k] = 1
    }
  }
}

/**
 * Points spread over a triangle — in box cells — no further apart than
 * SAMPLE, each seeded. A triangle larger than sixteen cells is split in four
 * first, and only the quarters that reach the box are spread over: a face of
 * a CAD part can cross a great many tiles, and each samples only its own
 * share of it.
 */
function seedTriangle(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  n: number,
  ws: TileScratch,
): void {
  const lo = -1, hi = n
  if (Math.max(ax, bx, cx) < lo || Math.min(ax, bx, cx) > hi) return
  if (Math.max(ay, by, cy) < lo || Math.min(ay, by, cy) > hi) return
  if (Math.max(az, bz, cz) < lo || Math.min(az, bz, cz) > hi) return
  const ab = Math.hypot(bx - ax, by - ay, bz - az)
  const bc = Math.hypot(cx - bx, cy - by, cz - bz)
  const ca = Math.hypot(ax - cx, ay - cy, az - cz)
  const longest = Math.max(ab, bc, ca)
  if (longest > 16) {
    const mx = (ax + bx) / 2, my = (ay + by) / 2, mz = (az + bz) / 2
    const nx = (bx + cx) / 2, ny = (by + cy) / 2, nz = (bz + cz) / 2
    const px = (cx + ax) / 2, py = (cy + ay) / 2, pz = (cz + az) / 2
    seedTriangle(ax, ay, az, mx, my, mz, px, py, pz, n, ws)
    seedTriangle(mx, my, mz, bx, by, bz, nx, ny, nz, n, ws)
    seedTriangle(px, py, pz, nx, ny, nz, cx, cy, cz, n, ws)
    seedTriangle(mx, my, mz, nx, ny, nz, px, py, pz, n, ws)
    return
  }
  const steps = Math.max(1, Math.ceil(longest / SAMPLE))
  const inv = 1 / steps
  for (let i = 0; i <= steps; i++) {
    for (let j = 0; i + j <= steps; j++) {
      const u = i * inv, w = j * inv, s = 1 - u - w
      seedAt(s * ax + u * bx + w * cx, s * ay + u * by + w * cy, s * az + u * bz + w * cz, n, ws)
    }
  }
}

/** The thirteen neighbours that come before a point in the box's order —
 *  half of the twenty-six round it; the other half comes after. */
const BEFORE: readonly (readonly [number, number, number])[] = (() => {
  const out: [number, number, number][] = []
  for (let c = -1; c <= 1; c++) for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) {
    if (c < 0 || (c === 0 && (b < 0 || (b === 0 && a < 0)))) out.push([a, b, c])
  }
  return out
})()

/**
 * Each point's seed put right by its neighbours', in two sweeps through the
 * box — forward taking the seeds of the thirteen neighbours before it,
 * backward those of the thirteen after — so a seed nearer than the one the
 * transform picked is carried along as far as it is nearest (Danielsson's
 * propagation, from the transform's choice). The transform picks a point's
 * seed by its grid point's distance plus the seed's own offset from it
 * squared, which favours a seed whose offset points on away from the point,
 * and every point round it picks alike; this measures the true distance to
 * each. Only points the transform reached take part.
 */
function sweepSeeds(ws: TileScratch, n: number): void {
  const { src, sx, sy, sz } = ws
  const plane = n * n
  const steps = Int32Array.from(BEFORE.map(([a, b, c]) => a + n * b + plane * c))
  // The box's outermost layer keeps the transform's choice: it is halo,
  // and its neighbours would run off the box.
  // The X lines anything reached, and how far along them.
  const from = ws.lineFrom, to = ws.lineTo
  for (let line = 0; line < plane; line++) {
    const row = n * line
    let lo = n, hi = -1
    for (let a = 1; a < n - 1; a++) {
      if (src[row + a] >= 0) {
        if (lo === n) lo = a
        hi = a
      }
    }
    from[line] = lo
    to[line] = hi
  }
  for (let pass = 0; pass < 2; pass++) {
    const sign = pass === 0 ? 1 : -1
    for (let ci = 1; ci < n - 1; ci++) {
      const c = pass === 0 ? ci : n - 1 - ci
      for (let bi = 1; bi < n - 1; bi++) {
        const b = pass === 0 ? bi : n - 1 - bi
        const line = b + n * c
        if (to[line] < 0) continue
        const row = n * line
        const lo = from[line], hi = to[line]
        for (let ai = pass === 0 ? lo : n - 1 - hi; ai <= (pass === 0 ? hi : n - 1 - lo); ai++) {
          const a = pass === 0 ? ai : n - 1 - ai
          const k = row + a
          const own = src[k]
          if (own < 0) continue
          let dx = a - sx[own], dy = b - sy[own], dz = c - sz[own]
          let best = dx * dx + dy * dy + dz * dz
          let which = own
          for (let e = 0; e < 13; e++) {
            const s = src[k + sign * steps[e]]
            if (s < 0 || s === which) continue
            dx = a - sx[s]
            dy = b - sy[s]
            dz = c - sz[s]
            const d = dx * dx + dy * dy + dz * dz
            if (d < best) {
              best = d
              which = s
            }
          }
          src[k] = which
        }
      }
    }
  }
}

/** The squared distance `nearest` found, cells². */
const nearestD2 = new Float64Array(1)

/** The seed box point (a, b, c) holds, or −1 with none in reach; its
 *  squared distance in nearestD2. */
function nearest(ws: TileScratch, n: number, a: number, b: number, c: number): number {
  const s = ws.src[a + n * (b + n * c)]
  if (s < 0) {
    nearestD2[0] = Infinity
    return -1
  }
  const dx = a - ws.sx[s], dy = b - ws.sy[s], dz = c - ws.sz[s]
  nearestD2[0] = dx * dx + dy * dy + dz * dz
  return s
}

/** The nearest of the seeds box point (a, b, c) and its six neighbours
 *  hold, or −1 with none in reach; its squared distance in nearestD2. */
function nearestAround(ws: TileScratch, n: number, a: number, b: number, c: number): number {
  const { src, sx, sy, sz } = ws
  const at = a + n * (b + n * c)
  const own = src[at]
  if (own < 0) {
    nearestD2[0] = Infinity
    return -1
  }
  let dx = a - sx[own], dy = b - sy[own], dz = c - sz[own]
  let best = dx * dx + dy * dy + dz * dz
  let which = own
  const plane = n * n
  for (let e = 0; e < 6; e++) {
    let k: number
    if (e === 0) { if (a === 0) continue; k = at - 1 }
    else if (e === 1) { if (a === n - 1) continue; k = at + 1 }
    else if (e === 2) { if (b === 0) continue; k = at - n }
    else if (e === 3) { if (b === n - 1) continue; k = at + n }
    else if (e === 4) { if (c === 0) continue; k = at - plane }
    else { if (c === n - 1) continue; k = at + plane }
    const s = src[k]
    if (s < 0 || s === which) continue
    dx = a - sx[s]
    dy = b - sy[s]
    dz = c - sz[s]
    const d = dx * dx + dy * dy + dz * dz
    if (d < best) {
      best = d
      which = s
    }
  }
  nearestD2[0] = best
  return which
}

/** The distance from box point (a, b, c) to the nearest seed, cells —
 *  Infinity with none in reach. */
function nearestSeed(ws: TileScratch, n: number, a: number, b: number, c: number): number {
  nearest(ws, n, a, b, c)
  return Math.sqrt(nearestD2[0])
}

// ---- pass C: distance from the outside, the signed field ------------------------------------

/**
 * The second pass over a tile: the signed field Ψ at its core. `seeds` are
 * where the outside begins round it — box points (of a box with the halo
 * hF) on either side of its edge, each with the nearest point of the edge
 * to it, in box cells; `coreF` says which core points are outside; `band`
 * the distance to the part of the free ones within reach (pass A's).
 */
export function tilePassC(
  plan: WrapPlan,
  seeds: { at: Uint32Array; foot: Float32Array },
  coreF: Uint8Array,
  bandIdx: Uint32Array,
  bandDS: Float32Array,
  ws: TileScratch,
): TilePsi {
  const T = TILE
  const H = plan.hF
  const n = T + 2 * H
  clearBox(ws, n)
  const { f, src, sx, sy, sz, occX } = ws
  for (let s = 0; s < seeds.at.length; s++) {
    const at = seeds.at[s]
    const a = at % n, b = ((at / n) | 0) % n, c = (at / (n * n)) | 0
    const x = seeds.foot[s * 3], y = seeds.foot[s * 3 + 1], z = seeds.foot[s * 3 + 2]
    const d = (x - a) * (x - a) + (y - b) * (y - b) + (z - c) * (z - c)
    if (d >= f[at]) continue
    f[at] = d
    src[at] = at
    sx[at] = x
    sy[at] = y
    sz[at] = z
    occX[b + n * c] = 1
  }
  if (seeds.at.length > 0) {
    featureTransform(f, src, n, plan.dmaxF * plan.dmaxF, occX, ws.feature)
    sweepSeeds(ws, n)
  }

  const idx = new Grow(new Uint32Array(4096))
  const psi = new Grow(new Float32Array(4096))
  let band = 0
  const rc = plan.rc
  const dmaxF = plan.dmaxF
  for (let k = 0; k < T; k++) {
    for (let j = 0; j < T; j++) {
      const base = T * (j + T * k)
      const boxBase = H + n * (j + H + n * (k + H))
      for (let i = 0; i < T; i++) {
        const p = base + i
        if (coreF[p]) {
          while (band < bandIdx.length && bandIdx[band] < p) band++
          if (band < bandIdx.length && bandIdx[band] === p) {
            idx.push(p)
            psi.push(bandDS[band] - rc)
          }
          continue
        }
        if (src[boxBase + i] < 0) continue
        const d = nearestSeed(ws, n, i + H, j + H, k + H)
        if (d > dmaxF) continue
        idx.push(p)
        psi.push(-d)
      }
    }
  }
  return { idx: idx.done(), psi: psi.done() }
}

// ---- the wrap's surface on a tile -----------------------------------------------------------

/** A level a point far outside or far inside stands at: past any the wrap
 *  is drawn at. */
export const FAR_OUT = 1e9

/** Each grid edge's vertex in a tile's march, by its lower point (of the
 *  (T + 1)³ box) and direction — kept from tile to tile, and cleared after
 *  each of the entries it set. */
let edgeVertex: Int32Array | null = null

/**
 * The wrap through a tile (I, J, K): marching cubes (CUBE_TRIANGLES) on its
 * cubes — those whose lowest corner is in its core — through `phi`, the
 * field less the wrap's level at the core and one more layer of points on
 * its +X, +Y and +Z sides ((T + 1)³, numbered as the core is with T + 1),
 * positive outside. `near` lists the points of it that are not just far,
 * round which the cubes the wrap can cross lie. Vertices on an edge in a
 * plane the tile shares with a neighbour carry their global key, so the two
 * make one.
 */
export function tileMarch(plan: WrapPlan, I: number, J: number, K: number, phi: Float32Array, near: Uint32Array): TileMesh {
  const T = TILE
  const m = T + 1
  const plane = m * m
  const need = new Uint8Array(T * T * T)
  for (let q = 0; q < near.length; q++) {
    const p = near[q]
    const a = p % m, b = ((p / m) | 0) % m, c = (p / plane) | 0
    for (let dc = -1; dc <= 0; dc++) {
      const z = c + dc
      if (z < 0 || z >= T) continue
      for (let db = -1; db <= 0; db++) {
        const y = b + db
        if (y < 0 || y >= T) continue
        for (let da = -1; da <= 0; da++) {
          const x = a + da
          if (x < 0 || x >= T) continue
          need[x + T * (y + T * z)] = 1
        }
      }
    }
  }
  if (!edgeVertex || edgeVertex.length !== plane * m * 3) edgeVertex = new Int32Array(plane * m * 3).fill(-1)
  const cache = edgeVertex
  const set = new Grow(new Uint32Array(1 << 12))
  const nx = plan.tx * T, ny = plan.ty * T
  const gx = I * T, gy = J * T, gz = K * T
  const h = plan.h
  const positions = new Grow(new Float32Array(1 << 12))
  const keys = new Grow(new Float64Array(1 << 12))
  const indices = new Grow(new Uint32Array(1 << 13))
  const corner = [0, 1, m, m + 1, plane, plane + 1, plane + m, plane + m + 1]
  const edgeFrom = CUBE_EDGE_FROM.map((c) => corner[c])
  const edgeStep = CUBE_EDGE_DIR.map((d) => (d === 1 ? 1 : d === 2 ? m : plane))
  const edgeAxis = CUBE_EDGE_DIR.map((d) => (d === 1 ? 0 : d === 2 ? 1 : 2))
  const vertexOn = (a: number, e: number): number => {
    const axis = edgeAxis[e]
    const slot = a * 3 + axis
    const known = cache[slot]
    if (known >= 0) return known
    const ai = a % m, aj = ((a / m) | 0) % m, ak = (a / plane) | 0
    const fa = offZero(phi[a])
    const fb = offZero(phi[a + edgeStep[e]])
    const s = Math.min(1, Math.max(0, fa / (fa - fb)))
    const id = positions.length / 3
    positions.push(plan.ox + (gx + ai + (axis === 0 ? s : 0)) * h)
    positions.push(plan.oy + (gy + aj + (axis === 1 ? s : 0)) * h)
    positions.push(plan.oz + (gz + ak + (axis === 2 ? s : 0)) * h)
    // On a plane shared with a neighbour: both ends on it.
    const shared = (axis !== 0 && (ai === 0 || ai === T)) || (axis !== 1 && (aj === 0 || aj === T)) || (axis !== 2 && (ak === 0 || ak === T))
    keys.push(shared ? (gx + ai + nx * (gy + aj + ny * (gz + ak))) * 8 + (1 << axis) : -1)
    cache[slot] = id
    set.push(slot)
    return id
  }
  for (let k = 0; k < T; k++) {
    for (let j = 0; j < T; j++) {
      for (let i = 0; i < T; i++) {
        if (!need[i + T * (j + T * k)]) continue
        const origin = i + m * (j + m * k)
        let c = 0
        for (let q = 0; q < 8; q++) if (phi[origin + corner[q]] > 0) c |= 1 << q
        if (c === 0 || c === 255) continue
        const tris = CUBE_TRIANGLES[c]
        for (let t = 0; t < tris.length; t++) {
          const e = tris[t]
          indices.push(vertexOn(origin + edgeFrom[e], e))
        }
      }
    }
  }
  for (let q = 0; q < set.length; q++) cache[set.data[q]] = -1
  return { positions: positions.done(), keys: keys.done(), indices: indices.done() }
}

/** The field kept off zero by a thousandth of a cell, on the side it is
 *  counted on: where it is zero at a grid point, every edge from that point
 *  would put its vertex on it, several vertices in one place. */
function offZero(x: number): number {
  return x > 0 ? Math.max(x, 1e-3) : Math.min(x, -1e-3)
}

// ---- snapping onto the part -------------------------------------------------------------------

/** closestOnTriangle's mark for a point inside the triangle. */
const FACE = 6

/**
 * The nearest point of the part to each of `vertices` — wrap vertices in
 * the tile (I, J, K), three floats each, with their normals — within
 * `reach` cells, among the triangles that lie roughly along the wrap there:
 * whose normal is within `cosMin` of the vertex's either way, the part's
 * triangles facing either way. The point found for each and 1 where one
 * was; where that point is a corner or an edge of the part, the foot on its
 * triangle's plane as well, when that lies on the part too (`alt`, NaN
 * else); the unit normal of the triangle it was found on (`plane`); and
 * how far each vertex is from the part at all.
 *
 * A wrap grown by `offset`, mm, lies that far off the part where the ball
 * touched it, not on it: then each vertex goes to the nearest point of the
 * part moved `offset` out along the line from it to the vertex — on the
 * part grown, exactly, a face's plane moved out, an edge's round — when the
 * vertex is within `reach` of that and the line runs within `cosMin` of its
 * normal; and the distance given is from the part grown.
 *
 * The triangles are sorted into a grid of their own size, and each vertex
 * looks through it ring by ring outward from its own grid cell, stopping
 * once no triangle further out could be nearer: a scan's triangles are many
 * times finer than the wrap's cell, and the reach holds hundreds of them.
 */
export function tileSnap(
  plan: WrapPlan,
  I: number,
  J: number,
  K: number,
  tri: Float32Array,
  vertices: Float32Array,
  normals: Float32Array,
  reach: number,
  cosMin: number,
  offset = 0,
): { to: Float32Array; alt: Float32Array; found: Uint8Array; distance: Float32Array; plane: Float32Array } {
  const T = TILE
  const h = plan.h
  const r = reach * h + offset
  let triCount = tri.length / 9
  const nv = vertices.length / 3
  const to = new Float32Array(nv * 3)
  const alt = new Float32Array(nv * 3).fill(NaN)
  const found = new Uint8Array(nv)
  const distance = new Float32Array(nv).fill(Infinity)
  const plane = new Float32Array(nv * 3)
  if (triCount === 0) return { to, alt, found, distance, plane }

  // Only the triangles within reach of a vertex: a tile can hold far more
  // than its vertices need — an inside full of struts beside an outer
  // wall, or a few points to look up.
  {
    const x0 = plan.ox + (I * T - 2) * h - r, y0 = plan.oy + (J * T - 2) * h - r, z0 = plan.oz + (K * T - 2) * h - r
    const nw = Math.ceil(((T + 4) * h + 2 * r) / r) + 1
    if (nw * nw * nw <= 1 << 22) {
      const cw = (x: number, o: number) => Math.min(nw - 1, Math.max(0, Math.floor((x - o) / r)))
      const marked = new Uint8Array(nw * nw * nw)
      for (let v = 0; v < nv; v++) {
        const a = cw(vertices[v * 3], x0), b = cw(vertices[v * 3 + 1], y0), c = cw(vertices[v * 3 + 2], z0)
        for (let k = Math.max(0, c - 1); k <= Math.min(nw - 1, c + 1); k++)
          for (let j = Math.max(0, b - 1); j <= Math.min(nw - 1, b + 1); j++)
            for (let i = Math.max(0, a - 1); i <= Math.min(nw - 1, a + 1); i++) marked[i + nw * (j + nw * k)] = 1
      }
      const keep = new Uint8Array(triCount)
      let kept = 0
      for (let t = 0; t < triCount; t++) {
        const o = t * 9
        const a0 = cw(Math.min(tri[o], tri[o + 3], tri[o + 6]), x0), a1 = cw(Math.max(tri[o], tri[o + 3], tri[o + 6]), x0)
        const b0 = cw(Math.min(tri[o + 1], tri[o + 4], tri[o + 7]), y0), b1 = cw(Math.max(tri[o + 1], tri[o + 4], tri[o + 7]), y0)
        const c0 = cw(Math.min(tri[o + 2], tri[o + 5], tri[o + 8]), z0), c1 = cw(Math.max(tri[o + 2], tri[o + 5], tri[o + 8]), z0)
        let hit = false
        for (let k = c0; k <= c1 && !hit; k++)
          for (let j = b0; j <= b1 && !hit; j++)
            for (let i = a0; i <= a1 && !hit; i++) if (marked[i + nw * (j + nw * k)]) hit = true
        if (hit) {
          keep[t] = 1
          kept++
        }
      }
      if (kept < triCount) {
        const fewer = new Float32Array(kept * 9)
        let e = 0
        for (let t = 0; t < triCount; t++) if (keep[t]) fewer.set(tri.subarray(t * 9, t * 9 + 9), 9 * e++)
        tri = fewer
        triCount = kept
        if (triCount === 0) return { to, alt, found, distance, plane }
      }
    }
  }

  // The grid: about the triangles' own size, but no finer than a third of
  // the reach, which a search then crosses in three rings, and no coarser
  // than the reach.
  let edges = 0
  for (let t = 0; t < triCount; t++) {
    const o = t * 9
    edges += Math.hypot(tri[o + 3] - tri[o], tri[o + 4] - tri[o + 1], tri[o + 5] - tri[o + 2])
  }
  const g = Math.min(r, Math.max(r / 3, (1.5 * edges) / triCount))
  const x0 = plan.ox + (I * T - 2) * h - r, y0 = plan.oy + (J * T - 2) * h - r, z0 = plan.oz + (K * T - 2) * h - r
  const span = (T + 4) * h + 2 * r
  const nc = Math.max(1, Math.ceil(span / g))
  const cellKey = (a: number, b: number, c: number) => a + nc * (b + nc * c)
  // Each triangle under every grid cell its box covers, within the tile and
  // the reach round it: a sparse grid, by sorted keys — the cell's key and
  // the triangle's number in one number each.
  const pairs = new Grow(new Float64Array(Math.max(16, triCount * 2)))
  const TRI = 2 ** 31
  const clampCell = (x: number) => (x < 0 ? 0 : x >= nc ? nc - 1 : x)
  for (let t = 0; t < triCount; t++) {
    const o = t * 9
    const ax = Math.min(tri[o], tri[o + 3], tri[o + 6]), bx = Math.max(tri[o], tri[o + 3], tri[o + 6])
    const ay = Math.min(tri[o + 1], tri[o + 4], tri[o + 7]), by = Math.max(tri[o + 1], tri[o + 4], tri[o + 7])
    const az = Math.min(tri[o + 2], tri[o + 5], tri[o + 8]), bz = Math.max(tri[o + 2], tri[o + 5], tri[o + 8])
    if (bx < x0 || by < y0 || bz < z0 || ax > x0 + span || ay > y0 + span || az > z0 + span) continue
    const i0 = clampCell(Math.floor((ax - x0) / g)), i1 = clampCell(Math.floor((bx - x0) / g))
    const j0 = clampCell(Math.floor((ay - y0) / g)), j1 = clampCell(Math.floor((by - y0) / g))
    const k0 = clampCell(Math.floor((az - z0) / g)), k1 = clampCell(Math.floor((bz - z0) / g))
    for (let c = k0; c <= k1; c++) {
      for (let b = j0; b <= j1; b++) {
        for (let a = i0; a <= i1; a++) {
          pairs.push(cellKey(a, b, c) * TRI + t)
        }
      }
    }
  }
  const sorted = pairs.done().sort()
  const list = new Uint32Array(sorted.length)
  // Each cell's run of triangles in `list`.
  const runs = new Map<number, number>()
  const runEnd: number[] = []
  for (let e = 0; e < sorted.length; e++) {
    const key = Math.floor(sorted[e] / TRI)
    list[e] = sorted[e] - key * TRI
    if (e === 0 || Math.floor(sorted[e - 1] / TRI) !== key) {
      runs.set(key, runEnd.length)
      runEnd.push(e, e + 1)
    } else runEnd[runEnd.length - 1] = e + 1
  }

  // Each triangle's unit normal, or zero for one with no area.
  const tn = new Float32Array(triCount * 3)
  for (let t = 0; t < triCount; t++) {
    const o = t * 9
    const ux = tri[o + 3] - tri[o], uy = tri[o + 4] - tri[o + 1], uz = tri[o + 5] - tri[o + 2]
    const vx = tri[o + 6] - tri[o], vy = tri[o + 7] - tri[o + 1], vz = tri[o + 8] - tri[o + 2]
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx
    const len = Math.hypot(cx, cy, cz)
    if (len > 0) {
      tn[t * 3] = cx / len
      tn[t * 3 + 1] = cy / len
      tn[t * 3 + 2] = cz / len
    }
  }

  const seen = new Int32Array(triCount).fill(-1)
  let stamp = 0
  const out = new Float64Array(4)
  const maxRing = Math.ceil(r / g)
  /**
   * Look through the triangles round (x, y, z) ring by ring out to `limit`,
   * calling `visit` with each once — skipping every cell further off than
   * `bound()`, squared, says could matter, and stopping once a whole ring
   * is.
   */
  const search = (x: number, y: number, z: number, limit: number, visit: (t: number) => void, bound: () => number) => {
    stamp++
    const ca = Math.floor((x - x0) / g), cb = Math.floor((y - y0) / g), cc = Math.floor((z - z0) / g)
    const rings = Math.min(maxRing, Math.ceil(limit / g))
    // How far (x, y, z) is from cell a along one axis, squared.
    const gap1 = (p: number, o: number, a: number) => {
      const lo = o + a * g
      const d = p < lo ? lo - p : p > lo + g ? p - lo - g : 0
      return d * d
    }
    for (let ring = 0; ring <= rings; ring++) {
      // Every cell of this ring is at least a ring less one cell off.
      const near = Math.max(0, ring - 1) * g
      if (near * near >= bound()) return
      for (let c = cc - ring; c <= cc + ring; c++) {
        if (c < 0 || c >= nc) continue
        const onC = c === cc - ring || c === cc + ring
        for (let b = cb - ring; b <= cb + ring; b++) {
          if (b < 0 || b >= nc) continue
          const onB = onC || b === cb - ring || b === cb + ring
          // On the ring's faces every cell; inside them only its two ends.
          const step = onB || ring === 0 ? 1 : 2 * ring
          const off = gap1(z, z0, c) + gap1(y, y0, b)
          for (let a = ca - ring; a <= ca + ring; a += step) {
            if (a < 0 || a >= nc) continue
            if (off + gap1(x, x0, a) >= bound()) continue
            const run = runs.get(cellKey(a, b, c))
            if (run === undefined) continue
            for (let e = runEnd[run]; e < runEnd[run + 1]; e++) {
              const t = list[e]
              if (seen[t] === stamp) continue
              seen[t] = stamp
              visit(t)
            }
          }
        }
      }
    }
  }

  const flat = 0.01 * h
  const bridgeReach = (0.6 * h) ** 2
  for (let v = 0; v < nv; v++) {
    const x = vertices[v * 3], y = vertices[v * 3 + 1], z = vertices[v * 3 + 2]
    const vnx = normals[v * 3], vny = normals[v * 3 + 1], vnz = normals[v * 3 + 2]
    if (offset > 0) {
      // Onto the part grown: the nearest point of the part at all, then out.
      let near = r * r
      let fx = 0, fy = 0, fz = 0
      search(
        x, y, z, r,
        (t) => {
          const o = t * 9
          closestOnTriangle(x, y, z, tri[o], tri[o + 1], tri[o + 2], tri[o + 3], tri[o + 4], tri[o + 5], tri[o + 6], tri[o + 7], tri[o + 8], out)
          const d2 = (out[0] - x) ** 2 + (out[1] - y) ** 2 + (out[2] - z) ** 2
          if (d2 >= near) return
          near = d2
          fx = out[0]
          fy = out[1]
          fz = out[2]
        },
        () => near,
      )
      const d = Math.sqrt(near)
      if (d >= r || d === 0) continue
      distance[v] = d - offset
      const ux = (x - fx) / d, uy = (y - fy) / d, uz = (z - fz) / d
      if (Math.abs(d - offset) > reach * h || Math.abs(ux * vnx + uy * vny + uz * vnz) < cosMin) continue
      to[v * 3] = fx + offset * ux
      to[v * 3 + 1] = fy + offset * uy
      to[v * 3 + 2] = fz + offset * uz
      found[v] = 1
      continue
    }
    let best = r * r
    let anyNear = Infinity
    let bestTri = -1
    let onFace = true
    search(
      x, y, z, r,
      (t) => {
        const o = t * 9
        closestOnTriangle(x, y, z, tri[o], tri[o + 1], tri[o + 2], tri[o + 3], tri[o + 4], tri[o + 5], tri[o + 6], tri[o + 7], tri[o + 8], out)
        const dx = out[0] - x, dy = out[1] - y, dz = out[2] - z
        const d2 = dx * dx + dy * dy + dz * dz
        if (d2 < anyNear) anyNear = d2
        if (d2 >= best) return
        const dot = tn[t * 3] * vnx + tn[t * 3 + 1] * vny + tn[t * 3 + 2] * vnz
        if (Math.abs(dot) < cosMin) return
        best = d2
        bestTri = t
        onFace = out[3] === FACE
        to[v * 3] = out[0]
        to[v * 3 + 1] = out[1]
        to[v * 3 + 2] = out[2]
        found[v] = 1
      },
      // Past the nearest found that qualifies, and past the nearest at all
      // — needed only to tell a bridge, half a cell off, from the rest.
      () => Math.max(best, Math.min(anyNear, bridgeReach)),
    )
    distance[v] = Math.sqrt(anyNear)
    if (found[v]) {
      plane[v * 3] = tn[bestTri * 3]
      plane[v * 3 + 1] = tn[bestTri * 3 + 1]
      plane[v * 3 + 2] = tn[bestTri * 3 + 2]
    }
    // Nearest to a corner or an edge of the part, where the vertices round
    // it all come to the same point: the foot on the triangle's plane as
    // well, where that lies on the part too — a corner hardly a corner.
    if (found[v] && !onFace) {
      const o = bestTri * 9
      const k = (x - tri[o]) * tn[bestTri * 3] + (y - tri[o + 1]) * tn[bestTri * 3 + 1] + (z - tri[o + 2]) * tn[bestTri * 3 + 2]
      const fx = x - k * tn[bestTri * 3], fy = y - k * tn[bestTri * 3 + 1], fz = z - k * tn[bestTri * 3 + 2]
      let near = Infinity
      search(
        fx, fy, fz, flat,
        (t) => {
          const p = t * 9
          closestOnTriangle(fx, fy, fz, tri[p], tri[p + 1], tri[p + 2], tri[p + 3], tri[p + 4], tri[p + 5], tri[p + 6], tri[p + 7], tri[p + 8], out)
          near = Math.min(near, Math.hypot(out[0] - fx, out[1] - fy, out[2] - fz))
        },
        () => Math.min(near * near, flat * flat * 1.0001),
      )
      if (near <= flat) {
        alt[v * 3] = fx
        alt[v * 3 + 1] = fy
        alt[v * 3 + 2] = fz
      }
    }
  }
  return { to, alt, found, distance, plane }
}
