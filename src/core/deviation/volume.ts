// SPDX-License-Identifier: AGPL-3.0-only
// The deviation as volumes: on a grid over the part, each cell is asked
// whether it lies inside the reference and whether inside the scan, and the
// cells where the answers differ, grouped into connected regions, are
// material the reference has and the part has not (excess) or the part has
// and the reference has not (missing) — so many cubic millimetres, so deep,
// wherever they sit, behind a wall or inside a cavity alike.
//
// Inside the reference is exact where it is closed: a column of cells along
// Z counts the crossings below each cell, in through down-facing triangles
// and out through up-facing ones. A column whose crossings do not cancel
// runs through a hole in the reference, and is read from the closed columns
// beside it. Inside the scan is its winding number (see winding.ts): about 1
// inside and 0 outside, easing towards ½ near holes.
// Where nothing was scanned the reference's own triangles stand in — the
// readings of the map on the reference with no scan behind them — so the
// scan is closed by the reference where it says nothing, and the two
// cannot disagree there. What stays unclear after that is unsure: told
// apart, never called an error. A cell within the tolerance of the scan's
// surface is the scan's noise, not an error, whatever the answers.

import type { Vec3 } from '../types'
import { rigidApply, rigidInvert, type Rigid } from './rigid'
import { emptyHit, NominalSurface } from './surface'
import { WindingTree } from './winding'
import { subdivideForMap, type ReferenceSamples } from './onReference'
import { edgeKey, rimLoops, type RimLoop } from '../geometry/openEdges'

export interface VolumeMesh {
  positions: Float32Array
  indices: Uint32Array
}

export type VolumeKind = 'excess' | 'missing' | 'unsure'

export interface VolumeDeviationOptions {
  /** In the reference's frame. Closed, or the answer's `referenceOpen` says
   *  where it is not. */
  reference: VolumeMesh
  /** In the scan's frame. */
  scan: VolumeMesh
  /** Takes the scan's coordinates into the reference's. */
  toReference: Rigid
  /** The patch offered as it is, in the reference's frame (see
   *  noScanPatchOf) — in place of the one made from `referenceMap` and the
   *  reference far from the scan. */
  noScanPatch?: VolumeMesh | null
  /** The map on the reference, when one is current: its pieces read as no
   *  scan are offered as patch. */
  referenceMap?: { samples: ReferenceSamples; values: Float32Array }
  /** False offers no reference far from the scan as patch; with no map
   *  either, there is no patch. */
  farPatch?: boolean
  /** T, mm: a disagreement within this of the scan's surface is noise. */
  tolerance: number
  /** The cell's side, mm; by default see defaultCell. */
  cell?: number
  /** The winding numbers read as unsure; default [0.3, 0.7]. */
  unsure?: [number, number]
  /** Only this box of the reference's frame is looked at. */
  within?: { min: Vec3; max: Vec3 }
  /** Boxes in the reference's frame to count the disagreeing volume in,
   *  by kind — for checking against what is known to be there. */
  count?: { min: Vec3; max: Vec3 }[]
  /** Hand back each kind's regions as a surface to draw (VolumeShell). */
  meshes?: boolean
  /** Which of the patch is taken: 'rims' (default), where its border
   *  runs along the scan's open rims; 'open', where the scan's own winding
   *  number is near ½ (PATCH_OPEN); 'all' of it. */
  patchRule?: 'rims' | 'open' | 'all'
  /** The scan's open rims walked round (rimLoops), when the caller keeps
   *  them — the worker does. */
  scanRims?: readonly RimLoop[]
  /** For the trees built here; see DEFAULT_BETA. */
  beta?: number
  /** Built already over `scan` — the worker keeps both — so not again. */
  scanSurface?: NominalSurface
  scanTree?: WindingTree
  /** What it is doing, and how far it has got over all, 0 to 1. */
  onProgress?: (text: string, fraction: number) => void
}

export interface VolumeRegion {
  kind: VolumeKind
  cells: number
  /** mm³. */
  volume: number
  /** The farthest any of its cells lies from the scan's surface, mm. */
  maxDepth: number
  /** Its volume over the area it shares with the reference's surface or
   *  with the scan's, whichever is the less, mm: a layer (a face standing
   *  0.4 mm off) is about that thick, a lump (a boss missing) about its
   *  height. */
  thickness: number
  box: { min: Vec3; max: Vec3 }
  centroid: Vec3
  /** The centre of its cell farthest from the scan's surface. */
  deepest: Vec3
  /** The reference triangle nearest that point, by its index in
   *  `reference.indices` (÷ 3). */
  referenceTriangle: number
  /** Of its cells bounded by the scan's side, the share the real scan
   *  bounds rather than the patch: 1 with no patch. */
  evidence: number
  /** The mean over its cells of |w − ½| · 2: 1 crisp, 0 a coin toss. */
  confidence: number
}

/** Regions drawn: the outer faces of their cells, wound outward, two
 *  triangles a face, with the region (its index in `regions`) of each
 *  triangle. */
export interface VolumeShell {
  positions: Float32Array
  indices: Uint32Array
  region: Uint32Array
}

export interface VolumeTotal {
  /** mm³. */
  volume: number
  /** Of the reference's volume, %. */
  share: number
}

export interface VolumeDeviation {
  /** The cell's side used, mm, and the thinnest thing it can see — two
   *  cells. */
  cell: number
  smallestSeen: number
  grid: { min: Vec3; dims: [number, number, number] }
  /** The reference's volume on the grid, mm³. */
  modelVolume: number
  /** The columns of cells through a hole in the reference, read from the
   *  closed columns beside them (see openColumns): how many and the box of
   *  their crossings. Null where it is closed over the grid. */
  referenceOpen: { columns: number; box: { min: Vec3; max: Vec3 } } | null
  totals: Record<VolumeKind, VolumeTotal>
  /** Disagreeing volume in regions too small to keep (under
   *  MIN_REGION_CELLS), mm³. */
  specks: number
  /** Largest first. */
  regions: VolumeRegion[]
  /** The patch's triangles as offered (cut short) and as kept, and the
   *  kept area, mm²; the scan's rims probed and found open; the patch's
   *  cells, those on its border, those of them along open rims, and the
   *  cells kept. */
  patch: { offered: number; offeredArea: number; kept: number; area: number; rimsProbed: number; rimsOpen: number; cells: number; border: number; borderAlongRims: number; keptCells: number }
  /** For each of `count`'s boxes, the disagreeing volume in it by kind
   *  after the tolerance band, specks included, mm³. */
  counted: Record<VolumeKind, number>[]
  /** With `meshes`: each kind's regions as one surface. */
  meshes: Record<VolumeKind, VolumeShell> | null
  /** −1 when the scan came in wound inside out. */
  scanSign: 1 | -1
  queries: { coarse: number; fine: number }
  /** What each stage took, ms. */
  timings: { tree: number; surface: number; model: number; offered: number; coarse: number; patch: number; fine: number; band: number; components: number; depth: number; total: number }
  /** What the grids and trees held at the most, bytes. */
  bytes: number
}

/** The coarse grid's cell is this many fine ones along each side. */
const COARSE = 4
/** The most cells the grid may have; past it the cell grows. */
export const MAX_CELLS = 16_000_000
/** Cells along the reference's longest side, by default. */
const CELLS_ALONG = 250
/** Regions under this many cells are specks: dropped. */
export const MIN_REGION_CELLS = 8
/** A coarse cell whose winding number is within this of ½ is read again
 *  cell by cell, with its neighbours. */
const NEAR_HALF = 0.4
const DEFAULT_UNSURE: [number, number] = [0.3, 0.7]
/** The grid takes in the reference grown by this many tolerances… */
const PAD_TOLERANCES = 10
/** …and the scan, up to this share of the reference's longest side past
 *  it: material the reference lacks outside its own box is the case this is
 *  for, a turntable under the part is not. */
const SCAN_REACH = 0.25
/** The longest a patch triangle's edge may be, in cells: shorter costs
 *  triangles faster than it saves queries. */
const PATCH_EDGE_CELLS = 8
/** Reference farther than FAR_CELLS cells (or FAR_MM, the more) from any
 *  scan is offered as patch, read on the reference cut FAR_SPACING_CELLS
 *  cells apart when there is no map. */
const FAR_CELLS = 4
const FAR_MM = 1
const FAR_SPACING_CELLS = 2
/** With patchRule 'open', a patch triangle is kept where the scan's own
 *  winding number is within this of ½. */
const PATCH_OPEN = 0.3
/** A patch cell on the border lies along an open rim of the scan's when
 *  one is within RIM_NEAR_CELLS cells, or RIM_NEAR_MM, the more. */
