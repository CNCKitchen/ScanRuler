// SPDX-License-Identifier: AGPL-3.0-only
// The arithmetic of cleaning a cloud up: pieces joined by a gap, the ones
// floating off the main body under a share of it, the points past a plane,
// and the cloud without a set of points — and, when a RevoMetro cloud is at
// hand (tests/revoFixtures.ts), what Floating finds on a real scan; and on
// the Stanford statuette and lucy clouds (one connected surface each, densely
// and unevenly sampled), that Floating leaves them whole. Those live outside
// the repository: SCANRULER_STANFORD_DIR names the folder holding
// statuette-cloud.ply and lucy-cloud.ply; lucy (14 M points) runs under
// SCANRULER_HEAVY=1. Each skips, loudly, where its file is absent.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildPointGraph } from '../../../src/core/geometry/buildPointGraph'
import { parsePLY } from '../../../src/core/parsers/ply'
import { sphereCloud } from '../../../tests/cloudFixtures'
import { revo } from '../../../tests/revoFixtures'
import { cloudPieces, floatingPieces, GAP_MAX_SPACINGS, GAP_SPACINGS, joinGap, pastPlane, withoutPoints } from '../core/clean'

/** A ball of radius 20 at 1 mm, with two specks off it: one of 30 points
 *  (a scrap) 10 mm clear of it and one of a single point (dust). */
function ballWithSpecks() {
  const ball = sphereCloud({ radius: 20, step: 1 })
  const p = Array.from(ball.positions)
  const n = Array.from(ball.normals)
  const ballPoints = p.length / 3
  for (let i = 0; i < 30; i++) {
    p.push(30 + (i % 6) * 0.8, Math.floor(i / 6) * 0.8, 0)
    n.push(0, 0, 1)
  }
  p.push(-40, 0, 0)
  n.push(1, 0, 0)
  return { positions: Float32Array.from(p), normals: Float32Array.from(n), ballPoints }
}

describe('pieces of a cloud', () => {
  const c = ballWithSpecks()
  const count = c.positions.length / 3
  const pieces = cloudPieces(c.positions, count, GAP_SPACINGS * 1)

  it('joins what lies within the gap and nothing further', () => {
    expect(pieces.size.length).toBe(3)
    expect(pieces.size[pieces.main]).toBe(c.ballPoints)
    expect([...pieces.size].sort((a, b) => a - b)).toEqual([1, 30, c.ballPoints])
  })

  it('marks the pieces under the share of the main body, and none at 0 %', () => {
    expect(floatingPieces(pieces, 0).floating).toBe(0)
    const tenth = floatingPieces(pieces, 10)
    expect(tenth.floating).toBe(2)
    expect(tenth.vertices.length).toBe(31)
    expect(tenth.vertices[0]).toBe(c.ballPoints)
    expect(tenth.mainPoints).toBe(c.ballPoints)
    expect(tenth.largestKept).toBe(0)
    // Just above one point's share: the dust goes, the scrap stays.
    const dust = floatingPieces(pieces, (2 / c.ballPoints) * 100)
    expect(dust.floating).toBe(1)
    expect(dust.vertices).toEqual(Uint32Array.of(count - 1))
    expect(dust.largestKept).toBe(30)
  })

  it('keeps only the main body at 100 %', () => {
    const all = floatingPieces(pieces, 100)
    expect(all.floating).toBe(2)
    expect(all.vertices.length).toBe(count - c.ballPoints)
  })
})

/** A flat patch sampled unevenly, as a scanner leaves a surface it saw at a
 *  slant: 40 x 40 mm at 0.5 mm, and beside it a strip 40 x 20 mm at 1.8 mm —
 *  a step past three of the median spacing (0.5 mm), but one surface. Off it,
 *  8 mm clear, a speck of 12 points at 0.5 mm. */
function unevenPatchWithSpeck() {
  const p: number[] = []
  for (let i = 0; i <= 80; i++) for (let j = 0; j <= 80; j++) p.push(i * 0.5, j * 0.5, 0)
  const surface0 = p.length / 3
  for (let i = 0; i <= 22; i++) for (let j = 1; j <= 11; j++) p.push(i * 1.8, 40 + j * 1.8, 0)
  const surface = p.length / 3
  for (let i = 0; i < 12; i++) p.push(-8 - (i % 4) * 0.5, Math.floor(i / 4) * 0.5, 0)
  return { positions: Float32Array.from(p), surface, sparse: surface - surface0 }
}

describe('the gap on an unevenly sampled surface', () => {
  const c = unevenPatchWithSpeck()
  const count = c.positions.length / 3
  const spacing = 0.5

  it('keeps a sparse stretch of one surface in one piece', () => {
    // Three spacings alone splits the sparse strip into its points.
    expect(cloudPieces(c.positions, count, GAP_SPACINGS * spacing).size.length).toBe(c.sparse + 2)
    const gap = joinGap(c.positions, count, spacing)
    expect(gap).toBeGreaterThan(1.8)
    expect(gap).toBeLessThan(8)
    const pieces = cloudPieces(c.positions, count, gap)
    expect(pieces.size.length).toBe(2)
    expect(pieces.size[pieces.main]).toBe(c.surface)
  })

  it('still finds the speck floating off it', () => {
    const survey = floatingPieces(cloudPieces(c.positions, count, joinGap(c.positions, count, spacing)), 1)
    expect(survey.floating).toBe(1)
    expect(Array.from(survey.vertices)).toEqual(Array.from({ length: 12 }, (_, i) => c.surface + i))
  })

  it('is three spacings on an even cloud, and never past the cap', () => {
    const ball = sphereCloud({ radius: 20, step: 1 })
    const gap = joinGap(ball.positions, ball.positions.length / 3, 1)
    expect(gap).toBeGreaterThanOrEqual(GAP_SPACINGS)
    expect(gap).toBeLessThan(GAP_SPACINGS * 1.2)
    // Half the points loose and far apart: the gap stops at the cap.
    const loose: number[] = []
    for (let i = 0; i < 200; i++) loose.push(i * 0.1, 0, 0, i * 50, 100, 0)
    expect(joinGap(Float32Array.from(loose), 400, 0.1)).toBeCloseTo(GAP_MAX_SPACINGS * 0.1, 6)
  })
})

