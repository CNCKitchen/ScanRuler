// SPDX-License-Identifier: AGPL-3.0-only
// Suggest creases (PN12): a box with sharp rims and rounded upright edges
// gives its two rims and nothing on the rounds — rounds of 4 mm on edges of
// 0.5 mm, and of 2 mm, only four edges across — and the scan path through
// each curve's grips keeps to its rim; a box with every edge sharp gives
// twelve curves meeting in its eight corners; a fold across a noisy sheet,
// which its triangles cross slantwise, comes out as one curve from edge to
// edge and nothing else, and the sheet without the fold as nothing; and a
// box of 320,000 triangles in a 2-million-triangle scan is read for a
// fraction of what the whole scan costs.

import { describe, expect, it } from 'vitest'
import { ScanPaths } from '../../../src/core/geometry/scanPath'
import type { Vec3 } from '../../../src/core/types'
import { type CreaseSuggestion, suggestCreases } from '../core/networkCreases'
import { traceCurve } from '../core/networkCurve'
import { gridScan } from './networkMeshes'

/** A rectangle of half-sides a, b with corners rounded to r, in the plane:
 *  its point at a share u of the way round, counter-clockwise from the
 *  middle of its +x side, and the signed distance of (x, y) from it. */
function roundedRect(a: number, b: number, r: number) {
  type Piece = { length: number; at: (t: number) => [number, number] }
  const line = (p: [number, number], q: [number, number]): Piece => ({ length: Math.hypot(q[0] - p[0], q[1] - p[1]), at: (t) => [p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])] })
  const arc = (c: [number, number], from: number): Piece => ({ length: (Math.PI * r) / 2, at: (t) => [c[0] + r * Math.cos(from + (t * Math.PI) / 2), c[1] + r * Math.sin(from + (t * Math.PI) / 2)] })
  const pieces = [
    line([a, 0], [a, b - r]),
    arc([a - r, b - r], 0),
    line([a - r, b], [-a + r, b]),
    arc([-a + r, b - r], Math.PI / 2),
    line([-a, b - r], [-a, -b + r]),
    arc([-a + r, -b + r], Math.PI),
    line([-a + r, -b], [a - r, -b]),
    arc([a - r, -b + r], (3 * Math.PI) / 2),
    line([a, -b + r], [a, 0]),
  ]
  const perimeter = pieces.reduce((s, p) => s + p.length, 0)
  const at = (u: number): [number, number] => {
    let d = (((u % 1) + 1) % 1) * perimeter
    for (const p of pieces) {
      if (d <= p.length) return p.at(p.length > 0 ? d / p.length : 0)
      d -= p.length
    }
    return pieces[pieces.length - 1].at(1)
  }
  const signed = (x: number, y: number) => {
    const qx = Math.abs(x) - (a - r)
    const qy = Math.abs(y) - (b - r)
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
  }
  return { perimeter, at, signed }
}

/** A 40 × 30 × 20 mm box scanned as one grid round it: a ring of its
 *  bottom, its four sides, a ring of its top — the rims between them sharp,
 *  the upright edges rounded to r — with edges about h long and noise. */
function roundedBox(r: number, h: number, noise = 0.01) {
  const height = 20
  const rect = roundedRect(20, 15, r)
  const ring = Math.round(6 / h)
  const wall = Math.round(height / h)
  const rows = 2 * ring + wall
  // The rings run from 0.6 of the way out to the rim.
  const inner = 0.6
  const at = (u: number, v: number): Vec3 => {
    const j = Math.min(rows, Math.max(0, v * rows))
    const [x, y] = rect.at(u)
    if (j <= ring) {
      const s = inner + ((1 - inner) * j) / ring
      return [s * x, s * y, 0]
    }
    if (j <= ring + wall) return [x, y, (height * (j - ring)) / wall]
    const s = 1 - ((1 - inner) * (j - ring - wall)) / ring
    return [s * x, s * y, height]
  }
  const mesh = gridScan(Math.round(rect.perimeter / h), rows, at, { wrap: true, noise })
  /** How far a point is from the nearer rim, the edge where the top or the
   *  bottom meets the sides. */
  const offRim = (p: ArrayLike<number>, i = 0) => Math.hypot(rect.signed(p[i], p[i + 1]), Math.min(Math.abs(p[i + 2]), Math.abs(p[i + 2] - height)))
  return { scan: new ScanPaths(mesh.positions, mesh.indices), rect, height, offRim }
}

