// SPDX-License-Identifier: AGPL-3.0-only
// Auto-align and segmentation on a point cloud: the same readings a mesh of
// the same part gives, from points, normals and neighbour adjacency alone.
import { describe, expect, it } from 'vitest'
import { autoAlign } from '../src/core/autoAlign'
import { rigidApply, rigidApplyToPoints, rigidFromAxisAngle, type Rigid } from '../src/core/deviation/rigid'
import { fitCylinderFromSeed } from '../src/core/fit/fitCylinderFromSeed'
import { planeRegionReport, segmentPlanes } from '../src/core/fit/segment'
import { buildMeshGraph } from '../src/core/geometry/buildGraph'
import { buildPointGraph } from '../src/core/geometry/buildPointGraph'
import { isCloud } from '../src/core/geometry/cloud'
import type { MeshGraph, Vec3 } from '../src/core/types'
import { type Cloud, applyRigidCloud, blockWithBoreCloud, planeCloud } from './cloudFixtures'
import { chamferedBlock, facetedSolid } from './facetedSolid'

const POSE: Rigid = (() => {
  const m = rigidFromAxisAngle([0.3, -0.5, 0.81], 0.9)
  m.t.set([12, -7, 30])
  return m
})()

const cloudGraph = (c: Cloud): MeshGraph => buildPointGraph({ kind: 'cloud', positions: c.positions, normals: c.normals })

/** Triangle soup of a cuboid centred on the origin, each face a grid. */
function blockSoup(sx: number, sy: number, sz: number, step: number): Float32Array {
  const out: number[] = []
  const face = (o: Vec3, u: Vec3, v: Vec3, nu: number, nv: number) => {
    const at = (i: number, j: number): Vec3 => [
      o[0] + (u[0] * i) / nu + (v[0] * j) / nv,
      o[1] + (u[1] * i) / nu + (v[1] * j) / nv,
      o[2] + (u[2] * i) / nu + (v[2] * j) / nv,
    ]
    for (let i = 0; i < nu; i++)
      for (let j = 0; j < nv; j++) out.push(...at(i, j), ...at(i + 1, j), ...at(i + 1, j + 1), ...at(i, j), ...at(i + 1, j + 1), ...at(i, j + 1))
  }
  const n = (s: number) => Math.max(1, Math.round(s / step))
  const [hx, hy, hz] = [sx / 2, sy / 2, sz / 2]
  face([hx, -hy, -hz], [0, sy, 0], [0, 0, sz], n(sy), n(sz))
  face([-hx, -hy, -hz], [0, 0, sz], [0, sy, 0], n(sz), n(sy))
  face([-hx, hy, -hz], [sx, 0, 0], [0, 0, sz], n(sx), n(sz))
  face([-hx, -hy, -hz], [0, 0, sz], [sx, 0, 0], n(sz), n(sx))
  face([-hx, -hy, hz], [sx, 0, 0], [0, sy, 0], n(sx), n(sy))
  face([-hx, -hy, -hz], [0, sy, 0], [sx, 0, 0], n(sy), n(sx))
  return Float32Array.from(out)
}

const posedDir = (d: Vec3): Vec3 => {
  const a = new Float64Array(3), o = new Float64Array(3)
  rigidApply(POSE, d[0], d[1], d[2], a)
  rigidApply(POSE, 0, 0, 0, o)
  return [a[0] - o[0], a[1] - o[1], a[2] - o[2]]
}
const offDeg = (a: Vec3, b: Vec3) => (Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 180) / Math.PI

describe('auto-align on a point cloud', () => {
  const block = applyRigidCloud(blockWithBoreCloud({ size: [60, 40, 20], boreRadius: 5, step: 1 }), POSE)
  const soup = blockSoup(60, 40, 20, 2)
  rigidApplyToPoints(POSE, soup)

  it('a rotated block cloud matches the block mesh', () => {
    const g = cloudGraph(block)
    expect(isCloud(g)).toBe(true)
    const fromCloud = autoAlign(g)
    const fromMesh = autoAlign(buildMeshGraph({ kind: 'soup', positions: soup }))
    expect(fromCloud.method).toBe('planes')
    const truth: Vec3[] = [posedDir([1, 0, 0]), posedDir([0, 1, 0]), posedDir([0, 0, 1])]
    for (let k = 0; k < 3; k++) {
      expect(offDeg(fromCloud.axes[k], truth[k]), `cloud axis ${k}`).toBeLessThanOrEqual(0.5)
      expect(offDeg(fromCloud.axes[k], fromMesh.axes[k]), `cloud vs mesh axis ${k}`).toBeLessThanOrEqual(0.5)
    }
    expect(fromCloud.planeShare).toBeGreaterThan(0.6)
  })

  it('refuses a cloud with too few points', () => {
    const g = cloudGraph({ positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]) })
    expect(() => autoAlign(g)).toThrow('Too little surface to align.')
  })
})

