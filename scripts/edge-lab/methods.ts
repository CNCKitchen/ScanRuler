// SPDX-License-Identifier: AGPL-3.0-only
// The candidate detectors of the edge lab. Every method takes a grayscale
// image and the pixels-per-mm and returns subpixel chains in the production
// EdgeChains layout, so the bench can render, count and fit them all the same
// way. Nothing here is wired into the app — this is the test bed.
import type { EdgeChains } from '../../src/core/flat/edges'
import { detectEdges } from '../../src/core/flat/edges'
import { fitCircle2d } from '../../src/core/fit/circle2d'
import {
  autoThresholds, chainLength, edgesToPointChains, gaussianBlur, hysteresis, magQuantiles, nms, otsu,
  pixelChainsToEdges, pointChainsToEdges, refinePixel, sobel, traceChains, type Gradients, type Pt,
} from './core'

export interface MethodInput { gray: Uint8Array; width: number; height: number; pxPerMm: number }
export interface MethodResult { chains: EdgeChains; kinds?: ('line' | 'arc')[]; note?: string }
export type Method = (input: MethodInput) => MethodResult

/** The shortest stretch of edge worth calling a feature, mm. */
export const MIN_FEATURE_MM = 1.0

// ---- 1. baseline: the production detector ----------------------------------

export const canny: Method = ({ gray, width, height }) => ({
  chains: detectEdges(gray, width, height, { sensitivity: 0.5 }),
})

// ---- shared: the Canny front end taken apart -------------------------------

interface CannyStages { blurred: Float32Array; g: Gradients; low: number; high: number; kept: Uint8Array }

function cannyStages(gray: Uint8Array, width: number, height: number, sigma: number, sensitivity: number, mask?: Uint8Array): CannyStages {
  const blurred = gaussianBlur(gray, width, height, sigma)
  const g = sobel(blurred, width, height)
  const { low, high } = autoThresholds(g.mag, sensitivity)
  const mark = nms(g, low, high)
  if (mask) for (let i = 0; i < mark.length; i++) if (!mask[i]) mark[i] = 0
  const kept = hysteresis(mark, width, height)
  return { blurred, g, low, high, kept }
}

// ---- shared: chain post-processing -----------------------------------------

/** A chain with the statistics the filters judge it by. */
interface Chain { pts: Pt[]; meanMag: number; minMag: number }

function chainsOf(pixelChains: number[][], g: Gradients): Chain[] {
  return pixelChains.map((pc) => {
    let sum = 0, min = Infinity
    for (const p of pc) { sum += g.mag[p]; min = Math.min(min, g.mag[p]) }
    return { pts: pc.map((p) => refinePixel(p, g)), meanMag: sum / pc.length, minMag: min }
  })
}

function tangentAt(pts: Pt[], atEnd: boolean, span = 6): Pt {
  const n = pts.length
  const k = Math.min(span, n - 1)
  const a = atEnd ? pts[n - 1 - k] : pts[k]
  const b = atEnd ? pts[n - 1] : pts[0]
  const dx = b[0] - a[0], dy = b[1] - a[1]
  const l = Math.hypot(dx, dy) || 1
  return [dx / l, dy / l]
}

/** Bridge gaps: endpoints within `radius` px whose outgoing tangents point at
 *  each other are joined. Mutual-best matching, a few passes. */
