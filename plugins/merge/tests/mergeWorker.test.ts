// SPDX-License-Identifier: AGPL-3.0-only
// The Merge workspace's part of the mesh worker, driven through the real
// worker: layers taken from staged loads, aligned onto the base or onto each
// other, kept across the workspace's own scan swaps and dropped on any other,
// and merged exactly as core/merge.ts merges.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkerRequest, WorkerResponse } from '../../../src/core/workerProtocol'
import { buildPointGraph } from '../../../src/core/geometry/buildPointGraph'
import { buildBinaryStl } from '../../../src/core/exportStl'
import { rigidApply, rigidCompose, rigidInvert, rigidRotationAngle, type Rigid } from '../../../src/core/deviation/rigid'
import type { FitOutput, FitSettings, Vec3 } from '../../../src/core/types'
import { applyRigidCloud, blockWithBoreCloud, halves, rigidOf, sphereCloud, type Cloud } from '../../../tests/cloudFixtures'
import { boxMesh } from '../../../tests/helpers'
import { mergeLayers } from '../core/merge'
import type { AlignReply, MergeOps } from '../core/protocol'
import type { LayerAlignResult } from '../core/layerAlign'

const DEG = Math.PI / 180
const CREASE = { mode: 'off', angleDeg: 30 } as const
const SETTINGS: FitSettings = { method: 'gaussian', sigma: 0 }

let scope: { onmessage: ((event: { data: WorkerRequest }) => void) | null; postMessage: (msg: WorkerResponse) => void }
let replies: WorkerResponse[]
let nextId = 1

beforeEach(async () => {
  replies = []
  scope = { onmessage: null, postMessage: (msg) => replies.push(msg) }
  vi.stubGlobal('self', scope)
  vi.resetModules()
  await import('../../../src/core/meshWorker')
})
afterEach(() => vi.unstubAllGlobals())

const send = (msg: WorkerRequest) => scope.onmessage!({ data: msg })

async function reply(id: number, ms = 60_000): Promise<WorkerResponse> {
  const until = Date.now() + ms
  for (;;) {
    const r = replies.find((m) => 'requestId' in m && m.requestId === id && m.type !== 'align-progress')
    if (r) return r
    if (Date.now() > until) throw new Error(`No answer to request ${id}.`)
    await new Promise((res) => setTimeout(res, 5))
  }
}

function post<K extends keyof MergeOps>(op: K, payload: MergeOps[K]['payload']): number {
  const id = nextId++
  send({ type: 'plugin', requestId: id, plugin: 'merge', op, payload })
  return id
}

async function result<K extends keyof MergeOps>(id: number): Promise<MergeOps[K]['result']> {
  const r = await reply(id)
  if (r.type === 'error') throw new Error(r.message)
  if (r.type !== 'plugin-ok') throw new Error(`Unexpected answer ${r.type}.`)
  return r.result as MergeOps[K]['result']
}

const call = <K extends keyof MergeOps>(op: K, payload: MergeOps[K]['payload']) => result<K>(post(op, payload))

/** A cloud loaded staged; its request id is the staged id. */
async function stage(c: Cloud): Promise<number> {
  const id = nextId++
  send({ type: 'load-buffers', requestId: id, positions: c.positions.slice(), normals: c.normals.slice(), crease: CREASE, staged: true })
  const r = await reply(id)
  if (r.type === 'error') throw new Error(r.message)
  expect(r.type).toBe('loaded')
  return id
}

/** A triangle soup loaded as an STL, staged or as the scan. */
async function loadStl(soup: Float32Array, staged: boolean): Promise<number> {
  const id = nextId++
  const bytes = new Uint8Array(buildBinaryStl(soup, null, null, 'merge test'))
  send({ type: 'load', requestId: id, name: 'part.stl', buffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, crease: CREASE, staged })
  const r = await reply(id)
  if (r.type === 'error') throw new Error(r.message)
  return id
}

/** The scan swapped for a staged one, as a session's commit does. */
async function commitScan(stagedId: number): Promise<void> {
  const id = nextId++
  send({ type: 'commit-import', requestId: id, scan: stagedId })
  expect((await reply(id)).type).toBe('import-ok')
}

const setBase = async (c: Cloud) => commitScan(await stage(c))

async function addLayer(id: string, c: Cloud, scale = 1) {
  return call('add-layer', { stagedId: await stage(c), id, scale })
}

/** The part in its own frame: the target is the half at +x, the layer the
 *  half at -x scanned in a frame TRUE off, so the pose that lays it on the
 *  target is TRUE^-1. */
