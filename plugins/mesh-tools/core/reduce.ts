// SPDX-License-Identifier: AGPL-3.0-only
// The scan reduced to a light mesh for CAD — a few thousand triangles to model
// over instead of a few million — held within a tolerance of the scan, and
// measured to prove it.
//
// The reduction is edge collapse on quadric error metrics (Garland & Heckbert
// 1997), done by meshoptimizer's simplifier: every vertex carries the planes
// of the faces around it, the edge whose collapse strays least from them goes
// first, and the collapses stop where the next one would stray too far. That
// is what makes it adaptive — a flat face ends as a couple of large
// triangles, a fillet keeps the density it needs — and why it is the method
// every mesh tool ships. The vertex left by a collapse is moved to where the
// planes put it rather than kept on one of the two scan points: the same
// collapses and the same count, and a quarter less deviation on real scans,
// because the best fit of a patch averages the scatter each scan point
// carries.
//
// The simplifier's own error is an estimate, not a distance anyone measured:
// an area-weighted mean over the planes a vertex has gathered, so a collapse
// across a strip of thin triangles — a fillet in a CAD tessellation, a crease
// in a scan — can move the surface several times what it reports. So the
// tolerance is not handed over and trusted. Each result is measured both
// ways: every scan point to the reduced surface, which catches detail lost,
// and the reduced surface back to the scan, which catches a patch bulging out
// of it. Where either strays past the tolerance, the scan points there are
// pinned — the simplifier may not collapse them — and the scan is reduced
// again. The pins gather where the tolerance is actually at risk, so the
// mesh stays dense there and nowhere else; shrinking the error target for the
// whole part instead costs two to three times the triangles for the same
// result.
//
// "Holds" means 99.9 % of each side lies within the tolerance, not all of it.
// A scan's worst point is a spike or a speck the reduction is right to
// flatten, and pinning every last one would keep the noise in the model. The
// maximum is measured and reported beside it, and the map says where it is.

import type { MeshoptSimplifier as Simplifier } from 'meshoptimizer/simplifier'
import { emptyHit, NominalSurface } from '../../../src/core/deviation/surface'
import type { FieldScale } from '../../../src/core/field/colormap'
import { compactEdit } from './edit'
import { round125 } from './round125'

export { round125 }

/** What the reduction is asked for. */
export interface ReduceSettings {
  /** How far the reduced surface may stray from the scan, mm. */
  tolerance: number
  /** Never more triangles than this — what a CAD importer takes. */
  maxTriangles: number
}

/** What came of it, measured. */
export interface ReduceReport {
  settings: ReduceSettings
  inputTriangles: number
  triangles: number
  vertices: number
  /** Scan points measured against the reduced surface — every vertex a
   *  triangle uses — and how many lie within the tolerance of it. */
  measured: number
  within: number
  /** Scan to reduced surface, mm: the 99.9th percentile and the largest
   *  distance, and the root mean square. */
  p999: number
  max: number
  rms: number
  /** Reduced surface to scan, mm, the same two figures. */
  backP999: number
  backMax: number
  /** Both 99.9th percentiles inside the tolerance. */
  held: boolean
  /** The triangle limit was below what the tolerance needs, and the scan was
   *  reduced to the limit instead — past the tolerance, unless `held` says
   *  it still happens to hold. */
  capped: boolean
  /** Reductions run on the way to this one. */
  passes: number
  /** Scan points pinned in place to hold the tolerance where the plain
   *  reduction strayed past it. */
  pinned: number
}

export interface ReducedMesh {
  /** The reduced mesh, compact: only the vertices its triangles use. */
  positions: Float32Array
  indices: Uint32Array
  /** Every scan vertex's number on it, −1 for one that was collapsed away —
   *  what carries the scan's vertices over when it becomes the edited copy. */
  vertexMap: Int32Array
  /** Signed distance from every scan vertex to the reduced surface, mm —
   *  positive where the scan lies outside it. NaN for a vertex no triangle
   *  uses. */
  deviation: Float32Array
  report: ReduceReport
}

/** The share of the scan, and of the reduced surface, that must lie inside
 *  the tolerance for it to hold. */
export const HELD_SHARE = 0.999

/** Reductions with pins before the result is taken as it stands. Real scans
 *  hold in two to four; each pass pins fewer new points than the last. */
const MAX_PASSES = 6

/** An error target no collapse reaches, for a reduction that is to stop at a
 *  triangle count alone. Finite: it crosses into the simplifier as a float. */
const UNBOUNDED_ERROR = 1e9

/** meshoptimizer's vertex flag for "never collapse this one". */
const PINNED = 1

type Simplify = typeof Simplifier

let loading: Promise<Simplify> | null = null

/** The simplifier, loaded on first use: most sessions never reduce a scan,
 *  and the module carries its own WebAssembly. A failed load is not cached,
 *  so the next attempt tries again. */