export function bridgeGaps(chains: Chain[], radius: number, maxAngleDeg = 35): Chain[] {
  const cosMin = Math.cos((maxAngleDeg * Math.PI) / 180)
  let cur = chains.slice()
  for (let pass = 0; pass < 4; pass++) {
    type End = { c: number; end: boolean; p: Pt; t: Pt }
    const ends: End[] = []
    cur.forEach((ch, c) => {
      if (ch.pts.length < 3) return
      ends.push({ c, end: false, p: ch.pts[0], t: tangentAt(ch.pts, false) })
      ends.push({ c, end: true, p: ch.pts[ch.pts.length - 1], t: tangentAt(ch.pts, true) })
    })
    const cell = Math.max(4, radius)
    const grid = new Map<number, number[]>()
    const key = (x: number, y: number) => Math.floor(y / cell) * 1_000_003 + Math.floor(x / cell)
    ends.forEach((e, i) => { const k = key(e.p[0], e.p[1]); const a = grid.get(k); if (a) a.push(i); else grid.set(k, [i]) })
    const best = new Int32Array(ends.length).fill(-1)
    const bestD = new Float64Array(ends.length).fill(Infinity)
    ends.forEach((e, i) => {
      const cx = Math.floor(e.p[0] / cell), cy = Math.floor(e.p[1] / cell)
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const bucket = grid.get((cy + dy) * 1_000_003 + (cx + dx))
        if (!bucket) continue
        for (const j of bucket) {
          const f = ends[j]
          if (f.c === e.c) continue
          const vx = f.p[0] - e.p[0], vy = f.p[1] - e.p[1]
          const d = Math.hypot(vx, vy)
          if (d > radius || d >= bestD[i]) continue
          // Outgoing tangent of the start is -t; of the end is +t.
          const ex = e.end ? e.t[0] : -e.t[0], ey = e.end ? e.t[1] : -e.t[1]
          const fx = f.end ? f.t[0] : -f.t[0], fy = f.end ? f.t[1] : -f.t[1]
          const dn = d || 1
          if ((ex * vx + ey * vy) / dn < cosMin) continue
          if ((fx * -vx + fy * -vy) / dn < cosMin) continue
          best[i] = j; bestD[i] = d
        }
      }
    })
    const merged = new Set<number>()
    const out: Chain[] = []
    let joined = 0
    // Join mutual best pairs; a chain may be joined at both ends across
    // passes, one end per pass keeps the bookkeeping simple.
    const usedChain = new Set<number>()
    ends.forEach((e, i) => {
      const j = best[i]
      if (j < 0 || best[j] !== i || i > j) return
      const f = ends[j]
      if (usedChain.has(e.c) || usedChain.has(f.c)) return
      const a = cur[e.c], b = cur[f.c]
      const aPts = e.end ? a.pts : a.pts.slice().reverse()
      const bPts = f.end ? b.pts.slice().reverse() : b.pts
      const na = a.pts.length, nb = b.pts.length
      out.push({
        pts: aPts.concat(bPts),
        meanMag: (a.meanMag * na + b.meanMag * nb) / (na + nb),
        minMag: Math.min(a.minMag, b.minMag),
      })
      usedChain.add(e.c); usedChain.add(f.c)
      merged.add(e.c); merged.add(f.c)
      joined++
    })
    cur.forEach((ch, c) => { if (!merged.has(c)) out.push(ch) })
    cur = out
    if (!joined) break
  }
  return cur
}

/** Mean signed intensity step across a chain, sampled ±off px along the
 *  local normal, plus how consistently the sign holds. A real edge has a
 *  bright side and a dark side all along; a scratch or printed glyph does
 *  not. (A cheap stand-in for the Mann–Whitney test of IPOL 2016.) */
function sideContrast(pts: Pt[], img: Float32Array, width: number, height: number, off = 3): { step: number; consistency: number } {
  let sum = 0, n = 0, pos = 0
  const stride = Math.max(1, Math.floor(pts.length / 64))
  for (let i = 0; i < pts.length; i += stride) {
    const a = pts[Math.max(0, i - 2)], b = pts[Math.min(pts.length - 1, i + 2)]
    let tx = b[0] - a[0], ty = b[1] - a[1]
    const l = Math.hypot(tx, ty)
    if (l < 1e-6) continue
    tx /= l; ty /= l
    const nx = -ty, ny = tx
    const p = pts[i]
    const x1 = Math.round(p[0] + nx * off - 0.5), y1 = Math.round(p[1] + ny * off - 0.5)
    const x2 = Math.round(p[0] - nx * off - 0.5), y2 = Math.round(p[1] - ny * off - 0.5)
    if (x1 < 0 || y1 < 0 || x2 < 0 || y2 < 0 || x1 >= width || x2 >= width || y1 >= height || y2 >= height) continue
    const d = img[y1 * width + x1] - img[y2 * width + x2]
    sum += d; n++
    if (d > 0) pos++
  }
  if (!n) return { step: 0, consistency: 0 }
  return { step: Math.abs(sum / n), consistency: Math.max(pos, n - pos) / n }
}

