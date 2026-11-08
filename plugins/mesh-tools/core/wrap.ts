// SPDX-License-Identifier: AGPL-3.0-only
// One closed skin round a part that is a mess inside — an assembly exported
// as one mesh, channels and bosses inside a casting, shells overlapping or
// facing the wrong way, a scan with cracks. What is inside is dropped, gaps
// narrower than a width are bridged, and what is left is easy to slice.
//
// It is the part closed by a ball: the ball, of radius r — half the gap —
// rolls everywhere it can reach from outside without touching the part, and
// the wrap is where it stopped. Only the distance to the triangles is ever
// used, never which way they face or whether they close, so any triangle
// soup is input enough. Free space is every point further than r from the
// part; the outside is the free space joined to infinity; and the wrap is
// the surface r from the outside — or r − t, grown by t. Where the ball
// touched the part the wrap lies on it, and across every opening it could
// not pass it bridges with a round of radius r. An open sheet has no
// inside, so it wraps to nothing unless grown: by t it is a slab 2t thick.
//
// It is worked out on a grid, but the grid only has to see the gap: its cell
// is a third of r. How closely the wrap follows the part is not the grid's
// — every vertex of it where the ball touched is moved onto the nearest
// triangle afterwards, which puts it on the part to the part's own
// precision. The grid is cut into tiles of 64³ points, and only the tiles
// the outside reaches are measured, and in them only the band round the
// surface: the cost goes with the area of the part's outside, not with the
// box it fills nor with what is inside it.
//
// In steps, each in wrapTile.ts for one tile, run as jobs (wrapJobs.ts) on a
// pool of workers or in this thread:
//
//  1. The triangles are sorted into the tiles they reach.
//  2. Pass A, from the grid's border inward, tile by tile as the outside
//     reaches them: the distance to the part (a feature transform from
//     points spread over the triangles, so a crack narrower than a cell is
//     still part), the free space as runs along X joined into pieces, and
//     where free space begins next to the part.
//  3. The pieces are joined across the tiles' faces as each tile comes;
//     those that reach the grid's border are the outside, and a tile it
//     reaches through a face is measured next.
//  4. Pass C, tile by tile: the distance from the outside, seeded where it
//     begins to within a share of a cell, and with it the signed field.
//     What steps 1 to 4 leave is kept (WrapMemo) for another Grow by.
//  5. The wrap through the field, by marching cubes on each tile's cubes,
//     welded along the tiles' faces; specks dropped.
//  6. Each vertex moved onto the nearest triangle within a cell and a half
//     that lies along the wrap there — grown, onto the part grown — unless
//     that would fold the wrap; those left off the part are its bridges.
//     With Edges: Sharp, the part's edges and corners the grid cut off put
//     back (wrapSharp.ts).
//  7. Reduced to within a sixteenth of a cell, tile by tile on three
//     tilings.

import type { MeshoptSimplifier as Simplifier } from 'meshoptimizer/simplifier'
import { round125 } from './round125'
import { dropSpecks } from './marching'
import { signedVolume } from './hollow'
import { halfEdges, openEdgeCount } from './boundary'
import { JITTER } from './distanceGrid'
import { vertexComponents } from '../../../src/core/geometry/unionFind'
import { FAR_OUT, FOOT_SCALE, STEPS, TILE, type TileA, type TileMesh, type TileRuns, type WrapPlan } from './wrapTile'
import { inlineRunner, runAll, type WrapJob, type WrapRunner } from './wrapJobs'
import { sharpen } from './wrapSharp'

/** How the wrap meets the part's edges: rebuilt sharp, or left rounded by
 *  the grid's cell. */
export type WrapEdges = 'sharp' | 'smooth'

export interface WrapSettings {
  /** Openings narrower than this are bridged, mm. */
  gap: number
  /** How far the wrap stands off the part, mm: 0 on it. */
  grow: number
  edges: WrapEdges
  /** The reduction's tolerance, mm; left out, a sixteenth of the cell. */
  tolerance?: number
}

export interface WrapStage {
  name: string
  ms: number
}

export interface WrapReport {
  settings: WrapSettings
  /** The grid's cell, mm, and whether the size of the part made it coarser
   *  than a sixth of the gap — then `fullGap` is the smallest gap it closes
   *  as exactly at this size. */
  cell: number
  coarsened: boolean
  fullGap: number | null
  /** Separate skins in the wrap — one for each part that does not touch
   *  another within the gap. */
  shells: number
  inputTriangles: number
  /** Input triangles that lie inside the wrap, dropped with it. */
  dropped: number
  triangles: number
  vertices: number
  /** The wrap's area, and how much of it bridges an opening rather than
   *  lying on the part, mm². */
  area: number
  bridgedArea: number
  /** The volume the wrap encloses, mm³. */
  volume: number
  /** How long each step took. */
  stages: WrapStage[]
  /** Tiles the grid has, and those that did any work. */
  tiles: number
  tilesWorked: number
  /** With Edges: Sharp, the points put back on the part's edges and at its
   *  corners. */
  sharpEdges: number
  sharpCorners: number
  /** Why so little of the part is left, when that is so — or null. */
  warning: string | null
}

export interface WrapResult {
  positions: Float32Array
  indices: Uint32Array
  /** 1 for each vertex that bridges an opening — not on the part. */
  bridge: Uint8Array
  report: WrapReport
}

/** The gap a person would start from: a two-hundredth of the part's
 *  diagonal on the 1-2-5 steps — 1 mm for a part a hand's width across. */
export function defaultWrapGap(bboxDiagonal: number): number {
  return round125(bboxDiagonal / 200)
}

/** The most grid points round the surface the field is worked out at. A
 *  larger part, or a finer gap, takes a coarser cell. */
const MAX_BAND_POINTS = 40_000_000

/** The most tiles the grid may have, worked or not. */
const MAX_TILES = 1_000_000

/** The cell is r over this: fine enough that a bridge is round and a gap
 *  just narrower than the setting reads as closed. */
const CELLS_PER_R = 3

/** And never coarser than r over this: past it the gap is not seen. */
const MIN_CELLS_PER_R = 1.5

/** A vertex is moved onto a triangle within this many cells of it whose
 *  normal is within this of its own, either way. */
const SNAP_REACH = 1.5
const SNAP_COS = 0.7

/** A vertex left off the part further than this many cells is a bridge;
 *  nearer, it is where the wrap rounds an edge of the part by the cell. */
const BRIDGE_CELLS = 0.5

/** How far past the wrap's level the distances are worked out, cells: the
 *  far corner of a cube the wrap crosses is up to √3 off it, and the field
 *  a little off the true distance besides. */
const REACH_MARGIN = 2.5

/** How far past r the distance to the part is worked out, cells, for what
 *  is free and where free space begins to be found. */
const FREE_MARGIN = 1.5

/** Shells enclosing less than this many cubic cells are specks. */
const MIN_SHELL_CELLS = 8

/** The reduction's tolerance, in cells, unless one is given. */
const REDUCE_SHARE = 1 / 16

const fmt = (x: number) => Number(x.toPrecision(3))

/** Raised in a run whose band outgrows MAX_BAND_POINTS: it is made again on
 *  a coarser grid. */
class TooFine extends Error {}

/**
 * The wrap round the triangles `indices` of `positions`, as `settings`
 * say. `simplifier` reduces it when given. The tiles' work runs on
 * `runner` — a pool of workers — or, left out, in this thread. With a
 * `memo`, the field measured is kept, and the next wrap of the same
 * triangles at the same gap starts from it: another Grow by is made in the
 * time the march, the snapping and the reduction take. Throws when there is
 * nothing to wrap, or the gap is too fine for the part's size.
 */
