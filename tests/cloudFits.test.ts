// SPDX-License-Identifier: AGPL-3.0-only
// Elements measured on a point cloud: the same fits, region growing and spot
// lookups a mesh gets, over neighbour-graph adjacency instead of triangles.
import { describe, expect, it } from 'vitest'
import { buildMeshGraph } from '../src/core/geometry/buildGraph'
import { buildPointGraph } from '../src/core/geometry/buildPointGraph'
import { isCloud } from '../src/core/geometry/cloud'
import { scanSpot } from '../src/core/geometry/nearest'
import { FitError } from '../src/core/fit/errors'
import { fitConeFromSeed, fitConeOnSelection } from '../src/core/fit/fitConeFromSeed'
import { fitCylinderFromSeed, fitCylinderOnSelection } from '../src/core/fit/fitCylinderFromSeed'
import { fitPlaneFromSeed, fitPlaneOnSelection } from '../src/core/fit/fitPlaneFromSeed'
import { fitSphereFromSeed, fitSphereOnSelection } from '../src/core/fit/fitSphereFromSeed'
import { looksLikeCrown, planeRegionReport } from '../src/core/fit/segment'
import type { MeshGraph } from '../src/core/types'
import { type Cloud, blockWithBoreCloud, coneCloud, cylinderCloud, planeCloud, sphereCloud, triangulateGrid } from './cloudFixtures'

const SETTINGS = { method: 'gaussian', sigma: 3 } as const
const NOISES = [0, 0.02, 0.1]

const graphOf = (c: Cloud) => buildPointGraph({ kind: 'cloud', positions: c.positions, normals: c.normals })

function seedNear(g: MeshGraph, x: number, y: number, z: number): number {
  let best = 0
  let bestD = Infinity
  for (let v = 0; v < g.vertexCount; v++) {
    const d = (g.positions[v * 3] - x) ** 2 + (g.positions[v * 3 + 1] - y) ** 2 + (g.positions[v * 3 + 2] - z) ** 2
    if (d < bestD) {
      bestD = d
      best = v
    }
  }
  return best
}

const all = (g: MeshGraph) => Uint32Array.from({ length: g.vertexCount }, (_, i) => i)

/** Several clouds as one, each point keeping its normal. */
function join(...parts: Cloud[]): Cloud {
  const n = parts.reduce((s, c) => s + c.positions.length, 0)
  const positions = new Float32Array(n)
  const normals = new Float32Array(n)
  let o = 0
  for (const c of parts) {
    positions.set(c.positions, o)
    normals.set(c.normals, o)
    o += c.positions.length
  }
  return { positions, normals }
}

/** Keeps the points the predicate accepts. */
function keep(c: Cloud, ok: (x: number, y: number, z: number) => boolean): Cloud {
  const p: number[] = []
  const n: number[] = []
  for (let i = 0; i < c.positions.length; i += 3) {
    if (!ok(c.positions[i], c.positions[i + 1], c.positions[i + 2])) continue
    p.push(c.positions[i], c.positions[i + 1], c.positions[i + 2])
    n.push(c.normals[i], c.normals[i + 1], c.normals[i + 2])
  }
  return { positions: Float32Array.from(p), normals: Float32Array.from(n) }
}

const memberCoords = (g: MeshGraph, region: Uint32Array) =>
  Array.from(region, (v) => [g.positions[v * 3], g.positions[v * 3 + 1], g.positions[v * 3 + 2]])

/** A plane standing on another: `base`'s points are taken as (u, v) and put
 *  into the frame `map` gives, normal `n`. */
function stood(base: Cloud, map: (u: number, v: number) => [number, number, number], n: [number, number, number]): Cloud {
  const p = new Float32Array(base.positions.length)
  const nn = new Float32Array(base.positions.length)
  for (let i = 0; i < p.length; i += 3) {
    p.set(map(base.positions[i], base.positions[i + 1]), i)
    nn.set(n, i)
  }
  return { positions: p, normals: nn }
}

/** Degrees between a fitted axis and z. */
const tiltDeg = (axis: readonly number[]) => (Math.acos(Math.min(1, Math.abs(axis[2]))) * 180) / Math.PI