interface PostOpts { minLenPx: number; minStep?: number; minConsistency?: number; bridge?: number }

function postFilter(chains: Chain[], img: Float32Array, width: number, height: number, o: PostOpts): Chain[] {
  let cur = o.bridge ? bridgeGaps(chains, o.bridge) : chains
  cur = cur.filter((c) => chainLength(c.pts) >= o.minLenPx)
  if (o.minStep !== undefined || o.minConsistency !== undefined) {
    cur = cur.filter((c) => {
      const s = sideContrast(c.pts, img, width, height)
      return s.step >= (o.minStep ?? 0) && s.consistency >= (o.minConsistency ?? 0)
    })
  }
  return cur
}

function toResult(chains: Chain[], note?: string): MethodResult {
  return { chains: pointChainsToEdges(chains.map((c) => c.pts)), note }
}

// ---- 2. Canny + chain post-processing --------------------------------------

export const cannyPost: Method = ({ gray, width, height, pxPerMm }) => {
  const s = cannyStages(gray, width, height, 1.4, 0.5)
  const chains = chainsOf(traceChains(s.kept, width, height), s.g)
  const out = postFilter(chains, s.blurred, width, height, {
    bridge: 4, minLenPx: MIN_FEATURE_MM * pxPerMm, minStep: 12, minConsistency: 0.8,
  })
  return toResult(out, `bridge 4 px · len ≥ ${MIN_FEATURE_MM} mm · side step ≥ 12 grey, sign ≥ 80 %`)
}

// ---- 3. Canny + Helmholtz (NFA) chain validation ---------------------------

/** Cumulative gradient distribution H(μ) = P(mag ≥ μ) as a lookup. */
function gradientTail(mag: Float32Array): (mu: number) => number {
  let max = 0
  for (let i = 0; i < mag.length; i++) if (mag[i] > max) max = mag[i]
  const BINS = 2048
  const hist = new Float64Array(BINS + 1)
  for (let i = 0; i < mag.length; i++) hist[Math.min(BINS, Math.floor((mag[i] / max) * BINS))]++
  const tail = new Float64Array(BINS + 2)
  for (let b = BINS; b >= 0; b--) tail[b] = tail[b + 1] + hist[b] / mag.length
  return (mu: number) => tail[Math.max(0, Math.min(BINS + 1, Math.floor((mu / max) * BINS)))]
}

/** EDPF's validation: a run of n pixels all at gradient ≥ μ is meaningful
 *  when Np·H(μ)^n ≤ ε. An invalid run is split at its weakest pixel and the
 *  halves tried again — the strong part of a chain survives a weak stretch. */
function validateNfa(pixelChains: number[][], g: Gradients, eps = 1, minRun = 4): number[][] {
  const H = gradientTail(g.mag)
  const logNp = 2 * Math.log(g.width * g.height)
  const out: number[][] = []
  const visit = (pc: number[]) => {
    if (pc.length < minRun) return
    let min = Infinity, at = 0
    for (let i = 0; i < pc.length; i++) if (g.mag[pc[i]] < min) { min = g.mag[pc[i]]; at = i }
    const logNfa = logNp + pc.length * Math.log(Math.max(1e-300, H(min)))
    if (logNfa <= Math.log(eps)) { out.push(pc); return }
    visit(pc.slice(0, at))
    visit(pc.slice(at + 1))
  }
  for (const pc of pixelChains) visit(pc)
  return out
}