const RIM_NEAR_CELLS = 6
/** A rim is open where the scan's winding number RIM_PROBE_CELLS cells past
 *  it is within RIM_OPEN of ½. The far skin of a thin wall cut through
 *  pulls it off ½ by up to about ¼; a hole's wall beside a crease the scan
 *  left open, to about 0.1 or 0.9. */
const RIM_PROBE_CELLS = 3
const RIM_OPEN = 0.4
const RIM_NEAR_MM = 2
/** The trees' β here: the winding number is held against 0.3, ½ and 0.7,
 *  and an error near 2e-2 is nothing to that, at half the nodes β = 2
 *  opens. */
export const DEFAULT_VOLUME_BETA = 1.5
/** Cell flags: what passes through a cell, and the marks of the passes. */
const F_REF = 1, F_PATCH = 2, F_SCAN = 4, F_BAND = 8, F_SEEN = 16, F_KEEP = 32
const KIND_OF = [null, 'excess', 'missing', 'unsure'] as const
const VISITED = 0x80

/** The cell for a tolerance on a reference this long: half the tolerance,
 *  or 1/250 of the longest side, whichever is the larger. */
export function defaultCell(tolerance: number, longest: number): number {
  return Math.max(tolerance / 2, longest / CELLS_ALONG)
}