const block = blockWithBoreCloud({ size: [40, 30, 20], boreRadius: 6, step: 1 })
const [lo, hi] = halves(block, 0, 16)
const TRUE = rigidOf([12, -7, 20], [5, -3, 8])
const POSE = rigidInvert(TRUE)
const layerPart = applyRigidCloud(lo, TRUE)
/** The layer's points once the graph has collapsed the block's repeated edge points. */
const LO_COUNT = buildPointGraph({ kind: 'cloud', positions: lo.positions, normals: lo.normals }).vertexCount

/** Rotation (degrees) and largest displacement over `c` (mm) between two poses. */
function delta(a: Rigid, b: Rigid, c: Cloud = layerPart): { deg: number; mm: number } {
  const p = new Float64Array(3), q = new Float64Array(3)
  let mm = 0
  for (let i = 0; i < c.positions.length; i += 3) {
    rigidApply(a, c.positions[i], c.positions[i + 1], c.positions[i + 2], p)
    rigidApply(b, c.positions[i], c.positions[i + 1], c.positions[i + 2], q)
    mm = Math.max(mm, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]))
  }
  return { deg: rigidRotationAngle(rigidCompose(rigidInvert(b), a)) / DEG, mm }
}

function aligned(r: AlignReply): LayerAlignResult {
  if ('stopped' in r) throw new Error('stopped')
  if ('refused' in r) throw new Error(r.refused)
  return r
}

/** A start a few degrees and millimetres off `pose`. */
const nudged = (pose: Rigid) => rigidCompose(rigidOf([3, -2, 4], [1.5, -1, 2]), pose)

/** The index of the point of `positions` nearest `at`. */
function nearest(positions: Float32Array, at: Vec3): number {
  let best = -1, d = Infinity
  for (let i = 0; i < positions.length; i += 3) {
    const e = Math.hypot(positions[i] - at[0], positions[i + 1] - at[1], positions[i + 2] - at[2])
    if (e < d) { d = e; best = i / 3 }
  }
  return best
}

const moved = (m: Rigid, p: Vec3): Vec3 => {
  const out = new Float64Array(3)
  rigidApply(m, p[0], p[1], p[2], out)
  return [out[0], out[1], out[2]]
}

describe('Merge worker: layers', () => {
  it('adds a cloud layer from a staged load and hands its geometry back', async () => {
    await setBase(hi)
    const added = await addLayer('a', layerPart)
    expect(added.isCloud).toBe(true)
    expect(added.vertexCount).toBe(LO_COUNT)
    expect(added.spacing).toBeGreaterThan(0.9)
    expect(added.spacing).toBeLessThan(1.1)
    const geo = await call('layer-geometry', { id: 'a' })
    expect(geo.positions.length).toBe(added.vertexCount * 3)
    expect(geo.normals.length).toBe(added.vertexCount * 3)
    expect(geo.indices).toBeUndefined()
  })

  it('scales a layer in inches to millimetres', async () => {
    await setBase(hi)
    const inches = { positions: lo.positions.map((v) => v / 25.4), normals: lo.normals.slice() }
    const added = await addLayer('in', inches, 25.4)
    expect(added.spacing).toBeGreaterThan(0.9)
    expect(added.spacing).toBeLessThan(1.1)
    const geo = await call('layer-geometry', { id: 'in' })
    const g = buildPointGraph({ kind: 'cloud', positions: inches.positions, normals: inches.normals })
    expect(geo.positions[0]).toBeCloseTo(g.positions[0] * 25.4, 4)
  })

  it('adds a mesh layer: median edge as its spacing, triangles in its geometry', async () => {
    await setBase(hi)
    const staged = await loadStl(boxMesh(20, 20), true)
    const added = await call('add-layer', { stagedId: staged, id: 'm', scale: 1 })
    expect(added.isCloud).toBe(false)
    expect(added.spacing).toBeCloseTo(1, 3)
    const geo = await call('layer-geometry', { id: 'm' })
    expect(geo.indices!.length).toBeGreaterThan(0)
  })

  it('refuses bad ids, a taken id, a used staged load and an unknown operation', async () => {
    await setBase(hi)
    const staged = await stage(layerPart)
    await call('add-layer', { stagedId: staged, id: 'a', scale: 1 })
    await expect(call('add-layer', { stagedId: staged, id: 'b', scale: 1 })).rejects.toThrow('The prepared import is no longer available.')
    await expect(call('add-layer', { stagedId: await stage(lo), id: 'a', scale: 1 })).rejects.toThrow('There is already a layer "a".')
    await expect(call('add-layer', { stagedId: await stage(lo), id: 'base', scale: 1 })).rejects.toThrow('"base"')
    await expect(call('add-layer', { stagedId: await stage(lo), id: 'z', scale: 0 })).rejects.toThrow('scale')
    await expect(call('layer-geometry', { id: 'nope' })).rejects.toThrow('There is no layer "nope".')
    await expect(call('remove-layer', { id: 'nope' })).rejects.toThrow('There is no layer "nope".')
    await expect(call('refine', { id: 'a', target: 'nope', start: POSE })).rejects.toThrow('There is no layer "nope".')
    await expect(call('refine', { id: 'a', target: 'a', start: POSE })).rejects.toThrow('onto itself')
    await expect(result(post('frobnicate' as keyof MergeOps, null as never))).rejects.toThrow('Merge has no operation "frobnicate".')
    await call('remove-layer', { id: 'a' })
    await expect(call('layer-geometry', { id: 'a' })).rejects.toThrow('There is no layer "a".')
  })
})