export const cannyNfa: Method = ({ gray, width, height, pxPerMm }) => {
  // Permissive thresholds — the validation does the selecting.
  const s = cannyStages(gray, width, height, 1.4, 0.9)
  const valid = validateNfa(traceChains(s.kept, width, height), s.g)
  const out = postFilter(chainsOf(valid, s.g), s.blurred, width, height, { bridge: 4, minLenPx: MIN_FEATURE_MM * pxPerMm })
  return toResult(out, `sens 0.9 · NFA ≤ 1 with Np = (W·H)² · bridge 4 px · len ≥ ${MIN_FEATURE_MM} mm`)
}

// ---- 4. Two-scale edge focusing --------------------------------------------

function dilate(mask: Uint8Array, width: number, height: number, r: number): Uint8Array {
  const tmp = new Uint8Array(mask.length)
  const out = new Uint8Array(mask.length)
  for (let y = 0; y < height; y++) {
    const row = y * width
    for (let x = 0; x < width; x++) {
      let v = 0
      for (let k = -r; k <= r && !v; k++) { const xx = x + k; if (xx >= 0 && xx < width && mask[row + xx]) v = 1 }
      tmp[row + x] = v
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let v = 0
      for (let k = -r; k <= r && !v; k++) { const yy = y + k; if (yy >= 0 && yy < height && tmp[yy * width + x]) v = 1 }
      out[y * width + x] = v
    }
  }
  return out
}

export const edgeFocus: Method = ({ gray, width, height, pxPerMm }) => {
  const coarseSigma = 3.5
  const coarse = cannyStages(gray, width, height, coarseSigma, 0.5)
  const mask = dilate(coarse.kept, width, height, Math.ceil(coarseSigma))
  const fine = cannyStages(gray, width, height, 1.4, 0.6, mask)
  const chains = chainsOf(traceChains(fine.kept, width, height), fine.g)
  const out = postFilter(chains, fine.blurred, width, height, { bridge: 4, minLenPx: MIN_FEATURE_MM * pxPerMm })
  return toResult(out, `σ ${coarseSigma} mask (dilated ${Math.ceil(coarseSigma)} px) ∧ σ 1.4 sens 0.6 · bridge 4 px · len ≥ ${MIN_FEATURE_MM} mm`)
}

// ---- 5. Edge Drawing + EDPF validation -------------------------------------

