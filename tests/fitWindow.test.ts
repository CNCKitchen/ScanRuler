// SPDX-License-Identifier: AGPL-3.0-only
// A cylinder fit confined to the drawn span: the surface past an end that was
// pulled in stays out of the best fit, and only out of the best fit — the
// length reported still says how far the scan reached.
import { describe, expect, it } from 'vitest'
import { buildMeshGraph } from '../src/core/geometry/buildGraph'
import { FitError } from '../src/core/fit/errors'
import { fitCylinderFromSeed, fitCylinderOnSelection } from '../src/core/fit/fitCylinderFromSeed'
import type { AxialWindow, MeshGraph } from '../src/core/types'
import { cylinderMesh } from './helpers'

const SETTINGS = { method: 'gaussian', sigma: 3 } as const

const R = 8
const LENGTH = 40
/** The top of the bore came out badly: over the last 8 mm the wall flares
 *  outward, up to 0.06 mm at the rim on a 0.02 mm noise floor — the kind of
 *  rounded-off mouth a scanner leaves on a hole. Mild on purpose: a gross
 *  flare is thrown out by the sigma clipping on its own, and it is the one
 *  that is not that bends a fit. */
const NOISE = 0.02
const FLARE_FROM = LENGTH / 2 - 8
const FLARE = 0.06

function flaredCylinder(): MeshGraph {
  const { positions } = cylinderMesh(R, LENGTH, 64, 24, NOISE)
  for (let i = 0; i < positions.length; i += 3) {
    const z = positions[i + 2]
    const r = Math.hypot(positions[i], positions[i + 1])
    if (z <= FLARE_FROM || r < R * 0.5) continue
    const k = 1 + (FLARE * (z - FLARE_FROM)) / (LENGTH / 2 - FLARE_FROM) / R
    positions[i] *= k
    positions[i + 1] *= k
  }
  return buildMeshGraph({ kind: 'soup', positions })
}

const graph = flaredCylinder()

/** Every wall vertex — the flared ones included — but neither end cap. */
function wall(g: MeshGraph): Uint32Array {
  const out: number[] = []
  for (let v = 0; v < g.vertexCount; v++) {
    const r = Math.hypot(g.positions[v * 3], g.positions[v * 3 + 1])
    if (r > R * 0.5 && Math.abs(g.positions[v * 3 + 2]) < LENGTH / 2 - 1e-3) out.push(v)
  }
  return Uint32Array.from(out)
}

const selection = wall(graph)
const full = fitCylinderOnSelection(graph, selection, SETTINGS)
/** How far along Z the marked wall reaches — the rim rows belong to the caps
 *  and are not in it, so this is a little short of the rod itself. */
const wallSpan = (() => {
  let lo = Infinity
  let hi = -Infinity
  for (let i = 0; i < selection.length; i++) {
    const z = graph.positions[selection[i] * 3 + 2]
    lo = Math.min(lo, z)
    hi = Math.max(hi, z)
  }
  return hi - lo
})()

/** The window that pulls the flared end in by `mm`: which of the two sides
 *  that is depends on which way the fit happened to point its axis. */
function offTop(mm: number): AxialWindow {
  return full.axis[2] > 0 ? { start: 0, end: -mm } : { start: -mm, end: 0 }
}

const countBelow = (z: number) => {
  let n = 0
  for (let i = 0; i < selection.length; i++) {
    if (graph.positions[selection[i] * 3 + 2] < z) n++
  }
  return n
}

describe('a cylinder fitted inside its span', () => {
  it('leaves the surface past a pulled-in end out of the fit', () => {
    const out = fitCylinderOnSelection(graph, selection, SETTINGS, offTop(8))
    // Exactly the vertices inside the span, give or take the one row of the
    // mesh a slightly tilted axis can move across the cut.
    expect(Math.abs(out.regionSize - countBelow(LENGTH / 2 - 8))).toBeLessThanOrEqual(64)
    expect(out.region.length).toBe(out.regionSize)
    expect(out.usedPoints).toBeLessThanOrEqual(out.regionSize)
    expect(out.regionSize).toBeLessThan(selection.length)
  })

  it('finds the true diameter once the flare is out of the way', () => {
    const out = fitCylinderOnSelection(graph, selection, SETTINGS, offTop(8))
    // The flare pulls the whole-surface fit a few microns wide; inside the
    // span the radius comes back to within the noise.
    expect(Math.abs(full.radius - R)).toBeGreaterThan(0.003)
    expect(Math.abs(out.radius - R)).toBeLessThan(0.001)
    expect(out.sigma).toBeLessThan(full.sigma)
  })

  it('still reports the length the scan reached', () => {
    const out = fitCylinderOnSelection(graph, selection, SETTINGS, offTop(8))
    expect(Math.abs(out.length - wallSpan)).toBeLessThan(0.05)
    expect(Math.abs(out.length - full.length)).toBeLessThan(0.05)
    expect(Math.abs(out.center[2])).toBeLessThan(0.1)
    expect(out.coverage).toBeGreaterThan(350)
  })

  it('takes nothing away when the span only reaches outward', () => {
    const out = fitCylinderOnSelection(graph, selection, SETTINGS, { start: 3, end: 5 })
    expect(out.radius).toBe(full.radius)
    expect(out.regionSize).toBe(full.regionSize)
    expect(out.length).toBe(full.length)
  })

  it('refuses a span with too little surface left inside it', () => {
    expect(() =>
      fitCylinderOnSelection(graph, selection, SETTINGS, { start: -LENGTH, end: -LENGTH }),
    ).toThrow(FitError)
    expect(() =>
      fitCylinderOnSelection(graph, selection, SETTINGS, { start: -LENGTH, end: -LENGTH }),
    ).toThrow(/inside the span/)
  })

  it('applies to a fit grown from a click the same way', () => {
    // A seed on the wall, well away from the flare.
    let seed = -1
    for (let v = 0; v < graph.vertexCount; v++) {
      const r = Math.hypot(graph.positions[v * 3], graph.positions[v * 3 + 1])
      if (r > R * 0.5 && Math.abs(graph.positions[v * 3 + 2]) < 0.9) {
        seed = v
        break
      }
    }
    expect(seed).toBeGreaterThanOrEqual(0)
    const grown = fitCylinderFromSeed(graph, [seed], SETTINGS)
    const window = grown.axis[2] > 0 ? { start: 0, end: -8 } : { start: -8, end: 0 }
    const out = fitCylinderFromSeed(graph, [seed], SETTINGS, window)
    expect(out.regionSize).toBeLessThan(grown.regionSize)
    expect(Math.abs(grown.radius - R)).toBeGreaterThan(0.003)
    expect(Math.abs(out.radius - R)).toBeLessThan(0.001)
    expect(Math.abs(out.length - grown.length)).toBeLessThan(0.05)
  })
})
