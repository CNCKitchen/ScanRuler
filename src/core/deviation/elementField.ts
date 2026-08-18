// SPDX-License-Identifier: AGPL-3.0-only
//
// Deviation of the scan from one fitted element, rather than from a whole
// nominal part.
//
// This is the other half of the same question. A reference model asks "is the
// part the shape it was drawn as"; an element asks "is this face flat, is this
// bore round, does this surface sit where the datum says it should" — and it
// asks it without a CAD file and without an alignment, because the element was
// measured on the scan and is already in its frame.
//
// Three things make an element's distance well defined where a raw closest
// point would not be:
//
//   * The element is bounded to what is drawn. A plane is infinite and a
//     cylinder is an endless tube; taken literally, a plane would paint a slab
//     clean through the part and colour the far face of a wall. So a vertex
//     counts only where it lies within the element's own extent — which is the
//     extent the grips set, so what is on screen is what gets measured.
//   * The sign follows the material, not the fit. Which way a fitted plane's
//     normal points is an accident of the fit, and inside a bore the material
//     is on the *inner* side, so the raw radial distance runs backwards. The
//     side is detected from the scan's own normals once, and can be flipped.
//   * A surface that faces the wrong way is not the surface being measured.
//     Even bounded, a plane on top of a 10 mm plate reaches the underside of
//     it; requiring the scan to face roughly the way the element faces there
//     leaves the far side out, the same way the wall thickness search does.
//
// Unbounded in distance, though: like the reference map, every vertex within
// the element keeps its value, so the display's max search distance stays a
// pure display control that can be dragged either way without recomputing.

import type { CylinderFit, FitData, PlaneFit, SphereFit } from '../types'

/** The kinds a signed deviation can be measured against: the three with a
 *  surface and therefore two sides. A point and a line have neither — the
 *  distance to them is unsigned, so there is no zero for a scale to run warm
 *  and cool around, and a map of one would be a different instrument. */
export type ElementTarget = PlaneFit | CylinderFit | SphereFit

export function isDeviationTarget(fit: FitData | undefined): fit is ElementTarget {
  return fit !== undefined && (fit.kind === 'plane' || fit.kind === 'cylinder' || fit.kind === 'sphere')
}

/** Which side of the element the material is on: `1` the element's own outward
 *  side — the way a plane's normal points, radially out of a cylinder or a
 *  sphere — and `-1` the other, which is what a bore or the inside of a shell
 *  is. It multiplies the reading, so "too much material" runs warm either way. */
export type MaterialSide = 1 | -1

/** How far a scan normal may be from facing the way the element's surface
 *  faces there, in degrees. Wide enough to keep a genuinely warped or badly
 *  scanned surface, tight enough to leave the other side of a wall out. */
export const DEFAULT_FACING_DEG = 60

export interface ElementFieldOptions {
  side: MaterialSide
  /** Facing limit in radians; null accepts whatever lies within the element. */
  maxNormalDeviation: number | null
  /** Restrict the map to these scan vertices — a surface marked by hand with
   *  the selection tools. Everything else reads as unmeasured, exactly like a
   *  vertex outside the element's own bounds. Null measures the whole scan. */
  subset?: Uint32Array | null
}

/** Where one scan vertex sits relative to the element. Filled in place: this is
 *  written once per vertex, and a fresh object per vertex would cost more than
 *  the arithmetic in it. */
interface Probe {
  /** Distance off the surface along the element's own outward direction. */
  offset: number
  /** Unit outward direction of the element surface at the closest point. */
  ox: number
  oy: number
  oz: number
  /** Within the element as drawn, and not on a degenerate spot (the axis of a
   *  cylinder, the centre of a sphere) where "outward" means nothing. */
  inside: boolean
}