export function volumeDeviation(o: VolumeDeviationOptions): VolumeDeviation {
  const progress = o.onProgress ?? (() => {})
  const tStart = performance.now()
  const T = o.tolerance
  const [unsureLo, unsureHi] = o.unsure ?? DEFAULT_UNSURE
  const toScan = rigidInvert(o.toReference)
  const timings = { tree: 0, surface: 0, model: 0, offered: 0, coarse: 0, patch: 0, fine: 0, band: 0, components: 0, depth: 0, total: 0 }

  let t = performance.now()
  progress('Building the winding trees…', 0)
  const scanTree = o.scanTree ?? new WindingTree(o.scan.positions, o.scan.indices, { beta: o.beta ?? DEFAULT_VOLUME_BETA })
  timings.tree = performance.now() - t
  t = performance.now()
  progress('Preparing the surfaces…', 0.01)
  const scanSurface = o.scanSurface ?? new NominalSurface(o.scan.positions, o.scan.indices)
  const refSurface = new NominalSurface(o.reference.positions, o.reference.indices)
  timings.surface = performance.now() - t

  // The grid.
  const refBox = boxOf(o.reference.positions, null)
  const longest = Math.max(refBox.max[0] - refBox.min[0], refBox.max[1] - refBox.min[1], refBox.max[2] - refBox.min[2])
  const scanBox = boxOf(o.scan.positions, o.toReference)
  const reach = SCAN_REACH * longest
  const lo: Vec3 = [0, 0, 0]
  const hi: Vec3 = [0, 0, 0]
  for (let k = 0; k < 3; k++) {
    lo[k] = Math.min(refBox.min[k] - PAD_TOLERANCES * T, Math.max(scanBox.min[k], refBox.min[k] - reach))
    hi[k] = Math.max(refBox.max[k] + PAD_TOLERANCES * T, Math.min(scanBox.max[k], refBox.max[k] + reach))
    if (o.within) {
      lo[k] = Math.max(lo[k], o.within.min[k])
      hi[k] = Math.min(hi[k], o.within.max[k])
    }
  }
  let h = o.cell ?? defaultCell(T, longest)
  const cellsAt = (s: number) => [0, 1, 2].reduce((n, k) => n * Math.max(1, Math.ceil((hi[k] - lo[k]) / s)), 1)
  while (cellsAt(h) > MAX_CELLS) h *= 1.05
  const nx = Math.max(1, Math.ceil((hi[0] - lo[0]) / h))
  const ny = Math.max(1, Math.ceil((hi[1] - lo[1]) / h))
  const nz = Math.max(1, Math.ceil((hi[2] - lo[2]) / h))
  const nxy = nx * ny
  const n = nxy * nz
  const ox = lo[0], oy = lo[1], oz = lo[2]

  // What the patch is cut from: the reference no scan stands behind — the
  // pieces of the map on the reference read as no scan, when there is one —
  // and the reference no scan stands near at all. The map misses a hole in
  // a thin wall whose faces another face looks the same way past; a face
  // far from any scan cannot be missed. Neither is a hole of the scan's for
  // that: the rims decide (patchRule). A patch of long slivers — the
  // reference's own on a cylinder, the map's pieces at the patch's rim —
  // cannot be read from afar by the tree: a node's reach is its longest
  // triangle's. Halved along their longest edges they cover the same
  // surface in pieces it can gather.
  const loops = o.scanRims ?? rimLoops(o.scan.indices)
  t = performance.now()
  progress('Finding what of the reference no scan stands near…', 0.02)
  let offered: VolumeMesh | null = null
  // The same reference cut both ways, for telling where the patch borders
  // on scanned reference: stamped from one cut, the two meet only where
  // they meet. Cut two ways, one would catch a cell the other misses all
  // over a face.
  let pieces: { scanned: VolumeMesh; bare: VolumeMesh } | null = null
  if (o.noScanPatch) offered = o.noScanPatch.indices.length > 0 ? o.noScanPatch : null
  else if (o.referenceMap || o.farPatch !== false) {
    const samples = o.referenceMap?.samples ?? subdivideForMap(o.reference.positions, o.reference.indices, null, FAR_SPACING_CELLS * h)
    const values = o.referenceMap ? o.referenceMap.values.slice() : new Float32Array(samples.positions.length / 3)
    if (o.farPatch !== false) {
      // Far from any scan, or looking across to the scan's rim: the nearest
      // scan on an open edge of it, farther off than the scan's noise. Past
      // a hole's rim the reference sees the rim beside it; on the scanned
      // side the scan lies under it.
      const far = Math.max(FAR_CELLS * h, FAR_MM)
      const off = Math.max(T, h / 2)
      const rimEdges = new Set<number>()
      const rimKey = edgeKey(o.scan.positions.length / 3)
      for (const loop of loops) {
        const V = loop.vertices
        for (let e = 0; e < loop.triangles.length; e++) rimEdges.add(rimKey(V[e], V[(e + 1) % V.length]))
      }
      const S = o.scan.positions, SI = scanSurface.index
      const q = new Float64Array(3)
      const near = emptyHit()
      for (let v = 0; v < values.length; v++) {
        if (Number.isNaN(values[v])) continue
        rigidApply(toScan, samples.positions[v * 3], samples.positions[v * 3 + 1], samples.positions[v * 3 + 2], q)
        if (!(scanSurface.closest(q[0], q[1], q[2], near, far) && near.distance <= far)) {
          values[v] = NaN
          continue
        }
        if (near.distance <= off || rimEdges.size === 0) continue
        const f = near.faceIndex * 3
        for (let k = 0; k < 3; k++) {
          const a = SI[f + k], b = SI[f + ((k + 1) % 3)]
          if (!rimEdges.has(rimKey(a, b))) continue
          if (segmentDistance(near.px, near.py, near.pz, S, a, b) < 1e-3 * h) {
            values[v] = NaN
            break
          }
        }
      }
    }
    const bare = noScanPatchOf(o.reference, samples, values)
    offered = bare.indices.length > 0 ? bare : null
    const isBare = (t: number) => Number.isNaN(values[samples.indices[t * 3]]) || Number.isNaN(values[samples.indices[t * 3 + 1]]) || Number.isNaN(values[samples.indices[t * 3 + 2]])
    pieces = { scanned: piecesWhere(samples, (t) => !isBare(t)), bare: piecesWhere(samples, isBare) }
  }
  if (offered) offered = compact(offered, PATCH_EDGE_CELLS * h)
  timings.offered = performance.now() - t

  // Inside the reference.
  t = performance.now()
  progress('Finding the inside of the reference…', 0.05)
  const { inside: model, referenceOpen } = modelInside(o.reference, ox, oy, oz, h, nx, ny, nz)
  let modelCells = 0
  for (let i = 0; i < n; i++) modelCells += model[i]
  timings.model = performance.now() - t

  // The scan's winding number, in the reference's frame, the patch added.
  const p = new Float64Array(3)
  const rawScan = (x: number, y: number, z: number): number => {
    rigidApply(toScan, x, y, z, p)
    return scanTree.at(p[0], p[1], p[2])
  }
  const scanSign = settleSign(model, nx, ny, nz, (i, j, k) => rawScan(ox + (i + 0.5) * h, oy + (j + 0.5) * h, oz + (k + 0.5) * h))

  // Coarse, then cell by cell where the coarse value cannot be trusted.
  t = performance.now()
  progress('Reading the scan on a coarse grid…', 0.06)
  const cx = Math.ceil(nx / COARSE), cy = Math.ceil(ny / COARSE), cz = Math.ceil(nz / COARSE)
  const cn = cx * cy * cz
  const coarse = new Float32Array(cn)
  const half = (COARSE / 2) * h
  const coarseAt = (i: number, j: number, k: number): Vec3 => [ox + i * COARSE * h + half, oy + j * COARSE * h + half, oz + k * COARSE * h + half]
  for (let k = 0; k < cz; k++) {
    for (let j = 0; j < cy; j++) {
      for (let i = 0; i < cx; i++) {
        const [x, y, z] = coarseAt(i, j, k)
        coarse[i + cx * (j + cy * k)] = scanSign * rawScan(x, y, z)
      }
    }
    if (k % 4 === 0) progress('Reading the scan on a coarse grid…', 0.06 + (0.04 * k) / cz)
  }
  timings.coarse = performance.now() - t
  const coarseQueries = cn

  // Cell flags: what passes through each cell.
  t = performance.now()
  const flags = new Uint8Array(n)
  const stampInto = (mesh: VolumeMesh, transform: Rigid | null, bit: number) => stamp(flags, bit, mesh, transform, ox, oy, oz, h, nx, ny, nz)
  const rule = o.patchRule ?? 'rims'
  let patch: VolumeMesh | null = offered
  const rims = { probed: 0, open: 0, cells: 0, border: 0, along: 0, keptCells: 0 }
  if (offered && rule === 'open') {
    // Where the scan's own winding number is about ½ (see PATCH_OPEN).
    const { positions: P, indices: I } = offered
    const kept: number[] = []
    for (let tt = 0; tt < I.length; tt += 3) {
      const a = I[tt] * 3, b = I[tt + 1] * 3, c = I[tt + 2] * 3
      const w = trilinear(coarse, cx, cy, cz, ((P[a] + P[b] + P[c]) / 3 - ox - half) / (COARSE * h), ((P[a + 1] + P[b + 1] + P[c + 1]) / 3 - oy - half) / (COARSE * h), ((P[a + 2] + P[b + 2] + P[c + 2]) / 3 - oz - half) / (COARSE * h))
      if (Math.abs(w - 0.5) < PATCH_OPEN) kept.push(I[tt], I[tt + 1], I[tt + 2])
    }
    patch = kept.length > 0 ? { positions: P, indices: Uint32Array.from(kept) } : null
  } else if (offered && rule === 'rims') {
    // The patch where the scan has a hole: a stretch of reference with no
    // scan behind it is taken only where its border runs along the scan's
    // open rims. A face standing in air (a boss the part has not) or inside
    // the material (the wall of a pocket the part has not) with no scan
    // behind it borders on scanned surface all round: it is no hole of the
    // scan's, and patched it would hide the very error it makes.
    progress('Closing the scan’s holes with the reference…', 0.1)
    stampInto(pieces?.scanned ?? o.reference, null, F_REF)
    stampInto(pieces?.bare ?? offered, null, F_PATCH)
    const near = Math.max(RIM_NEAR_CELLS * h, RIM_NEAR_MM)
    const openRims = openRimPoints(loops, o.scan.positions, o.scan.indices, h, (x, y, z) => scanSign * scanTree.at(x, y, z), o.toReference, rims)
    const hash = new PointHash(openRims, near)
    // Each cell of the patch goes with the border nearest it, through the
    // patch: the border where it meets scanned reference, which runs along
    // an open rim of the scan's (a hole) or not (a face the scan stands
    // apart from). A cut-away bottom goes with its cut; a box standing in
    // air with its foot, though the two touch. Patch with no border at all
    // — a whole body the scan never reached — is taken.
    const forEachAround = (c: number, visit: (d: number) => void) => {
      const i = c % nx, j = ((c / nx) | 0) % ny, k = (c / nxy) | 0
      for (let dk = -1; dk <= 1; dk++) {
        const kk = k + dk
        if (kk < 0 || kk >= nz) continue
        for (let dj = -1; dj <= 1; dj++) {
          const jj = j + dj
          if (jj < 0 || jj >= ny) continue
          for (let di = -1; di <= 1; di++) {
            const ii = i + di
            if (ii < 0 || ii >= nx || (di === 0 && dj === 0 && dk === 0)) continue
            visit(ii + nx * (jj + ny * kk))
          }
        }
      }
    }
    let queue: Int32Array = new Int32Array(1024)
    let tail = 0
    let patchCells = 0
    for (let c = 0; c < n; c++) {
      if (!(flags[c] & F_PATCH)) continue
      patchCells++
      let edge = false
      forEachAround(c, (d) => {
        if ((flags[d] & (F_REF | F_PATCH)) === F_REF) edge = true
      })
      if (!edge) continue
      rims.border++
      flags[c] |= F_SEEN
      const i = c % nx, j = ((c / nx) | 0) % ny, k = (c / nxy) | 0
      if (hash.any(ox + (i + 0.5) * h, oy + (j + 0.5) * h, oz + (k + 0.5) * h)) {
        flags[c] |= F_KEEP
        rims.along++
      }
      if (tail === queue.length) queue = grow(queue)
      queue[tail++] = c
    }
    for (let head = 0; head < tail; head++) {
      const c = queue[head]
      const keep = flags[c] & F_KEEP
      forEachAround(c, (d) => {
        if ((flags[d] & (F_PATCH | F_SEEN)) !== F_PATCH) return
        flags[d] |= F_SEEN | keep
        if (tail === queue.length) queue = grow(queue)
        queue[tail++] = d
      })
    }
    for (let c = 0; c < n; c++) {
      if ((flags[c] & (F_PATCH | F_SEEN)) === F_PATCH) flags[c] |= F_KEEP
      if ((flags[c] & (F_PATCH | F_KEEP)) === (F_PATCH | F_KEEP)) rims.keptCells++
    }
    rims.cells = patchCells
    const { positions: P, indices: I } = offered
    const kept: number[] = []
    for (let tt = 0; tt < I.length; tt += 3) {
      const a = I[tt] * 3, b = I[tt + 1] * 3, c = I[tt + 2] * 3
      const cell = cellIndex((P[a] + P[b] + P[c]) / 3, (P[a + 1] + P[b + 1] + P[c + 1]) / 3, (P[a + 2] + P[b + 2] + P[c + 2]) / 3, ox, oy, oz, h, nx, ny, nz)
      if (cell >= 0 && flags[cell] & F_KEEP) kept.push(I[tt], I[tt + 1], I[tt + 2])
    }
    patch = kept.length > 0 ? { positions: P, indices: Uint32Array.from(kept) } : null
  }
  if (patch && rule !== 'rims') stampInto(patch, null, F_KEEP)
  const patchTree = patch ? new WindingTree(patch.positions, patch.indices, { beta: o.beta ?? DEFAULT_VOLUME_BETA }) : null
  const patchSurface = patch ? new NominalSurface(patch.positions, patch.indices) : null
  if (patchTree) {
    progress('Closing the scan’s holes with the reference…', 0.14)
    for (let k = 0; k < cz; k++) {
      for (let j = 0; j < cy; j++) {
        for (let i = 0; i < cx; i++) {
          const [x, y, z] = coarseAt(i, j, k)
          coarse[i + cx * (j + cy * k)] += patchTree.at(x, y, z)
        }
      }
    }
  }
  timings.patch = performance.now() - t
  const winding = (x: number, y: number, z: number): number => scanSign * rawScan(x, y, z) + (patchTree ? patchTree.at(x, y, z) : 0)

  t = performance.now()
  progress('Reading the scan near its surface…', 0.2)
  // A coarse cell is read again where a scan or patch triangle crosses it —
  // the winding number jumps there — and where its value is near ½, with
  // its neighbours: near a hole it eases across cells. Away from both every
  // cell of it lies on one side of every surface, and the winding number is
  // harmonic there: the coarse value holds.
  const refine = new Uint8Array(cn)
  markCrossed(refine, o.scan, o.toReference, ox, oy, oz, COARSE * h, cx, cy, cz)
  if (patch) markCrossed(refine, patch, null, ox, oy, oz, COARSE * h, cx, cy, cz)
  const nearHalf = new Uint8Array(cn)
  for (let b = 0; b < cn; b++) if (Math.abs(coarse[b] - 0.5) < NEAR_HALF) nearHalf[b] = 1
  dilateInto(nearHalf, refine, cx, cy, cz)
  // Within a coarse cell read again, a cell within a cell of the scan or the
  // patch is read on its own. The others fall into groups, cut apart by
  // those, that each lie on one side of every surface: one reading holds
  // for a group. Not so round a rim, where the winding number turns through
  // every value about the edge: a coarse cell near the scan's rims or the
  // patch is read cell by cell.
  stampInto(o.scan, o.toReference, F_SCAN)
  bandAround(flags, F_SCAN | F_KEEP, F_BAND, nx, ny, nz)
  const full = new Uint8Array(cn)
  markRims(full, loops, o.scan.positions, o.toReference, ox, oy, oz, h, cx, cy, cz)
  for (let c = 0; c < n; c++) {
    if (!(flags[c] & F_KEEP)) continue
    const i = c % nx, j = ((c / nx) | 0) % ny, k = (c / nxy) | 0
    full[((i / COARSE) | 0) + cx * (((j / COARSE) | 0) + cy * ((k / COARSE) | 0))] = 1
  }
  // Per cell: its kind (0 agree, 1 excess, 2 missing, 3 unsure) and its
  // winding number, kept to a two-hundredth from −0.125.
  const kind = new Uint8Array(n)
  const wq = new Uint8Array(n)
  let fineQueries = 0
  const local = new Float64Array(COARSE ** 3)
  const group = new Int8Array(COARSE ** 3)
  const stack: number[] = []
  const H = COARSE / 2
  for (let bk = 0; bk < cz; bk++) {
    for (let bj = 0; bj < cy; bj++) {
      for (let bi = 0; bi < cx; bi++) {
        const b = bi + cx * (bj + cy * bk)
        const i0 = bi * COARSE, j0 = bj * COARSE, k0 = bk * COARSE
        const si = Math.min(COARSE, nx - i0), sj = Math.min(COARSE, ny - j0), sk = Math.min(COARSE, nz - k0)
        const cellAt = (li: number, lj: number, lk: number) => i0 + li + nx * (j0 + lj + ny * (k0 + lk))
        const read = (li: number, lj: number, lk: number) => {
          fineQueries++
          return winding(ox + (i0 + li + 0.5) * h, oy + (j0 + lj + 0.5) * h, oz + (k0 + lk + 0.5) * h)
        }
        if (!refine[b]) local.fill(coarse[b])
        else if (full[b]) {
          for (let lk = 0; lk < sk; lk++) for (let lj = 0; lj < sj; lj++) for (let li = 0; li < si; li++) local[li + COARSE * (lj + COARSE * lk)] = read(li, lj, lk)
        } else {
          // The cells in the band on their own; the rest by group. A coarse
          // cell no surface crosses (read again for being near ½) is cut
          // into its eight corners, the winding number easing across it.
          group.fill(-1)
          let crossed = false
          for (let lk = 0; lk < sk; lk++) for (let lj = 0; lj < sj; lj++) for (let li = 0; li < si; li++) {
            const l = li + COARSE * (lj + COARSE * lk)
            if (flags[cellAt(li, lj, lk)] & F_BAND) {
              local[l] = read(li, lj, lk)
              group[l] = 0
              crossed = true
            }
          }
          for (let lk = 0; lk < sk; lk++) for (let lj = 0; lj < sj; lj++) for (let li = 0; li < si; li++) {
            const l0 = li + COARSE * (lj + COARSE * lk)
            if (group[l0] !== -1) continue
            const value = read(li, lj, lk)
            const corner = crossed ? -1 : octant(li, lj, lk, H)
            stack.push(l0)
            group[l0] = 1
            while (stack.length > 0) {
              const l = stack.pop()!
              local[l] = value
              const li2 = l % COARSE, lj2 = ((l / COARSE) | 0) % COARSE, lk2 = (l / (COARSE * COARSE)) | 0
              for (let s2 = 0; s2 < 6; s2++) {
                const ni = li2 + (s2 === 0 ? -1 : s2 === 1 ? 1 : 0)
                const nj = lj2 + (s2 === 2 ? -1 : s2 === 3 ? 1 : 0)
                const nk = lk2 + (s2 === 4 ? -1 : s2 === 5 ? 1 : 0)
                if (ni < 0 || nj < 0 || nk < 0 || ni >= si || nj >= sj || nk >= sk) continue
                const m = ni + COARSE * (nj + COARSE * nk)
                if (group[m] !== -1) continue
                if (corner >= 0 && octant(ni, nj, nk, H) !== corner) continue
                group[m] = 1
                stack.push(m)
              }
            }
          }
        }
        for (let lk = 0; lk < sk; lk++) for (let lj = 0; lj < sj; lj++) for (let li = 0; li < si; li++) {
          const c = cellAt(li, lj, lk)
          const w = local[li + COARSE * (lj + COARSE * lk)]
          wq[c] = Math.max(0, Math.min(255, Math.round(w * 200) + 25))
          if (w >= unsureLo && w <= unsureHi) kind[c] = 3
          else if ((w > unsureHi ? 1 : 0) !== model[c]) kind[c] = model[c] ? 1 : 2
        }
      }
    }
    if (bk % 2 === 0) progress('Reading the scan near its surface…', 0.2 + (0.72 * bk) / cz)
  }
  timings.fine = performance.now() - t

  // Within the tolerance of the scan's surface: noise.
  t = performance.now()
  progress('Dropping what lies within the tolerance…', 0.92)
  const hit = emptyHit()
  for (let k = 0, c = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++, c++) {
        if (!kind[c]) continue
        rigidApply(toScan, ox + (i + 0.5) * h, oy + (j + 0.5) * h, oz + (k + 0.5) * h, p)
        // The search may come back with a face past T: it opens a leaf of
        // its tree whose box is within T and keeps the nearest face in it.
        if (scanSurface.closest(p[0], p[1], p[2], hit, T) && hit.distance <= T) kind[c] = 0
      }
    }
  }
  timings.band = performance.now() - t
  const counted = (o.count ?? []).map((b) => {
    const out: Record<VolumeKind, number> = { excess: 0, missing: 0, unsure: 0 }
    const i0 = Math.max(0, Math.ceil((b.min[0] - ox) / h - 0.5)), i1 = Math.min(nx - 1, Math.floor((b.max[0] - ox) / h - 0.5))
    const j0 = Math.max(0, Math.ceil((b.min[1] - oy) / h - 0.5)), j1 = Math.min(ny - 1, Math.floor((b.max[1] - oy) / h - 0.5))
    const k0 = Math.max(0, Math.ceil((b.min[2] - oz) / h - 0.5)), k1 = Math.min(nz - 1, Math.floor((b.max[2] - oz) / h - 0.5))
    for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const kd = kind[i + nx * (j + ny * k)]
      if (kd) out[KIND_OF[kd]!] += h * h * h
    }
    return out
  })

  // Regions.
  t = performance.now()
  progress('Grouping the cells into regions…', 0.95)
  const cellVolume = h * h * h
  const regions: VolumeRegion[] = []
  const found: { kind: number; cells: Int32Array }[] = []
  let queue: Int32Array = new Int32Array(1024)
  let specks = 0
  for (let start = 0; start < n; start++) {
    const kd = kind[start]
    if (kd === 0 || kd & VISITED) continue
    let head = 0, tail = 0
    queue[tail++] = start
    kind[start] = kd | VISITED
    while (head < tail) {
      const c = queue[head++]
      const i = c % nx, j = ((c / nx) | 0) % ny, k = (c / nxy) | 0
      for (let s = 0; s < 6; s++) {
        let d: number
        if (s === 0) { if (i === 0) continue; d = c - 1 }
        else if (s === 1) { if (i === nx - 1) continue; d = c + 1 }
        else if (s === 2) { if (j === 0) continue; d = c - nx }
        else if (s === 3) { if (j === ny - 1) continue; d = c + nx }
        else if (s === 4) { if (k === 0) continue; d = c - nxy }
        else { if (k === nz - 1) continue; d = c + nxy }
        if (kind[d] !== kd) continue
        kind[d] = kd | VISITED
        if (tail === queue.length) {
          const grown = new Int32Array(queue.length * 2)
          grown.set(queue)
          queue = grown
        }
        queue[tail++] = d
      }
    }
    if (tail < MIN_REGION_CELLS) specks += tail * cellVolume
    else found.push({ kind: kd, cells: queue.slice(0, tail) })
  }
  timings.components = performance.now() - t

  // What each region says.
  t = performance.now()
  progress('Measuring the regions…', 0.96)
  const original = originalTriangles(o.reference.indices, refSurface)
  const patchHit = emptyHit()
  // The regions' surfaces, for drawing: each region's cells' outer faces.
  const shells = o.meshes ? [new Shell(), new Shell(), new Shell()] : null
  for (const { kind: kd, cells } of found) {
    let sx = 0, sy = 0, sz = 0, conf = 0
    const bmin: Vec3 = [Infinity, Infinity, Infinity]
    const bmax: Vec3 = [-Infinity, -Infinity, -Infinity]
    let maxDepth = -1, deepest = cells[0]
    let modelFaces = 0, otherFaces = 0, bounded = 0, real = 0
    // Marked while it is measured, so a neighbour of another region of the
    // same kind is not taken for its own.
    for (const c of cells) kind[c] = kd | VISITED | 0x40
    for (const c of cells) {
      const i = c % nx, j = ((c / nx) | 0) % ny, k = (c / nxy) | 0
      const x = ox + (i + 0.5) * h, y = oy + (j + 0.5) * h, z = oz + (k + 0.5) * h
      sx += x
      sy += y
      sz += z
      if (x < bmin[0]) bmin[0] = x
      if (y < bmin[1]) bmin[1] = y
      if (z < bmin[2]) bmin[2] = z
      if (x > bmax[0]) bmax[0] = x
      if (y > bmax[1]) bmax[1] = y
      if (z > bmax[2]) bmax[2] = z
      conf += Math.min(1, Math.abs((wq[c] - 25) / 200 - 0.5) * 2)
      rigidApply(toScan, x, y, z, p)
      scanSurface.closest(p[0], p[1], p[2], hit)
      const depth = hit.distance
      if (depth > maxDepth) {
        maxDepth = depth
        deepest = c
      }
      let scanSide = false
      for (let s = 0; s < 6; s++) {
        const d =
          s === 0 ? (i === 0 ? -1 : c - 1) : s === 1 ? (i === nx - 1 ? -1 : c + 1) : s === 2 ? (j === 0 ? -1 : c - nx) : s === 3 ? (j === ny - 1 ? -1 : c + nx) : s === 4 ? (k === 0 ? -1 : c - nxy) : k === nz - 1 ? -1 : c + nxy
        if (d >= 0 && kind[d] === (kd | VISITED | 0x40)) continue
        if (shells) shells[kd - 1].face(x, y, z, h, s, regions.length)
        if (d >= 0 && model[d] !== model[c]) modelFaces++
        else {
          otherFaces++
          scanSide = true
        }
      }
      if (scanSide) {
        bounded++
        if (!patchSurface || !patchSurface.closest(x, y, z, patchHit, depth + h) || patchHit.distance >= depth - h) real++
      }
    }
    for (const c of cells) kind[c] = kd | VISITED
    const di = deepest % nx, dj = ((deepest / nx) | 0) % ny, dk = (deepest / nxy) | 0
    const deep: Vec3 = [ox + (di + 0.5) * h, oy + (dj + 0.5) * h, oz + (dk + 0.5) * h]
    refSurface.closest(deep[0], deep[1], deep[2], hit)
    const faces = Math.min(modelFaces, otherFaces) || Math.max(modelFaces, otherFaces)
    const volume = cells.length * cellVolume
    regions.push({
      kind: KIND_OF[kd]!,
      cells: cells.length,
      volume,
      maxDepth,
      thickness: faces > 0 ? volume / (faces * h * h) : 0,
      box: { min: bmin.map((v) => v - h / 2) as Vec3, max: bmax.map((v) => v + h / 2) as Vec3 },
      centroid: [sx / cells.length, sy / cells.length, sz / cells.length],
      deepest: deep,
      referenceTriangle: hit.faceIndex >= 0 ? original[hit.faceIndex] : -1,
      evidence: bounded > 0 ? real / bounded : 1,
      confidence: conf / cells.length,
    })
  }
  // Largest first; the shells' region numbers follow.
  const order = regions.map((_, i) => i).sort((a, b) => regions[b].volume - regions[a].volume)
  const rank = new Uint32Array(regions.length)
  order.forEach((r, i) => (rank[r] = i))
  const sorted = order.map((r) => regions[r])
  regions.length = 0
  regions.push(...sorted)
  const meshes = shells ? { excess: shells[0].done(rank), missing: shells[1].done(rank), unsure: shells[2].done(rank) } : null
  timings.depth = performance.now() - t

  const modelVolume = modelCells * cellVolume
  const totals = {} as Record<VolumeKind, VolumeTotal>
  for (const k of ['excess', 'missing', 'unsure'] as const) {
    const volume = regions.filter((r) => r.kind === k).reduce((s, r) => s + r.volume, 0)
    totals[k] = { volume, share: modelVolume > 0 ? (100 * volume) / modelVolume : 0 }
  }
  timings.total = performance.now() - tStart
  return {
    cell: h,
    smallestSeen: 2 * h,
    grid: { min: [ox, oy, oz], dims: [nx, ny, nz] },
    modelVolume,
    referenceOpen,
    totals,
    specks,
    regions,
    counted,
    meshes,
    patch: { offered: offered ? offered.indices.length / 3 : 0, offeredArea: offered ? areaOf(offered) : 0, kept: patch ? patch.indices.length / 3 : 0, area: patch ? areaOf(patch) : 0, rimsProbed: rims.probed, rimsOpen: rims.open, cells: rims.cells, border: rims.border, borderAlongRims: rims.along, keptCells: rims.keptCells },
    scanSign,
    queries: { coarse: coarseQueries * (patchTree ? 2 : 1), fine: fineQueries },
    timings,
    bytes: model.byteLength + kind.byteLength + wq.byteLength + coarse.byteLength + refine.byteLength + nearHalf.byteLength + flags.byteLength + full.byteLength + queue.byteLength + (o.scanTree ? 0 : scanTree.bytes) + (patchTree?.bytes ?? 0),
  }
}