export async function wrapMesh(
  positions: Float32Array,
  indices: Uint32Array,
  settings: WrapSettings,
  simplifier: typeof Simplifier | null,
  onProgress?: (text: string) => void,
  runner?: WrapRunner,
  memo?: WrapMemo,
): Promise<WrapResult> {
  const { gap, grow } = settings
  if (!(gap > 0) || !Number.isFinite(gap)) throw new Error('The gap must be more than zero.')
  if (!(grow >= 0) || !Number.isFinite(grow)) throw new Error('Grow by must be zero or more.')
  // units-ok: worked out in the worker, also the agent's answer
  if (grow > gap) throw new Error(`Grow by at most the gap, ${fmt(gap)} mm — or close a larger gap.`)
  const triangles = indices.length / 3
  if (triangles === 0) throw new Error('There is no mesh to wrap.')
  const jobs = runner ?? inlineRunner(simplifier)
  const stages: WrapStage[] = []
  let clock = now()
  const stage = (name: string) => {
    const t = now()
    stages.push({ name, ms: t - clock })
    clock = t
  }
  const say = (text: string) => onProgress?.(text)

  // ---- the grid --------------------------------------------------------------------------
  let lx = Infinity, ly = Infinity, lz = Infinity
  let hx = -Infinity, hy = -Infinity, hz = -Infinity
  let area = 0
  {
    // Over the vertices the triangles use.
    const used = new Uint8Array(positions.length / 3)
    for (let i = 0; i < indices.length; i++) used[indices[i]] = 1
    for (let v = 0; v < used.length; v++) {
      if (!used[v]) continue
      const x = positions[v * 3], y = positions[v * 3 + 1], z = positions[v * 3 + 2]
      if (x < lx) lx = x
      if (x > hx) hx = x
      if (y < ly) ly = y
      if (y > hy) hy = y
      if (z < lz) lz = z
      if (z > hz) hz = z
    }
  }
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2]
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2]
    area += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2
  }
  const r = gap / 2
  const sizeOf = (h: number) => {
    // The distance to the part decides what is free, r out, and gives the
    // field outside where the wrap's level comes near it — when grown to
    // within a couple of cells of r.
    const dmaxS = Math.max(r / h + FREE_MARGIN, grow / h + REACH_MARGIN)
    const pad = Math.ceil(dmaxS) + 3
    const tiles = [hx - lx, hy - ly, hz - lz].map((d) => Math.ceil((Math.ceil(d / h) + 1 + 2 * pad) / TILE))
    return { dmaxS, pad, tiles, band: (area / (h * h)) * 2 * dmaxS }
  }
  const refuse = (h: number) =>
    new Error(
      // units-ok: worked out in the worker, also the agent's answer
      `The part is too large to close gaps that fine — at its size the smallest gap that can be closed is ${fmt(round125(2 * MIN_CELLS_PER_R * h))} mm.`,
    )
  /** Whether the cell is already as coarse as the whole of the part's area
   *  needs: then a band past the budget is let be rather than tried again. */
  const coarseForAll = (h: number) => sizeOf(h).band <= MAX_BAND_POINTS
  /** The grid at cell `h`. */
  const planFor = (h: number): WrapPlan => {
    const size = sizeOf(h)
    const dmaxS = size.dmaxS
    const dmaxF = r / h + REACH_MARGIN
    return {
      h,
      ox: lx - (size.pad + JITTER[0]) * h,
      oy: ly - (size.pad + JITTER[1]) * h,
      oz: lz - (size.pad + JITTER[2]) * h,
      tx: size.tiles[0],
      ty: size.tiles[1],
      tz: size.tiles[2],
      rc: r / h,
      lc: (grow - r) / h,
      dmaxS,
      dmaxF,
      hS: Math.ceil(dmaxS) + 1,
      hF: Math.ceil(dmaxF) + 1,
    }
  }
  // The cell the gap asks for, unless the grid would have too many tiles.
  // The band is first tried at that cell even when all of the part's area
  // would be too much: only what the outside reaches is measured, and the
  // inside of a part can be most of its area. Should the band outgrow the
  // budget even so, the cell is made coarse enough for all of it.
  // The triangles' own fingerprint says whether they are the ones the kept
  // field was measured on: a few milliseconds a million.
  const key = memo ? fingerprint(positions, indices) : ''
  if (memo) {
    const kept = memo.field
    memo.field = null
    if (kept && kept.key === key && kept.gap === gap && kept.triangles === triangles && sizeOf(kept.plan.h).dmaxS <= kept.plan.dmaxS) {
      return await wrapOn(kept.plan.h, kept)
    }
  }
  let h = r / CELLS_PER_R
  while (product(sizeOf(h).tiles) > MAX_TILES) h *= 1.1
  for (;;) {
    if (r / h < MIN_CELLS_PER_R) throw refuse(h)
    try {
      return await wrapOn(h, null)
    } catch (e) {
      if (!(e instanceof TooFine)) throw e
      stage('Trying a finer grid')
      while (!coarseForAll(h) || product(sizeOf(h).tiles) > MAX_TILES) h *= 1.1
    }
  }

  /** The wrap on a grid of cell `h` — from the field `kept` from the wrap
   *  before, when there is one. */
  async function wrapOn(h: number, kept: WrapField | null): Promise<WrapResult> {
    const coarsened = h > (r / CELLS_PER_R) * 1.0001
    const plan: WrapPlan = kept ? { ...kept.plan, lc: (grow - r) / h } : planFor(h)
    const { tx, ty, tz, hS, hF } = plan
    const T = TILE
    const T2 = T * T
    const tileCount = tx * ty * tz
    const tileOf = (I: number, J: number, K: number) => I + tx * (J + ty * K)
    const tileI = (q: number) => q % tx
    const tileJ = (q: number) => ((q / tx) | 0) % ty
    const tileK = (q: number) => (q / (tx * ty)) | 0
    const onBorder = (q: number) => {
      const I = tileI(q), J = tileJ(q), K = tileK(q)
      return I === 0 || J === 0 || K === 0 || I === tx - 1 || J === ty - 1 || K === tz - 1
    }
    /** The tile across face f (0 −X, 1 +X, 2 −Y, 3 +Y, 4 −Z, 5 +Z), or −1. */
    const across = (q: number, f: number): number => {
      switch (f) {
        case 0: return tileI(q) > 0 ? q - 1 : -1
        case 1: return tileI(q) + 1 < tx ? q + 1 : -1
        case 2: return tileJ(q) > 0 ? q - tx : -1
        case 3: return tileJ(q) + 1 < ty ? q + tx : -1
        case 4: return tileK(q) > 0 ? q - tx * ty : -1
        default: return tileK(q) + 1 < tz ? q + tx * ty : -1
      }
    }

    // What the first four steps leave: kept from the wrap before when it is
    // of the same mesh and gap, else measured now.
    const field: WrapField = kept ?? {
      key,
      gap,
      triangles,
      plan,
      binStart: new Uint32Array(tileCount + 1),
      bins: EMPTY_U32,
      passA: new Array(tileCount).fill(null),
      settled: new Uint8Array(tileCount),
      outside: new Array(tileCount),
      psi: new Array(tileCount).fill(null),
      worked: [],
    }
    const { binStart, passA, settled, outside, psi, worked } = field
    const hasTriangles = (q: number) => binStart[q + 1] > binStart[q]
    /** A tile's triangles, nine floats each. */
    const trianglesOf = (tile: number): Float32Array => {
      const from = binStart[tile], to = binStart[tile + 1]
      const out = new Float32Array((to - from) * 9)
      for (let e = from; e < to; e++) {
        const t = field.bins[e]
        for (let k = 0; k < 3; k++) {
          const v = indices[t * 3 + k] * 3
          const o = (e - from) * 9 + k * 3
          out[o] = positions[v]
          out[o + 1] = positions[v + 1]
          out[o + 2] = positions[v + 2]
        }
      }
      return out
    }
    /** A tile's free space as runs: none until the outside has reached it. */
    const runsOf = (q: number): TileRuns => (!settled[q] ? NONE : (passA[q] ?? WHOLE))
    /** Whether a global grid point is outside — off the grid counts. */
    const isF = (gi: number, gj: number, gk: number): boolean => {
      if (gi < 0 || gj < 0 || gk < 0 || gi >= tx * T || gj >= ty * T || gk >= tz * T) return true
      const I = (gi / T) | 0, J = (gj / T) | 0, K = (gk / T) | 0
      const q = tileOf(I, J, K)
      const runs = runsOf(q)
      const L = gj - J * T + T * (gk - K * T)
      const x = gi - I * T
      for (let run = runs.lineStart[L]; run < runs.lineStart[L + 1]; run++) {
        if (runs.runX[2 * run] > x) return false
        if (runs.runX[2 * run + 1] >= x) return outside[q][runs.runComp[run]] === 1
      }
      return false
    }
    /** 1 when the first point of line L of tile q is outside. */
    const startsOutside = (q: number, L: number): number => {
      const runs = runsOf(q)
      const run = runs.lineStart[L]
      return run < runs.lineStart[L + 1] && runs.runX[2 * run] === 0 ? outside[q][runs.runComp[run]] : 0
    }
    /** Line L of tile q into `out` from `at`: 1 where it is outside. */
    const outsideAlong = (q: number, L: number, out: Uint8Array, at: number) => {
      const runs = runsOf(q)
      for (let run = runs.lineStart[L]; run < runs.lineStart[L + 1]; run++) {
        if (outside[q][runs.runComp[run]]) out.fill(1, at + runs.runX[2 * run], at + runs.runX[2 * run + 1] + 1)
      }
    }
    let shown = -1
    const progress = (what: string, done: number, of: number) => {
      const pc = Math.min(100, Math.floor((100 * done) / Math.max(1, of)))
      if (pc !== shown) {
        shown = pc
        say(`Wrapping — ${what}, ${pc} %…`)
      }
    }
    if (kept) stage('Kept from the wrap before')
    else {
      // ---- 1. the triangles into the tiles they reach -------------------------------------------
      say('Wrapping — sorting the triangles into tiles…')
      const reach = (hS + 1) * h
      // Each triangle's range of tiles, three pairs: worked out once, then
      // counted and filled.
      {
        // Dropped once the bins are filled.
        const ranges = new Uint16Array(triangles * 6)
        {
          const scale = 1 / (h * T)
          const lim = [tx - 1, ty - 1, tz - 1]
          const org = [plan.ox, plan.oy, plan.oz]
          for (let t = 0; t < triangles; t++) {
            const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3
            let count = 1
            for (let ax = 0; ax < 3; ax++) {
              const pa = positions[a + ax], pb = positions[b + ax], pc = positions[c + ax]
              const lo = pa < pb ? (pa < pc ? pa : pc) : pb < pc ? pb : pc
              const hi = pa > pb ? (pa > pc ? pa : pc) : pb > pc ? pb : pc
              const i0 = Math.max(0, Math.floor((lo - reach - org[ax]) * scale))
              const i1 = Math.min(lim[ax], Math.floor((hi + reach - org[ax]) * scale))
              ranges[t * 6 + ax * 2] = i0
              ranges[t * 6 + ax * 2 + 1] = i1
              count *= i1 - i0 + 1
            }
            if (count === 1) binStart[tileOf(ranges[t * 6], ranges[t * 6 + 2], ranges[t * 6 + 4]) + 1]++
            else {
              for (let K = ranges[t * 6 + 4]; K <= ranges[t * 6 + 5]; K++)
                for (let J = ranges[t * 6 + 2]; J <= ranges[t * 6 + 3]; J++)
                  for (let I = ranges[t * 6]; I <= ranges[t * 6 + 1]; I++) binStart[tileOf(I, J, K) + 1]++
            }
          }
        }
        for (let q = 0; q < tileCount; q++) binStart[q + 1] += binStart[q]
        const bins = (field.bins = new Uint32Array(binStart[tileCount]))
        {
          const at = binStart.slice(0, tileCount)
          for (let t = 0; t < triangles; t++) {
            for (let K = ranges[t * 6 + 4]; K <= ranges[t * 6 + 5]; K++)
              for (let J = ranges[t * 6 + 2]; J <= ranges[t * 6 + 3]; J++)
                for (let I = ranges[t * 6]; I <= ranges[t * 6 + 1]; I++) bins[at[tileOf(I, J, K)]++] = t
          }
        }
      }
      stage('Sorting into tiles')

      // ---- 2. pass A from the outside in, and 3. the outside ---------------------------------------
      // The outside spreads tile by tile from the grid's border: a tile no
      // triangle reaches is free space through and through, all of it
      // outside, and passes the outside on to every tile round it at once; a
      // tile with triangles is measured (pass A), and passes it on only across
      // a face where its outside touches. A tile it never reaches holds
      // nothing of the outside, so is never measured — the inside of a part
      // costs no more than sorting its triangles.
      const queued = new Uint8Array(tileCount)
      const compBase = new Int32Array(tileCount).fill(-1)
      const faceComps: (Int32Array[] | null)[] = new Array(tileCount).fill(null)
      const sets = new GrowingSets()
      const OUTSIDE = sets.add(1)
      const union = (x: number, y: number) => sets.union(x, y)
      /** A tile's runs known: its pieces joined to its neighbours' across the
       *  faces, and to the outside on the grid's border. */
      const settle = (q: number) => {
        settled[q] = 1
        const a = runsOf(q)
        const base = (compBase[q] = sets.add(a.comps))
        for (let f = 0; f < 6; f++) {
          const n = across(q, f)
          if (n < 0 || !settled[n]) continue
          // The lower tile first.
          const lo = f % 2 === 0 ? n : q, hi = f % 2 === 0 ? q : n
          const A = runsOf(lo), B = runsOf(hi), bA = compBase[lo], bB = compBase[hi]
          if (f < 2) {
            for (let L = 0; L < T2; L++) {
              const ae = A.lineStart[L + 1], bs = B.lineStart[L]
              if (ae === A.lineStart[L] || bs === B.lineStart[L + 1]) continue
              if (A.runX[2 * (ae - 1) + 1] === T - 1 && B.runX[2 * bs] === 0) union(bA + A.runComp[ae - 1], bB + B.runComp[bs])
            }
          } else if (f < 4) {
            for (let k = 0; k < T; k++) joinAcross(A, T - 1 + T * k, bA, B, T * k, bB, union)
          } else {
            for (let j = 0; j < T; j++) joinAcross(A, j + T * (T - 1), bA, B, j, bB, union)
          }
        }
        if (onBorder(q)) {
          const I = tileI(q), J = tileJ(q), K = tileK(q)
          for (let L = 0; L < T2; L++) {
            const j = L % T, k = (L / T) | 0
            const whole = (J === 0 && j === 0) || (J === ty - 1 && j === T - 1) || (K === 0 && k === 0) || (K === tz - 1 && k === T - 1)
            for (let run = a.lineStart[L]; run < a.lineStart[L + 1]; run++) {
              const x0 = a.runX[2 * run], x1 = a.runX[2 * run + 1]
              if (whole || (I === 0 && x0 === 0) || (I === tx - 1 && x1 === T - 1)) union(base + a.runComp[run], OUTSIDE)
            }
          }
        }
        if (passA[q]) faceComps[q] = facePieces(a)
      }
      const queue: number[] = []
      for (let q = 0; q < tileCount; q++) {
        if (!onBorder(q)) continue
        queued[q] = 1
        queue.push(q)
      }
      let withTriangles = 0
      for (let q = 0; q < tileCount; q++) if (hasTriangles(q)) withTriangles++
      const open: number[] = []
      let bandPoints = 0
      say('Wrapping — measuring the distance to the part…')
      while (queue.length > 0) {
        const batch: number[] = []
        while (queue.length > 0) {
          const q = queue.pop()!
          if (hasTriangles(q)) {
            batch.push(q)
            continue
          }
          settle(q)
          for (let f = 0; f < 6; f++) {
            const n = across(q, f)
            if (n >= 0 && !queued[n]) {
              queued[n] = 1
              queue.push(n)
            }
          }
        }
        if (batch.length === 0) break
        batch.sort((a, b) => a - b)
        await runAll(
          jobs,
          batch,
          (q) => ({ kind: 'a', plan, I: tileI(q), J: tileJ(q), K: tileK(q), tri: trianglesOf(q) }),
          (q, result) => {
            if (result.kind !== 'a') return
            passA[q] = result.a
            bandPoints += result.a.bandIdx.length
            if (bandPoints > MAX_BAND_POINTS && !coarseForAll(h)) throw new TooFine()
          },
          (done) => progress('measuring the distance to the part', worked.length + done, withTriangles),
          (q) => binStart[q + 1] - binStart[q],
        )
        for (const q of batch) {
          settle(q)
          worked.push(q)
          open.push(q)
        }
        // The tiles past them that the outside now reaches.
        let keep = 0
        for (const p of open) {
          let still = false
          const comps = faceComps[p]!
          for (let f = 0; f < 6; f++) {
            const n = across(p, f)
            if (n < 0 || queued[n]) continue
            if (comps[f].some((c) => sets.same(compBase[p] + c, OUTSIDE))) {
              queued[n] = 1
              queue.push(n)
            } else still = true
          }
          if (still) open[keep++] = p
        }
        open.length = keep
      }
      worked.sort((a, b) => a - b)
      stage('Distance to the part')

      for (let q = 0; q < tileCount; q++) {
        const n = runsOf(q).comps
        const flags = new Uint8Array(n)
        for (let c = 0; c < n; c++) flags[c] = sets.same(compBase[q] + c, OUTSIDE) ? 1 : 0
        outside[q] = flags
      }
      stage('Finding the outside')

      // ---- 4. pass C: distance from the outside, the signed field --------------------------------------
      // Where the outside begins, handed to every tile whose box reaches it.
      const nC = T + 2 * hF
      const seedAt: Map<number, { at: number[]; foot: number[] }> = new Map()
      const seedInto = (gi: number, gj: number, gk: number, fx: number, fy: number, fz: number) => {
        const I0 = Math.floor((gi - hF) / T), I1 = Math.floor((gi + hF) / T)
        const J0 = Math.floor((gj - hF) / T), J1 = Math.floor((gj + hF) / T)
        const K0 = Math.floor((gk - hF) / T), K1 = Math.floor((gk + hF) / T)
        for (let K = Math.max(0, K0); K <= Math.min(tz - 1, K1); K++) {
          const c = gk - K * T + hF
          for (let J = Math.max(0, J0); J <= Math.min(ty - 1, J1); J++) {
            const b = gj - J * T + hF
            for (let I = Math.max(0, I0); I <= Math.min(tx - 1, I1); I++) {
              const x = gi - I * T + hF
              const to = tileOf(I, J, K)
              let list = seedAt.get(to)
              if (!list) seedAt.set(to, (list = { at: [], foot: [] }))
              list.at.push(x + nC * (b + nC * c))
              list.foot.push(x + fx, b + fy, c + fz)
            }
          }
        }
      }
      for (const q of worked) {
        const a = passA[q]!
        if (a.crossQ.length === 0) continue
        const I = tileI(q), J = tileJ(q), K = tileK(q)
        for (let e = 0; e < a.crossQ.length; e++) {
          const p = a.crossQ[e]
          const gi = I * T + (p % T), gj = J * T + (((p / T) | 0) % T), gk = K * T + ((p / T2) | 0)
          const [ex, ey, ez] = STEPS[a.crossDir[e]]
          // Only where the free side is the outside.
          if (!isF(gi + ex, gj + ey, gk + ez)) continue
          const o = a.crossFoot.subarray(e * 6, e * 6 + 6)
          const k = 1 / FOOT_SCALE
          seedInto(gi, gj, gk, o[0] * k, o[1] * k, o[2] * k)
          seedInto(gi + ex, gj + ey, gk + ez, o[3] * k, o[4] * k, o[5] * k)
        }
        // Handed out: what the field keeps of the tile is its runs.
        a.crossQ = EMPTY_U32
        a.crossDir = EMPTY_U8
        a.crossFoot = EMPTY_I16
      }
      const passCTiles = [...new Set([...seedAt.keys(), ...worked.filter((q) => passA[q]!.bandIdx.length > 0 && outside[q].includes(1))])].sort((a, b) => a - b)
      shown = -1
      await runAll(
        jobs,
        passCTiles,
        (q) => {
          const list = seedAt.get(q)
          seedAt.delete(q)
          const a = passA[q]
          const job: WrapJob = {
            kind: 'c',
            plan,
            seedAt: list ? Uint32Array.from(list.at) : new Uint32Array(0),
            seedFoot: list ? Float32Array.from(list.foot) : new Float32Array(0),
            runs: runsOf(q),
            outside: outside[q],
            bandIdx: a?.bandIdx ?? new Uint32Array(0),
            bandDS: a?.bandDS ?? new Float32Array(0),
          }
          // Pass A's band is the job's now.
          if (a) {
            a.bandIdx = EMPTY_U32
            a.bandDS = EMPTY_F32
          }
          return job
        },
        (q, result) => {
          if (result.kind === 'c' && result.idx.length > 0) psi[q] = result
        },
        (done, of) => progress('measuring the distance from the outside', done, of),
        (q) => (seedAt.get(q)?.at.length ?? 0) + (passA[q]?.bandIdx.length ?? 0),
      )
      stage('Distance from the outside')
      if (memo) memo.field = field
    }

    // ---- 5. the wrap, tile by tile, welded ----------------------------------------------------------
    const m = T + 1
    const marchTiles: number[] = []
    for (let q = 0; q < tileCount; q++) {
      const I = tileI(q), J = tileJ(q), K = tileK(q)
      let any = psi[q] !== null
      for (let d = 1; d < 8 && !any; d++) {
        const I2 = I + (d & 1), J2 = J + ((d >> 1) & 1), K2 = K + ((d >> 2) & 1)
        if (I2 < tx && J2 < ty && K2 < tz && psi[tileOf(I2, J2, K2)] !== null) any = true
      }
      if (any) marchTiles.push(q)
    }
    const meshes: (TileMesh | null)[] = new Array(marchTiles.length).fill(null)
    const marchAt = new Map(marchTiles.map((q, w) => [q, w]))
    shown = -1
    await runAll(
      jobs,
      marchTiles,
      (q): WrapJob => {
        const I = tileI(q), J = tileJ(q), K = tileK(q)
        // The layer past the +X, +Y and +Z faces: which of its points are
        // outside, and the neighbours' field on it.
        const plusF = new Uint8Array(3 * m * m)
        // Read off the neighbours' runs a line at a time; the points on the
        // edges past two faces, a neighbour across an edge's, one by one.
        const xn = I + 1 < tx ? q + 1 : -1, yn = J + 1 < ty ? q + tx : -1, zn = K + 1 < tz ? q + tx * ty : -1
        for (let b = 0; b < T; b++) {
          for (let a = 0; a < T; a++) plusF[a + m * b] = xn < 0 ? 1 : startsOutside(xn, a + T * b)
          if (yn < 0) plusF.fill(1, m * m + m * b, m * m + m * b + T)
          else outsideAlong(yn, T * b, plusF, m * m + m * b)
          if (zn < 0) plusF.fill(1, 2 * m * m + m * b, 2 * m * m + m * b + T)
          else outsideAlong(zn, b, plusF, 2 * m * m + m * b)
        }
        for (let e = 0; e < m; e++) {
          plusF[T + m * e] = isF(I * T + T, J * T + T, K * T + e) ? 1 : 0
          plusF[e + m * T] = isF(I * T + T, J * T + e, K * T + T) ? 1 : 0
          plusF[m * m + T + m * e] = isF(I * T + T, J * T + T, K * T + e) ? 1 : 0
          plusF[m * m + e + m * T] = isF(I * T + e, J * T + T, K * T + T) ? 1 : 0
          plusF[2 * m * m + T + m * e] = isF(I * T + T, J * T + e, K * T + T) ? 1 : 0
          plusF[2 * m * m + e + m * T] = isF(I * T + e, J * T + T, K * T + T) ? 1 : 0
        }
        const plusIdx: number[] = []
        const plusPsi: number[] = []
        for (let d = 1; d < 8; d++) {
          const dI = d & 1, dJ = (d >> 1) & 1, dK = (d >> 2) & 1
          if (I + dI >= tx || J + dJ >= ty || K + dK >= tz) continue
          const field = psi[tileOf(I + dI, J + dJ, K + dK)]
          if (!field) continue
          for (let e = 0; e < field.lowIdx.length; e++) {
            const p = field.lowIdx[e]
            const li = p % T, lj = ((p / T) | 0) % T, lk = (p / T2) | 0
            // A neighbour's points on the plane it shares with this tile only.
            if ((dI && li !== 0) || (dJ && lj !== 0) || (dK && lk !== 0)) continue
            plusIdx.push(li + dI * T + m * (lj + dJ * T + m * (lk + dK * T)))
            plusPsi.push(field.lowPsi[e])
          }
        }
        const own = psi[q]
        return {
          kind: 'm',
          plan,
          I,
          J,
          K,
          runs: runsOf(q),
          outside: outside[q],
          psiIdx: own ? own.idx.slice() : new Uint32Array(0),
          psi: own ? own.psi.slice() : new Float32Array(0),
          plusF,
          plusIdx: Uint32Array.from(plusIdx),
          plusPsi: Float32Array.from(plusPsi),
        }
      },
      (q, result) => {
        if (result.kind === 'm' && result.mesh.indices.length > 0) meshes[marchAt.get(q)!] = result.mesh
      },
      (done, of) => progress('building the wrap', done, of),
      (q) => psi[q]?.idx.length ?? 0,
    )
    // Welded: a vertex on a plane two tiles share is one.
    let vertexTotal = 0
    let indexTotal = 0
    for (const mesh of meshes) {
      if (!mesh) continue
      vertexTotal += mesh.positions.length / 3
      indexTotal += mesh.indices.length
    }
    let wrapPos: Float32Array = new Float32Array(vertexTotal * 3)
    let wrapIdx: Uint32Array = new Uint32Array(indexTotal)
    {
      const shared = new Map<number, number>()
      let nv = 0
      let ni = 0
      for (let w = 0; w < marchTiles.length; w++) {
        const mesh = meshes[w]
        if (!mesh) continue
        const local = new Uint32Array(mesh.positions.length / 3)
        for (let v = 0; v < local.length; v++) {
          const key = mesh.keys[v]
          if (key >= 0) {
            const known = shared.get(key)
            if (known !== undefined) {
              local[v] = known
              continue
            }
            shared.set(key, nv)
          }
          local[v] = nv
          wrapPos[nv * 3] = mesh.positions[v * 3]
          wrapPos[nv * 3 + 1] = mesh.positions[v * 3 + 1]
          wrapPos[nv * 3 + 2] = mesh.positions[v * 3 + 2]
          nv++
        }
        for (let i = 0; i < mesh.indices.length; i++) wrapIdx[ni++] = local[mesh.indices[i]]
        meshes[w] = null
      }
      wrapPos = wrapPos.slice(0, nv * 3)
    }
    const left = dropSpecks(wrapPos, wrapIdx, MIN_SHELL_CELLS * h * h * h, 'out')
    wrapIdx = left.indices
    if (wrapIdx.length === 0) {
      const open = openEdgeCount(indices, positions.length / 3)
      if (open > 0 && grow === 0) {
        throw new Error(
          `Nothing to wrap — the mesh is an open surface (${open.toLocaleString('en-US')} open edges), and an open surface has no inside to wrap at Grow by 0. Grow it by half the thickness it should have.`,
        )
      }
      // units-ok: worked out in the worker, also the agent's answer
      throw new Error(`Nothing to wrap — nothing of the part is thicker than the grid's cell, ${fmt(h)} mm. Grow it, or close a larger gap.`)
    }
    stage('Building the wrap')

    // ---- 6. onto the part ------------------------------------------------------------------------------
    const nv = wrapPos.length / 3
    const normals = vertexNormals(wrapPos, wrapIdx)
    const snapped = new Uint8Array(nv)
    const offPart = new Float32Array(nv).fill(Infinity)
    const target = new Float32Array(nv * 3)
    const second = new Float32Array(nv * 3).fill(NaN)
    const facePlane = new Float32Array(nv * 3)
    {
      // The vertices by the tile they lie in.
      const used = new Uint8Array(nv)
      for (let i = 0; i < wrapIdx.length; i++) used[wrapIdx[i]] = 1
      const groups = new Map<number, number[]>()
      for (let v = 0; v < nv; v++) {
        if (!used[v]) continue
        const I = clampInt(Math.floor((wrapPos[v * 3] - plan.ox) / h / T), tx)
        const J = clampInt(Math.floor((wrapPos[v * 3 + 1] - plan.oy) / h / T), ty)
        const K = clampInt(Math.floor((wrapPos[v * 3 + 2] - plan.oz) / h / T), tz)
        const q = tileOf(I, J, K)
        let g = groups.get(q)
        if (!g) groups.set(q, (g = []))
        g.push(v)
      }
      const order = [...groups.keys()].sort((a, b) => a - b)
      shown = -1
      await runAll(
        jobs,
        order,
        (q): WrapJob => {
          const vs = groups.get(q)!
          const at = new Float32Array(vs.length * 3)
          const nn = new Float32Array(vs.length * 3)
          for (let e = 0; e < vs.length; e++) {
            for (let k = 0; k < 3; k++) {
              at[e * 3 + k] = wrapPos[vs[e] * 3 + k]
              nn[e * 3 + k] = normals[vs[e] * 3 + k]
            }
          }
          return { kind: 's', plan, I: tileI(q), J: tileJ(q), K: tileK(q), tri: trianglesOf(q), vertices: at, normals: nn, reach: SNAP_REACH, cosMin: SNAP_COS, offset: grow }
        },
        (q, found) => {
          if (found.kind !== 's') return
          const vs = groups.get(q)!
          for (let e = 0; e < vs.length; e++) {
            const v = vs[e]
            offPart[v] = found.distance[e]
            if (!found.found[e]) continue
            snapped[v] = 1
            target[v * 3] = found.to[e * 3]
            target[v * 3 + 1] = found.to[e * 3 + 1]
            target[v * 3 + 2] = found.to[e * 3 + 2]
            second[v * 3] = found.alt[e * 3]
            second[v * 3 + 1] = found.alt[e * 3 + 1]
            second[v * 3 + 2] = found.alt[e * 3 + 2]
            facePlane[v * 3] = found.plane[e * 3]
            facePlane[v * 3 + 1] = found.plane[e * 3 + 1]
            facePlane[v * 3 + 2] = found.plane[e * 3 + 2]
          }
        },
        (done, of) => progress('snapping onto the part', done, of),
        (q) => groups.get(q)!.length * (1 + Math.log2(1 + binStart[q + 1] - binStart[q])),
      )
      unfoldSnaps(wrapPos, wrapIdx, snapped, target, second)
    }
    let bridge: Uint8Array = new Uint8Array(nv)
    for (let v = 0; v < nv; v++) bridge[v] = !snapped[v] && offPart[v] > BRIDGE_CELLS * h ? 1 : 0
    stage('Snapping onto the part')

    // ---- sharp edges ------------------------------------------------------------------------------------
    // The part's own edges and corners put back where the grid rounded
    // them (wrapSharp.ts): at Grow by 0 only — grown, they are rounds.
    let sharpEdges = 0
    let sharpCorners = 0
    if (settings.edges === 'sharp' && grow === 0) {
      say('Wrapping — putting the edges back…')
      for (let v = 0; v < nv; v++) if (!snapped[v]) facePlane[v * 3] = facePlane[v * 3 + 1] = facePlane[v * 3 + 2] = 0
      /** How far each of `points` is from the part, by tile on the workers. */
      const probe = async (points: Float32Array): Promise<Float32Array> => {
        const n = points.length / 3
        const far = new Float32Array(n).fill(Infinity)
        const byTile = new Map<number, number[]>()
        for (let i = 0; i < n; i++) {
          const q = tileOf(
            clampInt(Math.floor((points[i * 3] - plan.ox) / h / T), tx),
            clampInt(Math.floor((points[i * 3 + 1] - plan.oy) / h / T), ty),
            clampInt(Math.floor((points[i * 3 + 2] - plan.oz) / h / T), tz),
          )
          let g = byTile.get(q)
          if (!g) byTile.set(q, (g = []))
          g.push(i)
        }
        await runAll(
          jobs,
          [...byTile.keys()].sort((a, b) => a - b),
          (q): WrapJob => {
            const list = byTile.get(q)!
            const at = new Float32Array(list.length * 3)
            for (let e = 0; e < list.length; e++) at.set(points.subarray(list[e] * 3, list[e] * 3 + 3), e * 3)
            return { kind: 's', plan, I: tileI(q), J: tileJ(q), K: tileK(q), tri: trianglesOf(q), vertices: at, normals: new Float32Array(list.length * 3), reach: 0.5, cosMin: 0, offset: 0 }
          },
          (q, found) => {
            if (found.kind !== 's') return
            const list = byTile.get(q)!
            for (let e = 0; e < list.length; e++) far[list[e]] = found.distance[e]
          },
        )
        return far
      }
      const sharp = await sharpen(wrapPos, wrapIdx, bridge, facePlane, h, probe)
      wrapPos = sharp.positions
      wrapIdx = sharp.indices
      bridge = sharp.bridge
      sharpEdges = sharp.edges
      sharpCorners = sharp.corners
      stage('Putting the edges back')
    }

    // ---- 7. reduced ---------------------------------------------------------------------------------------
    let outIdx: Uint32Array = wrapIdx
    if (simplifier) {
      say('Wrapping — reducing the wrap…')
      // Tiles of the grid; for the second pass tiles twice the size,
      // shifted half a tile, whose faces lie in the middle of the first's;
      // for the third four times the size, shifted a tile and a half, whose
      // faces miss both.
      const span = 1 / (h * T)
      const scale = [1, 2, 4], shift = [0, 0.5, 1.5]
      const dims = scale.map((k, l) => [tx, ty, tz].map((n) => Math.ceil((n + shift[l]) / k) + 1))
      const tileAt = (x: number, y: number, z: number, level: number) => {
        const k = scale[level], o = shift[level], [nx, ny, nz] = dims[level]
        const I = clampInt(Math.floor(((x - plan.ox) * span + o) / k), nx)
        const J = clampInt(Math.floor(((y - plan.oy) * span + o) / k), ny)
        const K = clampInt(Math.floor(((z - plan.oz) * span + o) / k), nz)
        return I + nx * (J + ny * K)
      }
      outIdx = await reduceManifold(jobs, wrapPos, wrapIdx, tileAt, Math.max(...dims.map(product)), settings.tolerance ?? h * REDUCE_SHARE, (text) =>
        say(`Wrapping — reducing the wrap${text}…`),
      )
    }
    const out = compactWithFlags(wrapPos, outIdx, bridge)
    stage('Reducing')

    // ---- the report -----------------------------------------------------------------------------------------
    // Input triangles inside the wrap: their middle more than a cell and a
    // half inside it.
    const lc = plan.lc
    let dropped = 0
    for (let t = 0; t < triangles; t++) {
      let cx = 0, cy = 0, cz = 0
      for (let k = 0; k < 3; k++) {
        const v = indices[t * 3 + k] * 3
        cx += positions[v]
        cy += positions[v + 1]
        cz += positions[v + 2]
      }
      const gi = Math.round((cx / 3 - plan.ox) / h), gj = Math.round((cy / 3 - plan.oy) / h), gk = Math.round((cz / 3 - plan.oz) / h)
      // In a tile the outside never reached: inside, and far.
      if (!settled[tileOf((gi / T) | 0, (gj / T) | 0, (gk / T) | 0)] || fieldAt(gi, gj, gk) < lc - 1.5) dropped++
    }
    function fieldAt(gi: number, gj: number, gk: number): number {
      const I = (gi / T) | 0, J = (gj / T) | 0, K = (gk / T) | 0
      const field = psi[tileOf(I, J, K)]
      const p = gi - I * T + T * (gj - J * T + T * (gk - K * T))
      if (field) {
        let lo = 0, hi = field.idx.length - 1
        while (lo <= hi) {
          const mid = (lo + hi) >> 1
          const x = field.idx[mid]
          if (x === p) return field.psi[mid]
          if (x < p) lo = mid + 1
          else hi = mid - 1
        }
      }
      return isF(gi, gj, gk) ? FAR_OUT : -FAR_OUT
    }
    let wrapArea = 0
    let bridgedArea = 0
    for (let t = 0; t < out.indices.length; t += 3) {
      const a = out.indices[t], b = out.indices[t + 1], c = out.indices[t + 2]
      const p = out.positions
      const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2]
      const vx = p[c * 3] - p[a * 3], vy = p[c * 3 + 1] - p[a * 3 + 1], vz = p[c * 3 + 2] - p[a * 3 + 2]
      const s = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2
      wrapArea += s
      bridgedArea += (s * (out.flags[a] + out.flags[b] + out.flags[c])) / 3
    }
    const { find: shellOf } = vertexComponents(out.indices, out.positions.length / 3)
    const shells = new Set<number>()
    for (let i = 0; i < out.indices.length; i += 3) shells.add(shellOf(out.indices[i]))
    const report: WrapReport = {
      settings: { ...settings },
      cell: h,
      coarsened,
      fullGap: coarsened ? round125(2 * CELLS_PER_R * h) : null,
      shells: shells.size,
      inputTriangles: triangles,
      dropped,
      triangles: out.indices.length / 3,
      vertices: out.positions.length / 3,
      area: wrapArea,
      bridgedArea,
      volume: signedVolume(out.positions, out.indices),
      stages,
      tiles: tileCount,
      tilesWorked: worked.length,
      sharpEdges,
      sharpCorners,
      warning: null,
    }
    // Next to nothing left of a mesh that is open: the ball got behind its
    // surface through an opening wider than the gap.
    if (grow === 0 && report.volume < 0.01 * (hx - lx) * (hy - ly) * (hz - lz)) {
      const open = openEdgeCount(indices, positions.length / 3)
      if (open > 0) {
        report.warning =
          `Little of the part is left: the mesh is open (${open.toLocaleString('en-US')} open edges), and where an opening is wider than the gap the ball gets behind the surface, which then has no inside. ` +
          'Close a gap wider than the widest opening, or grow it.'
      }
    }
    stage('Report')
    return { positions: out.positions, indices: out.indices, bridge: out.flags, report }
  }
}

