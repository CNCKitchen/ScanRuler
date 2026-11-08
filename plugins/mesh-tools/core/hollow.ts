// SPDX-License-Identifier: AGPL-3.0-only
// A closed part hollowed: its outside left as scanned, and an inner wall
// the thickness in from it all round, facing into a sealed cavity — what a
// resin print is hollowed with, or a cast's core.
//
// The inner wall is not the scan moved in. Moved point by point, a surface
// folds through itself wherever the part is thinner than twice the wall or
// curves tighter than it, and a scan does both somewhere. It is the surface
// the thickness in from the part's own, read off the part's distance field:
// where the part is thinner than twice the wall there is nothing that far in,
// and the part stays solid there; a boss on a thick base keeps its own small
// cavity or none. It never comes nearer the outside than the thickness, so
// the two never cross, and it is closed by how it is made.
//
// The field is read on a grid a third of the thickness across — coarser on
// a part too large for that many points — in four steps. Which grid points
// are inside the part: each column of them along Z crosses the surface at
// points where it enters and leaves, counted by the way each triangle faces.
// How far in each one is, roughly: a distance transform (Felzenszwalb &
// Huttenlocher's, exact on the grid) from every point outside and every
// point next to the surface. Exactly, in a band round where the inner wall
// will be: the distance to the nearest triangle, from the same search the
// deviation maps use. And the wall itself, where the distance crosses the
// thickness: marching tetrahedra on the grid's cubes, each cut into six that
// meet face to face, so the wall closes. Specks of cavity smaller than a
// couple of grid cells across — a thick spot just past twice the wall — are
// left solid, and the wall is reduced to within a sixteenth of a cell of
// itself, a wall that needs no scan's density.

import type { MeshoptSimplifier as Simplifier } from 'meshoptimizer/simplifier'
import { emptyHit, type ClosestHit } from '../../../src/core/deviation/surface'
import { closedness } from './boolean'
import { compactEdit, type EditedMesh } from './edit'
import { compactMesh, round125 } from './reduce'
import { distanceTransform, FAR, JITTER } from './distanceGrid'
import { dropSpecks, marchTetrahedra } from './marching'

/** What the field is measured against: the nearest point of the part's
 *  surface, within a distance — NominalSurface. */
export interface DistanceSurface {
  closest(x: number, y: number, z: number, out: ClosestHit, maxDistance?: number): boolean
}

export interface HollowReport {
  thickness: number
  /** The grid the distance field was read on, mm. */
  cell: number
  /** Cavities sealed in the part, the material they took out, mm³, and the
   *  part's enclosed volume before. */
  cavities: number
  removed: number
  volumeBefore: number
  /** Triangles the inner wall brought. */
  triangles: number
}

/** A wall thickness a person would start from: a hundred-and-twenty-fifth
 *  of the part's diagonal, on the 1-2-5 steps — 2 mm on a part a hand's
 *  width across. */
export function defaultWallThickness(bboxDiagonal: number): number {
  return round125(bboxDiagonal * 0.008)
}

/** The most grid points the field is read at — about 60 MB of it. A larger
 *  part is read on a coarser grid. */
const MAX_POINTS = 12_000_000

/** The inner wall is reduced to within this share of a cell of where the
 *  grid put it: lighter by an order of magnitude, its volume within a few
 *  parts in a thousand. */
const REDUCE_SHARE = 1 / 16

/** Cavities smaller than this many cubic cells are left solid. */
const MIN_CAVITY_CELLS = 8

/**
 * The part hollowed with a wall `thickness` thick: the outside as it is,
 * every vertex kept, and the inner wall's triangles after them. `surface` is
 * the part's own, for the exact distances; `simplifier`, when given, reduces
 * the inner wall. Throws when the mesh is not closed, or nowhere thick
 * enough to hollow.
 */