/** A 60 × 40 mm sheet on edges of 0.5 mm folded up by `deg` along the
 *  line from (12, 0) to (42, 40) — slantwise to its triangles — with
 *  0.02 mm of noise; and how far a point is from the fold, in plan. */
function foldedSheet(deg: number, noise = 0.02) {
  const a: [number, number] = [12, 0]
  const b: [number, number] = [42, 40]
  const l = Math.hypot(b[0] - a[0], b[1] - a[1])
  const across: [number, number] = [(b[1] - a[1]) / l, -(b[0] - a[0]) / l]
  const off = (x: number, y: number) => (x - a[0]) * across[0] + (y - a[1]) * across[1]
  const slope = Math.tan((deg * Math.PI) / 180)
  const mesh = gridScan(120, 80, (u, v) => [60 * u, 40 * v, slope * Math.max(0, off(60 * u, 40 * v))], { noise })
  return { scan: new ScanPaths(mesh.positions, mesh.indices), a, b, offFold: (p: ArrayLike<number>, i = 0) => Math.abs(off(p[i], p[i + 1])) }
}

/** The scan path through a suggested curve's nodes and grips, as the
 *  network traces a curve. */
function tracedPoints(scan: ScanPaths, s: CreaseSuggestion, c: CreaseSuggestion['curves'][number]): Float32Array {
  const at = new Map(s.nodes.map((n) => [n.id, n.at]))
  return traceCurve(scan, [at.get(c.from)!, ...c.via, at.get(c.to)!]).points
}

function worst(points: ArrayLike<number>, off: (p: ArrayLike<number>, i: number) => number): number {
  let w = 0
  for (let i = 0; i < points.length; i += 3) w = Math.max(w, off(points, i))
  return w
}

