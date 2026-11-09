// SPDX-License-Identifier: AGPL-3.0-only
// Alignment and deviation with a point cloud as the scan: the same pose, the
// same readings a mesh of the same vertices gives, measured from the points
// and their normals alone.
import { describe, expect, it, vi } from 'vitest'
import { computeDatumAlignment, transformFit } from '../src/core/alignment'
import { alignFromPairs, alignLocal, autoAlign } from '../src/core/deviation/align'
import { computeDeviation } from '../src/core/deviation/deviation'
import { deflectionVectors } from '../src/core/deviation/deflection'
import { computeElementDeviation } from '../src/core/deviation/elementField'
import { rigidApply, rigidApplyToPoints, rigidCompose, rigidFromAxisAngle, rigidInvert, rigidRotateVectors, rigidRotationAngle, type Rigid } from '../src/core/deviation/rigid'
import { NominalSurface } from '../src/core/deviation/surface'
import { fitPlaneFromSeed } from '../src/core/fit/fitPlaneFromSeed'
import { buildMeshGraph } from '../src/core/geometry/buildGraph'
import { buildPointGraph } from '../src/core/geometry/buildPointGraph'
import { isCloud } from '../src/core/geometry/cloud'
import type { MeshGraph, PlaneFit, Vec3 } from '../src/core/types'
import type { WorkerRequest, WorkerResponse } from '../src/core/workerProtocol'
import { type Cloud, blockWithBoreCloud, planeCloud, writePlyCloud } from './cloudFixtures'
import { chamferedBlock, facetedSolid } from './facetedSolid'
import { poseError } from './helpers'

vi.setConfig({ testTimeout: 120_000 })

const DEG = 180 / Math.PI
const IDENTITY: Rigid = { r: Float64Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1]), t: new Float64Array(3) }
const cloudGraph = (c: Cloud): MeshGraph => buildPointGraph({ kind: 'cloud', positions: c.positions, normals: c.normals })

function pose(axis: Vec3, deg: number, t: Vec3): Rigid {
  const m = rigidFromAxisAngle(axis, deg / DEG)
  m.t.set(t)
  return m
}

// The CAD part: a chamfered block with a bevel, a fine mesh.
const FACES = chamferedBlock()
const cad = facetedSolid(FACES, { subdivisions: 6 })
const reference = () => new NominalSurface(cad.positions, cad.indices)

/** The same part sampled differently, as a scan would: a cloud on its surface
 *  with each point's exact face normal. */
function scanCloud(subdivisions = 5, noise = 0): Cloud {
  const m = facetedSolid(FACES, { subdivisions, noise, seed: 9 })
  const normals = new Float32Array(m.positions.length)
  m.faceOf.forEach((f, v) => normals.set(FACES[f].n, v * 3))
  return { positions: m.positions, normals }
}

function moved(c: Cloud, m: Rigid): Cloud {
  const positions = c.positions.slice()
  const normals = c.normals.slice()
  rigidApplyToPoints(m, positions)
  rigidRotateVectors(m, normals)
  return { positions, normals }
}

/** How far the transform leaves the scan from where it was before `perturbed`
 *  moved it — mm at the worst point — and the rotation left over, degrees. */
function leftOver(result: Rigid, perturbed: Rigid, cloud: Cloud) {
  return {
    mm: poseError(result, rigidInvert(perturbed), cloud.positions),
    deg: rigidRotationAngle(rigidCompose(result, perturbed)) * DEG,
  }
}

const plane: PlaneFit = {
  kind: 'plane', center: [0, 0, 0], normal: [0, 0, 1], basisU: [1, 0, 0], basisV: [0, 1, 0], extentU: 11, extentV: 11,
  sigma: 0, usedPoints: 0, regionSize: 0,
}
const SETTINGS = { method: 'gaussian', sigma: 3 } as const

describe('deviation of a point cloud against the CAD', () => {
  it('equals that of a mesh of the same vertices, per vertex', () => {
    const c = moved(scanCloud(4, 0.02), pose([0.2, 0.5, 0.1], 1.5, [0.3, -0.2, 0.1]))
    const surface = reference()
    // Triangles over the same vertices: the readings must not care for them.
    const sphere = facetedSolid(FACES, { subdivisions: 4, noise: 0.02, seed: 9 })
    const mesh = buildMeshGraph({ kind: 'indexed', positions: c.positions.slice(), indices: sphere.indices })
    expect(isCloud(mesh)).toBe(false)
    const cloud = cloudGraph(c)
    expect(isCloud(cloud)).toBe(true)
    const a = computeDeviation(surface, cloud.positions, IDENTITY, { normals: c.normals, maxNormalDeviation: Math.PI / 2 })
    const b = computeDeviation(surface, mesh.positions, IDENTITY, { normals: c.normals, maxNormalDeviation: Math.PI / 2 })
    let measured = 0
    for (let v = 0; v < a.length; v++) {
      if (Number.isNaN(a[v])) expect(Number.isNaN(b[v])).toBe(true)
      else {
        expect(Math.abs(a[v] - b[v])).toBeLessThanOrEqual(1e-6)
        measured++
      }
    }
    expect(measured).toBeGreaterThan(a.length * 0.9)
  })

  it('reads the offset of a displaced cloud, signed outward', () => {
    const c = scanCloud(4)
    const out = new Float32Array(c.positions.length)
    for (let i = 0; i < out.length; i++) out[i] = c.positions[i] + c.normals[i] * 0.05
    const dev = computeDeviation(reference(), out, IDENTITY, { normals: c.normals, maxNormalDeviation: Math.PI / 2 })
    const finite = Array.from(dev).filter((x) => Number.isFinite(x))
    expect(finite.length).toBeGreaterThan(dev.length * 0.9)
    const median = finite.sort((x, y) => x - y)[finite.length >> 1]
    expect(Math.abs(median - 0.05)).toBeLessThan(0.005)
  })
})