/**
 * The reference triangles no scan stands behind, from a map on the
 * reference (onReference): a reference triangle every piece of which has a
 * corner read as no scan is taken whole — its pieces are fans of slivers —
 * and of the others, the pieces with such a corner.
 */
export function noScanPatchOf(reference: VolumeMesh, samples: VolumeMesh & { parent: Uint32Array }, values: Float32Array): VolumeMesh {
  const pieces = samples.indices.length / 3
  const bare = (t: number) => Number.isNaN(values[samples.indices[t * 3]]) || Number.isNaN(values[samples.indices[t * 3 + 1]]) || Number.isNaN(values[samples.indices[t * 3 + 2]])
  const total = new Uint32Array(reference.indices.length / 3)
  const unread = new Uint32Array(reference.indices.length / 3)
  for (let t = 0; t < pieces; t++) {
    total[samples.parent[t]]++
    if (bare(t)) unread[samples.parent[t]]++
  }
  const offset = reference.positions.length / 3
  const indices: number[] = []
  for (let r = 0; r < total.length; r++) if (total[r] > 0 && unread[r] === total[r]) indices.push(reference.indices[r * 3], reference.indices[r * 3 + 1], reference.indices[r * 3 + 2])
  for (let t = 0; t < pieces; t++) {
    const r = samples.parent[t]
    if (unread[r] === total[r] || !bare(t)) continue
    indices.push(samples.indices[t * 3] + offset, samples.indices[t * 3 + 1] + offset, samples.indices[t * 3 + 2] + offset)
  }
  const positions = new Float32Array(reference.positions.length + samples.positions.length)
  positions.set(reference.positions)
  positions.set(samples.positions, reference.positions.length)
  return { positions, indices: Uint32Array.from(indices) }
}