export const edgeDrawing: Method = ({ gray, width, height, pxPerMm }) => {
  const blurred = gaussianBlur(gray, width, height, 1.0)
  const g = sobel(blurred, width, height)
  const { gx, gy, mag } = g
  const n = width * height
  // Route only where the production detector would at least consider an
  // edge (its low hysteresis threshold); the NFA then validates.
  const { low: thresh } = autoThresholds(mag, 0.5)
  // Edge direction class: a vertical edge (gradient mostly along x) is
  // walked up and down; a horizontal one left and right.
  const vertical = new Uint8Array(n)
  for (let i = 0; i < n; i++) vertical[i] = Math.abs(gx[i]) >= Math.abs(gy[i]) ? 1 : 0
  // Anchors: gradient maxima across the edge, at every pixel (scan interval
  // 1, anchor threshold 0 — EDPF's parameter-free setting), strongest first.
  const anchors: number[] = []
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x
      const m = mag[i]
      if (m < thresh) continue
      if (vertical[i]) { if (m >= mag[i - 1] && m >= mag[i + 1]) anchors.push(i) }
      else if (m >= mag[i - width] && m >= mag[i + width]) anchors.push(i)
    }
  }
  anchors.sort((a, b) => mag[b] - mag[a])
  const edge = new Uint8Array(n)
  // dir: 0 up, 1 down, 2 left, 3 right
  const step = (p: number, dir: number): number => {
    const x = p % width, y = (p - x) / width
    let best = -1, bm = -1
    const tryPx = (xx: number, yy: number) => {
      if (xx < 1 || yy < 1 || xx >= width - 1 || yy >= height - 1) return
      const i = yy * width + xx
      if (mag[i] > bm) { bm = mag[i]; best = i }
    }
    if (dir === 0) { tryPx(x - 1, y - 1); tryPx(x, y - 1); tryPx(x + 1, y - 1) }
    else if (dir === 1) { tryPx(x - 1, y + 1); tryPx(x, y + 1); tryPx(x + 1, y + 1) }
    else if (dir === 2) { tryPx(x - 1, y - 1); tryPx(x - 1, y); tryPx(x - 1, y + 1) }
    else { tryPx(x + 1, y - 1); tryPx(x + 1, y); tryPx(x + 1, y + 1) }
    return best
  }
  const walk = (start: number, dir: number, out: number[]) => {
    let p = start
    let d = dir
    for (let guard = 0; guard < n; guard++) {
      const nx = step(p, d)
      if (nx < 0 || mag[nx] < thresh || edge[nx]) return
      edge[nx] = 1
      out.push(nx)
      p = nx
      // Direction class flipped: pick the side whose next step is strongest.
      if (vertical[nx] && d >= 2) {
        const up = step(nx, 0), dn = step(nx, 1)
        d = (up >= 0 ? mag[up] : -1) >= (dn >= 0 ? mag[dn] : -1) ? 0 : 1
      } else if (!vertical[nx] && d < 2) {
        const lf = step(nx, 2), rt = step(nx, 3)
        d = (lf >= 0 ? mag[lf] : -1) >= (rt >= 0 ? mag[rt] : -1) ? 2 : 3
      }
    }
  }
  const segments: number[][] = []
  for (const a of anchors) {
    if (edge[a]) continue
    edge[a] = 1
    const one: number[] = [], two: number[] = []
    if (vertical[a]) { walk(a, 0, one); walk(a, 1, two) } else { walk(a, 2, one); walk(a, 3, two) }
    segments.push(one.reverse().concat([a], two))
  }
  const valid = validateNfa(segments, g)
  const out = postFilter(chainsOf(valid, g), blurred, width, height, { minLenPx: MIN_FEATURE_MM * pxPerMm, minStep: 12, minConsistency: 0.8 })
  return toResult(out, `σ 1.0 · grad ≥ Canny low · anchors every px · NFA ≤ 1 · len ≥ ${MIN_FEATURE_MM} mm · side step ≥ 12 grey (${segments.length} raw segments)`)
}

// ---- 6. Iso-contour at the Otsu level (silhouette) -------------------------