describe('suggest creases', () => {
  it('gives a rounded box its two sharp rims and nothing on the rounds', () => {
    for (const [r, h] of [
      [4, 0.5],
      [2, 0.5],
    ]) {
      const box = roundedBox(r, h)
      const s = suggestCreases(box.scan)
      // Each rim in four, cut at the middles of its rounded corners: eight
      // curves round eight nodes, two curves at each.
      expect(s.curves.length).toBe(8)
      expect(s.nodes.length).toBe(8)
      for (const n of s.nodes) expect(s.curves.filter((c) => c.from === n.id || c.to === n.id).length).toBe(2)
      for (const c of s.curves) {
        // On a rim all along — none runs down a round — and square.
        expect(worst(c.points, box.offRim)).toBeLessThan(0.1)
        expect(c.angle).toBeGreaterThan(89)
        expect(c.angle).toBeLessThan(91)
        // The grips on the scan, and the scan path through them on the rim
        // round its rounded corners too.
        for (const g of c.via) expect(box.scan.closest(g)!.distance).toBeLessThan(1e-3)
        expect(worst(tracedPoints(box.scan, s, c), box.offRim)).toBeLessThan(0.1)
      }
      // Each rim whole, round its perimeter.
      for (const z of [0, box.height]) {
        const round = s.curves.filter((c) => Math.abs(c.points[2] - z) < 1).reduce((sum, c) => sum + c.length, 0)
        expect(Math.abs(round - box.rect.perimeter) / box.rect.perimeter).toBeLessThan(0.01)
      }
    }
  })

  it('gives a sharp box its twelve edges, meeting in its eight corners', () => {
    const box = roundedBox(0, 0.5)
    const s = suggestCreases(box.scan)
    expect(s.curves.length).toBe(12)
    expect(s.nodes.length).toBe(8)
    for (const n of s.nodes) {
      const corner = Math.hypot(Math.abs(n.at[0]) - 20, Math.abs(n.at[1]) - 15, Math.min(Math.abs(n.at[2]), Math.abs(n.at[2] - box.height)))
      expect(corner).toBeLessThan(0.05)
      expect(s.curves.filter((c) => c.from === n.id || c.to === n.id).length).toBe(3)
    }
    // Four 40 mm edges, four of 30 and four of 20, each square.
    const lengths = s.curves.map((c) => Math.round(c.length)).sort((a, b) => a - b)
    expect(lengths).toEqual([20, 20, 20, 20, 30, 30, 30, 30, 40, 40, 40, 40])
    for (const c of s.curves) expect(Math.abs(c.angle - 90)).toBeLessThan(1)
  })

  it('finds a fold across a noisy sheet as one curve from edge to edge, and nothing else', () => {
    for (const deg of [30, 35, 40]) {
      const sheet = foldedSheet(deg)
      const s = suggestCreases(sheet.scan)
      expect(s.curves.length).toBe(1)
      expect(s.nodes.length).toBe(2)
      const [c] = s.curves
      expect(worst(c.points, sheet.offFold)).toBeLessThan(0.25)
      expect(worst(tracedPoints(sheet.scan, s, c), sheet.offFold)).toBeLessThan(0.25)
      expect(Math.abs(c.angle - deg)).toBeLessThan(1)
      // Its ends at the sheet's edges, where the fold leaves it.
      const ends = s.nodes.map((n) => Math.min(Math.hypot(n.at[0] - sheet.a[0], n.at[1] - sheet.a[1]), Math.hypot(n.at[0] - sheet.b[0], n.at[1] - sheet.b[1])))
      for (const d of ends) expect(d).toBeLessThan(2)
      expect(c.length).toBeGreaterThan(46)
    }
    // The same sheet, noisier, and not folded: nothing.
    expect(suggestCreases(foldedSheet(0, 0.05).scan).curves).toEqual([])
  })

  it('reads 320,000 triangles in a box of a 2-million-triangle scan for a fraction of the whole scan', () => {
    const timed = (read: () => unknown) => {
      const t0 = performance.now()
      read()
      return performance.now() - t0
    }
    // A corrugated sheet 300 mm square on edges of 0.3 to 0.4 mm: folds of
    // 35° every 12.5 mm, slantwise to the triangles.
    const period = 25
    const slope = Math.tan((17.5 * Math.PI) / 180)
    const dir: [number, number] = [Math.cos((20 * Math.PI) / 180), Math.sin((20 * Math.PI) / 180)]
    const along = (x: number, y: number) => x * dir[0] + y * dir[1]
    const mesh = gridScan(
      1000,
      1000,
      (u, v) => {
        const m = (((along(300 * u, 300 * v) % period) + period) % period) - period / 2
        return [300 * u, 300 * v, slope * (period / 2 - Math.abs(m))]
      },
      { noise: 0.02 },
    )
    const scan = new ScanPaths(mesh.positions, mesh.indices)
    expect(scan.triangleCount).toBe(2_000_000)
    const box = { min: [90, 90, -10] as Vec3, max: [210, 210, 10] as Vec3 }
    const s = suggestCreases(scan, { box })
    // Against the whole scan on the same machine, not a fixed number of
    // milliseconds: this read takes 0.25 s on a desktop and 1.7 s on a CI
    // runner. CPU time is no way out, it counts the collector's threads too.
    // The best of three, since other test files only ever add to a read.
    const whole = timed(() => suggestCreases(scan))
    const ms = Math.min(...[0, 1, 2].map(() => timed(() => suggestCreases(scan, { box }))))
    // The twelve folds that cross the box, each whole, each one curve.
    expect(s.curves.length).toBe(12)
    const offFold = (p: ArrayLike<number>, i: number) => {
      const d = along(p[i], p[i + 1])
      return Math.abs(d - (period / 2) * Math.round(d / (period / 2)))
    }
    for (const c of s.curves) {
      expect(Math.abs(c.angle - 35)).toBeLessThan(1)
      expect(worst(c.points, offFold)).toBeLessThan(0.3)
    }
    // Measured at under a fifth of the whole scan, on an idle machine and under
    // the full suite alike. The 5 s is a bound only a real slowdown crosses.
    console.log(`creases: box ${ms.toFixed(0)} ms, whole scan ${whole.toFixed(0)} ms`)
    expect(ms).toBeLessThan(whole / 2.5)
    expect(ms).toBeLessThan(5000)
  }, 60_000)
})