// Clean clouds hold the tolerances tests/{plane,sphere,cylinder,cone}Fit.test.ts
// hold clean samples to; noisy ones the bounds those tests hold their noisy
// samples to.
describe.each(NOISES)('fits on clouds, noise %s', (noise) => {
  const clean = noise === 0

  it('plane', () => {
    const g = graphOf(planeCloud({ size: 40, step: 1, noise }))
    expect(isCloud(g)).toBe(true)
    const check = (out: { normal: readonly number[]; center: readonly number[] }) => {
      if (clean) {
        expect(1 - Math.abs(out.normal[2])).toBeLessThan(1e-6)
        expect(Math.abs(out.center[2])).toBeLessThan(0.002)
      } else {
        expect(Math.abs(out.normal[2])).toBeGreaterThan(0.9999)
        expect(Math.abs(out.center[2])).toBeLessThan(0.005)
      }
    }
    const out = fitPlaneFromSeed(g, [seedNear(g, 3, 4, 0)], SETTINGS)
    check(out)
    expect(out.regionSize).toBeGreaterThan(g.vertexCount * 0.95)
    check(fitPlaneOnSelection(g, all(g), SETTINGS))
  })

  it('cylinder', () => {
    const g = graphOf(cylinderCloud({ radius: 8, length: 40, step: 0.8, noise }))
    const check = (out: { radius: number; axis: readonly number[]; center: readonly number[] }) => {
      expect(Math.abs(out.radius - 8)).toBeLessThan(clean ? 0.005 : 0.1)
      expect(tiltDeg(out.axis)).toBeLessThan(clean ? 0.05 : 1)
      expect(Math.hypot(out.center[0], out.center[1])).toBeLessThan(clean ? 0.005 : 0.1)
    }
    check(fitCylinderFromSeed(g, [seedNear(g, 8, 0, 0)], SETTINGS))
    check(fitCylinderOnSelection(g, all(g), SETTINGS))
  })

  it('sphere', () => {
    const g = graphOf(sphereCloud({ radius: 10, step: 0.7, noise }))
    const check = (out: { radius: number; center: readonly number[] }) => {
      expect(Math.abs(out.radius - 10)).toBeLessThan(clean ? 0.005 : 0.1)
      for (const c of out.center) expect(Math.abs(c)).toBeLessThan(clean ? 0.005 : 0.1)
    }
    check(fitSphereFromSeed(g, [seedNear(g, 10, 0, 0)], SETTINGS))
    check(fitSphereOnSelection(g, all(g), SETTINGS))
  })

  it('cone', () => {
    // The cone fixture takes no noise of its own; jitter it along the normals.
    const base = coneCloud({ r1: 6, r2: 12, length: 30, step: 0.8 })
    const rough = { positions: Float32Array.from(base.positions), normals: base.normals }
    let s = 7
    for (let i = 0; i < rough.positions.length; i++) {
      s = (Math.imul(s, 1103515245) + 12345) >>> 0
      rough.positions[i] += rough.normals[i] * (s / 4294967296 - 0.5) * 2 * noise
    }
    const g = graphOf(rough)
    const half = Math.atan(6 / 30)
    const check = (out: { halfAngle: number; axis: readonly number[] }) => {
      expect(Math.abs((out.halfAngle * Math.PI) / 180 - half)).toBeLessThan(clean ? 0.001 : 0.02)
      expect(tiltDeg(out.axis)).toBeLessThan(clean ? 0.05 : 1)
    }
    check(fitConeFromSeed(g, [seedNear(g, 9, 0, 0)], SETTINGS))
    check(fitConeOnSelection(g, all(g), SETTINGS))
  })
})

describe('cloud and mesh of the same samples', () => {
  it('agree', () => {
    const c = cylinderCloud({ radius: 8, length: 40, step: 0.8 })
    const around = Math.max(8, Math.round((2 * Math.PI * 8) / 0.8))
    const rings = c.positions.length / 3 / around
    const cloud = graphOf(c)
    const mesh = buildMeshGraph({ kind: 'indexed', positions: c.positions, indices: triangulateGrid(c, around, rings) })
    expect(isCloud(mesh)).toBe(false)
    const fc = fitCylinderFromSeed(cloud, [seedNear(cloud, 8, 0, 0)], SETTINGS)
    const fm = fitCylinderFromSeed(mesh, [seedNear(mesh, 8, 0, 0)], SETTINGS)
    expect(Math.abs(fc.radius * 2 - fm.radius * 2)).toBeLessThan(cloud.spacing)
  })
})