export function isoContours(img: Float32Array, width: number, height: number, T: number): Pt[][] {
  // Corner values at pixel centres; cell (x,y) spans centres (x..x+1, y..y+1).
  // Sides: 0 top, 1 right, 2 bottom, 3 left. Each cell holds oriented
  // segments (entry side → exit side) with the ≥T region on the left.
  type Seg = { entry: number; exit: number; p1: Pt; p2: Pt; used: boolean }
  const cells = new Map<number, Seg[]>()
  const cross = (xa: number, ya: number, va: number, xb: number, yb: number, vb: number): Pt => {
    const t = (T - va) / (vb - va)
    return [xa + (xb - xa) * t + 0.5, ya + (yb - ya) * t + 0.5]
  }
  for (let y = 0; y < height - 1; y++) {
    for (let x = 0; x < width - 1; x++) {
      const i = y * width + x
      const tl = img[i], tr = img[i + 1], bl = img[i + width], br = img[i + width + 1]
      const c = (tl >= T ? 1 : 0) | (tr >= T ? 2 : 0) | (br >= T ? 4 : 0) | (bl >= T ? 8 : 0)
      if (c === 0 || c === 15) continue
      const sidePt = (s: number): Pt => s === 0 ? cross(x, y, tl, x + 1, y, tr) : s === 1 ? cross(x + 1, y, tr, x + 1, y + 1, br)
        : s === 2 ? cross(x, y + 1, bl, x + 1, y + 1, br) : cross(x, y, tl, x, y + 1, bl)
      const cornerOf: Record<string, [number, number, boolean]> = {
        '0,3': [x, y, tl >= T], '0,1': [x + 1, y, tr >= T], '1,2': [x + 1, y + 1, br >= T], '2,3': [x, y + 1, bl >= T],
      }
      const crossed: number[] = []
      if ((tl >= T) !== (tr >= T)) crossed.push(0)
      if ((tr >= T) !== (br >= T)) crossed.push(1)
      if ((bl >= T) !== (br >= T)) crossed.push(2)
      if ((tl >= T) !== (bl >= T)) crossed.push(3)
      const pairs: [number, number][] = []
      if (crossed.length === 2) pairs.push([crossed[0], crossed[1]])
      else {
        // Saddle: decide by the cell centre which corners connect.
        const centreIn = (tl + tr + bl + br) / 4 >= T
        if ((tl >= T) === centreIn) pairs.push([0, 1], [2, 3]) // TL joins BR side: separate TR and BL corners
        else pairs.push([0, 3], [1, 2])
      }
      const segs: Seg[] = []
      for (const [s1, s2] of pairs) {
        const p1 = sidePt(s1), p2 = sidePt(s2)
        // Orientation: inside on the left. Use a corner whose in/out state
        // we know lies on one side of the segment.
        const k = s1 < s2 ? `${s1},${s2}` : `${s2},${s1}`
        const corner = cornerOf[k] ?? [x, y, tl >= T]
        const cx = corner[0] + 0.5, cy = corner[1] + 0.5
        const crossz = (p2[0] - p1[0]) * (cy - p1[1]) - (p2[1] - p1[1]) * (cx - p1[0])
        // In image coords (y down) "left of travel" is crossz < 0.
        const cornerLeft = crossz < 0
        const keep = cornerLeft === corner[2]
        segs.push(keep ? { entry: s1, exit: s2, p1, p2, used: false } : { entry: s2, exit: s1, p1: p2, p2: p1, used: false })
      }
      cells.set(i, segs)
    }
  }
  const opposite = (s: number) => (s + 2) % 4
  const neighbour = (i: number, side: number) => side === 0 ? i - width : side === 1 ? i + 1 : side === 2 ? i + width : i - 1
  const contours: Pt[][] = []
  for (const [i0, segs0] of cells) {
    for (const s0 of segs0) {
      if (s0.used) continue
      s0.used = true
      const fwd: Pt[] = [s0.p1, s0.p2]
      let i = i0, s = s0
      for (;;) {
        const ni = neighbour(i, s.exit)
        const ns = cells.get(ni)?.find((t) => !t.used && t.entry === opposite(s.exit))
        if (!ns) break
        ns.used = true
        fwd.push(ns.p2)
        i = ni; s = ns
      }
      const back: Pt[] = []
      i = i0; s = s0
      for (;;) {
        const ni = neighbour(i, s.entry)
        const ns = cells.get(ni)?.find((t) => !t.used && t.exit === opposite(s.entry))
        if (!ns) break
        ns.used = true
        back.push(ns.p1)
        i = ni; s = ns
      }
      contours.push(back.reverse().concat(fwd))
    }
  }
  return contours
}

export const isoContour: Method = ({ gray, width, height, pxPerMm }) => {
  const blurred = gaussianBlur(gray, width, height, 1.0)
  const T = otsu(blurred)
  const contours = isoContours(blurred, width, height, T)
  const minLen = MIN_FEATURE_MM * pxPerMm
  const kept = contours.filter((c) => chainLength(c) >= minLen)
  return { chains: pointChainsToEdges(kept), note: `σ 1.0 · Otsu level ${T} · marching squares · len ≥ ${MIN_FEATURE_MM} mm (${contours.length} raw contours)` }
}

