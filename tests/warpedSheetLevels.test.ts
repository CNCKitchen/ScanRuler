// SPDX-License-Identifier: AGPL-3.0-only
// Datums on a stamped, warped sheet: bead crowns 0.4 mm proud of the sheet
// over about 15 % of it, the whole bent a few tenths over 180 mm. A plane
// on the crowns had no parallel face (the sheet sat inside the band it
// left clear), and the height map's levels ran sheet and crowns together
// into one. Now the parallel face is seen from about 0.3 mm on a clean
// scan, the levels are read with the warp taken out, and each level's
// plane levels the part on the sheet itself. The grid and the points on
// their own, then a mesh in the in-process worker.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mulberry32 } from '../src/core/fit/ransac'
import { parallelFaceNear } from '../src/core/alignment'
import { cellNoise, heightLevels, levelsThroughWarp, slopedCells } from '../src/core/geometry/heightGrid'
import { gaussian } from './helpers'
import { run, startHeadless, stlBytes, type Headless } from './commandKit'

vi.setConfig({ testTimeout: 120_000 })

type Vec3 = [number, number, number]

const BEAD = 0.4
/** The sheet's thickness, mm. */
const THICK = 0.3
/** Bead strips 5 mm wide every 40 mm along x, their flanks 0.5 mm. */
function bead(x: number): number {
  const d = Math.abs(((x + 17) % 40) - 20)
  if (d <= 2.5) return BEAD
  if (d >= 3) return 0
  return (BEAD * (1 + Math.cos((Math.PI * (d - 2.5)) / 0.5))) / 2
}
/** A bow along x and a twist, over 180 × 60 mm. */
const warp = (x: number, y: number, bow: number) => bow * ((x - 90) / 90) ** 2 + 0.1 * ((x - 90) / 90) * ((y - 30) / 30)
const sheet = (x: number, y: number, bow: number) => warp(x, y, bow) + bead(x)

/** Points on a plate `w` × 60 mm, 0.5 mm apart, at height f with noise. */
function platePoints(w: number, f: (x: number, y: number) => number, sigma: number, seed: number): Float32Array {
  const rand = mulberry32(seed)
  const out: number[] = []
  for (let y = 0; y <= 60; y += 0.5) for (let x = 0; x <= w; x += 0.5) out.push(x, y, f(x, y) + sigma * gaussian(rand))
  return Float32Array.from(out)
}

describe('a face parallel to the levelling plane, a few tenths off', () => {
  it('sees the sheet 0.4 mm behind a plane on the bead crowns', () => {
    const pts = platePoints(100, (x) => bead(x), 0.03, 1)
    let crowns = 0
    for (let i = 2; i < pts.length; i += 3) if (pts[i] > 0.2) crowns++
    expect(crowns / (pts.length / 3)).toBeGreaterThan(0.12)
    expect(crowns / (pts.length / 3)).toBeLessThan(0.2)
    const found = parallelFaceNear(pts, [50, 30, BEAD], [0, 0, 1])
    expect(found).not.toBeNull()
    expect(found!.offset).toBeCloseTo(-BEAD, 1)
    expect(found!.times).toBeGreaterThan(1.5)
    // Levelled on the sheet, the crowns hold less: nothing to say.
    expect(parallelFaceNear(pts, [50, 30, 0], [0, 0, 1])).toBeNull()
  })

  it('finds nothing on a flat plate scanned with an ordinary scanner’s noise', () => {
    for (const sigma of [0.03, 0.05, 0.08]) {
      const pts = platePoints(100, () => 0, sigma, 2)
      expect(parallelFaceNear(pts, [50, 30, 0], [0, 0, 1])).toBeNull()
      // Nor off a plane fitted a little off the plate.
      expect(parallelFaceNear(pts, [50, 30, 0.02], [0, 0, 1])).toBeNull()
    }
  })
})

