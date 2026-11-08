// SPDX-License-Identifier: AGPL-3.0-only
// A height map read further: the relief left when the surface round each
// cell is taken off it — icons, grooves, embossed lettering standing out of
// a face that curves or leans — and the heights it holds gathered into levels, a
// pad's tiers or a pocket's floors, each with how much of the map it covers,
// the cells on a slope (a fillet's ramp between tiers) left out first.
// A grid here is row by row, row 0 at the low v, NaN where there is nothing.

import { solveLinear } from '../fit/linalg'

/** The grid's sums under a separable kernel, one along u and one along v:
 *  Σ ku(i)·kv(j)·values over the cells round each, with the empty cells
 *  counting nothing. */
function convolve(values: Float64Array, cols: number, rows: number, ku: Float64Array, kv: Float64Array): Float64Array {
  const reach = (ku.length - 1) / 2
  const along = new Float64Array(values.length)
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let s = 0
      for (let i = Math.max(-reach, -c); i <= Math.min(reach, cols - 1 - c); i++) s += ku[i + reach] * values[r * cols + c + i]
      along[r * cols + c] = s
    }
  }
  const out = new Float64Array(values.length)
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let s = 0
      for (let j = Math.max(-reach, -r); j <= Math.min(reach, rows - 1 - r); j++) s += kv[j + reach] * along[(r + j) * cols + c]
      out[r * cols + c] = s
    }
  }
  return out
}

/** The height less the surface round it: at each cell a plane fitted to
 *  its neighbours by least squares, each weighed by a Gaussian of `sigma`
 *  cells, the empty ones left out — so what stands proud of the surface
 *  (positive) or sinks into it (negative) at about that width stands out,
 *  and a lean, even at the edge of what was hit, leaves nothing. Where the
 *  neighbours give no plane (a line of cells, a cell alone) their mean
 *  stands in for it. */
export function reliefGrid(values: Float32Array, cols: number, rows: number, sigma: number): Float32Array {
  const reach = Math.max(1, Math.ceil(3 * sigma))
  const k0 = new Float64Array(2 * reach + 1)
  const k1 = new Float64Array(2 * reach + 1)
  const k2 = new Float64Array(2 * reach + 1)
  for (let i = -reach; i <= reach; i++) {
    const g = Math.exp(-(i * i) / (2 * sigma * sigma))
    k0[i + reach] = g
    k1[i + reach] = i * g
    k2[i + reach] = i * i * g
  }
  const n = cols * rows
  const mask = new Float64Array(n)
  const h = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(values[i])) continue
    mask[i] = 1
    h[i] = values[i]
  }
  // The weighed moments of the neighbours' places (x along u, y along v,
  // in cells from the one fitted) and of their heights.
  const s00 = convolve(mask, cols, rows, k0, k0)
  const s10 = convolve(mask, cols, rows, k1, k0)
  const s01 = convolve(mask, cols, rows, k0, k1)
  const s20 = convolve(mask, cols, rows, k2, k0)
  const s11 = convolve(mask, cols, rows, k1, k1)
  const s02 = convolve(mask, cols, rows, k0, k2)
  const h00 = convolve(h, cols, rows, k0, k0)
  const h10 = convolve(h, cols, rows, k1, k0)
  const h01 = convolve(h, cols, rows, k0, k1)
  const out = new Float32Array(n).fill(Number.NaN)
  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue
    // [s00 s10 s01; s10 s20 s11; s01 s11 s02]·[a, b, c] = [h00, h10, h01],
    // a the fitted plane's height at the cell — by Cramer's rule.
    const A = s00[i], B = s10[i], C = s01[i], D = s20[i], E = s11[i], F = s02[i]
    const det = A * (D * F - E * E) - B * (B * F - E * C) + C * (B * E - D * C)
    const scale = A * D * F
    const a =
      scale > 0 && Math.abs(det) > 1e-9 * scale
        ? (h00[i] * (D * F - E * E) - B * (h10[i] * F - E * h01[i]) + C * (h10[i] * E - D * h01[i])) / det
        : h00[i] / A
    out[i] = values[i] - a
  }
  return out
}

