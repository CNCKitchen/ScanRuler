// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkerRequest, WorkerResponse } from '../src/core/workerProtocol'
import { CLOUD_REFUSAL, OP_CAPS, refusesOnCloud } from '../src/core/capabilities'
import { buildMeshGraph } from '../src/core/geometry/buildGraph'
import { buildPointGraph } from '../src/core/geometry/buildPointGraph'
import { planeCloud, writePlyCloud } from './cloudFixtures'
import { boxMesh } from './helpers'

// Every request type, spelled out: a type added to the protocol without a line
// here is a compile error, and one without a line in OP_CAPS fails below.
const ALL: Record<WorkerRequest['type'], true> = {
  load: true, 'commit-import': true, 'discard-import': true, recrease: true, fit: true,
  'fit-selection': true, 'load-nominal': true, align: true, 'align-abort': true, deviate: true,
  'deviate-reference': true, 'deviate-volume': true, thickness: true, transform: true,
  section: true, shadow: true, centroid: true, symmetry: true, flood: true, 'plane-region': true,
  segment: true, curvature: true, nearest: true, bounds: true, query: true, heights: true,
  'scan-qa': true, 'scan-rim': true, 'auto-align': true, 'closed-shells': true, deflection: true,
  'element-deviation': true, 'bounds-tree': true, plugin: true,
}

type Req = WorkerRequest extends infer R ? (R extends { requestId: number } ? Omit<R, 'requestId'> : never) : never
const ID = { r: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] } as never
const frame = { origin: [0, 0, 0], normal: [0, 0, 1], basisU: [1, 0, 0], basisV: [0, 1, 0] } as never
const NEEDS: Record<string, Req> = {
  'deviate-reference': { type: 'deviate-reference', transform: ID, facingDeg: null, spacing: 1 },
  'deviate-volume': { type: 'deviate-volume', transform: ID, tolerance: 0.1 },
  thickness: { type: 'thickness', method: 'ray', coneRays: 1, coneAngleDeg: 0, normalDeviationDeg: null, maxThickness: 50 },
  section: { type: 'section', origin: [0, 0, 0], normal: [0, 0, 1], minLength: 0 },
  shadow: { type: 'shadow', frame, tolerance: 0.1, play: 0, smoothDeg: 0 },
  centroid: { type: 'centroid' },
  symmetry: { type: 'symmetry', seed: null },
  'plane-region': { type: 'plane-region', vertices: new Uint32Array([0, 1, 2]) },
  segment: { type: 'segment', options: { minArea: 1, maxRms: 1, maxDeg: 10 } },
  curvature: { type: 'curvature' },
  nearest: { type: 'nearest', vertex: 0 },
  heights: { type: 'heights', grid: { origin: [-6, -6, 10], dir: [0, 0, -1], u: [1, 0, 0], v: [0, 1, 0], cell: 3, cols: 4, rows: 4, far: 30 } as never },
  'scan-qa': { type: 'scan-qa', sample: 100, rims: 3 },
  'scan-rim': { type: 'scan-rim', index: 0 },
  'auto-align': { type: 'auto-align' },
  'closed-shells': { type: 'closed-shells', which: 'scan' },
}

const plyMesh = (): ArrayBuffer => {
  const p = boxMesh(10, 2)
  const n = p.length / 3
  const rows = ['ply', 'format ascii 1.0', `element vertex ${n}`, 'property float x', 'property float y', 'property float z',
    `element face ${n / 3}`, 'property list uchar int vertex_indices', 'end_header']
  for (let i = 0; i < n; i++) rows.push(`${p[3 * i]} ${p[3 * i + 1]} ${p[3 * i + 2]}`)
  for (let f = 0; f < n / 3; f++) rows.push(`3 ${3 * f} ${3 * f + 1} ${3 * f + 2}`)
  return new TextEncoder().encode(rows.join('\n') + '\n').buffer as ArrayBuffer
}
const cloudPly = (): ArrayBuffer => writePlyCloud(planeCloud({ size: 5, step: 1 }), 'binary_little_endian')