describe('region growing on a cloud', () => {
  it('stops at a gap', () => {
    const g = graphOf(keep(planeCloud({ size: 40, step: 1 }), (x) => Math.abs(x) > 2))
    const out = fitPlaneFromSeed(g, [seedNear(g, -10, 0, 0)], SETTINGS)
    expect(out.regionSize).toBeGreaterThan(0)
    expect(memberCoords(g, out.region).every(([x]) => x < 0)).toBe(true)
  })

  it('stops at a crease', () => {
    const floor = planeCloud({ size: 40, step: 1 })
    // A wall standing up from the floor's x = 20 edge, facing -x.
    const wall = stood(planeCloud({ size: 40, step: 1 }), (u, v) => [20, v, u + 20], [-1, 0, 0])
    const g = graphOf(join(floor, wall))
    const out = fitPlaneFromSeed(g, [seedNear(g, -5, 0, 0)], SETTINGS)
    expect(memberCoords(g, out.region).every(([, , z]) => Math.abs(z) < 0.05)).toBe(true)
    expect(out.regionSize).toBeGreaterThan((floor.positions.length / 3) * 0.95)
  })

  it('uneven density does not leak or fragment', () => {
    const floor = planeCloud({ size: 40, step: 1, denseHalf: true })
    // A wall up from the floor's y = -20 edge, facing +y.
    const wall = stood(planeCloud({ size: 40, step: 1 }), (u, v) => [u, -20, v + 20], [0, 1, 0])
    const g = graphOf(join(floor, wall))
    const floorCount = floor.positions.length / 3
    const wallCount = wall.positions.length / 3
    for (const x of [-10, 10]) {
      const out = fitPlaneFromSeed(g, [seedNear(g, x, 5, 0)], SETTINGS)
      expect(memberCoords(g, out.region).every(([, y, z]) => Math.abs(z) < 0.05 && y > -20.5), `seed x=${x}`).toBe(true)
      expect(out.regionSize, `seed x=${x}`).toBeGreaterThan(floorCount * 0.97)
    }
    const up = fitPlaneFromSeed(g, [seedNear(g, 0, -20, 20)], SETTINGS)
    expect(memberCoords(g, up.region).every(([, y]) => Math.abs(y + 20) < 0.05)).toBe(true)
    expect(up.regionSize).toBeGreaterThan(wallCount * 0.9)
  })

  it('an isolated speck does not crash region grow', () => {
    const speck = { positions: Float32Array.from([200, 200, 0]), normals: Float32Array.from([0, 0, 1]) }
    const g = graphOf(join(planeCloud({ size: 20, step: 1 }), speck))
    const lone = g.vertexCount - 1
    expect(g.positions[lone * 3]).toBe(200)
    expect(() => fitPlaneFromSeed(g, [lone], SETTINGS)).toThrow(FitError)
    expect(() => fitSphereFromSeed(g, [lone], SETTINGS)).toThrow(FitError)
    expect(() => fitCylinderFromSeed(g, [lone], SETTINGS)).toThrow(FitError)
    expect(() => fitConeFromSeed(g, [lone], SETTINGS)).toThrow(FitError)
    // The rest of the cloud still grows from its own seed.
    expect(fitPlaneFromSeed(g, [seedNear(g, 0, 0, 0)], SETTINGS).regionSize).toBe(lone)
  })
})

describe('degenerate clouds', () => {
  const refuse = (g: MeshGraph) => {
    const sel = all(g)
    const tries: (() => unknown)[] = [
      () => fitPlaneFromSeed(g, [0], SETTINGS),
      () => fitSphereFromSeed(g, [0], SETTINGS),
      () => fitCylinderFromSeed(g, [0], SETTINGS),
      () => fitConeFromSeed(g, [0], SETTINGS),
      () => fitPlaneOnSelection(g, sel, SETTINGS),
      () => fitSphereOnSelection(g, sel, SETTINGS),
      () => fitCylinderOnSelection(g, sel, SETTINGS),
      () => fitConeOnSelection(g, sel, SETTINGS),
    ]
    for (const t of tries) {
      let err: unknown
      try {
        t()
      } catch (e) {
        err = e
      }
      expect(err, 'a refusal').toBeInstanceOf(FitError)
      expect((err as Error).message.length).toBeGreaterThan(10)
    }
  }

  it('a 1-point cloud: fits refuse with a message', () => {
    refuse(graphOf({ positions: Float32Array.from([1, 2, 3]), normals: Float32Array.from([0, 0, 1]) }))
  })

  it('a collinear cloud: fits refuse with a message', () => {
    const p: number[] = []
    const n: number[] = []
    for (let i = 0; i < 30; i++) {
      p.push(i, 0, 0)
      n.push(0, 0, 1)
    }
    refuse(graphOf({ positions: Float32Array.from(p), normals: Float32Array.from(n) }))
  })
})

