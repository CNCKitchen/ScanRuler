// SPDX-License-Identifier: AGPL-3.0-only
// A point cloud made a mesh: the surface its oriented points lie on, read
// as the zero of a signed distance and marched into triangles.
//
// Each point with its normal is a little tangent plane. The signed distance
// at a place is that of the planes of the points nearest it, weighted by how
// near each is (a Gaussian two cells wide), so the field is smooth where the
// points are noisy and follows them where they are dense. It is positive
// out of the material — the side the normals point to — so the triangles
// face the way the scan's normals did.
//
// The field is only made where there are points: the cells holding one and
// the cells next to those. Nothing is made across a hole or past the edge
// of an open scan, and the triangles the field still puts there — a little
// way past an edge, or where a tangent plane far from its point says
// nothing true — are trimmed: a triangle whose middle lies more than one
// and a half cells from every point goes. An open scan stays open; a hole
// stays a hole. Pieces of under 50 triangles left over go too.
//
// The marching is marching.ts's, on a sparse grid: one vertex per crossed
// grid edge, shared by every triangle on it, so the mesh comes out welded.

import { PointGrid } from '../../../src/core/geometry/pointGrid'
import { emitter, Grow, TETS, tetSurface } from './marching'

export interface MeshCloudSettings {
  /** The grid's cell, mm. Default two of the cloud's spacings, at least a
   *  two thousandth of its box's diagonal: about as many triangles as a
   *  scanner's own mesh of the cloud, well within its noise. */
  cell?: number
  /** The most grid cells it may make, held in maps in the worker: past it
   *  the mesh is refused before anything is made. Default MAX_CELLS. */
  maxCells?: number
}

export interface MeshCloudReport {
  /** The cell used, mm. */
  cell: number
  triangles: number
  vertices: number
  /** Triangles trimmed for lying away from every point. */
  trimmed: number
  /** Pieces in the mesh. */
  pieces: number
  ms: number
}

/** Points whose planes make the field at a place. */
const NEAREST = 8
/** The weights' width, in cells. */
const SIGMA_CELLS = 2
/** A place with no point within this many cells is outside. */
const REACH_CELLS = 4
/** A triangle whose middle lies further than this from every point, in
 *  cells, is trimmed. */
const TRIM_CELLS = 1.5
/** Pieces of fewer triangles are dropped. */
const MIN_PIECE = 50
/** Grid cells at most by default — the maps they are held in stay well
 *  under what a JavaScript Map holds (some 16.7 million entries). */
const MAX_CELLS = 6_000_000
/** The cells made round each cell holding a point, about, on a surface:
 *  its 3 × 3 × 3 neighbourhood, a third of which lies along it. */
const CELLS_PER_HELD = 9
/** The default cell, in spacings. */
const CELL_SPACINGS = 2
/** The grid's cells per box diagonal, at most. */
const MAX_CELLS_PER_DIAGONAL = 2000

const round3 = (v: number) => Math.round(v * 1000) / 1000

