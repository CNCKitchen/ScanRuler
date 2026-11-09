// SPDX-License-Identifier: AGPL-3.0-only
// What a parsed point cloud becomes before anything is measured on it: the
// usable points, exact duplicates collapsed, unit normals as given, the
// typical point spacing, and a neighbour graph (CSR, like a mesh's vertex
// adjacency) built from a radius of 2.5 spacings with at most 12 neighbours a
// point, then made symmetric.

import type { MeshGraph, ParsedMesh } from '../types'
import { PointGrid } from './pointGrid'

const RADIUS_SPACINGS = 2.5
const K_CAP = 12
/** Points whose nearest neighbour is measured for the spacing, at most. */
const SPACING_SAMPLE = 20000

export type PointGraph = MeshGraph & {
  /** Median distance from a point to its nearest neighbour, mm. */
  spacing: number
  /** For each input point, the index it has in the graph, or -1 when it was
   *  dropped. A collapsed duplicate maps to the copy that was kept. */
  vertexMap: Int32Array
}

export function buildPointGraph(parsed: ParsedMesh, onProgress?: (text: string, fraction?: number) => void): PointGraph {
  const src = parsed.positions
  if (src.length % 3 !== 0) throw new Error('The file contains incomplete vertex or triangle coordinates.')
  const nIn = src.length / 3
  const srcN = parsed.normals
  if (!srcN || srcN.length !== src.length) {
    throw new Error('This point cloud has no normals — ScanRuler needs them to measure on points.')
  }

  // Keep the usable points. A non-finite coordinate or normal is dropped, and
  // so is a zero-length normal: the XYZ reader writes (0,0,0) for a row whose
  // normal columns were all zero, which says "no normal here", and a point
  // without a normal cannot be measured on. Exact duplicates keep the first.
  onProgress?.('Indexing points…')
  const vertexMap = new Int32Array(nIn).fill(-1)
  const u32 = new Uint32Array(src.buffer, src.byteOffset, src.length)
  let tableSize = 16
  while (tableSize < nIn * 2) tableSize <<= 1
  const table = new Int32Array(tableSize).fill(-1) // slot -> kept index
  const mask = tableSize - 1
  const keptFrom: number[] = []
  // -0 and 0 are the same point: hash the bits with the sign of zero erased.
  const word = (i: number, c: number): number => (src[3 * i + c] === 0 ? 0 : u32[3 * i + c])
  for (let i = 0; i < nIn; i++) {
    const x = src[3 * i], y = src[3 * i + 1], z = src[3 * i + 2]
    const nx = srcN[3 * i], ny = srcN[3 * i + 1], nz = srcN[3 * i + 2]
    if (!Number.isFinite(x + y + z) || !Number.isFinite(nx + ny + nz)) continue
    if (!(Math.hypot(nx, ny, nz) > 0)) continue
    let h = Math.imul(word(i, 0), 0x9e3779b1)
    h = Math.imul(h ^ word(i, 1), 0x85ebca6b)
    h = Math.imul(h ^ word(i, 2), 0xc2b2ae35)
    h ^= h >>> 15
    let slot = h & mask
    for (;;) {
      const k = table[slot]
      if (k < 0) {
        table[slot] = keptFrom.length
        vertexMap[i] = keptFrom.length
        keptFrom.push(i)
        break
      }
      const j = keptFrom[k]
      if (src[3 * j] === x && src[3 * j + 1] === y && src[3 * j + 2] === z) {
        vertexMap[i] = k
        break
      }
      slot = (slot + 1) & mask
    }
  }
  const n = keptFrom.length
  if (n === 0) throw new Error('The file contains no usable points.')

  // Normals are normalised, never turned: a scanner's own orientation stands.
  const positions = new Float32Array(3 * n)
  const normals = new Float32Array(3 * n)
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity
  for (let k = 0; k < n; k++) {
    const i = keptFrom[k]
    const x = src[3 * i], y = src[3 * i + 1], z = src[3 * i + 2]
    positions[3 * k] = x; positions[3 * k + 1] = y; positions[3 * k + 2] = z
    const l = Math.hypot(srcN[3 * i], srcN[3 * i + 1], srcN[3 * i + 2])
    normals[3 * k] = srcN[3 * i] / l; normals[3 * k + 1] = srcN[3 * i + 1] / l; normals[3 * k + 2] = srcN[3 * i + 2] / l
    if (x < x0) x0 = x
    if (x > x1) x1 = x
    if (y < y0) y0 = y
    if (y > y1) y1 = y
    if (z < z0) z0 = z
    if (z > z1) z1 = z
  }
  const bboxDiag = Math.hypot(x1 - x0, y1 - y0, z1 - z0)

  // Spacing: median non-zero nearest-neighbour distance over (a deterministic
  // sample of) the points, found on a grid sized for about a point a cell.
  onProgress?.('Measuring point spacing…')
  const floor = bboxDiag > 0 ? 1e-6 * bboxDiag : 1e-9
  let spacing = floor
  if (n > 1 && bboxDiag > 0) {
    const coarse = new PointGrid(positions, bboxDiag / Math.cbrt(n))
    const step = Math.max(1, Math.floor(n / SPACING_SAMPLE))
    const one = new Int32Array(1)
    const dists: number[] = []
    for (let i = 0; i < n; i += step) {
      if (coarse.kNearest(i, 1, Infinity, one) === 0) continue
      const j = one[0]
      const d = Math.hypot(positions[3 * i] - positions[3 * j], positions[3 * i + 1] - positions[3 * j + 1], positions[3 * i + 2] - positions[3 * j + 2])
      if (d > 0) dists.push(d)
    }
    if (dists.length > 0) {
      dists.sort((a, b) => a - b)
      spacing = Math.max(dists[dists.length >> 1], floor)
    }
  }

  // Neighbours: each point's nearest within 2.5 spacings, at most 12, then
  // the union of both directions so the graph is undirected.
  onProgress?.('Linking neighbours…')
  const radius = RADIUS_SPACINGS * spacing
  const grid = new PointGrid(positions, radius)
  const asked = new Int32Array(n * K_CAP)
  const count = new Uint8Array(n)
  const row = new Int32Array(K_CAP)
  for (let i = 0; i < n; i++) {
    const c = grid.kNearest(i, K_CAP, radius, row)
    count[i] = c
    asked.set(row.subarray(0, c), i * K_CAP)
  }
  const has = (a: number, b: number): boolean => {
    for (let s = a * K_CAP, e = s + count[a]; s < e; s++) if (asked[s] === b) return true
    return false
  }
  const adjOffsets = new Uint32Array(n + 1)
  for (let i = 0; i < n; i++) {
    adjOffsets[i + 1] += count[i]
    for (let s = i * K_CAP, e = s + count[i]; s < e; s++) {
      const j = asked[s]
      if (!has(j, i)) adjOffsets[j + 1]++
    }
  }
  for (let i = 0; i < n; i++) adjOffsets[i + 1] += adjOffsets[i]
  const adjList = new Uint32Array(adjOffsets[n])
  const fill = adjOffsets.slice(0, n)
  for (let i = 0; i < n; i++) {
    for (let s = i * K_CAP, e = s + count[i]; s < e; s++) {
      const j = asked[s]
      adjList[fill[i]++] = j
      if (!has(j, i)) adjList[fill[j]++] = i
    }
  }

  return {
    positions,
    indices: new Uint32Array(0),
    normals,
    adjOffsets,
    adjList,
    vertexCount: n,
    triangleCount: 0,
    bboxDiag,
    spacing,
    vertexMap,
  }
}