/** How much a cell's value wanders from its neighbour's on the same
 *  surface, mm: the median step between cells side by side, as a standard
 *  deviation (×1.4826 for a median, ÷√2 for a difference of two). A step
 *  between surfaces is a few cells in many, and the median passes it by. */
export function cellNoise(values: Float32Array, cols: number, rows: number): number {
  const steps: number[] = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const v = values[r * cols + c]
      if (Number.isNaN(v)) continue
      if (c + 1 < cols && !Number.isNaN(values[r * cols + c + 1])) steps.push(Math.abs(values[r * cols + c + 1] - v))
      if (r + 1 < rows && !Number.isNaN(values[(r + 1) * cols + c])) steps.push(Math.abs(values[(r + 1) * cols + c] - v))
    }
  }
  if (steps.length === 0) return 0
  steps.sort((a, b) => a - b)
  return (1.4826 * steps[Math.floor(steps.length / 2)]) / Math.SQRT2
}

/** Which cells lie on a slope steeper than `maxDeg`: a fillet's ramp
 *  between two tiers, a cone, a wall met at a glance. Along each way the
 *  slope is the gentler of the steps to the neighbours either side — so a
 *  cell on the edge of a flat face, its one neighbour across a step, still
 *  counts as flat, while a cell on a ramp, rising to both neighbours, does
 *  not. A cell with no neighbour along a way counts as level along it. */
export function slopedCells(values: Float32Array, cols: number, rows: number, cell: number, maxDeg: number): Uint8Array {
  const out = new Uint8Array(values.length)
  const limit = Math.tan((maxDeg * Math.PI) / 180) * cell
  const gentler = (v: number, a: number, b: number) => {
    const da = Number.isNaN(a) ? Infinity : Math.abs(a - v)
    const db = Number.isNaN(b) ? Infinity : Math.abs(b - v)
    const d = Math.min(da, db)
    return d === Infinity ? 0 : d
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c
      const v = values[i]
      if (Number.isNaN(v)) continue
      const du = gentler(v, c > 0 ? values[i - 1] : Number.NaN, c + 1 < cols ? values[i + 1] : Number.NaN)
      const dv = gentler(v, r > 0 ? values[i - cols] : Number.NaN, r + 1 < rows ? values[i + cols] : Number.NaN)
      if (Math.hypot(du, dv) > limit) out[i] = 1
    }
  }
  return out
}

export interface HeightLevel {
  /** The level's median value. */
  height: number
  /** Its spread: the standard deviation of its cells about their mean. */
  sigma: number
  /** Its lowest and highest cell. */
  range: [number, number]
  cells: number
  /** cells × cell², mm². */
  area: number
  /** Of the cells with a value, how many are this level's. */
  share: number
  /** The grid box round its cells, [u, v] mm. */
  box: { min: [number, number]; max: [number, number] }
  /** The plane fitted to its cells' heights as read (a warp taken out of
   *  the values or not): where it stands over the middle of its cells,
   *  [u, v, height] mm, and how much it rises per mm along u and along v. */
  plane: { at: [number, number, number]; slope: [number, number] }
}

export interface LevelsResult {
  levels: HeightLevel[]
  /** The bin the values were counted in, mm — also the least gap between
   *  two levels. */
  gap: number
  /** The cells with a value that fall in no level — walls, edges, spray. */
  unassigned: number
}

/** The values a grid holds, gathered into levels: counted in bins `gap`
 *  wide, a level is a run of bins that each hold at least a two-hundredth
 *  of the cells (three at least) — a flat face fills a bin or two, a lean
 *  a run of them, and the few cells on a wall between two faces leave the
 *  bins between them thin, so the two stay apart. Each cell then joins the
 *  run its value lies in, or one a bin either side of it. Largest first.
 *  Each level's plane is fitted to `raw` — the heights as read, where the
 *  values have had a warp taken out — or to the values themselves. */