export function meshCloud(
  positions: Float32Array,
  normals: Float32Array,
  spacing: number,
  settings: MeshCloudSettings = {},
  progress?: (text: string) => void,
): { positions: Float32Array; indices: Uint32Array; report: MeshCloudReport } {
  const started = performance.now()
  const count = Math.floor(positions.length / 3)
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity
  for (let i = 0; i < count; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2]
    if (!Number.isFinite(x + y + z)) continue
    if (x < x0) x0 = x
    if (x > x1) x1 = x
    if (y < y0) y0 = y
    if (y > y1) y1 = y
    if (z < z0) z0 = z
    if (z > z1) z1 = z
  }
  const diagonal = Math.hypot(x1 - x0, y1 - y0, z1 - z0)
  // Never finer than a two-thousandth of the part, asked or not.
  const h = Math.max(settings.cell && settings.cell > 0 ? settings.cell : CELL_SPACINGS * spacing, diagonal / MAX_CELLS_PER_DIAGONAL)
  const empty = (): { positions: Float32Array; indices: Uint32Array; report: MeshCloudReport } => ({
    positions: new Float32Array(0),
    indices: new Uint32Array(0),
    report: { cell: h, triangles: 0, vertices: 0, trimmed: 0, pieces: 0, ms: performance.now() - started },
  })
  if (!(x1 >= x0) || !(h > 0)) return empty()

  // The grid: half-cell off the box, so a flat face never lies on its
  // corners, and two cells of room round it.
  const ox = x0 - 2.5 * h, oy = y0 - 2.5 * h, oz = z0 - 2.5 * h
  const nx = Math.ceil((x1 - ox) / h) + 3
  const ny = Math.ceil((y1 - oy) / h) + 3
  const nz = Math.ceil((z1 - oz) / h) + 3
  const plane = nx * ny
  const px = (g: number) => ox + (g % nx) * h
  const py = (g: number) => oy + (Math.floor(g / nx) % ny) * h
  const pz = (g: number) => oz + Math.floor(g / plane) * h

  progress?.('Finding where the points are…')
  // The cells it would make, counted off the cells holding a point before
  // any is made: past the budget, refused with a cell that fits.
  const budget = settings.maxCells ?? MAX_CELLS
  const held = new Set<number>()
  for (let i = 0; i < count && held.size * CELLS_PER_HELD <= budget; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2]
    if (!Number.isFinite(x + y + z)) continue
    held.add(Math.floor((x - ox) / h) + nx * Math.floor((y - oy) / h) + plane * Math.floor((z - oz) / h))
  }
  const estimate = held.size * CELLS_PER_HELD
  if (estimate > budget) {
    // The cells a surface takes go as one over the cell squared.
    const fits = h * Math.sqrt(estimate / budget) * 1.1
    throw new Error(`A grid of ${round3(h)} mm cells would take more than ${estimate.toLocaleString('en-US')} cells, past the ${budget.toLocaleString('en-US')} the worker holds — give a cell of at least ${round3(fits)} mm.`) // units-ok: the worker's refusal names mesh.mesh_cloud's cell, which is mm; the worker has no display units
  }
  held.clear()
  // The cells holding a point, and their neighbours.
  const active = new Set<number>()
  for (let i = 0; i < count; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2]
    if (!Number.isFinite(x + y + z)) continue
    const ci = Math.floor((x - ox) / h), cj = Math.floor((y - oy) / h), ck = Math.floor((z - oz) / h)
    for (let dk = -1; dk <= 1; dk++)
      for (let dj = -1; dj <= 1; dj++)
        for (let di = -1; di <= 1; di++) {
          const i2 = ci + di, j2 = cj + dj, k2 = ck + dk
          if (i2 < 0 || j2 < 0 || k2 < 0 || i2 >= nx - 1 || j2 >= ny - 1 || k2 >= nz - 1) continue
          active.add(i2 + nx * j2 + plane * k2)
        }
  }

  progress?.('Measuring the distance to the points…')
  const grid = new PointGrid(positions, Math.max(h, spacing) * 2)
  const near = new Int32Array(NEAREST)
  const reach = REACH_CELLS * h
  const twoSigma2 = 2 * (SIGMA_CELLS * h) ** 2
  const field = new Map<number, number>()
  const valueAt = (g: number): number => {
    let f = field.get(g)
    if (f !== undefined) return f
    const x = px(g), y = py(g), z = pz(g)
    const k = grid.kNearestTo(x, y, z, NEAREST, reach, near)
    if (k === 0) f = h
    else {
      let sw = 0
      let sf = 0
      for (let a = 0; a < k; a++) {
        const j = near[a] * 3
        const dx = x - positions[j], dy = y - positions[j + 1], dz = z - positions[j + 2]
        const w = Math.exp(-(dx * dx + dy * dy + dz * dz) / twoSigma2) + 1e-12
        sw += w
        sf += w * (normals[j] * dx + normals[j + 1] * dy + normals[j + 2] * dz)
      }
      f = sf / sw
    }
    field.set(g, f)
    return f
  }

  progress?.('Marching the surface…')
  const verts = new Grow(new Float32Array(1 << 16))
  const middles = new Grow(new Float32Array(1 << 16))
  const indices = new Grow(new Uint32Array(1 << 16))
  // A grid edge, as its lower corner and which of the cube's edges it is.
  const edgeCode = new Map<number, number>()
  const onEdge = new Map<number, number>()
  const vertexOn = (a: number, b: number): number => {
    const lo = Math.min(a, b)
    const diff = Math.abs(b - a)
    let code = edgeCode.get(diff)
    if (code === undefined) {
      code = edgeCode.size
      edgeCode.set(diff, code)
    }
    const key = lo * 16 + code
    let id = onEdge.get(key)
    if (id !== undefined) return id
    const fa = valueAt(a)
    const fb = valueAt(b)
    const s = fa / (fa - fb)
    id = verts.length / 3
    verts.push(px(a) + s * (px(b) - px(a)))
    verts.push(py(a) + s * (py(b) - py(a)))
    verts.push(pz(a) + s * (pz(b) - pz(a)))
    middles.push((px(a) + px(b)) / 2)
    middles.push((py(a) + py(b)) / 2)
    middles.push((pz(a) + pz(b)) / 2)
    onEdge.set(key, id)
    return id
  }
  const emit = emitter(() => middles.data, indices)
  const corner = [0, 1, nx, nx + 1, plane, plane + 1, plane + nx, plane + nx + 1]
  const g = new Float64Array(8)
  const f = new Float64Array(8)
  const pos: number[] = []
  const neg: number[] = []
  for (const origin of active) {
    let above = 0
    for (let c = 0; c < 8; c++) {
      g[c] = origin + corner[c]
      f[c] = valueAt(g[c])
      if (f[c] > 0) above++
    }
    if (above === 0 || above === 8) continue
    for (const tet of TETS) {
      pos.length = 0
      neg.length = 0
      for (const c of tet) (f[c] > 0 ? pos : neg).push(g[c])
      if (pos.length === 0 || neg.length === 0) continue
      let dx = 0, dy = 0, dz = 0
      for (const p of pos) {
        dx += px(p) / pos.length
        dy += py(p) / pos.length
        dz += pz(p) / pos.length
      }
      for (const q of neg) {
        dx -= px(q) / neg.length
        dy -= py(q) / neg.length
        dz -= pz(q) / neg.length
      }
      tetSurface(pos, neg, vertexOn, emit, dx, dy, dz)
    }
  }
  const allVerts = verts.done()
  const allIdx = indices.done()

  progress?.('Trimming what lies away from the points…')
  const keep = new Uint8Array(allIdx.length / 3)
  const trimAt = TRIM_CELLS * h
  let trimmed = 0
  for (let t = 0; t < allIdx.length; t += 3) {
    const a = allIdx[t] * 3, b = allIdx[t + 1] * 3, c = allIdx[t + 2] * 3
    const cx = (allVerts[a] + allVerts[b] + allVerts[c]) / 3
    const cy = (allVerts[a + 1] + allVerts[b + 1] + allVerts[c + 1]) / 3
    const cz = (allVerts[a + 2] + allVerts[b + 2] + allVerts[c + 2]) / 3
    if (grid.nearest(cx, cy, cz, trimAt) >= 0) keep[t / 3] = 1
    else trimmed++
  }

  // Pieces, by the vertices their triangles share; the small ones go.
  const vcount = allVerts.length / 3
  const parent = new Int32Array(vcount)
  for (let i = 0; i < vcount; i++) parent[i] = i
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]]
      x = parent[x]
    }
    return x
  }
  const join = (a: number, b: number) => {
    const ra = find(a), rb = find(b)
    if (ra !== rb) parent[ra] = rb
  }
  for (let t = 0; t < keep.length; t++) {
    if (!keep[t]) continue
    join(allIdx[t * 3], allIdx[t * 3 + 1])
    join(allIdx[t * 3], allIdx[t * 3 + 2])
  }
  const size = new Map<number, number>()
  for (let t = 0; t < keep.length; t++) if (keep[t]) size.set(find(allIdx[t * 3]), (size.get(find(allIdx[t * 3])) ?? 0) + 1)
  let pieces = 0
  for (const s of size.values()) if (s >= MIN_PIECE) pieces++

  // The kept triangles over the vertices they use.
  const remap = new Int32Array(vcount).fill(-1)
  const outIdx = new Grow(new Uint32Array(Math.max(16, allIdx.length)))
  const outPos = new Grow(new Float32Array(Math.max(16, allVerts.length)))
  for (let t = 0; t < keep.length; t++) {
    if (!keep[t] || (size.get(find(allIdx[t * 3])) ?? 0) < MIN_PIECE) continue
    for (let k = 0; k < 3; k++) {
      const v = allIdx[t * 3 + k]
      if (remap[v] < 0) {
        remap[v] = outPos.length / 3
        outPos.push(allVerts[v * 3])
        outPos.push(allVerts[v * 3 + 1])
        outPos.push(allVerts[v * 3 + 2])
      }
      outIdx.push(remap[v])
    }
  }
  const outPositions = outPos.done()
  const outIndices = outIdx.done()
  return {
    positions: outPositions,
    indices: outIndices,
    report: {
      cell: h,
      triangles: outIndices.length / 3,
      vertices: outPositions.length / 3,
      trimmed,
      pieces,
      ms: performance.now() - started,
    },
  }
}