const product = (xs: number[]) => xs.reduce((a, b) => a * b, 1)

/** Two hashes of the triangles — every bit of every corner they use, and
 *  their order — in one string. */
function fingerprint(positions: Float32Array, indices: Uint32Array): string {
  const bits = new Uint32Array(positions.buffer, positions.byteOffset, positions.length)
  let a = 0x811c9dc5, b = 0x9747b28c
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i]
    a = Math.imul(a ^ v, 0x01000193)
    b = Math.imul(b ^ v, 0x5bd1e995)
  }
  for (let i = 0; i < bits.length; i++) {
    const x = bits[i]
    a = Math.imul(a ^ x, 0x01000193)
    b = Math.imul(b ^ (x >>> 7), 0x5bd1e995) ^ (b >>> 13)
  }
  return `${indices.length}:${bits.length}:${(a >>> 0).toString(16)}:${(b >>> 0).toString(16)}`
}

/** What a wrap's first four steps leave: the grid, the triangles sorted
 *  into its tiles, each tile's free space and which of it is outside, and
 *  the signed field. None of it depends on Grow by but through how far the
 *  distance to the part was measured, `plan.dmaxS`. */
interface WrapField {
  key: string
  gap: number
  triangles: number
  plan: WrapPlan
  binStart: Uint32Array
  bins: Uint32Array
  passA: (TileA | null)[]
  settled: Uint8Array
  outside: Uint8Array[]
  psi: (TileField | null)[]
  worked: number[]
}