export function hollowMesh(
  positions: Float32Array,
  indices: Uint32Array,
  vertexCount: number,
  thickness: number,
  surface: DistanceSurface,
  simplifier: typeof Simplifier | null,
  onProgress?: (text: string) => void,
): EditedMesh & { report: HollowReport } {
  if (!(thickness > 0) || !Number.isFinite(thickness)) throw new Error('The wall thickness must be more than zero.')
  const shut = closedness(indices, vertexCount)
  if (shut.open > 0) {
    throw new Error(
      `The mesh is not closed — ${shut.open.toLocaleString('en-US')} open edge${shut.open === 1 ? '' : 's'}. Hollowing needs a closed part: close it with Fill holes first.`,
    )
  }
  const triangles = indices.length / 3
  const volumeBefore = signedVolume(positions, indices)
  if (!(volumeBefore > 0)) throw new Error('The mesh encloses no volume — is it turned inside out?')

  // ---- the grid ---------------------------------------------------------------
  let lx = Infinity, ly = Infinity, lz = Infinity
  let hx = -Infinity, hy = -Infinity, hz = -Infinity
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i] * 3
    lx = Math.min(lx, positions[v]); hx = Math.max(hx, positions[v])
    ly = Math.min(ly, positions[v + 1]); hy = Math.max(hy, positions[v + 1])
    lz = Math.min(lz, positions[v + 2]); hz = Math.max(hz, positions[v + 2])
  }
  let h = thickness / 3
  const dims = (cell: number) => [
    Math.ceil((hx - lx) / cell + 1 + JITTER[0]) + 2,
    Math.ceil((hy - ly) / cell + 1 + JITTER[1]) + 2,
    Math.ceil((hz - lz) / cell + 1 + JITTER[2]) + 2,
  ]
  let [nx, ny, nz] = dims(h)
  while (nx * ny * nz > MAX_POINTS) {
    h *= 1.1
    ;[nx, ny, nz] = dims(h)
  }
  const ox = lx - h * (1 + JITTER[0])
  const oy = ly - h * (1 + JITTER[1])
  const oz = lz - h * (1 + JITTER[2])
  const plane = nx * ny
  const total = plane * nz

  // ---- inside: each column along Z, entered and left ---------------------------
  onProgress?.('Hollowing — finding the inside of the part…')
  const inside = insideGrid(positions, indices, nx, ny, nz, ox, oy, oz, h)

  // ---- roughly how far in: a distance transform from outside and the surface
  onProgress?.('Hollowing — measuring how far in each point is…')
  const field = new Float32Array(total)
  for (let g = 0; g < total; g++) field[g] = inside[g] ? FAR : 0
  // The grid points next to the surface, from points spread over every
  // triangle no further apart than half a cell: a crack narrower than a
  // cell, which no grid point falls into, still counts as surface.
  for (let t = 0; t < triangles; t++) {
    const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3
    const longest = Math.max(
      Math.hypot(positions[b] - positions[a], positions[b + 1] - positions[a + 1], positions[b + 2] - positions[a + 2]),
      Math.hypot(positions[c] - positions[b], positions[c + 1] - positions[b + 1], positions[c + 2] - positions[b + 2]),
      Math.hypot(positions[a] - positions[c], positions[a + 1] - positions[c + 1], positions[a + 2] - positions[c + 2]),
    )
    const steps = Math.max(1, Math.ceil((2 * longest) / h))
    for (let i = 0; i <= steps; i++) {
      for (let j = 0; i + j <= steps; j++) {
        const u = i / steps, w = j / steps, s = 1 - u - w
        const x = s * positions[a] + u * positions[b] + w * positions[c]
        const y = s * positions[a + 1] + u * positions[b + 1] + w * positions[c + 1]
        const z = s * positions[a + 2] + u * positions[b + 2] + w * positions[c + 2]
        const gi = Math.round((x - ox) / h), gj = Math.round((y - oy) / h), gk = Math.round((z - oz) / h)
        field[gi + nx * (gj + ny * gk)] = 0
      }
    }
  }
  distanceTransform(field, nx, ny, nz)

  // ---- exactly how far, in a band round the wall ---------------------------------
  // The transform is out by no more than its seeds are from the surface —
  // under a cell either way. A cube the wall crosses has every corner within
  // a body diagonal of it, so the band takes in every corner the wall's
  // place is read from.
  const slack = Math.sqrt(3) * h + 1.5 * h
  const lo = thickness - slack
  const hi = thickness + slack
  const reach = hi + h
  const hit = emptyHit()
  let banded = 0
  for (let g = 0; g < total; g++) {
    if (!inside[g]) {
      field[g] = -thickness
      continue
    }
    const rough = Math.sqrt(field[g]) * h
    if (rough < lo || rough > hi) {
      field[g] = rough - thickness
      continue
    }
    if (banded++ % 200_000 === 0) onProgress?.(`Hollowing — measuring the wall, ${Math.round((100 * g) / total)} %…`)
    const i = g % nx, j = ((g / nx) | 0) % ny, k = (g / plane) | 0
    const found = surface.closest(ox + i * h, oy + j * h, oz + k * h, hit, reach)
    field[g] = (found ? hit.distance : reach) - thickness
  }

  // ---- the wall: where the distance crosses the thickness ----------------------------
  onProgress?.('Hollowing — building the inner wall…')
  const wall = marchTetrahedra(field, nx, ny, nz, ox, oy, oz, h)
  const kept = dropSpecks(wall.positions, wall.indices, MIN_CAVITY_CELLS * h * h * h, 'in')
  if (kept.pieces === 0) {
    throw new Error(
      // units-ok: built in the worker, also the agent's answer
      `Nothing to hollow — the part is nowhere thicker than twice the wall, ${round(2 * thickness)} mm. Take a thinner wall.`,
    )
  }
  let inner: { positions: Float32Array; indices: Uint32Array } = { positions: wall.positions, indices: kept.indices }
  if (simplifier) {
    onProgress?.('Hollowing — reducing the inner wall…')
    const [reduced] = simplifier.simplify(kept.indices, wall.positions, 3, 0, h * REDUCE_SHARE, ['ErrorAbsolute'])
    if (reduced.length > 0) inner = compactMesh(wall.positions, reduced)
  } else inner = compactMesh(wall.positions, kept.indices)
  const removed = -signedVolume(inner.positions, inner.indices)

  // ---- the part and its wall, one mesh --------------------------------------------------
  const all = new Float32Array(positions.length + inner.positions.length)
  all.set(positions)
  all.set(inner.positions, positions.length)
  const out = new Uint32Array(indices.length + inner.indices.length)
  out.set(indices)
  for (let i = 0; i < inner.indices.length; i++) out[indices.length + i] = inner.indices[i] + vertexCount
  const edited = compactEdit(all, out, vertexCount)
  return {
    ...edited,
    report: { thickness, cell: h, cavities: kept.pieces, removed, volumeBefore, triangles: inner.indices.length / 3 },
  }
}