describe('aligning a point cloud onto the CAD', () => {
  it('auto', () => {
    const p = pose([0.3, -0.5, 0.81], 12, [4, -3, 2])
    const c = moved(scanCloud(5), p)
    const r = autoAlign(reference(), c.positions, c.normals)
    const left = leftOver(r.transform, p, c)
    expect(r.source).toBe('auto')
    expect(left.deg).toBeLessThanOrEqual(0.05)
    expect(left.mm).toBeLessThanOrEqual(0.01)
  })

  it('from picked pairs', () => {
    const p = pose([0.1, 0.9, -0.3], 6, [2, 3, -1.5])
    const base = scanCloud(5)
    const c = moved(base, p)
    // Four vertices of the part, picked on the scan and on the CAD — only roughly.
    const idx = [100, 2500, 5000, 7500]
    const pairs = idx.map((i) => ({
      scan: [c.positions[i * 3], c.positions[i * 3 + 1], c.positions[i * 3 + 2]] as Vec3,
      nominal: [base.positions[i * 3] + 0.3, base.positions[i * 3 + 1] - 0.2, base.positions[i * 3 + 2] + 0.2] as Vec3,
    }))
    const r = alignFromPairs(reference(), c.positions, c.normals, pairs)
    const left = leftOver(r.transform, p, c)
    expect(left.deg).toBeLessThanOrEqual(0.05)
    expect(left.mm).toBeLessThanOrEqual(0.01)
  })

  it('locally, on marked points', () => {
    const p = pose([0.4, 0.2, 0.7], 1, [0.4, -0.3, 0.2])
    const base = scanCloud(5)
    const c = moved(base, p)
    // Marked: the points on the faces square to y and z.
    const marked: number[] = []
    for (let v = 0; v < base.normals.length / 3; v++) if (Math.abs(base.normals[v * 3 + 2]) > 0.99 || Math.abs(base.normals[v * 3 + 1]) > 0.99) marked.push(v)
    expect(marked.length).toBeGreaterThan(500)
    const r = alignLocal(reference(), c.positions, c.normals, Uint32Array.from(marked), IDENTITY, { maxDistance: 5 })
    const left = leftOver(r.transform, p, c)
    expect(left.deg).toBeLessThanOrEqual(0.05)
    expect(left.mm).toBeLessThanOrEqual(0.01)
  })
})

describe('datum alignment from fits on a cloud', () => {
  it('3-2-1: the primary plane to z, the secondary to x, the third zeroing y', () => {
    const p = pose([0.3, -0.5, 0.81], 0.9 * DEG, [12, -7, 30])
    const c = moved(blockWithBoreCloud({ size: [60, 40, 20], boreRadius: 5, step: 1 }), p)
    const g = cloudGraph(c)
    const faceAt = (q: Vec3): PlaneFit => {
      const a = new Float64Array(3)
      rigidApply(p, q[0], q[1], q[2], a)
      let best = 0
      let bestD = Infinity
      for (let v = 0; v < g.vertexCount; v++) {
        const d = (g.positions[v * 3] - a[0]) ** 2 + (g.positions[v * 3 + 1] - a[1]) ** 2 + (g.positions[v * 3 + 2] - a[2]) ** 2
        if (d < bestD) {
          bestD = d
          best = v
        }
      }
      return fitPlaneFromSeed(g, [best], SETTINGS) as unknown as PlaneFit
    }
    const top = faceAt([7, 9, 10])
    const side = faceAt([30, 5, 3])
    const front = faceAt([4, 20, 2])
    const origin = { kind: 'point' as const, center: front.center, sigma: 0, usedPoints: 0, regionSize: 0 }
    const m = computeDatumAlignment({ fit: top, axis: 'z+' }, { fit: side, axis: 'x+' }, origin)
    const movedTop = transformFit(top, m) as PlaneFit
    const movedSide = transformFit(side, m) as PlaneFit
    expect(movedTop.normal[2]).toBeCloseTo(1, 4)
    expect(Math.abs(movedTop.center[2])).toBeLessThan(0.01)
    expect(movedSide.normal[0]).toBeGreaterThan(0.9999)
    expect(Math.abs(movedSide.center[0])).toBeLessThan(0.01)
    // The cloud itself, carried by the same rigid: its +z face lies on z = 0
    // and the point picked on the front face on y = 0.
    const q = new Float64Array(3)
    const n = new Float64Array(3)
    const turn: Rigid = { r: m.r, t: new Float64Array(3) }
    let onTop = 0
    for (let v = 0; v < g.vertexCount; v++) {
      rigidApply(turn, g.normals[v * 3], g.normals[v * 3 + 1], g.normals[v * 3 + 2], n)
      if (n[2] < 0.999) continue
      rigidApply(m, g.positions[v * 3], g.positions[v * 3 + 1], g.positions[v * 3 + 2], q)
      expect(Math.abs(q[2])).toBeLessThan(0.01)
      onTop++
    }
    expect(onTop).toBeGreaterThan(500)
    const o = transformFit(origin, m) as typeof origin
    expect(Math.abs(o.center[1])).toBeLessThan(0.01)
  })
})