describe('a spot on a cloud', () => {
  const g = graphOf(planeCloud({ size: 10, step: 1 }))

  it('by point is the nearest point, with no triangle', () => {
    const s = scanSpot(g, { point: [2.1, 3.2, 0.4] })
    expect(s.triangle).toBeNull()
    expect(s.point).toEqual([2, 3, 0])
    expect(s.normal).toEqual([0, 0, 1])
    expect(s.distance).toBeCloseTo(Math.hypot(0.1, 0.2, 0.4), 5)
  })

  it('by vertex is that point', () => {
    const s = scanSpot(g, { vertex: 5 })
    expect(s.triangle).toBeNull()
    expect(s.vertex).toBe(5)
    expect(s.distance).toBe(0)
    expect(() => scanSpot(g, { vertex: g.vertexCount })).toThrow(/no vertex/)
  })
})

describe('far from the origin', () => {
  it('a plane 10 000 mm out fits to the same tolerance', () => {
    const c = planeCloud({ size: 40, step: 1, noise: 0.02 })
    for (let i = 0; i < c.positions.length; i++) c.positions[i] += 10000
    const g = graphOf(c)
    const out = fitPlaneFromSeed(g, [seedNear(g, 10003, 10004, 10000)], SETTINGS)
    expect(Math.abs(out.normal[2])).toBeGreaterThan(0.999)
    expect(Math.abs(out.center[2] - 10000)).toBeLessThan(0.02)
    expect(out.regionSize).toBeGreaterThan(g.vertexCount * 0.95)
  })
})

describe('plane-region report on a cloud', () => {
  const jittered = (): Cloud => {
    const c = planeCloud({ size: 40, step: 1 })
    let s = 11
    const r = () => {
      s = (Math.imul(s, 1103515245) + 12345) >>> 0
      return (s / 4294967296 - 0.5) * 2
    }
    for (let i = 0; i < c.positions.length; i += 3) {
      c.positions[i] += 0.4 * r()
      c.positions[i + 1] += 0.4 * r()
    }
    return c
  }

  // The area the points stand for: every point owns the cell around it, and
  // points sit on the 40 x 40 square's edge, so the rim cells reach half a
  // step past it — 41 x 41 cells (1681) rather than the 1600 the corners span.
  // The half-dense plane: 20 sparse columns of 41 unit cells, 41 x 81 quarter cells.
  for (const [name, cloud, expected] of [
    ['a regular plane', () => planeCloud({ size: 40, step: 1 }), 1681],
    ['a jittered plane', jittered, 1681],
    ['a half-dense plane', () => planeCloud({ size: 40, step: 1, denseHalf: true }), 820 + 830],
  ] as const) {
    it(`${name}: area within 10 % and no crown`, () => {
      const g = graphOf(cloud())
      const fit = fitPlaneFromSeed(g, [seedNear(g, 3, 4, 0)], SETTINGS)
      const r = planeRegionReport(g, fit.region, { normal: fit.normal, seed: 0 })
      expect(Math.abs(r.area - expected) / expected).toBeLessThan(0.1)
      expect(looksLikeCrown(r)).toBe(false)
    })
  }

  it('a bore on a cloud reports no closed end', () => {
    const g = graphOf(blockWithBoreCloud({ size: [30, 30, 30], boreRadius: 6, step: 1 }))
    const fit = fitCylinderFromSeed(g, [seedNear(g, 6, 0, 0)], SETTINGS)
    const r = planeRegionReport(g, fit.region, undefined, { center: fit.center, axis: fit.axis, radius: fit.radius })
    expect(r.vertices).toBe(fit.region.length)
    expect(r.closed).toBeUndefined()
  })
})
