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

  it('still matches the mesh with noisy normals (0.05 on each component)', () => {
    let s = 12345
    const rand = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296 - 0.5) * 2
    const rough = blockWithBoreCloud({ size: [60, 40, 20], boreRadius: 5, step: 1 })
    const normals = rough.normals.slice()
    for (let v = 0; v < normals.length; v += 3) {
      const x = normals[v] + 0.05 * rand(), y = normals[v + 1] + 0.05 * rand(), z = normals[v + 2] + 0.05 * rand()
      const l = Math.hypot(x, y, z)
      normals.set([x / l, y / l, z / l], v)
    }
    const g = cloudGraph(applyRigidCloud({ positions: rough.positions, normals }, POSE))
    const fromCloud = autoAlign(g)
    const fromMesh = autoAlign(buildMeshGraph({ kind: 'soup', positions: soup }))
    for (let k = 0; k < 3; k++) expect(offDeg(fromCloud.axes[k], fromMesh.axes[k]), `axis ${k}`).toBeLessThanOrEqual(0.5)
  })

  it('an open shell — the block scanned from above, no floor — matches its mesh', () => {
    // Everything below z = -4 left out: the floor and the sides' lower part,
    // as a part standing on the table is scanned.
    const whole = blockWithBoreCloud({ size: [60, 40, 20], boreRadius: 5, step: 1 })
    const keep: number[] = []
    for (let i = 0; i < whole.positions.length / 3; i++) if (whole.positions[3 * i + 2] > -4) keep.push(i)
    const pick = (a: Float32Array) => Float32Array.from(keep.flatMap((i) => [a[3 * i], a[3 * i + 1], a[3 * i + 2]]))
    const shell = applyRigidCloud({ positions: pick(whole.positions), normals: pick(whole.normals) }, POSE)
    const open = blockSoup(60, 40, 20, 2)
    const kept: number[] = []
    for (let t = 0; t < open.length; t += 9) if (Math.min(open[t + 2], open[t + 5], open[t + 8]) > -4.5) kept.push(...open.subarray(t, t + 9))
    const openSoup = Float32Array.from(kept)
    rigidApplyToPoints(POSE, openSoup)
    const fromCloud = autoAlign(cloudGraph(shell))
    const fromMesh = autoAlign(buildMeshGraph({ kind: 'soup', positions: openSoup }))
    expect(fromCloud.method).toBe(fromMesh.method)
    const truth: Vec3[] = [posedDir([1, 0, 0]), posedDir([0, 1, 0]), posedDir([0, 0, 1])]
    for (let k = 0; k < 3; k++) {
      expect(offDeg(fromCloud.axes[k], fromMesh.axes[k]), `cloud vs mesh axis ${k}`).toBeLessThanOrEqual(0.5)
      expect(offDeg(fromCloud.axes[k], truth[k]), `cloud axis ${k}`).toBeLessThanOrEqual(0.5)
    }
  })

  it('refuses a cloud with too few points', () => {
    const g = cloudGraph({ positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]) })
    expect(() => autoAlign(g)).toThrow('Too little surface to align.')
  })
})

/** The block with a bore as the fixture gives it as a cloud, and as a mesh over
 *  the same points: every face's grid cut into triangles, the edge and corner
 *  points the fixture gives once repeated per face, the bore's rings likewise, each
 *  triangle wound to its face's normal (the bore's to its first corner's). */