/** The field of the last wrap, kept for the next — by the wrap's worker,
 *  which lets it go with the worker, or when the next wrap is of another
 *  mesh or gap. */
export class WrapMemo {
  field: WrapField | null = null
}

/** A tile's field as pass C left it, with the points of it on its lower
 *  faces apart. */
type TileField = { idx: Uint32Array; psi: Float32Array; lowIdx: Uint32Array; lowPsi: Float32Array }

/** Disjoint sets that grow as tiles add their pieces; the lower root wins
 *  a join. */
class GrowingSets {
  private parent = new Int32Array(1024)
  private count = 0
  /** `n` new sets; the first one's number. */
  add(n: number): number {
    while (this.count + n > this.parent.length) {
      const bigger = new Int32Array(this.parent.length * 2)
      bigger.set(this.parent)
      this.parent = bigger
    }
    const first = this.count
    for (let i = 0; i < n; i++) this.parent[first + i] = first + i
    this.count += n
    return first
  }
  find(x: number): number {
    const p = this.parent
    while (p[x] !== x) {
      p[x] = p[p[x]]
      x = p[x]
    }
    return x
  }
  union(a: number, b: number): void {
    const ra = this.find(a), rb = this.find(b)
    if (ra < rb) this.parent[rb] = ra
    else if (rb < ra) this.parent[ra] = rb
  }
  same(a: number, b: number): boolean {
    return this.find(a) === this.find(b)
  }
}

