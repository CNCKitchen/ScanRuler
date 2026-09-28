// SPDX-License-Identifier: AGPL-3.0-only
// A fit from one click on an edge chain: the line or circle grows along the
// chain from the click and stops where the edge bends away.
import { describe, expect, it } from 'vitest'
import { fitCirclePoints, fitLinePoints } from '../src/core/flat/fit'
import { growCircleFromSeed, growLineFromSeed } from '../src/core/flat/grow'
import type { Vec2 } from '../src/core/flat/types'
import { mulberry32 } from '../src/core/fit/ransac'

/** A rounded rectangle traced counter-clockwise from the start of its
 *  bottom side, sampled every `spacing` (jittered by `jitter` of it) with
 *  uniform noise of ±`noise`·√3 (σ = noise) across the edge, closed back
 *  onto its first point the way a section's loop is. */
function roundedRect(
  w: number,
  h: number,
  r: number,
  spacing: number,
  noise: number,
  jitter = 0,
  seed = 1,
): Vec2[] {
  const rand = mulberry32(seed)
  // The outline as a run of straights and quarter arcs, walked by length.
  type Piece = { len: number; at: (t: number) => { p: Vec2; n: Vec2 } }
  const straight = (a: Vec2, b: Vec2): Piece => {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1])
    const d: Vec2 = [(b[0] - a[0]) / len, (b[1] - a[1]) / len]
    return { len, at: (t) => ({ p: [a[0] + d[0] * t, a[1] + d[1] * t], n: [d[1], -d[0]] }) }
  }
  const arc = (c: Vec2, a0: number): Piece => ({
    len: (Math.PI / 2) * r,
    at: (t) => {
      const a = a0 + t / r
      return { p: [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)], n: [Math.cos(a), Math.sin(a)] }
    },
  })
  const pieces: Piece[] = [
    straight([r, 0], [w - r, 0]),
    arc([w - r, r], -Math.PI / 2),
    straight([w, r], [w, h - r]),
    arc([w - r, h - r], 0),
    straight([w - r, h], [r, h]),
    arc([r, h - r], Math.PI / 2),
    straight([0, h - r], [0, r]),
    arc([r, r], Math.PI),
  ]
  const out: Vec2[] = []
  let s = 0
  const total = pieces.reduce((acc, p) => acc + p.len, 0)
  while (s < total) {
    let t = s
    let piece = pieces[0]
    for (const p of pieces) {
      if (t < p.len) {
        piece = p
        break
      }
      t -= p.len
    }
    const { p, n } = piece.at(t)
    const e = (rand() - 0.5) * 2 * Math.sqrt(3) * noise
    out.push([p[0] + n[0] * e, p[1] + n[1] * e])
    s += spacing * (1 + (rand() - 0.5) * 2 * jitter)
  }
  out.push([out[0][0], out[0][1]])
  return out
}

/** The chain rotated so that it starts `k` points in — the seam moved. */
function rotated(chain: Vec2[], k: number): Vec2[] {
  const open = chain.slice(0, -1)
  const turned = [...open.slice(k), ...open.slice(0, k)]
  return [...turned, turned[0]]
}

function nearest(chain: Vec2[], p: Vec2): number {
  let best = 0
  let bestD = Infinity
  chain.forEach((q, i) => {
    const d = Math.hypot(q[0] - p[0], q[1] - p[1])
    if (d < bestD) {
      bestD = d
      best = i
    }
  })
  return best
}