function probeElement(fit: ElementTarget, x: number, y: number, z: number, out: Probe): void {
  if (fit.kind === 'plane') {
    const dx = x - fit.center[0]
    const dy = y - fit.center[1]
    const dz = z - fit.center[2]
    const u = dx * fit.basisU[0] + dy * fit.basisU[1] + dz * fit.basisU[2]
    const v = dx * fit.basisV[0] + dy * fit.basisV[1] + dz * fit.basisV[2]
    out.offset = dx * fit.normal[0] + dy * fit.normal[1] + dz * fit.normal[2]
    out.ox = fit.normal[0]
    out.oy = fit.normal[1]
    out.oz = fit.normal[2]
    out.inside = Math.abs(u) <= fit.extentU && Math.abs(v) <= fit.extentV
    return
  }

  if (fit.kind === 'cylinder') {
    const dx = x - fit.center[0]
    const dy = y - fit.center[1]
    const dz = z - fit.center[2]
    const t = dx * fit.axis[0] + dy * fit.axis[1] + dz * fit.axis[2]
    const wx = dx - t * fit.axis[0]
    const wy = dy - t * fit.axis[1]
    const wz = dz - t * fit.axis[2]
    const rho = Math.hypot(wx, wy, wz)
    out.offset = rho - fit.radius
    // On the axis there is no radial direction to sign the reading with.
    if (rho <= 1e-12) {
      out.ox = 0
      out.oy = 0
      out.oz = 0
      out.inside = false
      return
    }
    out.ox = wx / rho
    out.oy = wy / rho
    out.oz = wz / rho
    out.inside = Math.abs(t) <= fit.length / 2
    return
  }

  const dx = x - fit.center[0]
  const dy = y - fit.center[1]
  const dz = z - fit.center[2]
  const dist = Math.hypot(dx, dy, dz)
  out.offset = dist - fit.radius
  if (dist <= 1e-12) {
    out.ox = 0
    out.oy = 0
    out.oz = 0
    out.inside = false
    return
  }
  out.ox = dx / dist
  out.oy = dy / dist
  out.oz = dz / dist
  // A sphere is drawn whole, so there is nothing to be outside of.
  out.inside = true
}

function emptyProbe(): Probe {
  return { offset: 0, ox: 0, oy: 0, oz: 1, inside: false }
}

/**
 * Which side of the element the part's material is on, read off the scan.
 *
 * The scan's own normals point out of the material, so a surface that belongs
 * to this element faces the way the element faces — or exactly the opposite
 * way, if the material is on the other side. Summing the agreement over
 * everything near the element answers it, and summing rather than counting lets
 * a squarely facing surface outweigh one caught at a glancing angle.
 *
 * Near, here, is the search distance in force when the element was chosen: it
 * is the user's own statement of how far still counts. Detected once and then
 * left alone — a side that re-derived itself while the search distance was
 * being dragged could invert the whole map mid-drag.
 */
export function detectMaterialSide(
  fit: ElementTarget,
  positions: Float32Array,
  normals: Float32Array,
  maxDistance: number,
): MaterialSide {
  const probe = emptyProbe()
  let agreement = 0
  for (let v = 0; v < positions.length / 3; v++) {
    probeElement(fit, positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2], probe)
    if (!probe.inside || Math.abs(probe.offset) > maxDistance) continue
    agreement +=
      normals[v * 3] * probe.ox + normals[v * 3 + 1] * probe.oy + normals[v * 3 + 2] * probe.oz
  }
  // Nothing near it to judge by — a construction floating clear of the part, or
  // a search distance dialled down to nothing. The element's own outward side
  // is as good an answer as there is, and the flip is one click away.
  return agreement < 0 ? -1 : 1
}

/**
 * Signed deviation of every scan vertex from the element, in millimetres, with
 * NaN wherever there is nothing to measure — outside the element as drawn, or
 * on a surface facing the wrong way.
 *
 * Positive is always extra material, whichever side of the element it is on,
 * so the map reads the same way as the one against a reference part.
 */
export function computeElementDeviation(
  fit: ElementTarget,
  positions: Float32Array,
  normals: Float32Array,
  { side, maxNormalDeviation, subset }: ElementFieldOptions,
): Float32Array {
  const n = positions.length / 3
  const values = new Float32Array(n)
  const probe = emptyProbe()
  const minFacing = maxNormalDeviation === null ? -Infinity : Math.cos(maxNormalDeviation)

  const measure = (v: number): void => {
    probeElement(fit, positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2], probe)
    if (!probe.inside) {
      values[v] = NaN
      return
    }
    // The material's outward normal is the element's, turned round when the
    // material is on the far side of it — inside a bore, out of a shell.
    const facing =
      side *
      (normals[v * 3] * probe.ox + normals[v * 3 + 1] * probe.oy + normals[v * 3 + 2] * probe.oz)
    values[v] = facing >= minFacing ? side * probe.offset : NaN
  }

  if (subset) {
    values.fill(NaN)
    for (let i = 0; i < subset.length; i++) measure(subset[i])
    return values
  }
  for (let v = 0; v < n; v++) measure(v)
  return values
}

/** What the element is, for the readout and the report: the one number that
 *  says which surface this map is measured against. */
export function describeTarget(fit: ElementTarget): string {
  if (fit.kind === 'plane') {
    return `plane, ${(2 * fit.extentU).toFixed(1)} × ${(2 * fit.extentV).toFixed(1)} mm as drawn`
  }
  if (fit.kind === 'cylinder') {
    return `cylinder, ⌀${(2 * fit.radius).toFixed(3)} mm × ${fit.length.toFixed(1)} mm as drawn`
  }
  return `sphere, ⌀${(2 * fit.radius).toFixed(3)} mm`
}