/** The pieces of a tile's free space on each of its six faces (−X, +X, −Y,
 *  +Y, −Z, +Z), each once. */
function facePieces(a: TileRuns): Int32Array[] {
  const T = TILE
  const lists: Int32Array[] = []
  const seen = new Uint8Array(a.comps)
  for (let f = 0; f < 6; f++) {
    seen.fill(0)
    const list: number[] = []
    for (let L = 0; L < T * T; L++) {
      const j = L % T, k = (L / T) | 0
      if ((f === 2 && j !== 0) || (f === 3 && j !== T - 1) || (f === 4 && k !== 0) || (f === 5 && k !== T - 1)) continue
      for (let run = a.lineStart[L]; run < a.lineStart[L + 1]; run++) {
        if (f === 0 && a.runX[2 * run] !== 0) continue
        if (f === 1 && a.runX[2 * run + 1] !== T - 1) continue
        const c = a.runComp[run]
        if (seen[c]) continue
        seen[c] = 1
        list.push(c)
      }
    }
    lists.push(Int32Array.from(list))
  }
  return lists
}

const EMPTY_U32 = new Uint32Array(0)
const EMPTY_F32 = new Float32Array(0)
const EMPTY_U8 = new Uint8Array(0)
const EMPTY_I16 = new Int16Array(0)