export function heightLevels(
  values: Float32Array,
  grid: { cols: number; cell: number; u0: number; v0: number },
  gap: number,
  raw: Float32Array = values,
): LevelsResult {
  let lo = Infinity
  let hi = -Infinity
  let count = 0
  for (const v of values) {
    if (Number.isNaN(v)) continue
    count++
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  if (count === 0) return { levels: [], gap, unassigned: 0 }
  // A gap too fine for the spread would want more bins than there are cells.
  let w = Math.max(gap, 1e-6)
  while ((hi - lo) / w > 4 * count + 100) w *= 2
  const bins = Math.floor((hi - lo) / w) + 1
  const counts = new Uint32Array(bins)
  const binOf = (v: number) => Math.min(bins - 1, Math.floor((v - lo) / w))
  for (const v of values) if (!Number.isNaN(v)) counts[binOf(v)]++
  const dense = Math.max(3, Math.ceil(count / 200))
  const runs: [number, number][] = []
  for (let b = 0; b < bins; b++) {
    if (counts[b] < dense) continue
    const last = runs[runs.length - 1]
    if (last && last[1] === b - 1) last[1] = b
    else runs.push([b, b])
  }
  // Each bin to the run it belongs to: its own, or the nearer one a bin
  // away.
  const core = new Int32Array(bins).fill(-1)
  runs.forEach(([a, b], k) => {
    for (let i = a; i <= b; i++) core[i] = k
  })
  const runOf = core.slice()
  for (let b = 0; b < bins; b++) {
    if (core[b] >= 0) continue
    const below = b > 0 ? core[b - 1] : -1
    const above = b + 1 < bins ? core[b + 1] : -1
    if (below >= 0 && above >= 0) runOf[b] = counts[b - 1] >= counts[b + 1] ? below : above
    else runOf[b] = below >= 0 ? below : above
  }
  const members: number[][] = runs.map(() => [])
  let unassigned = 0
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (Number.isNaN(v)) continue
    const k = runOf[binOf(v)]
    if (k < 0) unassigned++
    else members[k].push(i)
  }
  const { cols, cell, u0, v0 } = grid
  const levels: HeightLevel[] = members
    .filter((m) => m.length > 0)
    .map((m) => {
      const vs = m.map((i) => values[i]).sort((a, b) => a - b)
      const mean = vs.reduce((s, v) => s + v, 0) / vs.length
      const sigma = Math.sqrt(vs.reduce((s, v) => s + (v - mean) * (v - mean), 0) / vs.length)
      let c0 = Infinity, c1 = -Infinity, r0 = Infinity, r1 = -Infinity
      for (const i of m) {
        const c = i % cols
        const r = (i - c) / cols
        c0 = Math.min(c0, c); c1 = Math.max(c1, c)
        r0 = Math.min(r0, r); r1 = Math.max(r1, r)
      }
      const plane = planeOverCells(raw, m, grid)
      return {
        height: vs[Math.floor(vs.length / 2)],
        sigma,
        range: [vs[0], vs[vs.length - 1]] as [number, number],
        cells: m.length,
        area: m.length * cell * cell,
        share: m.length / count,
        box: { min: [u0 + c0 * cell, v0 + r0 * cell] as [number, number], max: [u0 + (c1 + 1) * cell, v0 + (r1 + 1) * cell] as [number, number] },
        plane,
      }
    })
  levels.sort((a, b) => b.cells - a.cells)
  return { levels, gap: w, unassigned }
}

/** The plane h = a + b·(u − ū) + c·(v − v̄) through the given cells'
 *  heights by least squares, ū, v̄ the middle of the cells. Level along a
 *  way the cells do not spread (a single row or column, a cell alone). */