const round = (x: number) => Number(x.toPrecision(3))

/** The volume a closed mesh wound outward encloses, mm³ — negative for one
 *  wound inward, as a cavity's wall is. */
export function signedVolume(positions: Float32Array, indices: Uint32Array): number {
  let v = 0
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3
    v +=
      positions[a] * (positions[b + 1] * positions[c + 2] - positions[b + 2] * positions[c + 1]) -
      positions[a + 1] * (positions[b] * positions[c + 2] - positions[b + 2] * positions[c]) +
      positions[a + 2] * (positions[b] * positions[c + 1] - positions[b + 1] * positions[c])
  }
  return v / 6
}

/**
 * Which grid points are inside the mesh: 1 each. Every column of points
 * along Z is crossed by the triangles over it — entering the part through
 * one that faces down, leaving through one that faces up — and a point is
 * inside where more have been entered than left below it.
 */
function insideGrid(
  positions: Float32Array,
  indices: Uint32Array,
  nx: number,
  ny: number,
  nz: number,
  ox: number,
  oy: number,
  oz: number,
  h: number,
): Uint8Array {
  const columns = nx * ny
  // Twice over the triangles: first how many crossings each column has,
  // then the crossings themselves, packed column by column.
  const start = new Uint32Array(columns + 1)
  const visit = (fill: ((column: number, z: number, enter: boolean) => void) | null) => {
    for (let t = 0; t < indices.length; t += 3) {
      const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3
      const ax = positions[a], ay = positions[a + 1]
      const bx = positions[b], by = positions[b + 1]
      const cx = positions[c], cy = positions[c + 1]
      const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
      if (area === 0) continue
      const i0 = Math.max(0, Math.ceil((Math.min(ax, bx, cx) - ox) / h))
      const i1 = Math.min(nx - 1, Math.floor((Math.max(ax, bx, cx) - ox) / h))
      const j0 = Math.max(0, Math.ceil((Math.min(ay, by, cy) - oy) / h))
      const j1 = Math.min(ny - 1, Math.floor((Math.max(ay, by, cy) - oy) / h))
      for (let j = j0; j <= j1; j++) {
        const py = oy + j * h
        for (let i = i0; i <= i1; i++) {
          const px = ox + i * h
          const wc = (bx - ax) * (py - ay) - (by - ay) * (px - ax)
          const wa = (cx - bx) * (py - by) - (cy - by) * (px - bx)
          const wb = (ax - cx) * (py - cy) - (ay - cy) * (px - cx)
          if (area > 0 ? wa <= 0 || wb <= 0 || wc <= 0 : wa >= 0 || wb >= 0 || wc >= 0) continue
          const column = i + nx * j
          if (!fill) {
            start[column + 1]++
            continue
          }
          const z = (wa * positions[a + 2] + wb * positions[b + 2] + wc * positions[c + 2]) / area
          // Facing up — wound anticlockwise seen from above — is a way out.
          fill(column, z, area < 0)
        }
      }
    }
  }
  visit(null)
  for (let c = 0; c < columns; c++) start[c + 1] += start[c]
  const zs = new Float64Array(start[columns])
  const enters = new Int8Array(start[columns])
  const at = start.slice(0, columns)
  visit((column, z, enter) => {
    const k = at[column]++
    zs[k] = z
    enters[k] = enter ? 1 : -1
  })

  const inside = new Uint8Array(columns * nz)
  for (let column = 0; column < columns; column++) {
    const from = start[column], to = start[column + 1]
    if (to - from < 2) continue
    // A handful each: sorted in place by insertion.
    for (let p = from + 1; p < to; p++) {
      const z = zs[p], e = enters[p]
      let q = p - 1
      while (q >= from && zs[q] > z) {
        zs[q + 1] = zs[q]
        enters[q + 1] = enters[q]
        q--
      }
      zs[q + 1] = z
      enters[q + 1] = e
    }
    let p = from
    let winding = 0
    for (let k = 0; k < nz; k++) {
      const z = oz + k * h
      while (p < to && zs[p] < z) winding += enters[p++]
      if (winding > 0) inside[column + columns * k] = 1
    }
  }
  return inside
}
