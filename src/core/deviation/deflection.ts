// SPDX-License-Identifier: AGPL-3.0-only
// The deviation map as motion. Every scan point is moved along the direction
// its reading was taken in, so the part can be watched going from the shape it
// should have to the shape it was measured at, exaggerated and looped the way
// an FE package animates a deformed shape. A map says by how much each point is
// off; this shows which way the part as a whole has gone — a warp, a twist, a
// wall leaning in.
//
// A reading is a signed length, and a length does not say which way to move a
// point. The scan's own normals would, if they could be trusted to face out of
// the material, and on an open scan they cannot: one too open to orient is left
// as wound, and a direction taken off it would play the animation inside out.
// So whatever measures a map writes down, as it goes, the direction each
// reading was taken along — from the closest point on the reference out to the
// scan point, or out of the element on the material's side. Reading times
// direction is then the scan point's offset from the ideal surface, and taking
// it away puts the point back on that surface.

import { niceFloor } from '../field/stats'

/**
 * Write the direction a reading was taken along, three bytes per vertex.
 *
 * A byte per component holds a unit vector to within half a degree — far finer
 * than a picture of a deformation needs — in a quarter of the memory floats
 * would take, and a map of a few million points carries one of these beside
 * it. Pointed so that the reading times it is the offset off the ideal
 * surface: outward from it, whichever side of it the point is on. A zero
 * vector, where there is no direction to be had, stays zero.
 */
export function writeDirection(out: Int8Array, v: number, x: number, y: number, z: number): void {
  const len = Math.hypot(x, y, z)
  const s = len > 1e-20 ? 127 / len : 0
  out[v * 3] = Math.round(x * s)
  out[v * 3 + 1] = Math.round(y * s)
  out[v * 3 + 2] = Math.round(z * s)
}

/** How far the motion is smoothed, as a share of the part's bounding-box
 *  diagonal: the spacing of the grid it is averaged on. Two millimetres on a
 *  part 200 mm across — wide enough that a hole and the face around it move
 *  together, narrow enough to keep a corner lifting on its own. */
export const DEFLECTION_SMOOTHING = 0.01

/** How far the motion may be smoothed, as shares of the part's diagonal: from
 *  the grain of a scan to a fifth of the part, which averages a warp out. */
export const MIN_DEFLECTION_SMOOTHING = 0.002
export const MAX_DEFLECTION_SMOOTHING = 0.2

/** The smoothing length to use, mm: the one the user set, else the suggested
 *  share of the part's diagonal, held to what the setting runs between. */
export function deflectionSmoothing(set: number | null, diagonal: number): number {
  const lo = MIN_DEFLECTION_SMOOTHING * diagonal
  const hi = MAX_DEFLECTION_SMOOTHING * diagonal
  return Math.min(hi, Math.max(lo, set ?? DEFLECTION_SMOOTHING * diagonal))
}

/** The smoothing grid never has more nodes than this: where the part is long
 *  and thin enough to need more, the spacing widens instead of the memory. */
const MAX_GRID_NODES = 2_000_000

export interface DeflectionOptions {
  /** Readings past this either way move no further than it: the end of the
   *  colour scale, past which the map is a dark cap rather than a reading. */
  limit: number
  /** Readings past this are not measurements, and do not move at all. */
  maxDistance: number
  /** Where the scan's vertices are, in the frame the directions are in — to
   *  smooth the motion over. Null moves every point by its own reading. */
  positions?: Float32Array | null
  /** How far to smooth it, in mm: the spacing of the grid it is averaged on. */
  smoothing?: number
}