describe('Merge worker: alignment', () => {
  it('refines two halves onto the base: the pose is recovered', async () => {
    await setBase(hi)
    await addLayer('a', layerPart)
    const r = aligned(await call('refine', { id: 'a', target: 'base', start: nudged(POSE) }))
    const d = delta(r.pose, POSE)
    expect(d.deg).toBeLessThanOrEqual(0.05)
    expect(d.mm).toBeLessThanOrEqual(0.02)
    expect(r.lowOverlap).toBe(false)
    expect(r.confident).toBe(true)
  })

  it('aligns from picked pairs', async () => {
    await setBase(hi)
    await addLayer('a', layerPart)
    const pick = (p: Vec3) => ({ layer: moved(TRUE, p), target: p })
    const r = aligned(await call('align-pairs', { id: 'a', target: 'base', pairs: [pick([-8, -15, 10]), pick([5, 15, -10]), pick([8, -15, -10])] }))
    const d = delta(r.pose, POSE)
    expect(d.deg).toBeLessThanOrEqual(0.05)
    expect(d.mm).toBeLessThanOrEqual(0.02)
  })

  it('refines a layer onto another layer, in that layer\'s own frame', async () => {
    await setBase(sphereCloud({ radius: 10, step: 1 }))
    // The target layer is the +x half scanned in its own frame OTHER off.
    const OTHER = rigidOf([-5, 9, 3], [-4, 2, 1])
    await addLayer('t', applyRigidCloud(hi, OTHER))
    await addLayer('a', layerPart)
    const want = rigidCompose(OTHER, POSE)
    const r = aligned(await call('refine', { id: 'a', target: 't', start: nudged(want) }))
    const d = delta(r.pose, want)
    expect(d.deg).toBeLessThanOrEqual(0.05)
    expect(d.mm).toBeLessThanOrEqual(0.02)
  })

  it('refines a cloud layer onto a mesh base', async () => {
    await loadStl(boxMesh(20, 20), false)
    // The box's own surface as points: every face at a 1 mm step, -x half.
    const pts: number[] = [], nrm: number[] = []
    for (let a = -10; a <= 10; a++) {
      for (let b = -10; b <= 10; b++) {
        for (const s of [-1, 1]) {
          pts.push(s * 10, a, b); nrm.push(s, 0, 0)
          pts.push(a, s * 10, b); nrm.push(0, s, 0)
          pts.push(a, b, s * 10); nrm.push(0, 0, s)
        }
      }
    }
    const [half] = halves({ positions: Float32Array.from(pts), normals: Float32Array.from(nrm) }, 0, 4)
    const part = applyRigidCloud(half, TRUE)
    await addLayer('a', part)
    const r = aligned(await call('refine', { id: 'a', target: 'base', start: nudged(POSE) }))
    const d = delta(r.pose, POSE, part)
    expect(d.deg).toBeLessThanOrEqual(0.05)
    expect(d.mm).toBeLessThanOrEqual(0.02)
  })

  it('a transient fit on each side answers ids align-datums lays the layer by', async () => {
    await setBase(hi)
    await addLayer('a', layerPart)
    const geo = await call('layer-geometry', { id: 'a' })
    const base = buildPointGraph({ kind: 'cloud', positions: hi.positions, normals: hi.normals })
    // The bore and the -y face, on both sides.
    const fit = async (id: string, elementType: 'cylinder' | 'plane', positions: Float32Array, at: Vec3) =>
      call('fit', { id, elementType, seeds: [nearest(positions, at)], settings: SETTINGS })
    const boreL = await fit('a', 'cylinder', geo.positions, moved(TRUE, [-6, 0, 0]))
    const faceL = await fit('a', 'plane', geo.positions, moved(TRUE, [0, -15, 0]))
    const boreB = await fit('base', 'cylinder', base.positions, [-6, 0, 0])
    const faceB = await fit('base', 'plane', base.positions, [0, -15, 0])
    expect((boreL.fit as FitOutput).kind).toBe('cylinder')
    expect(new Set([boreL.fitId, faceL.fitId, boreB.fitId, faceB.fitId]).size).toBe(4)
    const r = aligned(await call('align-datums', {
      id: 'a', target: 'base',
      layer: { primary: boreL.fitId, secondary: faceL.fitId, origin: null },
      targetDatums: { primary: boreB.fitId, secondary: faceB.fitId, origin: null },
    }))
    const d = delta(r.pose, POSE)
    expect(d.deg).toBeLessThanOrEqual(0.05)
    expect(d.mm).toBeLessThanOrEqual(0.02)

    // One datum a side is refused with the reason; a fit of the other side is a bad id.
    const one = await call('align-datums', {
      id: 'a', target: 'base',
      layer: { primary: boreL.fitId, secondary: null, origin: null },
      targetDatums: { primary: boreB.fitId, secondary: null, origin: null },
    })
    expect(one).toEqual({ refused: 'Needs two datums on each side — one alone leaves the part free to turn or slide.' })
    await expect(call('align-datums', {
      id: 'a', target: 'base',
      layer: { primary: boreB.fitId, secondary: faceL.fitId, origin: null },
      targetDatums: { primary: boreB.fitId, secondary: faceB.fitId, origin: null },
    })).rejects.toThrow(`There is no fit ${boreB.fitId} on layer "a".`)
  })

  it('stops a refine when Stop is pressed, and answers the next request', async () => {
    const fine = blockWithBoreCloud({ size: [40, 30, 20], boreRadius: 6, step: 0.4 })
    const [l, h] = halves(fine, 0, 16)
    await setBase(h)
    await addLayer('a', applyRigidCloud(l, TRUE))
    const refine = post('refine', { id: 'a', target: 'base', start: nudged(POSE) })
    const after = post('layer-geometry', { id: 'a' })
    expect(replies.some((m) => 'requestId' in m && m.requestId === refine)).toBe(false)
    send({ type: 'align-abort' })
    expect(await result<'refine'>(refine)).toEqual({ stopped: true })
    expect((await result<'layer-geometry'>(after)).positions.length).toBeGreaterThan(0)
  })
})