function planeOverCells(
  heights: Float32Array,
  cells: readonly number[],
  { cols, cell, u0, v0 }: { cols: number; cell: number; u0: number; v0: number },
): HeightLevel['plane'] {
  let n = 0, su = 0, sv = 0, sh = 0
  for (const i of cells) {
    const h = heights[i]
    if (Number.isNaN(h)) continue
    const c = i % cols
    n++
    su += u0 + (c + 0.5) * cell
    sv += v0 + ((i - c) / cols + 0.5) * cell
    sh += h
  }
  if (n === 0) return { at: [u0, v0, 0], slope: [0, 0] }
  const [mu, mv, mh] = [su / n, sv / n, sh / n]
  let uu = 0, uv = 0, vv = 0, uh = 0, vh = 0
  for (const i of cells) {
    const h = heights[i]
    if (Number.isNaN(h)) continue
    const c = i % cols
    const du = u0 + (c + 0.5) * cell - mu
    const dv = v0 + ((i - c) / cols + 0.5) * cell - mv
    uu += du * du; uv += du * dv; vv += dv * dv
    uh += du * (h - mh); vh += dv * (h - mh)
  }
  const det = uu * vv - uv * uv
  if (det > 1e-9 * uu * vv) return { at: [mu, mv, mh], slope: [(uh * vv - vh * uv) / det, (vh * uu - uh * uv) / det] }
  // A row or a column: the slope along it alone.
  return { at: [mu, mv, mh], slope: uu >= vv ? [uu > 0 ? uh / uu : 0, 0] : [0, vh / vv] }
}

/** A warp taken out of a height map before its levels were gathered. */
export interface Warp {
  /** The surface's highest less its lowest over the cells counted, mm — a
   *  lean counts too. */
  rise: number
  /** How far it bends away from the plane that fits it best, highest less
   *  lowest, mm. */
  bow: number
  /** The height it was put back at: its median over the cells counted. */
  base: number
  /** The values with the surface taken out and `base` put back, NaN where
   *  they are — what the levels were gathered from. */
  flat: Float32Array
}

/** The steepest a surface taken out of a height map may lean anywhere over
 *  it, degrees: a sheet's warp, a part not yet levelled — not a dome. */
const WARP_MAX_DEG = 5
/** The share of the map a level must hold to count as a level when the
 *  levels with a warp taken out are weighed against those without. */
const WARP_LEVEL_SHARE = 0.05
/** The least cells a warp surface is fitted to. */
const WARP_LEAST_CELLS = 30

/** The quadratic surface h = k·[1, x, y, x², xy, y²] through the given
 *  cells by least squares (x, y the cell's place scaled to −1…1 across the
 *  grid), or, with `terms` 3, the plane k·[1, x, y]. Null when the cells
 *  do not hold it. */
function polyFit(heights: ArrayLike<number>, cells: readonly number[], cols: number, rows: number, terms: 3 | 6): Float64Array | null {
  const a = new Float64Array(terms * terms)
  const b = new Float64Array(terms)
  const t = new Float64Array(6)
  for (const i of cells) {
    polyTerms(i, cols, rows, t)
    const h = heights[i]
    for (let p = 0; p < terms; p++) {
      b[p] += t[p] * h
      for (let q = 0; q < terms; q++) a[p * terms + q] += t[p] * t[q]
    }
  }
  return cells.length >= 2 * terms ? solveLinear(terms, a, b) : null
}

function polyTerms(i: number, cols: number, rows: number, t: Float64Array): void {
  const c = i % cols
  const x = (c + 0.5 - cols / 2) / (cols / 2)
  const y = ((i - c) / cols + 0.5 - rows / 2) / (rows / 2)
  t[0] = 1; t[1] = x; t[2] = y; t[3] = x * x; t[4] = x * y; t[5] = y * y
}