/**
 * How far each scan point is to move, as a vector in the scan's own
 * coordinates: three floats per vertex, to be drawn multiplied by however much
 * of the deviation is being shown on top of the scan as measured.
 *
 * What is exaggerated is how the part has deformed, so what is not that is
 * kept out of it:
 *
 *  - A point with no reading, or one past the search distance — scan spray, a
 *    fixture, a neighbouring feature — stays where it is. The map leaves it
 *    grey; swung out by fifty times a distance nobody believes, it would be
 *    the loudest thing on screen.
 *  - A reading past the end of the colour scale counts only as far as the
 *    end. Those are the few points the scale was chosen to leave out —
 *    material the reference does not have, the odd stray — and fifty times
 *    one of them is a sheet across the view that hides the part behind it.
 *  - Anything smaller than the smoothing length. The offsets are averaged
 *    over the space around each point, so what is exaggerated is the smooth
 *    part of the deviation: a warp, a wall leaning in, a corner lifting. The
 *    rest — the scanner's noise, the edge of a hole, a burr — stays on the
 *    part at its true size and rides along. Fifty times the noise is fur on
 *    every edge, and fifty times the step between a hole and the face around
 *    it folds the surface over itself.
 *
 * Averaged in space rather than along the surface, so both faces of a thin
 * wall move together — which is what a wall that has bent does — and the
 * cost is one pass over the points whatever the length. Only measured points
 * are averaged, so the unmeasured neither move nor hold their neighbours back.
 *
 * The map itself keeps every reading as measured; this is only the motion.
 */
export function deflectionVectors(
  values: Float32Array,
  directions: Int8Array,
  { limit, maxDistance, positions = null, smoothing = 0 }: DeflectionOptions,
): Float32Array {
  const n = Math.min(values.length, directions.length / 3, positions ? positions.length / 3 : Infinity)
  const out = new Float32Array(n * 3)
  const measured = new Uint8Array(n)
  let any = false
  for (let v = 0; v < n; v++) {
    const d = values[v]
    if (!(Math.abs(d) <= maxDistance)) continue
    measured[v] = 1
    any = true
    const s = Math.max(-limit, Math.min(limit, d)) / 127
    out[v * 3] = directions[v * 3] * s
    out[v * 3 + 1] = directions[v * 3 + 1] * s
    out[v * 3 + 2] = directions[v * 3 + 2] * s
  }
  if (!positions || !(smoothing > 0) || !any) return out
  return smoothInSpace(out, measured, positions, n, smoothing)
}

/**
 * The smoothed motion as a field in space: each point's vector is spread over
 * the eight nodes of the grid cell it lies in, weighted by how near it is to
 * each. Read back at a scan point it is the tent of two cells either way that
 * smoothInSpace returns; read at any other point — a vertex of a reference
 * the scan was never measured at — it is the same average of the scan around
 * that place.
 */
export interface DeflectionField {
  /** The motion at a place, in the frame of the positions the field was built
   *  over, written to `out`. False, and `out` zero, where no measured point
   *  lies within a cell of the place: the field says nothing there. */
  sample(x: number, y: number, z: number, out: Float64Array): boolean
}

/**
 * A box blur of radius `r` nodes along one axis of a grid of `comps` values per
 * node, in place, with nothing outside the grid: a running sum along each line,
 * so the cost does not grow with the radius. Three of them make a bell.
 */
function blurAxis(data: Float32Array, comps: number, nx: number, ny: number, nz: number, axis: 0 | 1 | 2 | number, r: number): void {
  const dims = [nx, ny, nz]
  const strides = [comps, nx * comps, nx * ny * comps]
  const len = dims[axis]
  const step = strides[axis]
  const a = (axis + 1) % 3
  const b = (axis + 2) % 3
  const line = new Float64Array(len)
  for (let c = 0; c < comps; c++) {
    for (let i = 0; i < dims[a]; i++) {
      for (let j = 0; j < dims[b]; j++) {
        const start = c + i * strides[a] + j * strides[b]
        let acc = 0
        for (let k = 0; k <= Math.min(r, len - 1); k++) acc += data[start + k * step]
        for (let k = 0; k < len; k++) {
          line[k] = acc
          const add = k + r + 1
          const drop = k - r
          if (add < len) acc += data[start + add * step]
          if (drop >= 0) acc -= data[start + drop * step]
        }
        for (let k = 0; k < len; k++) data[start + k * step] = line[k] / (2 * r + 1)
      }
    }
  }
}