/** A tile no triangle reaches: one run along every line, all one piece of
 *  free space. */
const WHOLE: TileRuns = (() => {
  const T = TILE
  const lineStart = new Uint32Array(T * T + 1)
  for (let L = 0; L <= T * T; L++) lineStart[L] = L
  const runX = new Uint8Array(2 * T * T)
  for (let L = 0; L < T * T; L++) runX[2 * L + 1] = T - 1
  return { lineStart, runX, runComp: new Int32Array(T * T), comps: 1 }
})()

/** A tile the outside has not reached: no free space of its own. */
const NONE: TileRuns = { lineStart: new Uint32Array(TILE * TILE + 1), runX: new Uint8Array(0), runComp: new Int32Array(0), comps: 0 }

/** Every run of line `La` of tile `a` joined to those of line `Lb` of tile
 *  `b` it overlaps along X — two lines facing each other across a face. */
function joinAcross(a: TileRuns, La: number, baseA: number, b: TileRuns, Lb: number, baseB: number, union: (x: number, y: number) => void): void {
  let i = a.lineStart[La], j = b.lineStart[Lb]
  const ie = a.lineStart[La + 1], je = b.lineStart[Lb + 1]
  while (i < ie && j < je) {
    const as = a.runX[2 * i], ae = a.runX[2 * i + 1]
    const bs = b.runX[2 * j], be = b.runX[2 * j + 1]
    if (as <= be && bs <= ae) union(baseA + a.runComp[i], baseB + b.runComp[j])
    if (ae < be) i++
    else j++
  }
}