const median = (xs: number[]): number => {
  const s = xs.slice().sort((p, q) => p - q)
  return s[Math.floor(s.length / 2)]
}

/**
 * A height map's levels, read through a warp: gathered as the values are,
 * and again with a smooth surface taken out — a quadratic fitted to the
 * largest level's cells, the cells off it by more than 2.5 times their
 * spread (or `gap`) dropped and the fit made again till it settles, so the
 * surface follows the larger of two levels a warp has run together and not
 * their mean. The second reading is kept when it holds more levels of a
 * twentieth of the map or more than the first: a stamped sheet's bead
 * crowns apart from the sheet, a warped plate's two steps. A surface that
 * leans past WARP_MAX_DEG anywhere is no warp, and one that rises less
 * than `gap` changes nothing; either way the levels are the first reading.
 *
 * `counted` are the values the levels are gathered from (sloped cells NaN),
 * `all` every value — flattened too, for the ramps beside the levels.
 */
export function levelsThroughWarp(
  counted: Float32Array,
  all: Float32Array,
  grid: { cols: number; rows: number; cell: number; u0: number; v0: number },
  gap: number,
): LevelsResult & { warp?: Warp } {
  const plain = heightLevels(counted, grid, gap)
  const top = plain.levels[0]
  if (!top) return plain
  const { cols, rows, cell } = grid
  const start: number[] = []
  const valued: number[] = []
  for (let i = 0; i < counted.length; i++) {
    const v = counted[i]
    if (Number.isNaN(v)) continue
    valued.push(i)
    if (v >= top.range[0] && v <= top.range[1]) start.push(i)
  }
  if (start.length < WARP_LEAST_CELLS) return plain
  // Fit, drop the cells far off it, fit again — till the cells kept stay.
  const t = new Float64Array(6)
  const at = (k: Float64Array, i: number) => {
    polyTerms(i, cols, rows, t)
    let s = 0
    for (let p = 0; p < k.length; p++) s += k[p] * t[p]
    return s
  }
  let use = start
  let k = polyFit(counted, use, cols, rows, 6)
  for (let pass = 0; pass < 10 && k; pass++) {
    const res = start.map((i) => counted[i] - at(k!, i))
    const mid = median(res)
    const spread = 1.4826 * median(res.map((r) => Math.abs(r - mid)))
    const keep = Math.max(2.5 * spread, gap)
    const next = start.filter((_, j) => Math.abs(res[j] - mid) <= keep)
    if (next.length < WARP_LEAST_CELLS) break
    if (next.length === use.length) break
    use = next
    k = polyFit(counted, use, cols, rows, 6)
  }
  if (!k) return plain
  // How it leans: x, y run −1…1 over cols·cell, rows·cell.
  const perU = 2 / (cols * cell)
  const perV = 2 / (rows * cell)
  const surface = new Float64Array(counted.length)
  for (let i = 0; i < surface.length; i++) surface[i] = at(k, i)
  let lo = Infinity, hi = -Infinity, steepest = 0
  for (const i of valued) {
    lo = Math.min(lo, surface[i])
    hi = Math.max(hi, surface[i])
    polyTerms(i, cols, rows, t)
    const gu = (k[1] + 2 * k[3] * t[1] + k[4] * t[2]) * perU
    const gv = (k[2] + k[4] * t[1] + 2 * k[5] * t[2]) * perV
    steepest = Math.max(steepest, Math.hypot(gu, gv))
  }
  if (hi - lo < gap || steepest > Math.tan((WARP_MAX_DEG * Math.PI) / 180)) return plain
  const base = median(valued.map((i) => surface[i]))
  const flatten = (v: Float32Array) => v.map((x, i) => (Number.isNaN(x) ? x : x - surface[i] + base))
  const warped = heightLevels(flatten(counted), grid, gap, counted)
  const substantial = (r: LevelsResult) => r.levels.filter((l) => l.share >= WARP_LEVEL_SHARE).length
  if (substantial(warped) <= substantial(plain)) return plain
  // The bend: the surface less the plane through it.
  const p = polyFit(surface, valued, cols, rows, 3)
  let blo = Infinity, bhi = -Infinity
  if (p) {
    for (const i of valued) {
      polyTerms(i, cols, rows, t)
      const r = surface[i] - (p[0] + p[1] * t[1] + p[2] * t[2])
      blo = Math.min(blo, r)
      bhi = Math.max(bhi, r)
    }
  }
  return { ...warped, warp: { rise: hi - lo, bow: p ? bhi - blo : hi - lo, base, flat: flatten(all) } }
}