export function loadSimplifier(): Promise<Simplify> {
  loading ??= import('meshoptimizer/simplifier')
    .then(async ({ MeshoptSimplifier }) => {
      await MeshoptSimplifier.ready
      return MeshoptSimplifier
    })
    .catch((error: unknown) => {
      loading = null
      throw error
    })
  return loading
}

/** How the reduction's deviation reads as colour: signed, the middle of the
 *  ramp on the scan, its ends at the tolerance. Everything within the
 *  tolerance is on the ramp and everything past it wears a cap, so where the
 *  reduced mesh strays too far is the one thing on the part in a colour the
 *  ramp never uses. */
export function reductionScale(tolerance: number): FieldScale {
  return {
    low: -tolerance,
    high: tolerance,
    bands: null,
    validMin: -Infinity,
    validMax: Infinity,
  }
}

/** A tolerance a person would have chosen for a part this size: about a
 *  four-thousandth of its diagonal, on the 1-2-5 steps — 0.05 mm for a part
 *  a hand's width across, 0.5 mm for one a metre long. */
export function defaultTolerance(bboxDiagonal: number): number {
  return round125(bboxDiagonal * 2.5e-4)
}

/** The vertices a mesh's triangles use, and the triangles renumbered onto
 *  them — what leaves the worker and what the file holds. */
export function compactMesh(
  positions: Float32Array,
  indices: Uint32Array,
): { positions: Float32Array; indices: Uint32Array } {
  const remap = new Int32Array(positions.length / 3).fill(-1)
  let n = 0
  for (let i = 0; i < indices.length; i++) if (remap[indices[i]] < 0) remap[indices[i]] = n++
  const outPositions = new Float32Array(n * 3)
  const outIndices = new Uint32Array(indices.length)
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i]
    const w = remap[v]
    outIndices[i] = w
    outPositions[w * 3] = positions[v * 3]
    outPositions[w * 3 + 1] = positions[v * 3 + 1]
    outPositions[w * 3 + 2] = positions[v * 3 + 2]
  }
  return { positions: outPositions, indices: outIndices }
}

/** The scan as the reduction reads it — welded, every alignment baked. */
export interface ScanMesh {
  positions: Float32Array
  indices: Uint32Array
  vertexCount: number
}

/** A reduction, measured against the scan it came from. */
interface Measured {
  positions: Float32Array
  indices: Uint32Array
  vertexMap: Int32Array
  /** Distance of every measured scan vertex to the reduced surface, sorted. */
  forward: Float64Array
  /** Distance of the reduced surface back to the scan, sorted. */
  back: Float64Array
  /** Corners of the scan triangle nearest each spot of the reduced surface
   *  that stands further off than the tolerance. */
  backStray: number[]
}

/**
 * Reduce the scan to few triangles that hold the tolerance — and no more than
 * the limit, if one is set — and measure what came of it.
 *
 * `scanSurface` is the scan prepared for closest-point queries, for measuring
 * the reduced surface back against it. It is asked for lazily, because the
 * worker keeps one per scan and building it is the slowest step there is.
 */