/** Gathers the outer faces of regions' cells. */
class Shell {
  private positions: number[] = []
  private regions: number[] = []

  /** The face of the cell centred at (x, y, z), `h` across, on side `s`
   *  (0 −x, 1 +x, 2 −y, 3 +y, 4 −z, 5 +z), wound to face out. */
  face(x: number, y: number, z: number, h: number, s: number, region: number): void {
    const r = h / 2
    const axis = s >> 1, out = s & 1 ? 1 : -1
    const u = (axis + 1) % 3, v = (axis + 2) % 3
    const c = [x, y, z]
    const corner = (a: number, b: number) => {
      const p = [c[0], c[1], c[2]]
      p[axis] += out * r
      p[u] += a * r
      p[v] += b * r
      this.positions.push(p[0], p[1], p[2])
    }
    // u × v is along +axis: counter-clockwise from outside on a + side.
    if (out > 0) {
      corner(-1, -1); corner(1, -1); corner(1, 1); corner(-1, 1)
    } else {
      corner(-1, -1); corner(-1, 1); corner(1, 1); corner(1, -1)
    }
    this.regions.push(region, region)
  }

  done(rank: Uint32Array): VolumeShell {
    const quads = this.regions.length / 2
    const indices = new Uint32Array(quads * 6)
    for (let q = 0; q < quads; q++) indices.set([q * 4, q * 4 + 1, q * 4 + 2, q * 4, q * 4 + 2, q * 4 + 3], q * 6)
    return { positions: Float32Array.from(this.positions), indices, region: Uint32Array.from(this.regions, (r) => rank[r]) }
  }
}

/** The cell holding a point, or −1 off the grid. */
function cellIndex(x: number, y: number, z: number, ox: number, oy: number, oz: number, h: number, nx: number, ny: number, nz: number): number {
  const i = Math.floor((x - ox) / h), j = Math.floor((y - oy) / h), k = Math.floor((z - oz) / h)
  if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) return -1
  return i + nx * (j + ny * k)
}