describe('Merge worker: the own-swap flag', () => {
  it('drops the layers when another scan takes the base\'s place', async () => {
    await setBase(hi)
    await addLayer('a', layerPart)
    await setBase(lo)
    await expect(call('layer-geometry', { id: 'a' })).rejects.toThrow('There is no layer "a".')
  })

  it('keeps them across its own merge swap, and drops them after merge-end', async () => {
    await setBase(hi)
    await addLayer('a', layerPart)
    await call('merge-begin', null)
    await setBase(lo)
    await call('merge-end', null)
    expect((await call('layer-geometry', { id: 'a' })).positions.length).toBe(LO_COUNT * 3)
    await setBase(hi)
    await expect(call('layer-geometry', { id: 'a' })).rejects.toThrow('There is no layer "a".')
  })

  it('keeps them across the history re-swapping the scan', async () => {
    await setBase(hi)
    await addLayer('a', layerPart)
    await call('undo-begin', null)
    await setBase(lo)
    await call('undo-end', null)
    expect((await call('layer-geometry', { id: 'a' })).positions.length).toBe(LO_COUNT * 3)
  })

  it('keeps aligning onto the base after the base moves', async () => {
    await setBase(hi)
    await addLayer('a', layerPart)
    aligned(await call('refine', { id: 'a', target: 'base', start: nudged(POSE) }))
    // The base baked a move: the layer's pose onto it is now MOVE o POSE.
    const MOVE = rigidOf([0, 0, 30], [10, 0, 0])
    const id = nextId++
    send({ type: 'transform', requestId: id, transform: MOVE })
    expect((await reply(id)).type).toBe('transform-ok')
    const want = rigidCompose(MOVE, POSE)
    const r = aligned(await call('refine', { id: 'a', target: 'base', start: nudged(want) }))
    const d = delta(r.pose, want)
    expect(d.deg).toBeLessThanOrEqual(0.05)
    expect(d.mm).toBeLessThanOrEqual(0.02)
  })
})