describe('growLineFromSeed', () => {
  // A 600 × 150 px part with 20 px fillets at 600 dpi: subpixel edges a
  // tenth of a pixel off.
  const part = roundedRect(600, 150, 20, 1, 0.1)

  it('grows along the side the click landed on and stops at the fillets', () => {
    const picks = growLineFromSeed(part, nearest(part, [300, 0]))
    const fit = fitLinePoints(picks)
    expect(Math.abs(fit.dir[1])).toBeLessThan(1e-3)
    expect(fit.center[1]).toBeCloseTo(0, 1)
    // The straight part is 560 px; the band lets a few pixels of each
    // fillet in and no more.
    expect(fit.length).toBeGreaterThan(555)
    expect(fit.length).toBeLessThan(570)
    expect(fit.sigma).toBeLessThan(0.15)
    for (const p of picks) expect(p[1]).toBeLessThan(0.5)
  })

  it('takes the vertical side the same way', () => {
    const picks = growLineFromSeed(part, nearest(part, [600, 75]))
    const fit = fitLinePoints(picks)
    expect(Math.abs(fit.dir[0])).toBeLessThan(1e-3)
    expect(fit.center[0]).toBeCloseTo(600, 1)
    expect(fit.length).toBeGreaterThan(105)
    expect(fit.length).toBeLessThan(120)
  })

  it('runs across the seam of a closed chain', () => {
    // The chain now starts in the middle of the bottom side, and the click
    // lands two points past it: the line still covers the whole side.
    const turned = rotated(part, nearest(part, [300, 0]))
    const picks = growLineFromSeed(turned, 2)
    const fit = fitLinePoints(picks)
    expect(fit.length).toBeGreaterThan(555)
    expect(Math.abs(fit.center[0] - 300)).toBeLessThan(3)
  })

  it('refuses a click on a fillet', () => {
    expect(() => growLineFromSeed(part, nearest(part, [580 + 20 * Math.SQRT1_2, 20 - 20 * Math.SQRT1_2]))).toThrow(
      /curved/,
    )
  })

  it('refuses a click on a hole', () => {
    const rand = mulberry32(3)
    const hole: Vec2[] = []
    for (let i = 0; i < 754; i++) {
      const a = (i / 754) * 2 * Math.PI
      const e = (rand() - 0.5) * 0.35
      hole.push([100 + (120 + e) * Math.cos(a), 100 + (120 + e) * Math.sin(a)])
    }
    hole.push([hole[0][0], hole[0][1]])
    expect(() => growLineFromSeed(hole, 40)).toThrow(/curved/)
  })

  it('carries a stray point along without stopping at it', () => {
    const chain = part.map((p): Vec2 => [p[0], p[1]])
    const stray = nearest(chain, [200, 0])
    chain[stray] = [chain[stray][0], chain[stray][1] - 2]
    const picks = growLineFromSeed(chain, nearest(chain, [300, 0]))
    const fit = fitLinePoints(picks)
    expect(fit.length).toBeGreaterThan(555)
    // The stray itself is let go at the end.
    expect(picks.some((p) => p[1] < -1)).toBe(false)
  })

  it('stops an open chain where the line runs into a tangent arc', () => {
    // A straight run from the origin, then a 30-unit arc leaving it tangent.
    const chain: Vec2[] = []
    for (let x = 0; x <= 100; x += 1) chain.push([x, 0])
    for (let i = 1; i <= 47; i++) {
      const a = -Math.PI / 2 + i / 30
      chain.push([100 + 30 * Math.cos(a), 30 + 30 * Math.sin(a)])
    }
    const picks = growLineFromSeed(chain, 50)
    const fit = fitLinePoints(picks)
    expect(Math.abs(fit.dir[1])).toBeLessThan(1e-3)
    expect(picks[0][0]).toBeCloseTo(0, 6)
    expect(picks[picks.length - 1][0]).toBeLessThan(104)
    expect(picks.length).toBeGreaterThan(98)
  })

  it('serves a coarse section in millimetres by the same rule', () => {
    // A 30 × 10 mm part with 2 mm fillets, sliced at 0.3 mm with the
    // uneven spacing a mesh cut has, 10 µm of scanner noise.
    const cut = roundedRect(30, 10, 2, 0.3, 0.01, 0.4, 5)
    const picks = growLineFromSeed(cut, nearest(cut, [15, 0]))
    const fit = fitLinePoints(picks)
    expect(Math.abs(fit.dir[1])).toBeLessThan(2e-3)
    expect(fit.center[1]).toBeCloseTo(0, 2)
    expect(fit.length).toBeGreaterThan(25.5)
    expect(fit.length).toBeLessThan(27.2)
  })
})