export function reduceMesh(
  simplifier: Simplify,
  scan: ScanMesh,
  settings: ReduceSettings,
  scanSurface: () => NominalSurface,
  onProgress?: (text: string) => void,
): ReducedMesh {
  const { tolerance } = settings
  if (!(tolerance > 0)) throw new Error('The tolerance must be more than zero.')
  if (!(settings.maxTriangles >= 1)) throw new Error('The triangle limit must be at least one.')

  // Every vertex a triangle uses is measured, every pass: the pins need to
  // know each point that strayed, not a sample of them.
  const used = new Uint8Array(scan.vertexCount)
  for (let i = 0; i < scan.indices.length; i++) used[scan.indices[i]] = 1
  let usedCount = 0
  for (let v = 0; v < scan.vertexCount; v++) usedCount += used[v]
  const measuredVertices = new Uint32Array(usedCount)
  for (let v = 0, i = 0; v < scan.vertexCount; v++) if (used[v]) measuredVertices[i++] = v
  // Written in place by every pass — the same vertices each time, so the
  // last pass leaves the whole field its own.
  const deviation = new Float32Array(scan.vertexCount).fill(NaN)

  const run = (target: number, triangles: number, pins: Uint8Array | null): Measured => {
    const indices = scan.indices.slice()
    const positions = scan.positions.slice()
    const [count] = simplifier.simplifyWithUpdate(
      indices, positions, 3, NO_ATTRIBUTES, 0, [], pins,
      Math.min(indices.length, triangles * 3), target, ['ErrorAbsolute'],
    )
    // The vertices left keep their numbers' order, as an edit's do.
    const reduced = compactEdit(positions, indices.subarray(0, count), scan.vertexCount)
    const surface = new NominalSurface(reduced.positions, reduced.indices)
    const forward = scanToReduced(surface, scan.positions, measuredVertices, deviation)
    const back = reducedToScan(scanSurface(), reduced.positions, reduced.indices, tolerance)
    return { ...reduced, forward, back: back.distances, backStray: back.stray }
  }
  const holds = (r: Measured) =>
    quantile(r.forward, HELD_SHARE) <= tolerance && quantile(r.back, HELD_SHARE) <= tolerance

  const pins = new Uint8Array(scan.vertexCount)
  let pinned = 0
  let passes = 0
  let m: Measured
  for (;;) {
    passes++
    onProgress?.(
      pinned > 0
        ? `Reducing — pass ${passes}, ${pinned.toLocaleString('en-US')} points pinned…`
        : 'Reducing…',
    )
    m = run(tolerance, 0, pins)
    if (holds(m) || passes >= MAX_PASSES) break
    // Pin where it strayed: each scan point left too far from the reduced
    // surface, and the scan under each spot of it that stands too far off.
    let added = 0
    const pin = (v: number) => {
      if (pins[v] || !used[v]) return
      pins[v] = PINNED
      added++
    }
    for (let i = 0; i < measuredVertices.length; i++) {
      const v = measuredVertices[i]
      if (Math.abs(deviation[v]) > tolerance) pin(v)
    }
    for (const v of m.backStray) pin(v)
    // Nothing new to pin is as far as pinning goes.
    if (added === 0) break
    pinned += added
  }

  let capped = false
  if (m.indices.length / 3 > settings.maxTriangles) {
    passes++
    onProgress?.(`Reducing to ${settings.maxTriangles.toLocaleString('en-US')} triangles…`)
    m = run(UNBOUNDED_ERROR, Math.max(1, Math.floor(settings.maxTriangles)), null)
    capped = true
  }

  const { forward, back } = m
  let sq = 0
  let within = 0
  for (let i = 0; i < forward.length; i++) {
    sq += forward[i] * forward[i]
    if (forward[i] <= tolerance) within++
  }
  const p999 = quantile(forward, HELD_SHARE)
  const backP999 = quantile(back, HELD_SHARE)
  return {
    positions: m.positions,
    indices: m.indices,
    vertexMap: m.vertexMap,
    deviation,
    report: {
      settings: { ...settings },
      inputTriangles: scan.indices.length / 3,
      triangles: m.indices.length / 3,
      vertices: m.positions.length / 3,
      measured: forward.length,
      within,
      p999,
      max: forward.length ? forward[forward.length - 1] : 0,
      rms: forward.length ? Math.sqrt(sq / forward.length) : 0,
      backP999,
      backMax: back.length ? back[back.length - 1] : 0,
      held: p999 <= tolerance && backP999 <= tolerance,
      capped,
      passes,
      pinned,
    },
  }
}

const NO_ATTRIBUTES = new Float32Array(0)

/** Distance from each listed scan vertex to the reduced surface, sorted
 *  ascending; each vertex's signed distance is written to `signed` at its
 *  own index as well. */
function scanToReduced(
  surface: NominalSurface,
  positions: Float32Array,
  vertices: Uint32Array,
  signed: Float32Array,
): Float64Array {
  const out = new Float64Array(vertices.length)
  const hit = emptyHit()
  for (let i = 0; i < vertices.length; i++) {
    const v = vertices[i]
    surface.closest(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2], hit)
    out[i] = hit.distance
    signed[v] = hit.signed
  }
  return out.sort()
}

/** Distance from the reduced surface back to the scan, sorted ascending:
 *  from each of its vertices, which a collapse may have moved off the scan,
 *  and from the middle of each of its triangles, the point furthest from any
 *  vertex a large flat triangle has. With them, the corners of the scan
 *  triangle nearest every such point further off than `tolerance`. */
function reducedToScan(
  scan: NominalSurface,
  positions: Float32Array,
  indices: Uint32Array,
  tolerance: number,
): { distances: Float64Array; stray: number[] } {
  const vertexCount = positions.length / 3
  const distances = new Float64Array(vertexCount + indices.length / 3)
  const stray: number[] = []
  const hit = emptyHit()
  const probe = (x: number, y: number, z: number, i: number) => {
    scan.closest(x, y, z, hit)
    distances[i] = hit.distance
    if (hit.distance <= tolerance) return
    // The surface's own index buffer — reordered by its tree, but naming
    // the scan's vertices all the same.
    const f = hit.faceIndex * 3
    stray.push(scan.index[f], scan.index[f + 1], scan.index[f + 2])
  }
  for (let v = 0; v < vertexCount; v++) probe(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2], v)
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3
    const b = indices[t + 1] * 3
    const c = indices[t + 2] * 3
    probe(
      (positions[a] + positions[b] + positions[c]) / 3,
      (positions[a + 1] + positions[b + 1] + positions[c + 1]) / 3,
      (positions[a + 2] + positions[b + 2] + positions[c + 2]) / 3,
      vertexCount + t / 3,
    )
  }
  return { distances: distances.sort(), stray }
}

/** The value a share `q` of a sorted list lies at or below. */
function quantile(sorted: Float64Array, q: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]
}
