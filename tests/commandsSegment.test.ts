// SPDX-License-Identifier: AGPL-3.0-only
// The scan's flat regions through the commands: scan.segment on a faceted
// block, a round sheet's strips named curved and joined into one run while
// a faceted one's facets stay faces, mirror twins across a plane, a region
// marked — or several — and
// fitted with element.fit_marked; element.fit answering the region it grew
// and warning when it grew across two surfaces, or on the crown of a bead,
// and answering each of several seeds, a seed left out with a warning. In
// the in-process worker (commandKit.ts).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chamferedBlock, face, facetedSolid } from './facetedSolid'
import { refused, run, soupOf, startHeadless, stlBytes, type Headless } from './commandKit'
import { seedOff } from '../src/core/fit/seedOff'

type Vec3 = [number, number, number]

let headless: Headless
beforeAll(async () => {
  headless = await startHeadless()
})
afterAll(() => headless.stop())

/** A flat ring at z = 0 with a round bead standing on it — a torus's upper
 *  half, radius R round z, its tube r — every vertex moved a little up or
 *  down, the same way wherever it repeats. */
function beadedPlate(R: number, r: number, noise = 0.01): Float32Array {
  const tris: number[] = []
  const N = 360
  const M = 24
  const hash = (x: number, y: number, z: number) => {
    const h = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453
    return h - Math.floor(h) - 0.5
  }
  const jitter = (p: Vec3): Vec3 => [p[0], p[1], p[2] + 2 * noise * hash(p[0], p[1], p[2])]
  const quad = (a: Vec3, b: Vec3, c: Vec3, d: Vec3) => tris.push(...a, ...b, ...c, ...a, ...c, ...d)
  const bead = (i: number, k: number): Vec3 => {
    const th = (i / N) * 2 * Math.PI
    const ph = (k / M) * Math.PI
    const rho = R + r * Math.cos(ph)
    return jitter([rho * Math.cos(th), rho * Math.sin(th), r * Math.sin(ph)])
  }
  for (let i = 0; i < N; i++) for (let k = 0; k < M; k++) quad(bead(i, k), bead(i + 1, k), bead(i + 1, k + 1), bead(i, k + 1))
  const ring = (r0: number, r1: number) => {
    const at = (i: number, k: number): Vec3 => {
      const th = (i / N) * 2 * Math.PI
      const rho = r0 + ((r1 - r0) * k) / 30
      return jitter([rho * Math.cos(th), rho * Math.sin(th), 0])
    }
    for (let i = 0; i < N; i++) for (let k = 0; k < 30; k++) quad(at(i, k), at(i, k + 1), at(i + 1, k + 1), at(i + 1, k))
  }
  ring(R + r, R + 12)
  ring(10, R - r)
  return Float32Array.from(tris)
}

/** A sheet bent round the z axis at radius R across `spanDeg`, `length`
 *  long — or, with `facets`, the polygon of that many flat facets inscribed
 *  in the arc — every vertex moved a little along the radius, the same way
 *  wherever it repeats. */
function arcSheet(R: number, spanDeg: number, length: number, { facets = 0, noise = 0.005 } = {}): Float32Array {
  const tris: number[] = []
  const span = (spanDeg * Math.PI) / 180
  const N = Math.ceil((R * span) / 0.3)
  const M = Math.ceil(length / 0.3)
  const hash = (i: number, k: number) => {
    const h = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453
    return h - Math.floor(h) - 0.5
  }
  const at = (i: number, k: number): Vec3 => {
    const th = -span / 2 + (span * i) / N
    let r = R
    if (facets) {
      // On the chord of the facet the angle falls in.
      const w = span / facets
      const mid = -span / 2 + w * (Math.min(facets - 1, Math.floor((th + span / 2) / w)) + 0.5)
      r = (R * Math.cos(w / 2)) / Math.cos(th - mid)
    }
    r += 2 * noise * hash(i, k)
    return [r * Math.cos(th), r * Math.sin(th), (length * k) / M]
  }
  for (let i = 0; i < N; i++)
    for (let k = 0; k < M; k++) tris.push(...at(i, k), ...at(i + 1, k), ...at(i + 1, k + 1), ...at(i, k), ...at(i + 1, k + 1), ...at(i, k + 1))
  return Float32Array.from(tris)
}