describe('growCircleFromSeed', () => {
  const part = roundedRect(600, 150, 20, 1, 0.1)

  it('takes the fillet the click landed on', () => {
    const picks = growCircleFromSeed(part, nearest(part, [580 + 20 * Math.SQRT1_2, 20 - 20 * Math.SQRT1_2]))
    const fit = fitCirclePoints(picks)
    expect(fit.radius).toBeCloseTo(20, 0)
    expect(Math.abs(fit.radius - 20)).toBeLessThan(0.15)
    expect(fit.center[0]).toBeCloseTo(580, 0)
    expect(fit.center[1]).toBeCloseTo(20, 0)
    // A quarter arc of 31 px, plus the few pixels of side the band lets in.
    expect(picks.length).toBeGreaterThan(28)
    expect(picks.length).toBeLessThan(42)
  })

  it('refuses a click on a straight side', () => {
    expect(() => growCircleFromSeed(part, nearest(part, [300, 0]))).toThrow(/straight/)
  })

  it('takes a whole hole from one click on its rim', () => {
    const rand = mulberry32(3)
    const hole: Vec2[] = []
    for (let i = 0; i < 754; i++) {
      const a = (i / 754) * 2 * Math.PI
      const e = (rand() - 0.5) * 0.35
      hole.push([100 + (120 + e) * Math.cos(a), 100 + (120 + e) * Math.sin(a)])
    }
    hole.push([hole[0][0], hole[0][1]])
    const picks = growCircleFromSeed(hole, 40)
    expect(picks.length).toBeGreaterThan(740)
    const fit = fitCirclePoints(picks)
    expect(fit.radius).toBeCloseTo(120, 1)
    expect(fit.center[0]).toBeCloseTo(100, 1)
    expect(fit.center[1]).toBeCloseTo(100, 1)
  })

  it('finds a shallow arc once the window is wide enough to resolve it', () => {
    // A 90° arc of radius 400 px between two straights — 16 px of sagitta
    // over its chord, but a dozen points of it look straight.
    const chain: Vec2[] = []
    for (let x = -200; x < 0; x += 1) chain.push([x, 0])
    for (let i = 0; i <= 628; i++) {
      const a = -Math.PI / 2 + i / 400
      chain.push([400 * Math.cos(a), 400 + 400 * Math.sin(a)])
    }
    for (let y = 1; y <= 200; y += 1) chain.push([400, 400 + y])
    const picks = growCircleFromSeed(chain, nearest(chain, [400 * Math.SQRT1_2, 400 - 400 * Math.SQRT1_2]))
    const fit = fitCirclePoints(picks)
    expect(fit.radius).toBeCloseTo(400, 0)
    expect(picks.length).toBeGreaterThan(600)
    expect(picks.length).toBeLessThan(660)
  })

  it('serves a coarse section in millimetres', () => {
    const cut = roundedRect(30, 10, 2, 0.3, 0.01, 0.4, 5)
    const picks = growCircleFromSeed(cut, nearest(cut, [28 + 2 * Math.SQRT1_2, 2 - 2 * Math.SQRT1_2]))
    const fit = fitCirclePoints(picks)
    // Ten points of 10 µm noise on a quarter arc: the radius is good to a
    // few hundredths.
    expect(Math.abs(fit.radius - 2)).toBeLessThan(0.06)
    expect(Math.abs(fit.center[0] - 28)).toBeLessThan(0.06)
    expect(Math.abs(fit.center[1] - 2)).toBeLessThan(0.06)
  })
})