/** A run of sloped cells touching each other: its cells, the grid box
 *  round them, [u, v] mm, and the heights of the lowest and the highest
 *  level it borders — two for a ramp between tiers (the gentle ends of a
 *  rounded ramp may read as thin levels of their own; they lie between),
 *  one for a ramp off a tier that leads to none. */
export interface Ramp {
  cells: number
  box: { min: [number, number]; max: [number, number] }
  joins: number[]
}

/** How much of the map is sloped, and the ramps it makes — the runs of
 *  sloped cells (`steep`, slopedCells) side by side, the smallest left out
 *  (under a two-hundredth of the cells with a value, eight at least) —
 *  largest first. A cell borders a level when its neighbour along u or v
 *  is a flat cell whose value lies in that level's range. */
export function rampsOf(
  values: Float32Array,
  steep: Uint8Array,
  grid: { cols: number; rows: number; cell: number; u0: number; v0: number },
  levels: readonly HeightLevel[],
): { sloped: number; valued: number; ramps: Ramp[] } {
  const { cols, rows, cell, u0, v0 } = grid
  let valued = 0
  let sloped = 0
  for (let i = 0; i < values.length; i++) {
    if (Number.isNaN(values[i])) continue
    valued++
    if (steep[i]) sloped++
  }
  const levelAt = (i: number): number => {
    const v = values[i]
    if (Number.isNaN(v) || steep[i]) return -1
    return levels.findIndex((l) => v >= l.range[0] && v <= l.range[1])
  }
  const least = Math.max(8, Math.ceil(valued / 200))
  const seen = new Uint8Array(values.length)
  const ramps: Ramp[] = []
  for (let start = 0; start < values.length; start++) {
    if (!steep[start] || seen[start] || Number.isNaN(values[start])) continue
    const stack = [start]
    seen[start] = 1
    let n = 0, c0 = Infinity, c1 = -Infinity, r0 = Infinity, r1 = -Infinity
    const borders = new Set<number>()
    while (stack.length > 0) {
      const i = stack.pop()!
      n++
      const c = i % cols
      const r = (i - c) / cols
      c0 = Math.min(c0, c); c1 = Math.max(c1, c)
      r0 = Math.min(r0, r); r1 = Math.max(r1, r)
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const cc = c + dc, rr = r + dr
        if (cc < 0 || cc >= cols || rr < 0 || rr >= rows) continue
        const j = rr * cols + cc
        if (steep[j] && !Number.isNaN(values[j])) {
          if (!seen[j]) {
            seen[j] = 1
            stack.push(j)
          }
        } else {
          const l = levelAt(j)
          if (l >= 0) borders.add(l)
        }
      }
    }
    if (n < least) continue
    ramps.push({
      cells: n,
      box: { min: [u0 + c0 * cell, v0 + r0 * cell], max: [u0 + (c1 + 1) * cell, v0 + (r1 + 1) * cell] },
      joins: [...new Set([Math.min(...[...borders].map((l) => levels[l].height)), Math.max(...[...borders].map((l) => levels[l].height))])].filter(Number.isFinite),
    })
  }
  ramps.sort((a, b) => b.cells - a.cells)
  return { sloped, valued, ramps }
}