function buildField(
  vectors: Float32Array,
  measured: Uint8Array,
  positions: Float32Array,
  n: number,
  spacing: number,
): DeflectionField | null {
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (let v = 0; v < n; v++) {
    if (!measured[v]) continue
    const x = positions[v * 3], y = positions[v * 3 + 1], z = positions[v * 3 + 2]
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
    if (z < minZ) minZ = z
    if (z > maxZ) maxZ = z
  }
  if (!(minX <= maxX)) return null
  // Up to the part's smoothing length the grid is as coarse as the smoothing
  // asked for and the tent over it is the whole of it. Past it, the grid stays
  // as fine as that length and the sums are blurred over the rest: a coarse
  // grid read by trilinear interpolation shows its own cells — squares, where
  // the field changes from one to the next — where a blur over a fine one does
  // not.
  const fine = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) * DEFLECTION_SMOOTHING
  let h = fine > 0 && spacing >= fine * 1.5 ? fine : spacing
  let nx = 0, ny = 0, nz = 0
  for (;;) {
    // One node past the far side, so every point has a whole cell around it.
    nx = Math.floor((maxX - minX) / h) + 2
    ny = Math.floor((maxY - minY) / h) + 2
    nz = Math.floor((maxZ - minZ) / h) + 2
    if (nx * ny * nz <= MAX_GRID_NODES) break
    h *= 1.25
  }
  const sum = new Float32Array(nx * ny * nz * 3)
  const weight = new Float32Array(nx * ny * nz)
  const nxy = nx * ny

  // The cell a point lies in and its weights towards the far corner, shared
  // by both passes.
  let base = 0, tx = 0, ty = 0, tz = 0
  const locate = (x: number, y: number, z: number): void => {
    const fx = (x - minX) / h
    const fy = (y - minY) / h
    const fz = (z - minZ) / h
    const ix = Math.max(0, Math.min(nx - 2, Math.floor(fx)))
    const iy = Math.max(0, Math.min(ny - 2, Math.floor(fy)))
    const iz = Math.max(0, Math.min(nz - 2, Math.floor(fz)))
    tx = fx - ix
    ty = fy - iy
    tz = fz - iz
    base = ix + iy * nx + iz * nxy
  }
  const corner = (c: number): number => base + (c & 1) + ((c >> 1) & 1) * nx + ((c >> 2) & 1) * nxy
  const cornerWeight = (c: number): number =>
    (c & 1 ? tx : 1 - tx) * ((c >> 1) & 1 ? ty : 1 - ty) * ((c >> 2) & 1 ? tz : 1 - tz)

  for (let v = 0; v < n; v++) {
    if (!measured[v]) continue
    locate(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2])
    for (let c = 0; c < 8; c++) {
      const w = cornerWeight(c)
      const k = corner(c)
      sum[k * 3] += w * vectors[v * 3]
      sum[k * 3 + 1] += w * vectors[v * 3 + 1]
      sum[k * 3 + 2] += w * vectors[v * 3 + 2]
      weight[k] += w
    }
  }

  // The blur is of the sums and the weights alike, and the field is their
  // quotient (normalised convolution): where the scan is sparse the weight is
  // small and the average is still the average of what there is, not a pull
  // towards zero.
  if (spacing >= h * 1.5) {
    const r = Math.max(1, Math.round(spacing / h - 1))
    for (let pass = 0; pass < 3; pass++) {
      for (let axis = 0; axis < 3; axis++) {
        blurAxis(sum, 3, nx, ny, nz, axis, r)
        blurAxis(weight, 1, nx, ny, nz, axis, r)
      }
    }
  }

  return {
    sample(x, y, z, out) {
      out[0] = out[1] = out[2] = 0
      // Past the grid by more than a cell the nearest nodes are not near: the
      // clamp in `locate` would drag the edge's value out across the void.
      if (x < minX - h || y < minY - h || z < minZ - h) return false
      if (x > minX + (nx - 1) * h + h || y > minY + (ny - 1) * h + h || z > minZ + (nz - 1) * h + h) return false
      locate(x, y, z)
      let ox = 0, oy = 0, oz = 0, total = 0
      for (let c = 0; c < 8; c++) {
        const k = corner(c)
        const nodeWeight = weight[k]
        if (!(nodeWeight > 0)) continue
        const w = Math.max(0, cornerWeight(c))
        ox += (w * sum[k * 3]) / nodeWeight
        oy += (w * sum[k * 3 + 1]) / nodeWeight
        oz += (w * sum[k * 3 + 2]) / nodeWeight
        total += w
      }
      if (!(total > 0)) return false
      out[0] = ox / total
      out[1] = oy / total
      out[2] = oz / total
      return true
    },
  }
}