function blockWithBore(): { cloud: Cloud; mesh: MeshGraph } {
  const size: Vec3 = [60, 40, 20]
  const step = 1
  const r = 5
  const cloud = blockWithBoreCloud({ size, boreRadius: r, step })
  const ticks = (len: number) => {
    const n = Math.max(1, Math.round(len / step))
    return Array.from({ length: n + 1 }, (_, i) => -len / 2 + (len * i) / n)
  }
  const [sx, sy, sz] = size
  const rings = Math.max(1, Math.round(sz / step))
  const around = Math.max(8, Math.round((2 * Math.PI * r) / step))
  // The faces' points come first in the cloud, the bore's rings last.
  const base = cloud.positions.length / 3 - (rings + 1) * around
  const pos = Array.from(cloud.positions)
  const keyOf = (p: ArrayLike<number>) => Array.from(p, Math.fround).join(',')
  const onFace = new Map<string, number>()
  for (let i = 0; i < base; i++) onFace.set(keyOf(cloud.positions.subarray(i * 3, i * 3 + 3)), i)
  expect(onFace.size).toBe(base) // no point given twice
  // Each face is its own sheet, as the cloud's faces are told apart by their
  // normals: an edge point a second face reaches is given that face again,
  // past the cloud's own points, so no mesh vertex averages two faces.
  const used = new Set<number>()
  const tris: number[] = []
  const faceNormal: (Vec3 | null)[] = []
  const grid = (us: number[], vs: number[], at: (u: number, v: number) => Vec3, normal: Vec3, keep: (p: Vec3) => boolean = () => true) => {
    const idx = us.map(() => vs.map(() => -1))
    us.forEach((u, i) => vs.forEach((v, j) => {
      const p = at(u, v)
      if (!keep(p)) return
      const k = onFace.get(keyOf(p))
      expect(k).toBeDefined()
      if (used.has(k!)) {
        idx[i][j] = pos.length / 3
        pos.push(...p)
      } else {
        idx[i][j] = k!
        used.add(k!)
      }
    }))
    for (let i = 0; i + 1 < us.length; i++)
      for (let j = 0; j + 1 < vs.length; j++) {
        const [a, b, c, d] = [idx[i][j], idx[i + 1][j], idx[i + 1][j + 1], idx[i][j + 1]]
        if (a >= 0 && b >= 0 && c >= 0) { tris.push(a, b, c); faceNormal.push(normal) }
        if (a >= 0 && c >= 0 && d >= 0) { tris.push(a, c, d); faceNormal.push(normal) }
      }
  }
  for (const s of [-1, 1]) {
    grid(ticks(sy), ticks(sz), (y, z) => [(s * sx) / 2, y, z], [s, 0, 0])
    grid(ticks(sx), ticks(sz), (x, z) => [x, (s * sy) / 2, z], [0, s, 0])
    grid(ticks(sx), ticks(sy), (x, y) => [x, y, (s * sz) / 2], [0, 0, s], (p) => Math.hypot(p[0], p[1]) > r + step / 2)
  }
  // Every face point is a corner of the faces' grids.
  expect(used.size).toBe(base)
  const bore: number[] = []
  for (let k = 0; k <= rings; k++)
    for (let j = 0; j < around; j++) {
      const a = (2 * Math.PI * j) / around
      bore.push(r * Math.cos(a), r * Math.sin(a), -sz / 2 + (sz * k) / rings)
    }
  expect(cloud.positions.subarray(base * 3)).toEqual(Float32Array.from(bore))
  for (let k = 0; k < rings; k++)
    for (let j = 0; j < around; j++) {
      const a = base + k * around + j, b = base + k * around + ((j + 1) % around)
      tris.push(a, b, a + around, b, b + around, a + around)
      faceNormal.push(null, null)
    }
  // Each triangle wound with its face's normal, or its first corner's.
  const wound = Uint32Array.from(tris)
  for (let t = 0; t < wound.length; t += 3) {
    const [a, b, c] = [wound[t], wound[t + 1], wound[t + 2]]
    const e1 = [0, 1, 2].map((k) => pos[b * 3 + k] - pos[a * 3 + k])
    const e2 = [0, 1, 2].map((k) => pos[c * 3 + k] - pos[a * 3 + k])
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]
    const want = faceNormal[t / 3] ?? [cloud.normals[a * 3], cloud.normals[a * 3 + 1], cloud.normals[a * 3 + 2]]
    if (n[0] * want[0] + n[1] * want[1] + n[2] * want[2] < 0) {
      wound[t + 1] = c
      wound[t + 2] = b
    }
  }
  const mesh = buildMeshGraph({ kind: 'indexed', positions: Float32Array.from(pos), indices: wound })
  return { cloud, mesh }
}

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

  it('splits a block with a bore like its mesh', () => {
    const { cloud, mesh } = blockWithBore()
    const o = { minArea: 20, maxRms: 0.05, maxDeg: 15 }
    const fromCloud = segmentPlanes(cloudGraph(cloud), o)
    const fromMesh = segmentPlanes(mesh, o)
    expect(fromCloud.regions).toHaveLength(fromMesh.regions.length)
    expect(fromCloud.runs).toHaveLength(fromMesh.runs.length)
    // The faces, largest first: the same flags, normals and areas within a tenth.
    const same = (c: (typeof fromCloud.regions)[number], m: (typeof fromMesh.regions)[number], label: string) => {
      expect(c.curved, `${label} curved`).toBe(m.curved)
      expect(Math.abs(c.area - m.area) / m.area, `${label} area`).toBeLessThan(0.1)
      expect(c.normal[0] * m.normal[0] + c.normal[1] * m.normal[1] + c.normal[2] * m.normal[2], `${label} normal`).toBeGreaterThan(0.999)
    }
    for (let k = 0; k < 6; k++) same(fromCloud.regions[k], fromMesh.regions[k], `face ${k}`)
    // The bore's facets are of one size, so their order is not told: by the way they face.
    const around = (rs: typeof fromMesh.regions) => rs.slice(6).sort((a, b) => Math.atan2(a.normal[1], a.normal[0]) - Math.atan2(b.normal[1], b.normal[0]))
    const wallCloud = around(fromCloud.regions)
    const wallMesh = around(fromMesh.regions)
    wallMesh.forEach((m, k) => same(wallCloud[k], m, `bore facet ${k}`))
    // The six faces, each square to an axis, and not curved.
    const faces = fromCloud.regions.slice(0, 6)
    expect(faces.map((r) => r.normal.map((v) => Math.round(Math.abs(v))).join('')).sort()).toEqual(['001', '001', '010', '010', '100', '100'])
    for (const r of faces) {
      expect(r.curved).toBe(false)
      expect(r.area).toBeGreaterThan(700)
    }
    expect(fromCloud.claimed / fromCloud.considered).toBeGreaterThan(0.95)
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