/** Sets `bit` on every cell a mesh's triangles pass through, moved by
 *  `transform` first if given: a triangle smaller than a cell by its
 *  corners and middle, a larger one by points half a cell apart over it. */
function stamp(flags: Uint8Array, bit: number, mesh: VolumeMesh, transform: Rigid | null, ox: number, oy: number, oz: number, h: number, nx: number, ny: number, nz: number): void {
  const { positions: P, indices: I } = mesh
  const c = new Float64Array(9)
  const p = new Float64Array(3)
  const mark = (x: number, y: number, z: number) => {
    const cell = cellIndex(x, y, z, ox, oy, oz, h, nx, ny, nz)
    if (cell >= 0) flags[cell] |= bit
  }
  for (let t = 0; t < I.length; t += 3) {
    for (let q = 0; q < 3; q++) {
      const v = I[t + q] * 3
      if (transform) {
        rigidApply(transform, P[v], P[v + 1], P[v + 2], p)
        c[q * 3] = p[0]
        c[q * 3 + 1] = p[1]
        c[q * 3 + 2] = p[2]
      } else {
        c[q * 3] = P[v]
        c[q * 3 + 1] = P[v + 1]
        c[q * 3 + 2] = P[v + 2]
      }
    }
    const l0 = Math.hypot(c[3] - c[0], c[4] - c[1], c[5] - c[2])
    const l1 = Math.hypot(c[6] - c[3], c[7] - c[4], c[8] - c[5])
    const l2 = Math.hypot(c[0] - c[6], c[1] - c[7], c[2] - c[8])
    const longest = Math.max(l0, l1, l2)
    if (longest <= h) {
      mark(c[0], c[1], c[2])
      mark(c[3], c[4], c[5])
      mark(c[6], c[7], c[8])
      mark((c[0] + c[3] + c[6]) / 3, (c[1] + c[4] + c[7]) / 3, (c[2] + c[5] + c[8]) / 3)
      continue
    }
    // Rows along the longest edge A→B towards the far corner C, half a cell
    // apart and points half a cell apart along each: a sliver gets few rows.
    const first = longest === l0 ? 0 : longest === l1 ? 1 : 2
    const a = first * 3, b = ((first + 1) % 3) * 3, f = ((first + 2) % 3) * 3
    const ux = c[b] - c[a], uy = c[b + 1] - c[a + 1], uz = c[b + 2] - c[a + 2]
    const vx = c[f] - c[a], vy = c[f + 1] - c[a + 1], vz = c[f + 2] - c[a + 2]
    const area2 = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx)
    const rows = Math.max(1, Math.ceil(area2 / longest / (h / 2)))
    for (let r = 0; r <= rows; r++) {
      const t = r / rows
      // From A + t·(C − A) to B + t·(C − B).
      const sx = c[a] + t * vx, sy = c[a + 1] + t * vy, sz = c[a + 2] + t * vz
      const ex = c[b] + t * (c[f] - c[b]), ey = c[b + 1] + t * (c[f + 1] - c[b + 1]), ez = c[b + 2] + t * (c[f + 2] - c[b + 2])
      const steps = Math.max(1, Math.ceil(((1 - t) * longest) / (h / 2)))
      for (let q = 0; q <= steps; q++) {
        const w = q / steps
        mark(sx + (ex - sx) * w, sy + (ey - sy) * w, sz + (ez - sz) * w)
      }
    }
  }
}

/** Sets `to` on every cell with any of `from`, and on its six neighbours. */
function bandAround(flags: Uint8Array, from: number, to: number, nx: number, ny: number, nz: number): void {
  const nxy = nx * ny
  for (let c = 0; c < flags.length; c++) {
    if (!(flags[c] & from)) continue
    const i = c % nx, j = ((c / nx) | 0) % ny, k = (c / nxy) | 0
    flags[c] |= to
    if (i > 0) flags[c - 1] |= to
    if (i < nx - 1) flags[c + 1] |= to
    if (j > 0) flags[c - nx] |= to
    if (j < ny - 1) flags[c + nx] |= to
    if (k > 0) flags[c - nxy] |= to
    if (k < nz - 1) flags[c + nxy] |= to
  }
}

/** The triangles of a mesh that `keep` takes. */
function piecesWhere(m: VolumeMesh, keep: (t: number) => boolean): VolumeMesh {
  const out: number[] = []
  for (let t = 0; t < m.indices.length / 3; t++) if (keep(t)) out.push(m.indices[t * 3], m.indices[t * 3 + 1], m.indices[t * 3 + 2])
  return { positions: m.positions, indices: Uint32Array.from(out) }
}

/** How far a point is from the segment between two vertices. */
function segmentDistance(x: number, y: number, z: number, P: Float32Array, a: number, b: number): number {
  const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2]
  const ex = P[b * 3] - ax, ey = P[b * 3 + 1] - ay, ez = P[b * 3 + 2] - az
  const l2 = ex * ex + ey * ey + ez * ez
  const u = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey + (z - az) * ez) / l2)) : 0
  return Math.hypot(x - ax - u * ex, y - ay - u * ey, z - az - u * ez)
}

/** Marks every coarse cell within a cell and a half of a rim's vertices. */
function markRims(mark: Uint8Array, loops: readonly RimLoop[], positions: Float32Array, toReference: Rigid, ox: number, oy: number, oz: number, h: number, cx: number, cy: number, cz: number): void {
  const p = new Float64Array(3)
  const s = COARSE * h
  for (const loop of loops) {
    for (const v of loop.vertices) {
      rigidApply(toReference, positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2], p)
      const i0 = Math.max(0, Math.floor((p[0] - 1.5 * h - ox) / s)), i1 = Math.min(cx - 1, Math.floor((p[0] + 1.5 * h - ox) / s))
      const j0 = Math.max(0, Math.floor((p[1] - 1.5 * h - oy) / s)), j1 = Math.min(cy - 1, Math.floor((p[1] + 1.5 * h - oy) / s))
      const k0 = Math.max(0, Math.floor((p[2] - 1.5 * h - oz) / s)), k1 = Math.min(cz - 1, Math.floor((p[2] + 1.5 * h - oz) / s))
      for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) mark[i + cx * (j + cy * k)] = 1
    }
  }
}

/**
 * Points along the scan's open rims, in the reference's frame, about a cell
 * apart: where the scan has a hole. A rim is open where the scan's winding
 * number just past it — RIM_PROBE_CELLS on, the way its triangle runs — is
 * about ½: across a hole the scan stands round the point on both sides.
 * Past the rim of a crease the scan never joined up (a hole's wall beside
 * the face round its mouth) it reads near 0 or 1. Rims shorter than two
 * cells are noise.
 */
function openRimPoints(
  loops: readonly RimLoop[],
  positions: Float32Array,
  indices: Uint32Array,
  h: number,
  windingAt: (x: number, y: number, z: number) => number,
  toReference: Rigid,
  stats: { probed: number; open: number },
): Float64Array {
  const P = positions
  const out: number[] = []
  const p = new Float64Array(3)
  for (const loop of loops) {
    const V = loop.vertices
    const edges = loop.triangles.length
    let length = 0
    for (let e = 0; e < edges; e++) {
      const a = V[e] * 3, b = V[(e + 1) % V.length] * 3
      length += Math.hypot(P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2])
    }
    if (length < 2 * h) continue
    let since = h
    for (let e = 0; e < edges; e++) {
      const va = V[e], vb = V[(e + 1) % V.length]
      const a = va * 3, b = vb * 3
      const ex = P[b] - P[a], ey = P[b + 1] - P[a + 1], ez = P[b + 2] - P[a + 2]
      const el = Math.hypot(ex, ey, ez)
      since += el
      if (since < h || el === 0) continue
      since = 0
      const t = loop.triangles[e] * 3
      const vc = indices[t] !== va && indices[t] !== vb ? indices[t] : indices[t + 1] !== va && indices[t + 1] !== vb ? indices[t + 1] : indices[t + 2]
      const mx = (P[a] + P[b]) / 2, my = (P[a + 1] + P[b + 1]) / 2, mz = (P[a + 2] + P[b + 2]) / 2
      // Away from the triangle's third corner, square to the edge.
      let dx = mx - P[vc * 3], dy = my - P[vc * 3 + 1], dz = mz - P[vc * 3 + 2]
      const along = (dx * ex + dy * ey + dz * ez) / (el * el)
      dx -= along * ex
      dy -= along * ey
      dz -= along * ez
      const dl = Math.hypot(dx, dy, dz)
      if (dl === 0) continue
      stats.probed++
      const reach = RIM_PROBE_CELLS * h
      const w = windingAt(mx + (reach * dx) / dl, my + (reach * dy) / dl, mz + (reach * dz) / dl)
      if (Math.abs(w - 0.5) >= RIM_OPEN) continue
      stats.open++
      rigidApply(toReference, mx, my, mz, p)
      out.push(p[0], p[1], p[2])
    }
  }
  return Float64Array.from(out)
}