describe('segment on a point cloud', () => {
  const options = { minArea: 10, maxRms: 0.05, maxDeg: 15 }

  /** The mesh's vertices as a cloud, each with the normal of the face it lies on. */
  function cloudOf(m: ReturnType<typeof facetedSolid>, faceNormal: (f: number) => Vec3): Cloud {
    const normals = new Float32Array(m.positions.length)
    m.faceOf.forEach((f, v) => normals.set(faceNormal(f), v * 3))
    return { positions: m.positions, normals }
  }

  for (const noise of [0, 0.003]) {
    it(`splits a chamfered block cloud like its mesh (noise ${noise})`, () => {
      const faces = chamferedBlock()
      const m = facetedSolid(faces, { noise })
      const fromMesh = segmentPlanes(buildMeshGraph({ kind: 'indexed', positions: m.positions, indices: m.indices }), options)
      const fromCloud = segmentPlanes(cloudGraph(cloudOf(m, (f) => faces[f].n)), options)
      expect(fromMesh.regions).toHaveLength(faces.length)
      expect(fromCloud.regions).toHaveLength(fromMesh.regions.length)
      expect(fromCloud.regions.map((r) => r.curved)).toEqual(fromMesh.regions.map((r) => r.curved))
      expect(fromCloud.runs).toHaveLength(fromMesh.runs.length)
      // Each face's area, as a share of the whole, within a few percent of the mesh's.
      const total = (s: typeof fromMesh) => s.regions.reduce((a, r) => a + r.area, 0)
      const share = (s: typeof fromMesh) => s.regions.map((r) => r.area / total(s)).sort()
      share(fromCloud).forEach((a, i) => expect(Math.abs(a - share(fromMesh)[i])).toBeLessThan(0.05))
    })
  }

  it('splits a block with a bore into its six faces and the bore wall', () => {
    const c = blockWithBoreCloud({ size: [60, 40, 20], boreRadius: 5, step: 1 })
    const s = segmentPlanes(cloudGraph(c), { minArea: 20, maxRms: 0.05, maxDeg: 15 })
    // Largest first: the six faces, each square to an axis, each pair opposite.
    const faces = s.regions.slice(0, 6)
    expect(faces.map((r) => r.normal.map((v) => Math.round(Math.abs(v))).join('')).sort()).toEqual(['001', '001', '010', '010', '100', '100'])
    for (const r of faces) expect(r.area).toBeGreaterThan(700)
    // The rest is the bore wall: facets whose normals lie across z, on the bore.
    const wall = s.regions.slice(6)
    expect(wall.length).toBeGreaterThanOrEqual(8)
    for (const r of wall) {
      expect(Math.abs(r.normal[2])).toBeLessThan(0.01)
      expect(Math.hypot(r.point[0], r.point[1])).toBeLessThan(5.01)
      expect(r.area).toBeLessThan(100)
    }
    // Between them they hold nearly every point of the part.
    expect(s.claimed / s.considered).toBeGreaterThan(0.95)
  })
})

describe('a bore closed at an end, on a cloud', () => {
  const report = (c: Cloud) => {
    const g = cloudGraph(c)
    let seed = 0
    for (let v = 0; v < g.vertexCount; v++) if (Math.abs(g.positions[v * 3] - 6) < 1e-3 && Math.abs(g.positions[v * 3 + 1]) < 1e-3 && Math.abs(g.positions[v * 3 + 2]) < 1) seed = v
    const fit = fitCylinderFromSeed(g, [seed], { method: 'gaussian', sigma: 3 })
    return planeRegionReport(g, fit.region, undefined, { center: fit.center, axis: fit.axis, radius: fit.radius })
  }

  it('finds the floor the axis meets', () => {
    const through = blockWithBoreCloud({ size: [30, 30, 30], boreRadius: 6, step: 1 })
    // A floor across the bore at z = 9, its normal facing the open end at -z.
    const disc = planeCloud({ size: 12, step: 1 })
    const keep = [...Array(disc.positions.length / 3).keys()].filter((i) => Math.hypot(disc.positions[i * 3], disc.positions[i * 3 + 1]) < 5.5)
    const floor: Cloud = {
      positions: Float32Array.from(keep.flatMap((i) => [disc.positions[i * 3], disc.positions[i * 3 + 1], 9])),
      normals: Float32Array.from(keep.flatMap(() => [0, 0, -1])),
    }
    const blind: Cloud = {
      positions: Float32Array.from([...through.positions, ...floor.positions]),
      normals: Float32Array.from([...through.normals, ...floor.normals]),
    }
    const r = report(blind)
    expect(r.closed).toBeDefined()
    expect(Math.abs(r.closed!.at[2] - 9)).toBeLessThan(0.5)
    expect(report(through).closed).toBeUndefined()
  })
})