describe('height levels through a warp', () => {
  /** The warped sheet read as a grid of 1 mm cells, its sloped cells out. */
  function sheetGrid(bow: number) {
    const cols = 180
    const rows = 60
    const cell = 1
    const rand = mulberry32(5)
    const all = new Float32Array(cols * rows)
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) all[r * cols + c] = sheet(c + 0.5, r + 0.5, bow) + 0.03 * gaussian(rand)
    const steep = slopedCells(all, cols, rows, cell, 10)
    const counted = all.map((v, i) => (steep[i] ? Number.NaN : v))
    const gap = Math.max(3 * cellNoise(counted, cols, rows), 0.02)
    return { all, counted, gap, grid: { cols, rows, cell, u0: 0, v0: 0 } }
  }

  it('reads the sheet and the crowns as two levels, and says the warp', () => {
    const { all, counted, gap, grid } = sheetGrid(0.35)
    // As the values are, one level holds nearly all of the map.
    const plain = heightLevels(counted, grid, gap)
    expect(plain.levels.filter((l) => l.share >= 0.05)).toHaveLength(1)
    const found = levelsThroughWarp(counted, all, grid, gap)
    expect(found.warp).toBeDefined()
    expect(found.warp!.rise).toBeGreaterThan(0.3)
    expect(found.warp!.rise).toBeLessThan(0.6)
    expect(found.warp!.bow).toBeGreaterThan(0.25)
    const [base, crowns] = found.levels
    expect(base.share).toBeGreaterThan(0.75)
    expect(crowns.share).toBeGreaterThan(0.1)
    expect(crowns.height - base.height).toBeCloseTo(BEAD, 1)
    expect(base.sigma).toBeLessThan(0.06)
    // Each level's plane is fitted to the heights as read: level across the
    // sheet (the bow is symmetric about its middle), at its mean height.
    expect(Math.abs(base.plane.slope[0])).toBeLessThan(1e-3)
    expect(base.plane.at[0]).toBeCloseTo(90, -1)
  })

  it('leaves an ordinary part’s levels as they were', () => {
    // A plate with a pad 1 mm proud, flat and level: no warp to take out.
    const cols = 80
    const rows = 40
    const rand = mulberry32(9)
    const g = new Float32Array(cols * rows)
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) g[r * cols + c] = (c > 30 && c < 50 && r > 10 && r < 30 ? 1 : 0) + 0.01 * gaussian(rand)
    const grid = { cols, rows, cell: 0.5, u0: 0, v0: 0 }
    const steep = slopedCells(g, cols, rows, 0.5, 10)
    const counted = g.map((v, i) => (steep[i] ? Number.NaN : v))
    const gap = Math.max(3 * cellNoise(counted, cols, rows), 0.02)
    const found = levelsThroughWarp(counted, g, grid, gap)
    expect(found.warp).toBeUndefined()
    expect(found.levels.map((l) => l.height)).toEqual(heightLevels(counted, grid, gap).levels.map((l) => l.height))
  })
})

describe('levelling a warped, beaded sheet in the worker', () => {
  let headless: Headless
  beforeAll(async () => {
    headless = await startHeadless()
    const h = 0.5
    const nx = 360
    const ny = 120
    const rand = mulberry32(11)
    const z = new Float32Array((nx + 1) * (ny + 1))
    for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) z[j * (nx + 1) + i] = sheet(i * h, j * h, 0.3) + 0.02 * gaussian(rand)
    // A closed sheet 0.3 mm thick: the top, the back the same 0.3 mm
    // behind it (facing away, so never taken for the parallel face), and
    // the edges between.
    const tris: number[] = []
    const vert = (i: number, j: number, back: boolean) => [i * h, j * h, z[j * (nx + 1) + i] - (back ? THICK : 0)]
    const quad = (a: number[], b: number[], c: number[], d: number[]) => tris.push(...a, ...b, ...c, ...a, ...c, ...d)
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        quad(vert(i, j, false), vert(i + 1, j, false), vert(i + 1, j + 1, false), vert(i, j + 1, false))
        quad(vert(i, j, true), vert(i, j + 1, true), vert(i + 1, j + 1, true), vert(i + 1, j, true))
      }
    }
    for (let i = 0; i < nx; i++) {
      quad(vert(i, 0, true), vert(i + 1, 0, true), vert(i + 1, 0, false), vert(i, 0, false))
      quad(vert(i + 1, ny, true), vert(i, ny, true), vert(i, ny, false), vert(i + 1, ny, false))
    }
    for (let j = 0; j < ny; j++) {
      quad(vert(0, j + 1, true), vert(0, j, true), vert(0, j, false), vert(0, j + 1, false))
      quad(vert(nx, j, true), vert(nx, j + 1, true), vert(nx, j + 1, false), vert(nx, j, false))
    }
    const out = Float32Array.from(tris)
    await run('scan.open', { bytes: stlBytes(out), name: 'beaded-sheet.stl', discard: true })
  })
  afterAll(() => headless.stop())

  type Plane = { origin: Vec3; normal: Vec3 }
  type Levels = { warp?: { rise: number; bow: number; note: string }; levels: { height: number; sharePct: number; plane?: Plane }[] }
  type Datum = { parallelFace?: { offset: number; times: number; note: string } }

  it('gives two levels with their planes, and the crowns’ plane warns of the sheet behind it', async () => {
    const m = await run<Levels>('scan.heightmap', { levels: true })
    expect(m.warp?.note).toMatch(/warp was taken out/)
    const [base, crowns] = m.levels
    expect(crowns.height - base.height).toBeCloseTo(BEAD, 1)
    expect(base.sharePct).toBeGreaterThan(70)
    expect(crowns.plane).toBeDefined()
    expect(base.plane!.normal[2]).toBeGreaterThan(0.999)

    // Levelled on the crowns: the sheet, behind it, holds more.
    const onCrowns = await run<Datum>('align.datum', { primary: { plane: crowns.plane } })
    expect(onCrowns.parallelFace?.offset).toBeCloseTo(-BEAD, 1)
    expect(onCrowns.parallelFace?.times).toBeGreaterThan(1.5)
    await run('align.clear')
    // Levelled on the sheet: nothing to say, and the sheet at z 0.
    const onSheet = await run<Datum>('align.datum', { primary: { plane: base.plane }, primaryAxis: 'z+' })
    expect(onSheet.parallelFace).toBeUndefined()
    const after = await run<Levels>('scan.heightmap', { levels: true })
    expect(after.levels[0].height).toBeCloseTo(0, 1)
  })
})