/** Points hashed into cubes of a reach, asked whether any lies within it. */
class PointHash {
  private readonly at = new Map<number, number[]>()
  constructor(private readonly points: Float64Array, private readonly reach: number) {
    for (let q = 0; q < points.length; q += 3) {
      const key = this.key(Math.floor(points[q] / reach), Math.floor(points[q + 1] / reach), Math.floor(points[q + 2] / reach))
      const list = this.at.get(key)
      if (list) list.push(q)
      else this.at.set(key, [q])
    }
  }

  private key(i: number, j: number, k: number): number {
    return (i + 1_000) * 4_000_000 + (j + 1_000) * 2_000 + (k + 1_000)
  }

  any(x: number, y: number, z: number): boolean {
    const r = this.reach
    const i = Math.floor(x / r), j = Math.floor(y / r), k = Math.floor(z / r)
    for (let dk = -1; dk <= 1; dk++) {
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const list = this.at.get(this.key(i + di, j + dj, k + dk))
          if (!list) continue
          for (const q of list) {
            const P = this.points
            if ((P[q] - x) ** 2 + (P[q + 1] - y) ** 2 + (P[q + 2] - z) ** 2 <= r * r) return true
          }
        }
      }
    }
    return false
  }
}

function grow(queue: Int32Array): Int32Array {
  const grown = new Int32Array(queue.length * 2)
  grown.set(queue)
  return grown
}

/** Which of a coarse cell's eight corners a cell of it lies in. */
function octant(i: number, j: number, k: number, half: number): number {
  return (i >= half ? 1 : 0) + (j >= half ? 2 : 0) + (k >= half ? 4 : 0)
}

/** The coarse values at a point given in coarse cells from the first
 *  one's centre, trilinear, clamped to the grid. */
function trilinear(g: Float32Array, cx: number, cy: number, cz: number, fx: number, fy: number, fz: number): number {
  fx = Math.max(0, Math.min(cx - 1, fx))
  fy = Math.max(0, Math.min(cy - 1, fy))
  fz = Math.max(0, Math.min(cz - 1, fz))
  const i = Math.min(cx - 2, Math.floor(fx)), j = Math.min(cy - 2, Math.floor(fy)), k = Math.min(cz - 2, Math.floor(fz))
  if (i < 0 || j < 0 || k < 0) return g[Math.round(fx) + cx * (Math.round(fy) + cy * Math.round(fz))]
  const u = fx - i, v = fy - j, w = fz - k
  const at = (a: number, b: number, c: number) => g[i + a + cx * (j + b + cy * (k + c))]
  return (
    (1 - w) * ((1 - v) * ((1 - u) * at(0, 0, 0) + u * at(1, 0, 0)) + v * ((1 - u) * at(0, 1, 0) + u * at(1, 1, 0))) +
    w * ((1 - v) * ((1 - u) * at(0, 0, 1) + u * at(1, 0, 1)) + v * ((1 - u) * at(0, 1, 1) + u * at(1, 1, 1)))
  )
}

function areaOf(m: VolumeMesh): number {
  const P = m.positions, I = m.indices
  let a = 0
  for (let t = 0; t < I.length; t += 3) {
    const p = I[t] * 3, q = I[t + 1] * 3, r = I[t + 2] * 3
    const ux = P[q] - P[p], uy = P[q + 1] - P[p + 1], uz = P[q + 2] - P[p + 2]
    const vx = P[r] - P[p], vy = P[r + 1] - P[p + 1], vz = P[r + 2] - P[p + 2]
    a += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2
  }
  return a
}

/** The mesh with every triangle halved across its longest edge until no
 *  edge is longer than `edge` — the same surface; the new corners are
 *  shared by the two halves, not by the neighbour across the edge, which
 *  the winding number does not mind. */
export function compact(mesh: VolumeMesh, edge: number): VolumeMesh {
  const { positions: P, indices: I } = mesh
  const pos: number[] = Array.from(P)
  const out: number[] = []
  const e2 = edge * edge
  const len2 = (a: number, b: number) => (pos[a * 3] - pos[b * 3]) ** 2 + (pos[a * 3 + 1] - pos[b * 3 + 1]) ** 2 + (pos[a * 3 + 2] - pos[b * 3 + 2]) ** 2
  const stack: number[] = []
  for (let t = 0; t < I.length; t += 3) {
    stack.push(I[t], I[t + 1], I[t + 2])
    while (stack.length > 0) {
      const c = stack.pop()!, b = stack.pop()!, a = stack.pop()!
      const ab = len2(a, b), bc = len2(b, c), ca = len2(c, a)
      const most = Math.max(ab, bc, ca)
      if (most <= e2) {
        out.push(a, b, c)
        continue
      }
      // Rotated so that a→b is the longest edge, the winding kept.
      const [x, y, z] = most === ab ? [a, b, c] : most === bc ? [b, c, a] : [c, a, b]
      const m = pos.length / 3
      pos.push((pos[x * 3] + pos[y * 3]) / 2, (pos[x * 3 + 1] + pos[y * 3 + 1]) / 2, (pos[x * 3 + 2] + pos[y * 3 + 2]) / 2)
      stack.push(x, m, z, m, y, z)
    }
  }
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(out) }
}

/** The box round a mesh's vertices, moved by `transform` first if given —
 *  then round its own box's corners moved, which holds it. */
function boxOf(positions: Float32Array, transform: Rigid | null): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity]
  const max: Vec3 = [-Infinity, -Infinity, -Infinity]
  for (let v = 0; v < positions.length; v += 3) {
    for (let k = 0; k < 3; k++) {
      if (positions[v + k] < min[k]) min[k] = positions[v + k]
      if (positions[v + k] > max[k]) max[k] = positions[v + k]
    }
  }
  if (!transform) return { min, max }
  const out = { min: [Infinity, Infinity, Infinity] as Vec3, max: [-Infinity, -Infinity, -Infinity] as Vec3 }
  const p = new Float64Array(3)
  for (let c = 0; c < 8; c++) {
    rigidApply(transform, c & 1 ? max[0] : min[0], c & 2 ? max[1] : min[1], c & 4 ? max[2] : min[2], p)
    for (let k = 0; k < 3; k++) {
      out.min[k] = Math.min(out.min[k], p[k])
      out.max[k] = Math.max(out.max[k], p[k])
    }
  }
  return out
}

/**
 * 1 for each cell whose centre lies inside the reference. Each column of
 * cells along Z gathers the heights where the reference's triangles cross
 * it, +1 where a triangle faces down (the column enters there) and −1 where
 * it faces up; a cell is inside where the sum below its centre is above 0 —
 * where bodies overlap the sum is 2, still inside. The columns stand a
 * hair off the cell centres so a column through a shared edge or corner is
 * not counted twice. Over a hole the sum never comes back to 0, and the
 * column would read inside up to the grid's top or from its bottom: a lump
 * of material nothing stands for. See openColumns.
 */