// ---- 6b. Iso-contour at the local mean (Marr–Hildreth-style 50 % rule) ------

/** Box mean over radius r via an integral image. */
function boxMean(img: Float32Array, width: number, height: number, r: number): Float32Array {
  const W = width + 1
  const integ = new Float64Array(W * (height + 1))
  for (let y = 1; y <= height; y++) {
    let row = 0
    for (let x = 1; x <= width; x++) {
      row += img[(y - 1) * width + (x - 1)]
      integ[y * W + x] = integ[(y - 1) * W + x] + row
    }
  }
  const out = new Float32Array(width * height)
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(height, y + r + 1)
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(width, x + r + 1)
      const s = integ[y1 * W + x1] - integ[y0 * W + x1] - integ[y1 * W + x0] + integ[y0 * W + x0]
      out[y * width + x] = s / ((y1 - y0) * (x1 - x0))
    }
  }
  return out
}

export const isoLocal: Method = ({ gray, width, height, pxPerMm }) => {
  const blurred = gaussianBlur(gray, width, height, 1.0)
  const r = Math.round(0.4 * pxPerMm)
  const mean = boxMean(blurred, width, height, r)
  const diff = new Float32Array(width * height)
  for (let i = 0; i < diff.length; i++) diff[i] = blurred[i] - mean[i]
  const contours = isoContours(diff, width, height, 0)
  const minLen = MIN_FEATURE_MM * pxPerMm
  const chains: Chain[] = contours.filter((c) => chainLength(c) >= minLen).map((pts) => ({ pts, meanMag: 0, minMag: 0 }))
  const out = postFilter(chains, blurred, width, height, { minLenPx: minLen, minStep: 12, minConsistency: 0.8 })
  return toResult(out, `σ 1.0 · level = local mean (r ${r} px = 0.4 mm) · marching squares · len ≥ ${MIN_FEATURE_MM} mm · side step ≥ 12 grey (${contours.length} raw contours)`)
}

// ---- 7. Line / arc primitive segmentation ----------------------------------

function lineMaxResidual(pts: Pt[], i0: number, i1: number): number {
  const n = i1 - i0 + 1
  let mx = 0, my = 0
  for (let i = i0; i <= i1; i++) { mx += pts[i][0]; my += pts[i][1] }
  mx /= n; my /= n
  let sxx = 0, sxy = 0, syy = 0
  for (let i = i0; i <= i1; i++) { const x = pts[i][0] - mx, y = pts[i][1] - my; sxx += x * x; sxy += x * y; syy += y * y }
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy)
  const nx = -Math.sin(theta), ny = Math.cos(theta)
  let worst = 0
  for (let i = i0; i <= i1; i++) worst = Math.max(worst, Math.abs((pts[i][0] - mx) * nx + (pts[i][1] - my) * ny))
  return worst
}

function arcMaxResidual(pts: Pt[], i0: number, i1: number, maxRadius: number): number {
  const n = i1 - i0 + 1
  const xs = new Float64Array(n), ys = new Float64Array(n)
  for (let i = 0; i < n; i++) { xs[i] = pts[i0 + i][0]; ys[i] = pts[i0 + i][1] }
  const c = fitCircle2d(xs, ys)
  if (!c || !(c.r > 0) || c.r > maxRadius) return Infinity
  let worst = 0
  for (let i = 0; i < n; i++) worst = Math.max(worst, Math.abs(Math.hypot(xs[i] - c.cu, ys[i] - c.cv) - c.r))
  return worst
}

/** Longest j ≥ j0 such that ok(j) holds, assuming monotone failure. */
function extend(j0: number, jmax: number, ok: (j: number) => boolean): number {
  let j = j0
  let s = 8
  while (j + s <= jmax && ok(j + s)) j += s
  while (s > 1) { s >>= 1; if (j + s <= jmax && ok(j + s)) j += s }
  return j
}