describe('capabilities', () => {
  it('every worker request type is classified', () => {
    expect(Object.keys(OP_CAPS).sort()).toEqual(Object.keys(ALL).sort())
  })

  it('refusesOnCloud: only a cloud graph and a triangle op', () => {
    const c = planeCloud({ size: 3, step: 1 })
    const cloud = buildPointGraph({ kind: 'cloud', positions: c.positions, normals: c.normals })
    const mesh = buildMeshGraph({ kind: 'indexed', positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: Uint32Array.from([0, 1, 2]) })
    expect(refusesOnCloud('section', cloud)).toBe(CLOUD_REFUSAL)
    expect(refusesOnCloud('section', mesh)).toBeNull()
    expect(refusesOnCloud('section', null)).toBeNull()
    expect(refusesOnCloud('bounds', cloud)).toBeNull()
    expect(CLOUD_REFUSAL).toBe('Needs a mesh — this scan is a point cloud.')
  })
})

describe('worker gate', () => {
  let replies: WorkerResponse[]
  let scope: { onmessage: ((e: { data: WorkerRequest }) => void) | null; postMessage: (m: WorkerResponse) => void }
  const send = (m: Req, id: number): WorkerResponse => {
    replies.length = 0
    scope.onmessage!({ data: { ...m, requestId: id } as WorkerRequest })
    return replies.filter((r) => 'requestId' in r && r.requestId === id).at(-1)!
  }
  const load = (name: string, buffer: ArrayBuffer): void => {
    const r = send({ type: 'load', name, buffer, crease: { mode: 'on', angleDeg: 30 } }, 1)
    if (r.type !== 'loaded') throw new Error(JSON.stringify(r))
  }
  beforeEach(async () => {
    replies = []
    scope = { onmessage: null, postMessage: (msg) => replies.push(msg) }
    vi.stubGlobal('self', scope)
    vi.resetModules()
    await import('../src/core/meshWorker')
  })
  afterEach(() => vi.unstubAllGlobals())

  it('each needsTriangles op refuses a cloud with CLOUD_REFUSAL', () => {
    const wanted = Object.keys(OP_CAPS).filter((k) => OP_CAPS[k as keyof typeof OP_CAPS].needsTriangles).sort()
    expect(Object.keys(NEEDS).sort()).toEqual(wanted)
    load('cloud.ply', cloudPly())
    let id = 10
    for (const [op, req] of Object.entries(NEEDS)) {
      expect(send(req, ++id), op).toMatchObject({ type: 'error', message: CLOUD_REFUSAL })
    }
  })

  it('a cloud still takes the ops that need no triangles; the reference shells are not refused', () => {
    load('cloud.ply', cloudPly())
    expect(send({ type: 'bounds' }, 2).type).toBe('bounds-ok')
    expect(send({ type: 'closed-shells', which: 'nominal' }, 3)).toMatchObject({ type: 'error', message: 'No model loaded.' })
  })

  it('the same ops still run on a small mesh', () => {
    load('box.ply', plyMesh())
    let id = 100
    for (const [op, req] of Object.entries(NEEDS)) {
      const r = send(req, ++id)
      expect(r, op).toBeDefined()
      if (r.type === 'error') expect(r.message, op).not.toMatch(/point cloud/)
    }
    expect(send({ type: 'section', origin: [0, 0, 0], normal: [0, 0, 1], minLength: 0 }, 99).type).toBe('section-ok')
    expect(send({ type: 'nearest', vertex: 0 }, 98).type).toBe('nearest-ok')
    expect(send({ type: 'centroid' }, 97).type).toBe('centroid-ok')
  })
})

describe('surfaceOf', () => {
  afterEach(() => {
    vi.doUnmock('../src/core/workerPlugins')
    vi.unstubAllGlobals()
  })

  it('surfaceOf on a cloud throws CLOUD_REFUSAL', async () => {
    const replies: WorkerResponse[] = []
    const scope = { onmessage: null as ((e: { data: WorkerRequest }) => void) | null, postMessage: (m: WorkerResponse) => replies.push(m) }
    vi.stubGlobal('self', scope)
    vi.resetModules()
    vi.doMock('../src/core/workerPlugins', () => ({
      workerPlugins: [{
        id: 'probe',
        handle: (_op: string, _payload: unknown, ctx: { scan(): never; surfaceOf(g: never, why: string): unknown }) => {
          ctx.surfaceOf(ctx.scan(), 'probe')
          return { result: null }
        },
      }],
    }))
    await import('../src/core/meshWorker')
    scope.onmessage!({ data: { type: 'load', requestId: 1, name: 'cloud.ply', buffer: cloudPly(), crease: { mode: 'on', angleDeg: 30 } } })
    replies.length = 0
    scope.onmessage!({ data: { type: 'plugin', requestId: 2, plugin: 'probe', op: 'x', payload: null } })
    expect(replies.at(-1)).toMatchObject({ type: 'error', message: CLOUD_REFUSAL })
  })
})
