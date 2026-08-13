import { describe, expect, it } from 'vitest'
import { fitSphereClipped } from '../src/core/fit/sphere'
import { ransacSphere, mulberry32 } from '../src/core/fit/ransac'
import { allIndices, sampleSphere } from './helpers'

const CENTER: [number, number, number] = [10, -5, 3]
const R = 12.7

describe('Gaussian sphere fit', () => {
  it('recovers a full noisy sphere to micron level', () => {
    const pts = sampleSphere(30_000, CENTER, R, 0.02)
    const fit = fitSphereClipped(pts, allIndices(30_000), 3)!
    expect(fit).toBeTruthy()
    expect(Math.abs(fit.sphere.r - R)).toBeLessThan(0.005)
    expect(Math.abs(fit.sphere.cx - CENTER[0])).toBeLessThan(0.005)
    expect(Math.abs(fit.sphere.cy - CENTER[1])).toBeLessThan(0.005)
    expect(Math.abs(fit.sphere.cz - CENTER[2])).toBeLessThan(0.005)
    expect(fit.sigma).toBeGreaterThan(0.015)
    expect(fit.sigma).toBeLessThan(0.025)
  })

  it('recovers a 60-degree cap (partially visible sphere)', () => {
    const pts = sampleSphere(20_000, CENTER, R, 0.02, 43, (60 * Math.PI) / 180)
    const fit = fitSphereClipped(pts, allIndices(20_000), 3)!
    expect(Math.abs(fit.sphere.r - R)).toBeLessThan(0.02)
    expect(Math.abs(fit.sphere.cz - CENTER[2])).toBeLessThan(0.02)
  })

  it('sigma clipping sheds sparse gross outliers', () => {
    const pts = sampleSphere(20_000, CENTER, R, 0.02, 44)
    // Push 2% of points 0.5 mm outward — dust / reconstruction spikes.
    const rand = mulberry32(99)
    for (let i = 0; i < 400; i++) {
      const k = (rand() * 20_000) | 0
      const j = k * 3
      const dx = pts[j] - CENTER[0]
      const dy = pts[j + 1] - CENTER[1]
      const dz = pts[j + 2] - CENTER[2]
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
      pts[j] += (dx / d) * 0.5
      pts[j + 1] += (dy / d) * 0.5
      pts[j + 2] += (dz / d) * 0.5
    }
    const clipped = fitSphereClipped(pts, allIndices(20_000), 3)!
    expect(Math.abs(clipped.sphere.r - R)).toBeLessThan(0.01)
    expect(clipped.used.length).toBeLessThan(20_000)
  })
})

describe('RANSAC sphere estimate', () => {
  it('finds the sphere despite 30% structured outliers', () => {
    const cap = sampleSphere(3_000, CENTER, R, 0.02, 45, (70 * Math.PI) / 180)
    // Fake "rod" contamination: a dense line of points leaving the sphere.
    const rand = mulberry32(7)
    const rod = new Float32Array(1_300 * 3)
    for (let i = 0; i < 1_300; i++) {
      const t = rand() * 20
      rod[i * 3] = CENTER[0] + (rand() - 0.5) * 2
      rod[i * 3 + 1] = CENTER[1] + (rand() - 0.5) * 2
      rod[i * 3 + 2] = CENTER[2] + R + t
    }
    const all = new Float32Array(cap.length + rod.length)
    all.set(cap)
    all.set(rod, cap.length)
    const res = ransacSphere(all, allIndices(4_300), { seed: 1 })!
    expect(res).toBeTruthy()
    expect(Math.abs(res.sphere.r - R)).toBeLessThan(0.1)
    expect(Math.abs(res.sphere.cx - CENTER[0])).toBeLessThan(0.1)
  })
})