describe('the plane and the delete', () => {
  it('takes the points past the plane, on the side its normal points to', () => {
    const p = Float32Array.of(0, 0, -1, 0, 0, 0.5, 0, 0, 2)
    expect(pastPlane(p, 3, [0, 0, 0], [0, 0, 1])).toEqual(Uint32Array.of(1, 2))
    expect(pastPlane(p, 3, [0, 0, 1], [0, 0, -2])).toEqual(Uint32Array.of(0, 1))
    expect(() => pastPlane(p, 3, [0, 0, 0], [0, 0, 0])).toThrow()
  })

  it('leaves the rest in order, with each point\'s new index', () => {
    const p = Float32Array.of(0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3)
    const n = Float32Array.of(0, 0, 1, 0, 1, 0, 1, 0, 0, 0, 0, -1)
    const out = withoutPoints(p, n, 4, Uint32Array.of(1, 3, 3))
    expect(out.dropped).toBe(2)
    expect(Array.from(out.positions)).toEqual([0, 0, 0, 2, 2, 2])
    expect(Array.from(out.normals)).toEqual([0, 0, 1, 1, 0, 0])
    expect(Array.from(out.map)).toEqual([0, -1, 1, -1])
  })
})

const R = revo()

describe.skipIf(!R.exists)('a RevoMetro cloud', () => {
  it('finds a main body and the pieces floating off it, quickly', () => {
    const bytes = readFileSync(R.pass('0905_02'))
    const ply = parsePLY(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
    const positions = ply.positions
    const count = positions.length / 3
    // The spacing the app reads off a cloud: the median nearest neighbour,
    // estimated here from a sample.
    const spacing = sampleSpacing(positions, count)
    const t0 = performance.now()
    const pieces = cloudPieces(positions, count, joinGap(positions, count, spacing))
    const ms = performance.now() - t0
    const tenth = floatingPieces(pieces, 10)
    console.log(`${count} points, spacing ${spacing.toFixed(3)} mm, ${pieces.size.length} pieces in ${ms.toFixed(0)} ms; main ${tenth.mainPoints}, at 10 %: ${tenth.floating} floating, ${tenth.vertices.length} points, largest kept ${tenth.largestKept}`)
    expect(tenth.mainPoints).toBeGreaterThan(count * 0.5)
    expect(ms).toBeLessThan(20_000)
  }, 60_000)
})

function sampleSpacing(p: Float32Array, count: number): number {
  const ds: number[] = []
  const stride = Math.max(1, Math.floor(count / 200))
  for (let i = 0; i < count; i += stride) {
    let best = Infinity
    for (let j = 0; j < count; j += 1) {
      if (j === i) continue
      const d = (p[3 * i] - p[3 * j]) ** 2 + (p[3 * i + 1] - p[3 * j + 1]) ** 2 + (p[3 * i + 2] - p[3 * j + 2]) ** 2
      if (d < best) best = d
    }
    ds.push(Math.sqrt(best))
  }
  ds.sort((a, b) => a - b)
  return ds[ds.length >> 1]
}

const STANFORD = process.env.SCANRULER_STANFORD_DIR || 'C:/tmp/scans/work'
const HEAVY = process.env.SCANRULER_HEAVY === '1'

/** Floating at the panel's default 1 % on a Stanford cloud made from one
 *  connected mesh: under a thousandth of the points may be marked. */
function stanfordFloating(name: string, heavy: boolean) {
  const file = join(STANFORD, name)
  const present = existsSync(file)
  if (!present) console.warn(`
⚠ ${file} not found — its Floating acceptance test is SKIPPED. Set SCANRULER_STANFORD_DIR to run it.
`)
  describe.skipIf(!present || (heavy && !HEAVY))(`the Stanford ${name}`, () => {
    it('stays one surface: Floating at 1 % marks under 0.1 % of it', () => {
      const b = readFileSync(file)
      const g = buildPointGraph(parsePLY(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer))
      const gap = joinGap(g.positions, g.vertexCount, g.spacing)
      const survey = floatingPieces(cloudPieces(g.positions, g.vertexCount, gap), 1)
      const share = survey.vertices.length / g.vertexCount
      console.log(`${name}: ${g.vertexCount} points, spacing ${g.spacing.toFixed(3)} mm, gap ${(gap / g.spacing).toFixed(2)} spacings; at 1 %: ${survey.floating} floating, ${survey.vertices.length} points (${(share * 100).toFixed(3)} %)`)
      expect(share).toBeLessThan(0.001)
    }, 600_000)
  })
}

stanfordFloating('statuette-cloud.ply', false)
stanfordFloating('lucy-cloud.ply', true)