/** Average a vector per point over the space around it: see DeflectionField. */
function smoothInSpace(
  vectors: Float32Array,
  measured: Uint8Array,
  positions: Float32Array,
  n: number,
  spacing: number,
): Float32Array {
  const out = new Float32Array(n * 3)
  const field = buildField(vectors, measured, positions, n, spacing)
  if (!field) return out
  const at = new Float64Array(3)
  for (let v = 0; v < n; v++) {
    if (!measured[v]) continue
    field.sample(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2], at)
    out[v * 3] = at[0]
    out[v * 3 + 1] = at[1]
    out[v * 3 + 2] = at[2]
  }
  return out
}

/**
 * The same motion as deflectionVectors, as a field that can be read anywhere
 * rather than a vector per scan point: what a pre-deformed export reads at the
 * vertices of the part that was modelled. Null when nothing was measured.
 */
export function deflectionField(
  values: Float32Array,
  directions: Int8Array,
  { limit, maxDistance, positions = null, smoothing = 0 }: DeflectionOptions,
): DeflectionField | null {
  if (!positions || !(smoothing > 0)) return null
  const n = Math.min(values.length, directions.length / 3, positions.length / 3)
  const vectors = new Float32Array(n * 3)
  const measured = new Uint8Array(n)
  let any = false
  for (let v = 0; v < n; v++) {
    const d = values[v]
    if (!(Math.abs(d) <= maxDistance)) continue
    measured[v] = 1
    any = true
    const s = Math.max(-limit, Math.min(limit, d)) / 127
    vectors[v * 3] = directions[v * 3] * s
    vectors[v * 3 + 1] = directions[v * 3 + 1] * s
    vectors[v * 3 + 2] = directions[v * 3 + 2] * s
  }
  return any ? buildField(vectors, measured, positions, n, smoothing) : null
}

/** The end of the colour scale moves this share of the part's size at the
 *  suggested scale — about what an FE package's automatic scale shows. */
const DEFLECTION_SHARE = 0.05

/** The scale runs from the deviation as measured to this many times it. */
export const MIN_DEFLECTION_SCALE = 1
export const MAX_DEFLECTION_SCALE = 10_000

/**
 * The exaggeration to show a map at until the user picks one: enough that a
 * reading at the end of the colour scale — as far as anything moves, see
 * deflectionVectors — moves by a twentieth of the part's bounding-box
 * diagonal. The scale opens on its own to take in the bulk of the readings,
 * so this is the bulk of the deviation made plain, whatever the part.
 * Rounded down to a figure worth typing.
 */
export function suggestDeflectionScale(limit: number, diagonal: number): number {
  if (!(limit > 0) || !(diagonal > 0)) return MIN_DEFLECTION_SCALE
  // A hair over before rounding down: 5 / 0.1 is 49.99999… in floats, and
  // would come out as 40.
  const scale = niceFloor(((DEFLECTION_SHARE * diagonal) / limit) * (1 + 1e-9))
  return Math.min(MAX_DEFLECTION_SCALE, Math.max(MIN_DEFLECTION_SCALE, scale))
}

/**
 * How much of the deviation is shown at a point in the loop, `phase` in
 * cycles: none of it at the start — the ideal shape — up to `scale` times it
 * halfway, and back. Eased into both ends, so the part slows into the extremes
 * and the eye has time to read them, as in an FE deformed-shape animation.
 */
export function deflectionFactor(phase: number, scale: number): number {
  return (scale * (1 - Math.cos(2 * Math.PI * phase))) / 2
}

/**
 * The phase at which the loop first shows the deviation as measured — the
 * scan exactly as it is on screen — so an animation can start from there
 * rather than with a jump to the ideal shape. A scale of one or less never
 * gets past the scan as measured; it starts at its top.
 */
export function deflectionStartPhase(scale: number): number {
  if (scale <= 1) return 0.5
  return Math.acos(1 - 2 / scale) / (2 * Math.PI)
}