function modelInside(ref: VolumeMesh, ox: number, oy: number, oz: number, h: number, nx: number, ny: number, nz: number): { inside: Uint8Array; referenceOpen: VolumeDeviation['referenceOpen'] } {
  const { positions: P, indices: I } = ref
  const ex = h * 1.37e-5, ey = h * 2.71e-5
  const columns = nx * ny
  const counts = new Uint32Array(columns + 1)
  // Twice: once to count each column's crossings, once to write them.
  const visit = (write: ((col: number, z: number, sign: number) => void) | null) => {
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3
      const ax = P[a], ay = P[a + 1], bx = P[b], by = P[b + 1], cxx = P[c], cyy = P[c + 1]
      const area = (bx - ax) * (cyy - ay) - (by - ay) * (cxx - ax)
      if (area === 0) continue
      const i0 = Math.max(0, Math.ceil((Math.min(ax, bx, cxx) - ox - ex) / h - 0.5))
      const i1 = Math.min(nx - 1, Math.floor((Math.max(ax, bx, cxx) - ox - ex) / h - 0.5))
      const j0 = Math.max(0, Math.ceil((Math.min(ay, by, cyy) - oy - ey) / h - 0.5))
      const j1 = Math.min(ny - 1, Math.floor((Math.max(ay, by, cyy) - oy - ey) / h - 0.5))
      if (i0 > i1 || j0 > j1) continue
      const sign = area > 0 ? -1 : 1
      const inv = 1 / area
      for (let j = j0; j <= j1; j++) {
        const y = oy + (j + 0.5) * h + ey
        for (let i = i0; i <= i1; i++) {
          const x = ox + (i + 0.5) * h + ex
          // Barycentric weights of (x, y) in the triangle's shadow.
          const wa = ((bx - x) * (cyy - y) - (by - y) * (cxx - x)) * inv
          const wb = ((cxx - x) * (ay - y) - (cyy - y) * (ax - x)) * inv
          const wc = 1 - wa - wb
          if (wa < 0 || wb < 0 || wc < 0) continue
          const col = i + j * nx
          if (write) write(col, wa * P[a + 2] + wb * P[b + 2] + wc * P[c + 2], sign)
          else counts[col + 1]++
        }
      }
    }
  }
  visit(null)
  for (let c = 0; c < columns; c++) counts[c + 1] += counts[c]
  const zs = new Float32Array(counts[columns])
  const signs = new Int8Array(counts[columns])
  const fill = counts.slice(0, columns)
  visit((col, z, sign) => {
    const at = fill[col]++
    zs[at] = z
    signs[at] = sign
  })
  const inside = new Uint8Array(columns * nz)
  const open = new Uint8Array(columns)
  const openList: number[] = []
  let zLo = Infinity, zHi = -Infinity
  for (let col = 0; col < columns; col++) {
    const s = counts[col], e = counts[col + 1]
    if (e === s) continue
    let total = 0
    for (let q = s; q < e; q++) total += signs[q]
    if (total !== 0) {
      open[col] = 1
      openList.push(col)
      for (let q = s; q < e; q++) {
        if (zs[q] < zLo) zLo = zs[q]
        if (zs[q] > zHi) zHi = zs[q]
      }
    }
    // Insertion sort: a column crosses a few surfaces.
    for (let q = s + 1; q < e; q++) {
      const z = zs[q], g = signs[q]
      let r = q - 1
      while (r >= s && zs[r] > z) {
        zs[r + 1] = zs[r]
        signs[r + 1] = signs[r]
        r--
      }
      zs[r + 1] = z
      signs[r + 1] = g
    }
    let q = s
    // Crossings gone from it, the column may be inside from its first one
    // up where they are exits, and up to its last where they are entries.
    let sum = total < 0 ? -total : 0
    for (let k = 0; k < nz; k++) {
      const z = oz + (k + 0.5) * h
      while (q < e && zs[q] < z) sum += signs[q++]
      if (sum > 0) inside[col + k * columns] = 1
    }
  }
  if (openList.length === 0) return { inside, referenceOpen: null }
  openColumns(inside, open, counts, openList, nx, ny, nz)
  let iLo = nx, iHi = -1, jLo = ny, jHi = -1
  for (const col of openList) {
    const i = col % nx, j = (col / nx) | 0
    if (i < iLo) iLo = i
    if (i > iHi) iHi = i
    if (j < jLo) jLo = j
    if (j > jHi) jHi = j
  }
  return { inside, referenceOpen: { columns: openList.length, box: { min: [ox + iLo * h, oy + jLo * h, zLo], max: [ox + (iHi + 1) * h, oy + (jHi + 1) * h, zHi] } } }
}

/**
 * The columns through a hole in the reference read from those beside them:
 * a cell its own crossings leave inside stays so where most of the closed
 * columns with any material, in the nearest ring round it that has one, say
 * so. Those with none do not count: a face missing at the rim of the part
 * has the air on one side, and its column goes on with the wall on the
 * other. With nothing to go by the column has no material.
 */
function openColumns(inside: Uint8Array, open: Uint8Array, counts: Uint32Array, list: readonly number[], nx: number, ny: number, nz: number): void {
  const columns = nx * ny
  for (const col of list) {
    const i = col % nx, j = (col / nx) | 0
    const ring: number[] = []
    for (let r = 1; ring.length === 0 && r < Math.max(nx, ny); r++) {
      for (let dj = -r; dj <= r; dj++) {
        for (let di = -r; di <= r; di++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue
          const ii = i + di, jj = j + dj
          if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue
          const c = ii + jj * nx
          if (!open[c] && counts[c + 1] > counts[c]) ring.push(c)
        }
      }
    }
    for (let k = 0; k < nz; k++) {
      let says = 0
      for (const c of ring) says += inside[c + k * columns]
      if (2 * says <= ring.length) inside[col + k * columns] = 0
    }
  }
}

/** 1 when the scan is wound with its normals out of the material, −1 when
 *  it came in the other way round: the sign of its winding number summed
 *  over cells well inside the reference — two cells in from every side. */
function settleSign(model: Uint8Array, nx: number, ny: number, nz: number, at: (i: number, j: number, k: number) => number): 1 | -1 {
  const nxy = nx * ny
  const deep: number[] = []
  for (let c = 0; c < model.length; c++) {
    if (!model[c]) continue
    const i = c % nx, j = ((c / nx) | 0) % ny, k = (c / nxy) | 0
    if (i < 2 || j < 2 || k < 2 || i >= nx - 2 || j >= ny - 2 || k >= nz - 2) continue
    if (model[c - 2] && model[c + 2] && model[c - 2 * nx] && model[c + 2 * nx] && model[c - 2 * nxy] && model[c + 2 * nxy]) deep.push(c)
  }
  const cells = deep.length > 0 ? deep : [...model.keys()].filter((c) => model[c])
  if (cells.length === 0) return 1
  const step = Math.max(1, Math.floor(cells.length / 64))
  let sum = 0
  for (let q = 0; q < cells.length; q += step) {
    const c = cells[q]
    sum += at(c % nx, ((c / nx) | 0) % ny, (c / nxy) | 0)
  }
  return sum < 0 ? -1 : 1
}

/** Marks every coarse cell a triangle's box touches. */
function markCrossed(mark: Uint8Array, mesh: VolumeMesh, transform: Rigid | null, ox: number, oy: number, oz: number, s: number, cx: number, cy: number, cz: number): void {
  const { positions: P, indices: I } = mesh
  const p = new Float64Array(3)
  const lo = [0, 0, 0], hi = [0, 0, 0]
  const o = [ox, oy, oz], dims = [cx, cy, cz]
  for (let t = 0; t < I.length; t += 3) {
    lo[0] = lo[1] = lo[2] = Infinity
    hi[0] = hi[1] = hi[2] = -Infinity
    for (let q = 0; q < 3; q++) {
      const v = I[t + q] * 3
      if (transform) rigidApply(transform, P[v], P[v + 1], P[v + 2], p)
      else {
        p[0] = P[v]
        p[1] = P[v + 1]
        p[2] = P[v + 2]
      }
      for (let k = 0; k < 3; k++) {
        if (p[k] < lo[k]) lo[k] = p[k]
        if (p[k] > hi[k]) hi[k] = p[k]
      }
    }
    const r0 = [0, 0, 0], r1 = [0, 0, 0]
    let outside = false
    for (let k = 0; k < 3; k++) {
      r0[k] = Math.max(0, Math.floor((lo[k] - o[k]) / s))
      r1[k] = Math.min(dims[k] - 1, Math.floor((hi[k] - o[k]) / s))
      if (r0[k] > r1[k]) outside = true
    }
    if (outside) continue
    for (let k = r0[2]; k <= r1[2]; k++) for (let j = r0[1]; j <= r1[1]; j++) for (let i = r0[0]; i <= r1[0]; i++) mark[i + cx * (j + cy * k)] = 1
  }
}

/** Sets in `into` every cell of `from` and its 26 neighbours. */
function dilateInto(from: Uint8Array, into: Uint8Array, cx: number, cy: number, cz: number): void {
  for (let k = 0; k < cz; k++) {
    for (let j = 0; j < cy; j++) {
      for (let i = 0; i < cx; i++) {
        if (!from[i + cx * (j + cy * k)]) continue
        for (let dk = Math.max(0, k - 1); dk <= Math.min(cz - 1, k + 1); dk++) {
          for (let dj = Math.max(0, j - 1); dj <= Math.min(cy - 1, j + 1); dj++) {
            for (let di = Math.max(0, i - 1); di <= Math.min(cx - 1, i + 1); di++) into[di + cx * (dj + cy * dk)] = 1
          }
        }
      }
    }
  }
}

/** For each triangle of a surface's tree order, its index in the mesh it
 *  was built from: the tree reorders its triangles, and reports them so. */
function originalTriangles(indices: Uint32Array, surface: NominalSurface): Int32Array {
  const key = (a: number, b: number, c: number) => `${a},${b},${c}`
  const at = new Map<string, number>()
  for (let t = 0; t < indices.length / 3; t++) at.set(key(indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2]), t)
  const out = new Int32Array(surface.triangleCount)
  const s = surface.index
  for (let f = 0; f < surface.triangleCount; f++) out[f] = at.get(key(s[f * 3], s[f * 3 + 1], s[f * 3 + 2])) ?? -1
  return out
}