describe('element deviation and deflection on a cloud', () => {
  it('element deviation reads each point off the fitted element', () => {
    const base = planeCloud({ size: 20, step: 1 })
    const c = { positions: base.positions.slice(), normals: base.normals }
    for (let v = 0; v < c.positions.length / 3; v++) c.positions[v * 3 + 2] = 0.01 * (v % 5)
    const g = cloudGraph(c)
    const directions = new Int8Array(g.positions.length)
    const values = computeElementDeviation(plane, g.positions, g.normals, { side: 1, maxNormalDeviation: null, directions })
    for (let v = 0; v < values.length; v++) {
      expect(values[v]).toBeCloseTo(0.01 * (v % 5), 6)
      expect(directions[v * 3 + 2]).toBe(127)
    }
  })

  it('deflection moves a cloud vertices by their readings along the directions', () => {
    const base = planeCloud({ size: 20, step: 1 })
    const g = cloudGraph({ positions: base.positions.map((x, i) => (i % 3 === 2 ? 0.2 : x)), normals: base.normals })
    const directions = new Int8Array(g.positions.length)
    const values = computeElementDeviation(plane, g.positions, g.normals, { side: 1, maxNormalDeviation: null, directions })
    const vectors = deflectionVectors(values, directions, { limit: 1, maxDistance: 5, positions: g.positions, smoothing: 0 })
    expect(vectors).toHaveLength(g.positions.length)
    for (let v = 0; v < values.length; v++) {
      expect(vectors[v * 3]).toBeCloseTo(0, 6)
      expect(vectors[v * 3 + 2]).toBeCloseTo(0.2, 5)
    }
    // Smoothed over the cloud's own vertices: a flat offset stays what it was.
    const smooth = deflectionVectors(values, directions, { limit: 1, maxDistance: 5, positions: g.positions, smoothing: 2 })
    for (let v = 0; v < values.length; v++) expect(smooth[v * 3 + 2]).toBeCloseTo(0.2, 4)
  })
})

describe('moving a cloud by hand', () => {
  it('the transform op moves the points and normals, and a refit finds the moved element', () => {
    const m = pose([0.3, -0.5, 0.81], 20, [5, -6, 7])
    // The core of the op: bake the rigid into the graph's points and normals.
    const g = cloudGraph(planeCloud({ size: 30, step: 1 }))
    const before = fitPlaneFromSeed(g, [0], SETTINGS) as unknown as PlaneFit
    rigidApplyToPoints(m, g.positions)
    rigidRotateVectors(m, g.normals)
    const after = fitPlaneFromSeed(g, [0], SETTINGS) as unknown as PlaneFit
    const expected = transformFit(before, m) as PlaneFit
    for (let k = 0; k < 3; k++) expect(Math.abs(after.normal[k] - expected.normal[k])).toBeLessThan(1e-4)
    const off = [0, 1, 2].reduce((s, k) => s + (after.center[k] - expected.center[k]) * expected.normal[k], 0)
    expect(Math.abs(off)).toBeLessThan(1e-3)
  })

  it('the worker transform request takes a cloud and moves it', async () => {
    const replies: WorkerResponse[] = []
    const scope = { onmessage: null as ((e: { data: WorkerRequest }) => void) | null, postMessage: (r: WorkerResponse) => void replies.push(r) }
    vi.stubGlobal('self', scope)
    vi.resetModules()
    await import('../src/core/meshWorker')
    try {
      const send = (msg: object, id: number): WorkerResponse => {
        replies.length = 0
        scope.onmessage!({ data: { ...msg, requestId: id } as WorkerRequest })
        return replies.filter((r) => 'requestId' in r && r.requestId === id).at(-1)!
      }
      const loaded = send({ type: 'load', name: 'c.ply', buffer: writePlyCloud(planeCloud({ size: 10, step: 1 }), 'binary_little_endian'), crease: { mode: 'on', angleDeg: 30 } }, 1)
      expect(loaded.type).toBe('loaded')
      const move: Rigid = pose([0, 0, 1], 0, [3, 4, 5])
      expect(send({ type: 'transform', transform: move }, 2).type).toBe('transform-ok')
      expect(send({ type: 'bounds' }, 3)).toMatchObject({ type: 'bounds-ok', min: [-2, -1, 5], max: [8, 9, 5] })
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
