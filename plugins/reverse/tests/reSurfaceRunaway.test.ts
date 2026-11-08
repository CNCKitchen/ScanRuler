// SPDX-License-Identifier: AGPL-3.0-only
// A freeform surface that stays by its points. The fit leaves every
// quadratic free, so where a patchy region's points run out — a disc in
// its square box, a hole in the middle — the surface went on as the
// points' edge bent, and on the water pump's underside curled 100 mm off
// a part 20 mm tall. A weak pull toward the region's plane holds the
// cells no point is near, moving the surface at the points by under their
// noise; a fit that still runs away is refused, naming where; the
// kernel's surface through the fit is checked to follow it, and its
// triangles are counted before it is meshed.
import { describe, expect, it, vi } from 'vitest'
import { Builder } from '../core/build'
import type { Feature } from '../core/features'
import { ReKernel } from '../core/kernel'
import { DEFAULT_SURFACE_FIT, evalSurface, fitSurface, fitSurfaceReported, gridArea, gridOf, meshTriangles, PULL, runAway, type SurfaceFitResult } from '../core/surfaceFit'
import { build } from './reKit'

const kernelPromise = ReKernel.load()

/** A deterministic noise source, so a failing case fails the same way. */
function noise(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    const a = s / 4294967296
    s = (s * 1664525 + 1013904223) >>> 0
    const b = s / 4294967296
    return Math.sqrt(-2 * Math.log(a + 1e-12)) * Math.cos(2 * Math.PI * b)
  }
}

/** Points z = f(x, y) on a disc of radius r with a hole of radius `hole`
 *  in it, every `step` mm, noisy in z by sigma. */
function disc(f: (x: number, y: number) => number, r: number, hole: number, step: number, sigma: number, seed = 1): Float64Array {
  const rnd = noise(seed)
  const pts: number[] = []
  for (let x = -r; x <= r; x += step) {
    for (let y = -r; y <= r; y += step) {
      const d = Math.hypot(x, y)
      if (d > r || d < hole) continue
      pts.push(x, y, f(x, y) + rnd() * sigma)
    }
  }
  return Float64Array.from(pts)
}

/** Points on a grid w × h, z = f(x, y), a few microns off it. */
function patch(f: (x: number, y: number) => number, w: number, h: number, step: number): Float64Array {
  const pts: number[] = []
  for (let x = -w / 2; x <= w / 2; x += step) for (let y = -h / 2; y <= h / 2; y += step) pts.push(x, y, f(x, y) + 0.01 * Math.sin(7 * x + 3 * y))
  return Float64Array.from(pts)
}

/** Stepped levels with a slight twist: a housing's underside, near enough. */
const levels = (x: number, y: number) => (x > 10 ? 4 : 0) + (y < -20 ? -3 : 0) + (x < -30 ? 2 : 0) + (x * y) / 2000
/** The levels curling up steeply into a rim from radius c. */
const rim = (c: number, k: number) => (x: number, y: number) => levels(x, y) + Math.max(0, Math.hypot(x, y) - c) ** 2 * k
const net = (n: number) => ({ ...DEFAULT_SURFACE_FIT, net: { u: n, v: n } })

function overPlane(fit: SurfaceFitResult, x: number, y: number, z: number): { u: number; v: number; h: number } {
  const d = [x - fit.origin[0], y - fit.origin[1], z - fit.origin[2]]
  const dot = (a: readonly number[]) => d[0] * a[0] + d[1] * a[1] + d[2] * a[2]
  return { u: dot(fit.axisU), v: dot(fit.axisV), h: dot(fit.normal) }
}

/** How far the fitted surface leaves the points' height range anywhere. */
function overshoot(fit: SurfaceFitResult, xyz: Float64Array): number {
  let lo = Infinity, hi = -Infinity
  for (let i = 0; i < xyz.length; i += 3) {
    const { h } = overPlane(fit, xyz[i], xyz[i + 1], xyz[i + 2])
    lo = Math.min(lo, h)
    hi = Math.max(hi, h)
  }
  let worst = 0
  for (let a = 0; a <= 40; a++) {
    for (let b = 0; b <= 40; b++) {
      const p = evalSurface(fit, fit.uRange[0] + ((fit.uRange[1] - fit.uRange[0]) * a) / 40, fit.vRange[0] + ((fit.vRange[1] - fit.vRange[0]) * b) / 40)
      const { h } = overPlane(fit, p[0], p[1], p[2])
      worst = Math.max(worst, h - hi, lo - h)
    }
  }
  return worst
}