const open = (faces = chamferedBlock(), noise = 0.01) =>
  run('scan.open', { bytes: stlBytes(soupOf(facetedSolid(faces, { noise }))), name: 'block.stl', discard: true })

interface Region {
  id: number
  normal: Vec3
  point: Vec3
  sigma: number
  area: number
  box: { min: Vec3; max: Vec3 }
  vertices: number
  curved?: { sagitta: number }
  run?: number
  neighbours: { id: number; deg: number; smooth: boolean }[]
  mirror?: { id: number | 'self'; deg: number; mm: number }
}
interface CurvedRun { id: number; regions: number[]; area: number; along?: Vec3; cylinder?: { radius: number; axis: Vec3; sigma: number }; note: string }
interface Segmented {
  found: number
  shown?: number
  considered: number
  claimed: number
  maxRms: number
  noise: number
  regions: Region[]
  curvedRuns?: CurvedRun[]
  runsFound?: number
  marked?: { points: number; from: string }
  region?: Region | Region[]
}

const near = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] > Math.cos((0.5 * Math.PI) / 180)
const byNormal = (s: Segmented, n: Vec3) => s.regions.find((r) => near(r.normal, n))!

describe('scan.segment', () => {
  it('finds each face as one region, with its plane and neighbours', async () => {
    await open()
    const s = await run<Segmented>('scan.segment', { minArea: 10 })
    expect(s.found).toBe(11)
    expect(s.regions).toHaveLength(11)
    expect(s.regions.map((r) => r.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
    const top = byNormal(s, [0, 0, 1])
    expect(top.point[2]).toBeCloseTo(10, 1)
    expect(top.sigma).toBeLessThan(0.015)
    const bevel = byNormal(s, [Math.sin((25 * Math.PI) / 180), 0, Math.cos((25 * Math.PI) / 180)])
    expect(top.neighbours.find((n) => n.id === bevel.id)?.deg).toBeCloseTo(25, 0)
    // No vertex lists in the answer.
    expect(JSON.stringify(s).length).toBeLessThan(6000)
    // Faces, not strips: nothing curved, no edge smooth, no runs.
    expect(s.maxRms).toBe(0.05)
    expect(s.noise).toBeGreaterThan(0)
    expect(s.noise).toBeLessThan(0.02)
    expect(s.regions.some((r) => r.curved || r.run)).toBe(false)
    expect(s.regions.some((r) => r.neighbours.some((n) => n.smooth))).toBe(false)
    expect(s.curvedRuns).toBeUndefined()

    // Past the limit, the neighbours within 35° — a run's chain goes on
    // through them — are listed all the same.
    const few = await run<Segmented>('scan.segment', { minArea: 10, limit: 3 })
    expect(few.shown).toBe(3)
    expect(few.regions).toHaveLength(3)
    expect(few.regions.map((r) => r.neighbours)).toEqual(s.regions.slice(0, 3).map((r) => r.neighbours.filter((n) => n.id <= 3 || n.deg <= 35)))
    const past = few.regions.flatMap((r) => r.neighbours.filter((n) => n.id > 3))
    expect(past.length).toBeGreaterThan(0)
    for (const n of past) expect(n.deg).toBeLessThanOrEqual(35)
  })

  it('gives each region a point on it: a ring’s, not its centroid in the hole', async () => {
    // The inner ring of the beaded plate runs 10 to 23.8 mm out: its centroid
    // is the origin, in the hole, where a plane seeded on it fits nothing.
    await run('scan.open', { bytes: stlBytes(beadedPlate(25, 1.2)), name: 'bead.stl', discard: true })
    const s = await run<Segmented>('scan.segment', { minArea: 10 })
    const flat = s.regions.filter((r) => near(r.normal, [0, 0, 1]) && Math.abs(r.point[2]) < 0.05)
    expect(flat.length).toBeGreaterThan(0)
    for (const r of flat) {
      const rho = Math.hypot(r.point[0], r.point[1])
      expect(rho, `region ${r.id}`).toBeGreaterThan(9.9)
      // A vertex of the plate's rings, by its radius.
      expect(rho < 23.85 || rho > 26.15, `region ${r.id}`).toBe(true)
    }
    const seeded = await run<{ element: { fit: { normal: Vec3 }; sigma?: number } }>('element.fit', { kind: 'plane', at: { point: flat[0].point } })
    expect(Math.abs(seeded.element.fit.normal[2])).toBeGreaterThan(0.999)
  })

  it('names the strips a curved surface is cut into, and the run they make', async () => {
    // R40 over 60°: a plane grows about 10° of it before its σ reaches
    // maxRms, so it comes out as several regions.
    await run('scan.open', { bytes: stlBytes(arcSheet(40, 60, 40)), name: 'arc.stl', discard: true })
    const s = await run<Segmented>('scan.segment', { minArea: 10 })
    expect(s.found).toBeGreaterThanOrEqual(4)
    const strips = s.regions.filter((r) => r.area > 50)
    for (const r of strips) {
      expect(r.curved, `region ${r.id}`).toBeDefined()
      expect(r.sigma).toBeGreaterThan(0.01)
    }
    const across = strips.flatMap((r) => r.neighbours.filter((n) => strips.some((o) => o.id === n.id)))
    expect(across.length).toBeGreaterThan(0)
    for (const n of across) expect(n.smooth).toBe(true)
    // One run holds them all: one cylinder along z, R40.
    expect(s.curvedRuns).toHaveLength(1)
    const [one] = s.curvedRuns!
    for (const r of strips) {
      expect(one.regions).toContain(r.id)
      expect(r.run).toBe(1)
    }
    expect(Math.abs(one.along![2])).toBeGreaterThan(0.999)
    expect(one.cylinder!.radius).toBeCloseTo(40, 0)
    expect(one.cylinder!.sigma).toBeLessThan(0.01)
    expect(one.note).toMatch(/^one curved surface cut into \d+ strips — smooth joins \d+(–\d+)?°, planes’ σ [\d.]+(–[\d.]+)? against maxRms 0\.05; one cylinder R40(\.\d)? σ/)
    // Marking a run's regions marks the surface.
    const marked = await run<Segmented>('scan.segment', { minArea: 10, mark: one.regions })
    expect(marked.marked!.points).toBe(s.regions.filter((r) => one.regions.includes(r.id)).reduce((n, r) => n + r.vertices, 0))
  })

  it('leaves a faceted prism its facets: no strip curved, no join smooth, no run', async () => {
    await run('scan.open', { bytes: stlBytes(arcSheet(40, 60, 40, { facets: 6 })), name: 'facets.stl', discard: true })
    const s = await run<Segmented>('scan.segment', { minArea: 10 })
    expect(s.found).toBe(6)
    for (const r of s.regions) {
      expect(r.curved).toBeUndefined()
      expect(r.sigma).toBeLessThan(0.01)
      for (const n of r.neighbours) {
        expect(n.deg).toBeCloseTo(10, 0)
        expect(n.smooth).toBe(false)
      }
    }
    expect(s.curvedRuns).toBeUndefined()
  })

  it('pairs mirror twins across a plane', async () => {
    await open()
    const s = await run<Segmented>('scan.segment', { minArea: 10, symmetric: 'ZX' })
    const plusY = byNormal(s, [0, 1, 0])
    const minusY = byNormal(s, [0, -1, 0])
    expect(plusY.mirror?.id).toBe(minusY.id)
    expect(minusY.mirror?.id).toBe(plusY.id)
    expect(plusY.mirror!.deg).toBeLessThan(0.5)
    expect(plusY.mirror!.mm).toBeLessThan(0.05)
    const s2 = Math.SQRT1_2
    expect(byNormal(s, [s2, s2, 0]).mirror?.id).toBe(byNormal(s, [s2, -s2, 0]).id)
    // The top straddles the plane: its own twin.
    expect(byNormal(s, [0, 0, 1]).mirror?.id).toBe('self')
    // Across YZ the bevel has none.
    const yz = await run<Segmented>('scan.segment', { minArea: 10, symmetric: 'YZ' })
    expect(byNormal(yz, [Math.sin((25 * Math.PI) / 180), 0, Math.cos((25 * Math.PI) / 180)]).mirror).toBeUndefined()
  })

  it('marks a region for element.fit_marked', async () => {
    await open()
    expect((await refused('element.fit_marked', { kind: 'plane', marked: true })).code).toBe('invalid_state')
    const all = await run<Segmented>('scan.segment', { minArea: 10 })
    const s = await run<Segmented>('scan.segment', { minArea: 10, mark: 2 })
    // The region marked, not the list again.
    expect(s.regions).toBeUndefined()
    expect(s.region).toEqual(all.regions[1])
    expect(s.found).toBe(all.found)
    expect(s.marked).toEqual({ points: all.regions[1].vertices, from: 'scan.segment region 2' })
    const fitted = await run<{ element: { fit: { normal: Vec3; usedPoints: number }; source: { markedPoints: number } } }>('element.fit_marked', { kind: 'plane', marked: true })
    expect(near(fitted.element.fit.normal, all.regions[1].normal)).toBe(true)
    expect(fitted.element.source.markedPoints).toBe(all.regions[1].vertices)
    expect((await refused('scan.segment', { mark: 99 })).code).toBe('invalid_input')
    expect((await refused('scan.segment', { mark: [1, 99] })).message).toMatch(/no region 99/)
    expect((await refused('element.fit_marked', { kind: 'plane', marked: true, vertices: [1, 2, 3] })).code).toBe('invalid_input')
    // With list: true, the list as well.
    expect((await run<Segmented>('scan.segment', { minArea: 10, mark: 2, list: true })).regions).toEqual(all.regions)
  })

  it('marks four regions one after another in under 1 k each, or several together', async () => {
    await open()
    const all = await run<Segmented>('scan.segment', { minArea: 10 })
    for (const id of [1, 2, 3, 4]) {
      const s = await run<Segmented>('scan.segment', { minArea: 10, mark: id })
      expect(JSON.stringify(s).length, `mark ${id}`).toBeLessThan(1000)
      expect((s.region as Region).id).toBe(id)
    }
    // Several together: their points, each region answered.
    const two = await run<Segmented>('scan.segment', { minArea: 10, mark: [3, 1, 3] })
    expect(two.marked).toEqual({ points: all.regions[0].vertices + all.regions[2].vertices, from: 'scan.segment regions 3, 1' })
    expect((two.region as Region[]).map((r) => r.id)).toEqual([3, 1])
    const fitted = await run<{ element: { source: { markedPoints: number } } }>('element.fit_marked', { kind: 'plane', marked: true })
    expect(fitted.element.source.markedPoints).toBe(all.regions[0].vertices + all.regions[2].vertices)
  })

  it('keeps to a box', async () => {
    await open()
    const s = await run<Segmented>('scan.segment', { box: { min: [-30, -30, 5], max: [30, 30, 30] }, minArea: 10 })
    expect(s.considered).toBeLessThan(s.claimed * 3)
    for (const r of s.regions) expect(r.box.min[2]).toBeGreaterThanOrEqual(5)
    expect(s.regions.some((r) => near(r.normal, [0, 0, -1]))).toBe(false)
  })
})

describe('element.fit answers the region it grew', () => {
  it('gives the area, box and normal spread, and marks it', async () => {
    await open(chamferedBlock(), 0.005)
    const r = await run<{ region: { area: number; box: { min: Vec3; max: Vec3 }; normalSpreadDeg: number }; warning?: string; marked?: { points: number } ; element: { fit: { regionSize: number } } }>('element.fit', { kind: 'plane', at: { point: [-5, 0, 10] }, mark: true })
    expect(r.region.area).toBeGreaterThan(780)
    expect(r.region.area).toBeLessThan(900)
    expect(r.region.box.max[0]).toBeLessThan(10.3)
    expect(r.region.normalSpreadDeg).toBeLessThan(5)
    expect(r.warning).toBeUndefined()
    expect(r.marked?.points).toBe(r.element.fit.regionSize)
    // A point is picked, not grown: it has no region to mark.
    expect((await refused('element.fit', { kind: 'point', at: { point: [-5, 0, 10] }, mark: true })).code).toBe('invalid_input')
  })

  it('warns when a box straddling a shallow crease grows it over two surfaces', async () => {
    const t = (2 * Math.PI) / 180
    const faces = chamferedBlock().filter((f) => f.name !== 'bevel')
    faces.push(face('roof', [Math.sin(t), 0, Math.cos(t)], [0, 0, 10]))
    await open(faces, 0.02)
    const r = await run<{ warning?: string; region: { second?: { centroid: Vec3; angleDeg: number; offset: number } } }>('element.fit', {
      kind: 'plane',
      at: { point: [-8, 0, 10] },
      within: { min: [-16, -10, 5], max: [12, 10, 12] },
    })
    expect(r.warning).toMatch(/^two surfaces\?/)
    expect(r.warning).toMatch(/shrink the box or move the seed/)
    expect(r.region.second!.centroid[0]).toBeGreaterThan(1)
    expect(r.region.second!.angleDeg).toBeGreaterThan(1)
    expect(r.region.second!.offset).toBeLessThan(0)
    // Kept off the crease, the same seed grows one surface.
    const one = await run<{ warning?: string }>('element.fit', { kind: 'plane', at: { point: [-8, 0, 10] }, within: { min: [-16, -10, 5], max: [-1, 10, 12] } })
    expect(one.warning).toBeUndefined()
  })

  it('answers each of several seeds, and warns of one left out: on another surface, or on this one outside the region', async () => {
    type Seed = { vertex: number; point: Vec3; distance: number; inRegion?: boolean; offMm?: number; deg?: number }
    type Fit = { seeds: Seed[]; warning?: string; marked: { points: number }; element: { fit: { regionSize: number } } }
    await open(chamferedBlock(), 0.005)
    // One seed answers as it always has.
    const top = await run<Fit>('element.fit', { kind: 'plane', at: { point: [-5, 0, 10] }, mark: true })
    expect(Object.keys(top.seeds[0]).sort()).toEqual(['distance', 'point', 'vertex'])
    const side = await run<Fit>('element.fit', { kind: 'plane', at: { point: [0, -15, 0] }, mark: true })
    // On the top and on a side: one surface grows, from the seed on it.
    const both = await run<Fit>('element.fit', { kind: 'plane', at: [{ point: [-5, 0, 10] }, { point: [0, -15, 0] }], mark: true })
    expect(both.seeds.map((s) => s.inRegion).sort()).toEqual([false, true])
    const [inside, left] = both.seeds[0].inRegion ? [both.seeds[0], both.seeds[1]] : [both.seeds[1], both.seeds[0]]
    expect(Math.abs(inside.offMm!)).toBeLessThan(0.05)
    expect(inside.deg!).toBeLessThan(5)
    expect(Math.abs(left.offMm!)).toBeGreaterThan(5)
    expect(left.deg!).toBeGreaterThan(80)
    const n = both.seeds.indexOf(left) + 1
    expect(both.warning).toMatch(new RegExp(`^seeds lie on two surfaces\\? the plane grew from seed ${3 - n}; seed ${n} lies \\d+(\\.\\d+)? mm off it, turned \\d+(\\.\\d)?° — fit each on its own, or mark both`))
    // The other seed is no part of the region: it is the one surface's alone.
    expect(both.marked.points).toBe((both.seeds[0].inRegion ? top : side).marked.points)
    // Two seeds on one face: both in it, nothing to say.
    const one = await run<Fit>('element.fit', { kind: 'plane', at: [{ point: [-5, -5, 10] }, { point: [-5, 5, 10] }] })
    expect(one.seeds.map((s) => s.inRegion)).toEqual([true, true])
    expect(one.warning).toBeUndefined()
    // A seed on the plane, outside the box the surface was kept to.
    const boxed = await run<Fit>('element.fit', { kind: 'plane', at: [{ point: [-8, 0, 10] }, { point: [5, 0, 10] }], within: { min: [-16, -10, 5], max: [-1, 10, 12] } })
    expect(boxed.seeds.map((s) => s.inRegion)).toEqual([true, false])
    expect(Math.abs(boxed.seeds[1].offMm!)).toBeLessThan(0.05)
    expect(boxed.warning).toMatch(/^seed 2 lies on it \(0(\.\d+)? mm off it, turned \d+(\.\d)?°\) but outside the region it grew to/)
  })

  it('reads a seed against each kind of surface', () => {
    const base = { sigma: 0.01, usedPoints: 100, regionSize: 100 }
    // A bore of radius 5 along z, a seed 0.2 mm into the metal facing the axis.
    const bore = seedOff({ ...base, kind: 'cylinder', center: [0, 0, 0], axis: [0, 0, 1], radius: 5, length: 10, coverage: 360 }, [5.2, 0, 1], [-1, 0, 0])
    expect(bore!.offMm).toBeCloseTo(0.2, 9)
    expect(bore!.deg).toBeCloseTo(0, 4)
    // A ball, the seed on it but its normal 30° off.
    const ball = seedOff({ ...base, kind: 'sphere', center: [0, 0, 0], radius: 10 }, [0, 0, 10], [Math.sin(Math.PI / 6), 0, Math.cos(Math.PI / 6)])
    expect(ball!.offMm).toBeCloseTo(0, 9)
    expect(ball!.deg).toBeCloseTo(30, 6)
    // A 45° cone, radius 5 at its centre: a point 1 mm out square to its slant.
    const s = Math.SQRT1_2
    const cone = seedOff({ ...base, kind: 'cone', center: [0, 0, 0], axis: [0, 0, 1], halfAngle: 45, radius: 5, radius1: 4, radius2: 6, length: 2, coverage: 360 }, [5 + s, 0, -s], [s, 0, -s])
    expect(cone!.offMm).toBeCloseTo(1, 9)
    expect(cone!.deg).toBeCloseTo(0, 4)
    // A torus: on the tube's outer equator.
    const ring = seedOff({ ...base, kind: 'torus', center: [0, 0, 0], axis: [0, 0, 1], majorRadius: 20, minorRadius: 2, tubeCoverage: 360, spineCoverage: 360 }, [22, 0, 0], [1, 0, 0])
    expect(ring!.offMm).toBeCloseTo(0, 9)
    expect(ring!.deg).toBeCloseTo(0, 4)
    // A point has no surface.
    expect(seedOff({ kind: 'point', center: [0, 0, 0], sigma: 0, usedPoints: 0, regionSize: 0 }, [1, 0, 0], [1, 0, 0])).toBeNull()
  })

  it('warns of a plane grown on the crown of a bead, not on a face', async () => {
    await run('scan.open', { bytes: stlBytes(beadedPlate(25, 1.2)), name: 'bead.stl', discard: true })
    const crown = await run<{ region: { fill: number; normalSpreadDeg: number }; warning?: string }>('element.fit', { kind: 'plane', at: { point: [0, 25, 1.2] } })
    expect(crown.region.fill).toBeLessThan(0.15)
    expect(crown.warning).toMatch(/^the crown of a bead or round, not a face\? 95 % of its normals lie within \d+(\.\d)?° of the plane's and it fills \d+ % of the rectangle it spans/)
    // The flat beside it, a ring round the bead, is a face.
    const flat = await run<{ region: { fill: number }; warning?: string }>('element.fit', { kind: 'plane', at: { point: [30, 0, 0] } })
    expect(flat.region.fill).toBeGreaterThan(0.15)
    expect(flat.warning).toBeUndefined()
  })
})
