// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { chainCount, detectEdges, type EdgeChains } from '../src/core/flat/edges'

// Synthetic scans: dark background, bright shapes, edges softened over a
// couple of pixels the way scanner optics soften them. The softening is what
// gives the subpixel refinement something true to land on.

const W = 220
const H = 180

/** Intensity ramp over |d| ≤ 1 px around a signed distance to the edge. */
function shade(d: number): number {
  if (d <= -1) return 30
  if (d >= 1) return 225
  return 30 + (225 - 30) * (0.5 + 0.5 * Math.sin((d * Math.PI) / 2))
}

/** A bright axis-aligned rectangle with edges at the given (fractional) lines. */
function rectImage(x0: number, y0: number, x1: number, y1: number): Uint8Array {
  const gray = new Uint8Array(W * H)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const cx = x + 0.5
      const cy = y + 0.5
      // Signed distance into the rectangle (negative outside).
      const d = Math.min(cx - x0, x1 - cx, cy - y0, y1 - cy)
      gray[y * W + x] = shade(d)
    }
  }
  return gray
}

/** A bright disc of the given center and radius. */
function discImage(cx: number, cy: number, r: number): Uint8Array {
  const gray = new Uint8Array(W * H)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = r - Math.hypot(x + 0.5 - cx, y + 0.5 - cy)
      gray[y * W + x] = shade(d)
    }
  }
  return gray
}

function allPoints(chains: EdgeChains): [number, number][] {
  const pts: [number, number][] = []
  for (let i = 0; i * 2 < chains.points.length; i++) {
    pts.push([chains.points[i * 2], chains.points[i * 2 + 1]])
  }
  return pts
}

describe('detectEdges', () => {
  it('finds the outline of a rectangle where it actually is', () => {
    const chains = detectEdges(rectImage(40.5, 30.5, 180.5, 150.5), W, H)
    expect(chainCount(chains)).toBeGreaterThan(0)
    const pts = allPoints(chains)
    expect(pts.length).toBeGreaterThan(300)
    // Away from the corners — where the contour genuinely rounds over a
    // couple of pixels — every point sits on one of the four edge lines, to
    // subpixel.
    let worst = 0
    for (const [x, y] of pts) {
      const nearCornerX = Math.min(Math.abs(x - 40.5), Math.abs(x - 180.5)) < 4
      const nearCornerY = Math.min(Math.abs(y - 30.5), Math.abs(y - 150.5)) < 4
      if (nearCornerX && nearCornerY) continue
      const d = Math.min(
        Math.abs(x - 40.5),
        Math.abs(x - 180.5),
        Math.abs(y - 30.5),
        Math.abs(y - 150.5),
      )
      worst = Math.max(worst, d)
    }
    expect(worst).toBeLessThan(0.5)
    // And the left edge specifically is recovered well under a tenth of a
    // pixel on average — the point of the subpixel refinement.
    const left = pts.filter(([x, y]) => Math.abs(x - 40.5) < 2 && y > 40 && y < 140)
    expect(left.length).toBeGreaterThan(50)
    const mean = left.reduce((s, p) => s + p[0], 0) / left.length
    expect(Math.abs(mean - 40.5)).toBeLessThan(0.1)
  })

  it('finds a circle at its radius', () => {
    const chains = detectEdges(discImage(110, 90, 55.3), W, H)
    const pts = allPoints(chains)
    expect(pts.length).toBeGreaterThan(200)
    let sum = 0
    for (const [x, y] of pts) sum += Math.hypot(x - 110, y - 90)
    const meanR = sum / pts.length
    expect(Math.abs(meanR - 55.3)).toBeLessThan(0.2)
  })

  it('links the disc into few long chains rather than pixel confetti', () => {
    const chains = detectEdges(discImage(110, 90, 55.3), W, H)
    const count = chainCount(chains)
    expect(count).toBeGreaterThan(0)
    expect(count).toBeLessThan(8)
    const longest = Math.max(
      ...Array.from({ length: count }, (_, c) => chains.offsets[c + 1] - chains.offsets[c]),
    )
    expect(longest).toBeGreaterThan(150)
  })

  it('sees nothing in a blank image', () => {
    const gray = new Uint8Array(W * H).fill(128)
    expect(chainCount(detectEdges(gray, W, H))).toBe(0)
  })

  it('higher sensitivity keeps fainter edges', () => {
    // A faint step: 100 → 118.
    const gray = new Uint8Array(W * H)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        gray[y * W + x] = x + 0.5 < 110 ? 100 : 118
      }
    }
    // Noise so the thresholds have a distribution to stand on.
    let seed = 42
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return seed / 2 ** 32
    }
    for (let i = 0; i < gray.length; i++) {
      gray[i] = Math.max(0, Math.min(255, gray[i] + (rand() - 0.5) * 6))
    }
    const shy = detectEdges(gray, W, H, { sensitivity: 0 })
    const keen = detectEdges(gray, W, H, { sensitivity: 1 })
    expect(keen.points.length).toBeGreaterThan(shy.points.length)
  })
})