/** How far apart two fits of the same points are at the points. */
function moved(a: SurfaceFitResult, b: SurfaceFitResult, xyz: Float64Array): number {
  let worst = 0
  for (let i = 0; i < xyz.length; i += 3) {
    const pa = overPlane(a, xyz[i], xyz[i + 1], xyz[i + 2])
    const qa = evalSurface(a, pa.u, pa.v)
    const pb = overPlane(b, xyz[i], xyz[i + 1], xyz[i + 2])
    const qb = evalSurface(b, pb.u, pb.v)
    worst = Math.max(worst, Math.hypot(qa[0] - qb[0], qa[1] - qb[1], qa[2] - qb[2]))
  }
  return worst
}

describe('the pull toward the plane', () => {
  it('holds the empty corners of a patchy region by its points', () => {
    for (const [xyz, params, sigma] of [
      [disc(levels, 60, 15, 1.5, 1, 5), net(14), 1],
      [disc(levels, 60, 45, 1.5, 0.5, 5), net(20), 0.5],
    ] as const) {
      const free = fitSurface(xyz, params, sigma, 0)
      const held = fitSurface(xyz, params, sigma)
      expect(overshoot(free, xyz)).toBeGreaterThan(4)
      expect(overshoot(held, xyz)).toBeLessThan(0.5)
      // At the points it moves by under half the residual, well under
      // the noise.
      expect(moved(free, held, xyz)).toBeLessThan(0.5 * free.rms + 1e-9)
      expect(moved(free, held, xyz)).toBeLessThan(sigma)
    }
  })

  it('moves a curved patch at its points by under the noise, however low the noise', () => {
    for (const sigma of [0.3, 0.02]) {
      const xyz = disc((x, y) => (x * x + 0.6 * y * y) / 400, 60, 15, 1.5, sigma, 3)
      const free = fitSurface(xyz, net(14), sigma, 0)
      const held = fitSurface(xyz, net(14), sigma)
      expect(moved(free, held, xyz)).toBeLessThan(sigma)
      // The bowl carries on past its points as a bowl: its corners are
      // bent back toward the plane only a little.
      expect(overshoot(held, xyz)).toBeGreaterThan(10)
    }
  })

  it('leaves a region with points near every cell as it was', () => {
    const xyz = patch((x) => Math.sqrt(900 - x * x) - 30, 30, 20, 0.5)
    const free = fitSurface(xyz, { ...DEFAULT_SURFACE_FIT, net: { u: 8, v: 4 } }, 0.02, 0)
    const held = fitSurface(xyz, { ...DEFAULT_SURFACE_FIT, net: { u: 8, v: 4 } }, 0.02, PULL)
    expect(Array.from(held.heights)).toEqual(Array.from(free.heights))
  })
})

describe('a fit that runs away', () => {
  it('is refused, naming the spot and where the points run out', () => {
    const xyz = disc(rim(56, 1), 60, 15, 1, 0.5, 5)
    const fit = fitSurface(xyz, net(14), 0.5)
    expect(overshoot(fit, xyz)).toBeGreaterThan(0.425 * 120)
    expect(runAway(fit, xyz, DEFAULT_SURFACE_FIT.expandPct)).toMatch(
      /^The surface runs away from its points: it stands [\d.]+ mm (above the highest|below the lowest) of them at \(-?[\d.]+, -?[\d.]+, -?[\d.]+\), [\d.]+ mm past where the region's points run out at \(/,
    )
    expect(() => fitSurfaceReported(xyz, net(14))).toThrow(/runs away from its points/)
  })

  it('is not refused for a curve carried on past its points', () => {
    const xyz = disc((x, y) => (x * x + 0.6 * y * y) / 400, 60, 15, 1.5, 0.3, 3)
    expect(runAway(fitSurface(xyz, net(14), 0.3), xyz, DEFAULT_SURFACE_FIT.expandPct)).toBeNull()
    const cyl = patch((x) => Math.sqrt(900 - x * x) - 30, 30, 20, 0.5)
    expect(runAway(fitSurface(cyl, { ...DEFAULT_SURFACE_FIT, net: { u: 8, v: 4 } }, 0.02), cyl, DEFAULT_SURFACE_FIT.expandPct)).toBeNull()
  })
})