const clampInt = (x: number, n: number) => (x < 0 ? 0 : x >= n ? n - 1 : x)

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

/** Each vertex's normal: the sum of its triangles' areas times their
 *  normals, made unit. */
function vertexNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
  const n = new Float32Array(positions.length)
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2]
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2]
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx
    for (const v of [a, b, c]) {
      n[v] += cx
      n[v + 1] += cy
      n[v + 2] += cz
    }
  }
  for (let v = 0; v < n.length; v += 3) {
    const len = Math.hypot(n[v], n[v + 1], n[v + 2])
    if (len > 0) {
      n[v] /= len
      n[v + 1] /= len
      n[v + 2] /= len
    }
  }
  return n
}

/** Rounds of moves: a vertex held back because a neighbour not yet moved
 *  would have folded may go once that one has. */
const SNAP_PASSES = 4

/**
 * Move each vertex `snapped` says to its `target`, one after another in
 * their order — unless that turns a triangle round it over against the way
 * it faced as the grid made it, or puts it where a vertex moved before it
 * already is (a corner of the part, which every vertex round it is nearest
 * to — then its `second`, the foot on its triangle's plane, is tried, where
 * there is one): then it stays for this round, and is tried again in the
 * next. Two
 * vertices in one place would be one to the reduction, which would join the
 * wrap to itself there. `snapped` is left saying which moved.
 */
function unfoldSnaps(positions: Float32Array, indices: Uint32Array, snapped: Uint8Array, target: Float32Array, second: Float32Array): void {
  const nv = positions.length / 3
  const start = new Uint32Array(nv + 1)
  for (let i = 0; i < indices.length; i++) start[indices[i] + 1]++
  for (let v = 0; v < nv; v++) start[v + 1] += start[v]
  const around = new Uint32Array(indices.length)
  const at = start.slice(0, nv)
  for (let i = 0; i < indices.length; i++) around[at[indices[i]]++] = (i / 3) | 0
  // Each triangle's normal as the grid made it.
  const faced = new Float32Array(indices.length)
  const cross = (t: number, out: Float32Array | Float64Array, o: number) => {
    const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3
    const p = positions
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2]
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2]
    out[o] = uy * vz - uz * vy
    out[o + 1] = uz * vx - ux * vz
    out[o + 2] = ux * vy - uy * vx
  }
  for (let t = 0; t < indices.length / 3; t++) cross(t, faced, t * 3)
  const now3 = new Float64Array(3)
  const bits = new Uint32Array(target.buffer, target.byteOffset, target.length)
  const placeOf = (v: number) => (Math.imul(bits[v * 3], 73856093) ^ Math.imul(bits[v * 3 + 1], 19349663) ^ Math.imul(bits[v * 3 + 2], 83492791)) >>> 0
  const sameTarget = (v: number, w: number) => bits[v * 3] === bits[w * 3] && bits[v * 3 + 1] === bits[w * 3 + 1] && bits[v * 3 + 2] === bits[w * 3 + 2]
  // The places taken, by vertex: an open-addressed table twice the size of
  // the vertices that may move, −1 where empty.
  let size = 1024
  for (let v = 0; v < nv; v++) if (snapped[v]) size++
  const slots = 1 << Math.ceil(Math.log2(2 * size))
  const table = new Int32Array(slots).fill(-1)
  const mask = slots - 1
  /** Whether a vertex already moved is where v's target is. */
  const isTaken = (v: number): boolean => {
    for (let at = placeOf(v) & mask; table[at] >= 0; at = (at + 1) & mask) if (sameTarget(v, table[at])) return true
    return false
  }
  const take = (v: number) => {
    let at = placeOf(v) & mask
    while (table[at] >= 0) at = (at + 1) & mask
    table[at] = v
  }
  const waiting = snapped.slice()
  snapped.fill(0)
  for (let pass = 0; pass < SNAP_PASSES; pass++) {
    let moved = 0
    for (let v = 0; v < nv; v++) {
      if (!waiting[v]) continue
      if (isTaken(v)) {
        // Taken: the foot on its triangle's plane, where there is one.
        if (Number.isNaN(second[v * 3])) {
          waiting[v] = 0
          continue
        }
        target[v * 3] = second[v * 3]
        target[v * 3 + 1] = second[v * 3 + 1]
        target[v * 3 + 2] = second[v * 3 + 2]
        second[v * 3] = NaN
        if (isTaken(v)) {
          waiting[v] = 0
          continue
        }
      }
      const x = positions[v * 3], y = positions[v * 3 + 1], z = positions[v * 3 + 2]
      positions[v * 3] = target[v * 3]
      positions[v * 3 + 1] = target[v * 3 + 1]
      positions[v * 3 + 2] = target[v * 3 + 2]
      let folds = false
      for (let e = start[v]; e < start[v + 1] && !folds; e++) {
        const t = around[e]
        cross(t, now3, 0)
        if (now3[0] * faced[t * 3] + now3[1] * faced[t * 3 + 1] + now3[2] * faced[t * 3 + 2] <= 0) folds = true
      }
      if (folds) {
        positions[v * 3] = x
        positions[v * 3 + 1] = y
        positions[v * 3 + 2] = z
        continue
      }
      waiting[v] = 0
      snapped[v] = 1
      moved++
      take(v)
    }
    if (moved === 0) break
  }
}

/** Reductions tried, each with more vertices held, before the wrap is left
 *  as the grid made it. */
const MAX_REDUCE_PASSES = 6