describe('Merge worker: merge', () => {
  it('equals mergeLayers called directly, only the visible layers', async () => {
    await setBase(hi)
    await addLayer('a', layerPart)
    const other = rigidOf([0, 30, 0], [0, 0, 50])
    await addLayer('b', applyRigidCloud(lo, other))
    await addLayer('hidden', lo)
    const ga = await call('layer-geometry', { id: 'a' })
    const gb = await call('layer-geometry', { id: 'b' })
    const base = buildPointGraph({ kind: 'cloud', positions: hi.positions, normals: hi.normals })
    const toFile = rigidOf([1, 2, 3], [4, 5, 6])
    const poses = { a: POSE, b: rigidInvert(other), hidden: POSE }
    const merged = await call('merge', { poses, visible: ['a', 'b'], toFile, scale: 1, dedupe: 0.5 })
    const direct = mergeLayers({
      base: { positions: base.positions.subarray(0, base.vertexCount * 3), normals: base.normals.subarray(0, base.vertexCount * 3) },
      layers: [
        { positions: ga.positions, normals: ga.normals, pose: POSE },
        { positions: gb.positions, normals: gb.normals, pose: rigidInvert(other) },
      ],
      toFile, scale: 1, dedupe: 0.5,
    })
    expect(merged.dropped).toBe(direct.dropped)
    expect(merged.dropped).toBeGreaterThan(0)
    expect(Array.from(merged.baseMap)).toEqual(Array.from(direct.baseMap))
    expect(Array.from(merged.positions)).toEqual(Array.from(direct.positions))
    expect(Array.from(merged.normals)).toEqual(Array.from(direct.normals))
  })

  it('refuses a visible layer it does not hold or one without a pose', async () => {
    await setBase(hi)
    await addLayer('a', layerPart)
    const toFile = rigidOf([0, 0, 0], [0, 0, 0])
    await expect(call('merge', { poses: { a: POSE }, visible: ['x'], toFile, scale: 1, dedupe: null })).rejects.toThrow('There is no layer "x".')
    await expect(call('merge', { poses: {}, visible: ['a'], toFile, scale: 1, dedupe: null })).rejects.toThrow('No pose for layer "a".')
  })
})

// Base + 5 passes the size of a Revo pass (~760 k points each) + the merged
// cloud, all held by one worker: the spec's memory budget.
describe.skipIf(process.env.SCANRULER_HEAVY !== '1')('Merge worker: memory (SCANRULER_HEAVY=1)', () => {
  it('holds a base and five 760 k-point layers and merges them', async () => {
    const pass = (k: number) => {
      const c = sphereCloud({ radius: 123, step: 0.5 })
      for (let i = 0; i < c.positions.length; i += 3) c.positions[i] += k * 300
      return c
    }
    let peak = 0
    const sample = () => { peak = Math.max(peak, process.memoryUsage().rss) }
    await setBase(pass(0))
    sample()
    const ids: string[] = []
    let total = 0
    for (let k = 1; k <= 5; k++) {
      const added = await addLayer(`p${k}`, pass(k))
      expect(added.vertexCount).toBeGreaterThan(740_000)
      total += added.vertexCount
      ids.push(`p${k}`)
      sample()
    }
    const id = { r: Float64Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1]), t: new Float64Array(3) }
    const poses = Object.fromEntries(ids.map((i) => [i, id]))
    const t0 = performance.now()
    const merged = await call('merge', { poses, visible: ids, toFile: id, scale: 1, dedupe: 0.5 })
    const ms = performance.now() - t0
    sample()
    expect(merged.positions.length / 3).toBe(merged.baseMap.length + total - merged.dropped)
    console.log(`[merge heavy] layers ${total} points, merge ${ms.toFixed(0)} ms, peak rss ${(peak / 2 ** 20).toFixed(0)} MiB`)
    expect(peak).toBeLessThan(HEAVY_RSS_BUDGET)
  }, 600_000)
})

/** Peak resident memory for the heavy test (the whole test process): 931 MiB
 *  measured once on 2026-11-09, × 1.5. */
const HEAVY_RSS_BUDGET = 1400 * 2 ** 20