describe('the kernel’s surface and its mesh', () => {
  /** A freeform surface feature through all the points, built. */
  async function fitted(xyz: Float64Array, fit: Partial<typeof DEFAULT_SURFACE_FIT> & { robust?: boolean }) {
    const builder = new Builder(await kernelPromise)
    const positions = Float32Array.from(xyz)
    builder.setScan(null, positions)
    const region = Uint32Array.from({ length: positions.length / 3 }, (_, i) => i)
    const f = { id: 1, kind: 'surface', name: 'Surface 1', region, fit: { ...DEFAULT_SURFACE_FIT, ...fit }, visible: true } as unknown as Feature
    const out = await build(builder, [f])
    builder.dispose()
    return { result: out.results[0], body: out.bodies[0] }
  }

  it('counts the triangles the mesher makes within a factor of two', async () => {
    const k = await kernelPromise
    for (const [xyz, n] of [
      [patch((x) => Math.sqrt(900 - x * x) - 30, 40, 20, 0.5), 8],
      [patch((x, y) => (x * x - y * y) / 80, 40, 40, 1), 10],
      [patch((x, y) => (x * x + y * y) / 400, 200, 200, 4), 12],
    ] as const) {
      const fit = fitSurface(xyz, { ...net(n), smoothness: 0.001 }, 0.01)
      const grid = gridOf(fit)
      const face = k.surfaceThrough(grid.points, grid.rows, grid.cols)
      for (const chord of [0.05, 0.02]) {
        const made = k.mesh(face, chord).indices.length / 3
        expect(made / meshTriangles(fit, chord)).toBeGreaterThan(0.5)
        expect(made / meshTriangles(fit, chord)).toBeLessThan(2)
      }
      k.release(face)
    }
  })

  it('takes a denser grid where the kernel’s surface through the first swings off it', async () => {
    const xyz = patch((x, y) => 3 * Math.sin(x / 5) * Math.cos(y / 7), 100, 100, 1)
    // Through three samples a span the kernel's surface has thousands of
    // times the fit's area.
    const k = await kernelPromise
    const fit = fitSurface(xyz, { ...net(20), smoothness: 0.001 }, 0.01)
    const grid = gridOf(fit)
    const face = k.surfaceThrough(grid.points, grid.rows, grid.cols)
    expect(k.surfaceArea(face) / gridArea(grid)).toBeGreaterThan(100)
    k.release(face)
    const { result, body } = await fitted(xyz, { net: { u: 20, v: 20 }, smoothness: 0.001 })
    expect(result.status).toBe('ok')
    // The face built stands where the fit does: its box is the grid's.
    let lo = Infinity, hi = -Infinity
    for (let i = 2; i < grid.points.length; i += 3) [lo, hi] = [Math.min(lo, grid.points[i]), Math.max(hi, grid.points[i])]
    expect(Math.abs(body.box!.min[2] - lo)).toBeLessThan(0.5)
    expect(Math.abs(body.box!.max[2] - hi)).toBeLessThan(0.5)
    expect(body.triangles).toBeLessThan(50_000)
  })

  it('refuses a fit that runs away before the kernel makes it', async () => {
    const { result, body } = await fitted(disc(rim(56, 1), 60, 15, 1, 0.5, 5), { net: { u: 14, v: 14 } })
    expect(result.status).toBe('failed')
    expect(result.message).toMatch(/runs away from its points/)
    expect(body).toBeUndefined()
  })

  it('refuses a surface that would mesh to too many triangles, before it is meshed', async () => {
    // An egg crate a metre across, 600 mm deep, the net following it.
    const xyz = patch((x, y) => 300 * Math.sin(x / 51) * Math.sin(y / 51), 1000, 1000, 10)
    // Asked of the mesher rather than the clock: a fixed time limit failed
    // on slower CI runners while the count still came first.
    const meshed = vi.spyOn(await kernelPromise, 'mesh')
    try {
      const { result } = await fitted(xyz, { net: { u: 20, v: 20 }, smoothness: 0, expandPct: 0 })
      expect(result.status).toBe('failed')
      expect(result.message).toMatch(/^The surface would mesh to about \d+ k triangles at its 0.05 mm chord/)
      expect(meshed).not.toHaveBeenCalled()
    } finally {
      meshed.mockRestore()
    }
  })

  it('draws a fitted surface to a chord after its size', async () => {
    const { result, body } = await fitted(patch((x, y) => (x * x + y * y) / 2000, 300, 300, 6), { net: { u: 8, v: 8 } })
    expect(result.status).toBe('ok')
    // About 400 mm across with its margin: drawn to 0.2 mm, not 0.05.
    expect(body.triangles).toBeLessThan(3000)
  })
})