/**
 * The wrap reduced to within `tolerance`, and still a closed manifold.
 *
 * In pieces, on the runner's workers: first the triangles of each tile —
 * whose middle lies in it — the vertices the tile shares with the next held
 * where they are; then the same again on tiles twice the size, shifted half
 * a tile along all three axes, whose shared vertices lie in the middle of
 * the first ones, so every vertex has been a tile's own in one of the two;
 * and once more on tiles four times the size, so a flat face larger than a
 * tile comes down to fewer triangles. The
 * simplifier, given millions of triangles at once, stops long before the
 * tolerance would let it and takes minutes getting there; given a tile's
 * thousands it is done in milliseconds, and each call is repeated while it
 * still takes a good share off. `tileOf` gives the tile of a point at each
 * `level` of the three, as a number below `tiles`.
 *
 * The simplifier does not check that an edge it collapses leaves every edge
 * round it with two triangles, and where snapping has laid thin triangles
 * flat on a face of the part it cannot see one turn over: wherever the
 * result has an edge one or three triangles share, the vertices there and
 * round them are held too, and the whole is reduced again from the start.
 * Left as it was if that does not settle it.
 */
async function reduceManifold(
  jobs: WrapRunner,
  positions: Float32Array,
  indices: Uint32Array,
  tileOf: (x: number, y: number, z: number, level: number) => number,
  tiles: number,
  tolerance: number,
  onPass: (text: string) => void,
): Promise<Uint32Array> {
  const nv = positions.length / 3
  const held = new Uint8Array(nv)
  /** Hold the vertices of `faults` and those round them in the wrap as the
   *  grid made it. */
  const holdAround = (faults: number[]) => {
    const fault = new Uint8Array(nv)
    for (const v of faults) fault[v] = 1
    for (let t = 0; t < indices.length; t += 3) {
      const a = indices[t], b = indices[t + 1], c = indices[t + 2]
      if (fault[a] | fault[b] | fault[c]) held[a] = held[b] = held[c] = 1
    }
  }
  const local = new Int32Array(nv).fill(-1)
  const firstTile = new Int32Array(nv)
  const seam = new Uint8Array(nv)
  /** `current` reduced tile by tile, the tiles shifted or not. */
  const reduceInTiles = async (current: Uint32Array, level: number): Promise<Uint32Array> => {
    const count = current.length / 3
    // The triangles by tile, in order: counted, then placed.
    const tileOfTri = new Int32Array(count)
    const tileStart = new Uint32Array(tiles + 1)
    for (let t = 0; t < count; t++) {
      const a = current[t * 3] * 3, b = current[t * 3 + 1] * 3, c = current[t * 3 + 2] * 3
      const q = tileOf(
        (positions[a] + positions[b] + positions[c]) / 3,
        (positions[a + 1] + positions[b + 1] + positions[c + 1]) / 3,
        (positions[a + 2] + positions[b + 2] + positions[c + 2]) / 3,
        level,
      )
      tileOfTri[t] = q
      tileStart[q + 1]++
    }
    for (let q = 0; q < tiles; q++) tileStart[q + 1] += tileStart[q]
    const order = new Uint32Array(count)
    {
      const fill = tileStart.slice(0, tiles)
      for (let t = 0; t < count; t++) order[fill[tileOfTri[t]]++] = t
    }
    // Shared: a vertex with triangles in two tiles.
    firstTile.fill(-1)
    seam.fill(0)
    for (let t = 0; t < count; t++) {
      for (let k = 0; k < 3; k++) {
        const v = current[t * 3 + k]
        if (firstTile[v] < 0) firstTile[v] = tileOfTri[t]
        else if (firstTile[v] !== tileOfTri[t]) seam[v] = 1
      }
    }
    const spans: number[] = []
    for (let q = 0; q < tiles; q++) if (tileStart[q + 1] > tileStart[q]) spans.push(q)
    const parts: Uint32Array[] = new Array(spans.length)
    const vertsOf: number[][] = new Array(spans.length)
    await runAll(
      jobs,
      spans.map((_, i) => i),
      (i): WrapJob => {
        const from = tileStart[spans[i]], to = tileStart[spans[i] + 1]
        const verts: number[] = []
        const tri = new Uint32Array((to - from) * 3)
        for (let e = from; e < to; e++) {
          for (let k = 0; k < 3; k++) {
            const v = current[order[e] * 3 + k]
            if (local[v] < 0) {
              local[v] = verts.length
              verts.push(v)
            }
            tri[(e - from) * 3 + k] = local[v]
          }
        }
        const pos = new Float32Array(verts.length * 3)
        const lock = new Uint8Array(verts.length)
        for (let j = 0; j < verts.length; j++) {
          const v = verts[j]
          pos[j * 3] = positions[v * 3]
          pos[j * 3 + 1] = positions[v * 3 + 1]
          pos[j * 3 + 2] = positions[v * 3 + 2]
          lock[j] = seam[v] | held[v]
          local[v] = -1
        }
        vertsOf[i] = verts
        return { kind: 'r', indices: tri, positions: pos, lock, tolerance }
      },
      (i, result) => {
        if (result.kind !== 'r') return
        const verts = vertsOf[i]
        const back = new Uint32Array(result.indices.length)
        for (let j = 0; j < back.length; j++) back[j] = verts[result.indices[j]]
        parts[i] = back
        vertsOf[i] = []
      },
      undefined,
      (i) => tileStart[spans[i] + 1] - tileStart[spans[i]],
    )
    let total = 0
    for (const p of parts) total += p.length
    const joined = new Uint32Array(total)
    total = 0
    for (const p of parts) {
      joined.set(p, total)
      total += p.length
    }
    return joined
  }
  for (let pass = 1; pass <= MAX_REDUCE_PASSES; pass++) {
    if (pass > 1) onPass(`, pass ${pass}`)
    let reduced = indices
    for (let level = 0; level < 3; level++) reduced = await reduceInTiles(reduced, level)
    if (reduced.length === 0) return indices
    const faults = manifoldFaults(reduced, nv)
    if (faults.length === 0) return reduced
    holdAround(faults)
  }
  return indices
}

/** The vertices of every edge that does not have exactly two triangles, one
 *  each way round. Each vertex's edges out sorted, so a reduced face's fan of
 *  thousands round one vertex costs no more than its length. */
function manifoldFaults(indices: Uint32Array, vertexCount: number): number[] {
  const { offsets, to } = halfEdges(indices, vertexCount)
  for (let a = 0; a < vertexCount; a++) if (offsets[a + 1] - offsets[a] > 1) to.subarray(offsets[a], offsets[a + 1]).sort()
  /** How many of a's edges go to b. */
  const edgesTo = (a: number, b: number): number => {
    let lo = offsets[a], hi = offsets[a + 1]
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (to[mid] < b) lo = mid + 1
      else hi = mid
    }
    let n = 0
    while (lo < offsets[a + 1] && to[lo] === b) {
      n++
      lo++
    }
    return n
  }
  const out: number[] = []
  for (let a = 0; a < vertexCount; a++) {
    for (let e = offsets[a]; e < offsets[a + 1]; e++) {
      const b = to[e]
      if (e > offsets[a] && to[e - 1] === b) {
        out.push(a, b)
        continue
      }
      if (edgesTo(b, a) !== 1 || (e + 1 < offsets[a + 1] && to[e + 1] === b)) out.push(a, b)
    }
  }
  return out
}

/** The mesh on the vertices its triangles use, in the order they first
 *  come, each with its flag. */
function compactWithFlags(positions: Float32Array, indices: Uint32Array, flags: Uint8Array): { positions: Float32Array; indices: Uint32Array; flags: Uint8Array } {
  const remap = new Int32Array(positions.length / 3).fill(-1)
  let n = 0
  for (let i = 0; i < indices.length; i++) if (remap[indices[i]] < 0) remap[indices[i]] = n++
  const outPositions = new Float32Array(n * 3)
  const outFlags = new Uint8Array(n)
  const outIndices = new Uint32Array(indices.length)
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i]
    const w = remap[v]
    outIndices[i] = w
    outPositions[w * 3] = positions[v * 3]
    outPositions[w * 3 + 1] = positions[v * 3 + 1]
    outPositions[w * 3 + 2] = positions[v * 3 + 2]
    outFlags[w] = flags[v]
  }
  return { positions: outPositions, indices: outIndices, flags: outFlags }
}