/** Split chains into line and arc runs (greedy growth, tolerance in px);
 *  runs shorter than minLenPx are dropped. Close to Rosin & West in spirit,
 *  with a fixed tolerance rather than their significance measure. */
export function segmentPrimitives(chains: Pt[][], tol: number, minLenPx: number, maxRadius: number): { chains: Pt[][]; kinds: ('line' | 'arc')[] } {
  const out: Pt[][] = []
  const kinds: ('line' | 'arc')[] = []
  for (const pts of chains) {
    const n = pts.length
    let i = 0
    while (i < n - 2) {
      const jl = extend(Math.min(i + 2, n - 1), n - 1, (j) => lineMaxResidual(pts, i, j) <= tol)
      let ja = i
      if (n - 1 - i >= 6) ja = extend(Math.min(i + 5, n - 1), n - 1, (j) => arcMaxResidual(pts, i, j, maxRadius) <= tol)
      const useArc = ja > jl + Math.max(4, (jl - i) * 0.3)
      const j = useArc ? ja : jl
      const run = pts.slice(i, j + 1)
      if (chainLength(run) >= minLenPx) { out.push(run); kinds.push(useArc ? 'arc' : 'line') }
      i = Math.max(j, i + 1)
    }
  }
  return { chains: out, kinds }
}

function primitivesOf(base: Method, label: string): Method {
  return (input) => {
    const r = base(input)
    const seg = segmentPrimitives(edgesToPointChains(r.chains), 0.6, MIN_FEATURE_MM * input.pxPerMm, 400 * input.pxPerMm)
    return { chains: pointChainsToEdges(seg.chains), kinds: seg.kinds, note: `${label} → line/arc runs, tol 0.6 px, len ≥ ${MIN_FEATURE_MM} mm` }
  }
}

export const primitivesCanny = primitivesOf(cannyPost, 'canny+post')
export const primitivesEd = primitivesOf(edgeDrawing, 'edge drawing')

export const METHODS: { key: string; title: string; run: Method; summary: string }[] = [
  { key: 'canny', title: 'A · Canny (current)', run: canny, summary: 'Production detector, sensitivity 0.5, σ 1.4, chains ≥ 8 px.' },
  { key: 'canny-post', title: 'B · Canny + chain statistics', run: cannyPost, summary: 'Same pixels; bridge gaps, drop chains shorter than 1 mm, require a consistent bright/dark side along the chain.' },
  { key: 'canny-nfa', title: 'C · Canny + Helmholtz (NFA) validation', run: cannyNfa, summary: 'Permissive Canny, then EDPF’s a-contrario test per chain: Np·H(min gradient)^length ≤ 1, recursively split at the weakest pixel.' },
  { key: 'edge-focus', title: 'D · Two-scale edge focusing', run: edgeFocus, summary: 'Coarse σ 3.5 Canny selects which edges exist; fine σ 1.4 Canny inside a dilated mask locates them.' },
  { key: 'edge-drawing', title: 'E · Edge Drawing + EDPF', run: edgeDrawing, summary: 'Anchor-and-route edge segments (no NMS/hysteresis), validated by NFA, then the same side-contrast test as B.' },
  { key: 'iso-contour', title: 'F · Iso-contour (silhouette)', run: isoContour, summary: 'Marching squares at the Otsu grey level, subpixel by linear interpolation — only object/background boundaries exist.' },
  { key: 'iso-local', title: 'F2 · Iso-contour at the local mean', run: isoLocal, summary: 'Marching squares where the image crosses its own 0.4 mm local mean (an unbiased 50 % crossing for any step), then the side-contrast test.' },
  { key: 'prim-canny', title: 'G · B → line/arc primitives', run: primitivesCanny, summary: 'Chains of B split into straight and circular runs; runs under 1 mm dropped.' },
  { key: 'prim-ed', title: 'H · E → line/arc primitives', run: primitivesEd, summary: 'Chains of E split into straight and circular runs; runs under 1 mm dropped.' },
]
