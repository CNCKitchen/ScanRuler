// SPDX-License-Identifier: AGPL-3.0-only
// A cloud too large to pack, or thinned as it was read, goes into a project
// as the cloud the worker holds (a PLY it writes) rather than its file: the
// manifest says so, and opening it reads the same points without thinning
// them again.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkerRequest, WorkerResponse } from '../src/core/workerProtocol'
import { packProject, readMembers, unpackProject } from '../src/core/project/archive'
import { collectProject, heldCloudWord, packsHeldCloud, PACK_ORIGINAL_BYTES, prepareProjectState, withHeldCloud, type SourceFiles } from '../src/app/project'
import { identityRigid, rigidInvert, type Rigid } from '../src/core/deviation/rigid'
import { installPlugins } from '../src/plugins/registry'
import { useStore, type Element } from '../src/state/store'
import type { PlaneFit } from '../src/core/types'
import { buildPointCloudPly } from '../src/core/exportPointCloud'
import { parsePLY } from '../src/core/parsers/ply'
import { planeCloud, writePlyCloud } from './cloudFixtures'
import { fresh } from './projectKit'

beforeAll(() => installPlugins())

const cloud = planeCloud({ size: 20, step: 1, noise: 0.05 })
const COUNT = cloud.positions.length / 3
const fileBytes = () => new Uint8Array(writePlyCloud(cloud, 'binary_little_endian'))
const bufferOf = (bytes: Uint8Array) => bytes.slice().buffer as ArrayBuffer

const plane = (id: number): Element => ({
  id,
  kind: 'plane',
  name: `Plane ${id}`,
  color: '#f00',
  source: { type: 'fitted', seeds: [id], selection: Uint32Array.from([1, 2, 3]), settings: { method: 'gaussian', sigma: 1 } },
  status: 'done',
  visible: true,
  fit: {
    kind: 'plane',
    center: [0, 0, 0],
    normal: [0, 0, 1],
    basisU: [1, 0, 0],
    basisV: [0, 1, 0],
    extentU: 5,
    extentV: 5,
    sigma: 0.01,
    usedPoints: 100,
    regionSize: 100,
  } as unknown as PlaneFit,
})

/** The session as a loaded cloud leaves it. */
function cloudSession(name: string) {
  fresh()
  useStore.getState().beginLoad(name)
  useStore.getState().finishLoad(COUNT, 0, 10, [0, 0, 0])
  useStore.setState({ scanIsCloud: true, elements: [plane(1)], nextId: 2 })
}

/** A file of `size` bytes as far as anything asking its size knows, without
 *  holding them. */
function oversized(size: number): Blob {
  const blob = new Blob([new Uint8Array(8)])
  Object.defineProperty(blob, 'size', { value: size })
  return blob
}

describe('which scans a project keeps as the held cloud', () => {
  const scan = (file: Blob, extra: Partial<NonNullable<SourceFiles['scan']>> = {}) => ({ name: 'big.ply', file, ...extra })

  it('keeps a small cloud read whole as its file', () => {
    expect(packsHeldCloud(scan(new Blob([fileBytes()])), true)).toBe(false)
  })

  it('keeps the held cloud for one thinned as it was read, whatever its size', () => {
    expect(packsHeldCloud(scan(new Blob([fileBytes()]), { maxPoints: 50 }), true)).toBe(true)
  })

  it('keeps the held cloud for a file past the limit', () => {
    expect(packsHeldCloud(scan(oversized(2.7e9)), true)).toBe(true)
    expect(packsHeldCloud(scan(oversized(PACK_ORIGINAL_BYTES + 1)), true)).toBe(true)
    expect(packsHeldCloud(scan(oversized(PACK_ORIGINAL_BYTES)), true)).toBe(false)
    expect(heldCloudWord(scan(oversized(2.7e9)), 30_000_000)).toContain('30,000,000 points read from big.ply, not the 2.70 GB file')
  })

  it('keeps a mesh, and a cloud that is the held one already, as their file', () => {
    expect(packsHeldCloud(scan(oversized(2.7e9)), false)).toBe(false)
    expect(packsHeldCloud(scan(oversized(2.7e9), { held: true }), true)).toBe(false)
    expect(packsHeldCloud(null, true)).toBe(false)
  })
})

describe('a thinned cloud through a project', () => {
  let replies: WorkerResponse[]
  let scope: { onmessage: ((e: { data: WorkerRequest }) => void) | null; postMessage: (m: WorkerResponse) => void }
  const send = <T extends WorkerResponse['type']>(msg: WorkerRequest, type: T): Extract<WorkerResponse, { type: T }> => {
    replies.length = 0
    scope.onmessage!({ data: msg })
    const r = replies.at(-1)!
    if (r.type !== type) throw new Error(r.type === 'error' ? r.message : `expected ${type}, got ${r.type}`)
    return r as Extract<WorkerResponse, { type: T }>
  }
  const load = (requestId: number, name: string, bytes: Uint8Array, extra: { maxPoints?: number; transform?: Rigid } = {}) =>
    send({ type: 'load', requestId, name, buffer: bufferOf(bytes), crease: { mode: 'off', angleDeg: 30 }, ...extra }, 'loaded')

  beforeEach(async () => {
    replies = []
    scope = { onmessage: null, postMessage: (msg) => replies.push(msg) }
    vi.stubGlobal('self', scope)
    vi.resetModules()
    await import('../src/core/meshWorker')
  })
  afterEach(() => vi.unstubAllGlobals())

  /** Open `bytes` thinned to `keep`, save the project as useProject does
   *  for it, and open the project's scan member again as useProject does. */
  async function saveAndReopen(keep: number, alignment: Rigid | null, colors: Uint8Array | null = null) {
    cloudSession('big.ply')
    const thinned = load(1, 'big.ply', fileBytes(), { maxPoints: keep, ...(alignment ? { transform: alignment } : {}) })
    useStore.setState({ appliedAlignment: alignment })
    const sources: SourceFiles = { scan: { name: 'big.ply', file: new Blob([fileBytes()]), maxPoints: keep }, reference: null, image: null }
    expect(packsHeldCloud(sources.scan, true)).toBe(true)
    const snapshot = collectProject(sources, null, '0.1.0')
    const held = send({ type: 'held-cloud', requestId: 2, toFile: alignment ? rigidInvert(alignment) : identityRigid(), comment: 'big.ply as held', ...(colors ? { colors } : {}) }, 'held-cloud-ok')
    const saved = withHeldCloud(snapshot, held.bytes)
    const back = unpackProject(packProject(saved.manifest, await readMembers(saved.members)))
    const m = back.manifest.scan!
    const reopened = load(3, 'big.ply', back.members.get(m.member)!, {
      ...(m.heldCloud ? {} : { maxPoints: m.maxPoints }),
      ...(m.appliedAlignment ? { transform: alignment! } : {}),
    })
    return { thinned, held, snapshot, saved, back, reopened }
  }

  it('packs the points held, says so in the manifest, and reopens them as they were', async () => {
    const { thinned, held, snapshot, back, reopened } = await saveAndReopen(100, null)
    expect(held.points).toBe(100)
    const m = back.manifest.scan!
    expect(m.heldCloud).toBe(true)
    expect(m.maxPoints).toBeUndefined()
    expect(m.units).toBeUndefined()
    expect(m.scale).toBeUndefined()
    expect(m.member).toBe('scan.ply')
    expect(m.fileName).toBe('big.ply')
    expect([...back.members.keys()]).toEqual(['scan.ply'])
    // Read as it is: the same hundred points, in the same order, so every
    // element and mark numbers the same ones.
    expect(reopened.vertexCount).toBe(100)
    expect(Array.from(reopened.positions)).toEqual(Array.from(thinned.positions))
    expect(Array.from(reopened.normals)).toEqual(Array.from(thinned.normals))
    // The session as captured is left as it was: still the original file.
    expect(snapshot.manifest.scan?.maxPoints).toBe(100)
    expect(snapshot.manifest.scan?.heldCloud).toBeUndefined()
    // And the work comes back with it.
    useStore.setState({ elements: [], nextId: 1 })
    prepareProjectState(back.manifest, back.members)()
    expect(useStore.getState().elements.map((e) => e.name)).toEqual(['Plane 1'])
  })

  it('writes an aligned cloud in its file frame, the alignment put on again on opening', async () => {
    const turn: Rigid = { r: Float64Array.of(0, -1, 0, 1, 0, 0, 0, 0, 1), t: Float64Array.of(5, -3, 2) }
    const { thinned, back, reopened } = await saveAndReopen(80, turn)
    expect(back.manifest.scan?.appliedAlignment).not.toBeNull()
    expect(reopened.vertexCount).toBe(80)
    for (let i = 0; i < thinned.positions.length; i++) expect(reopened.positions[i]).toBeCloseTo(thinned.positions[i], 4)
  })

  it('carries the file colours into the held cloud', async () => {
    const colors = new Uint8Array(100 * 3).map((_, i) => (i * 37) % 251)
    const { saved } = await saveAndReopen(100, null, colors)
    const member = saved.members[0].bytes as Uint8Array
    const parsed = parsePLY(bufferOf(member))
    expect(Array.from(parsed.colors!)).toEqual(Array.from(colors))
  })

  it('saves a reopened held cloud as its file again, still marked held, never thinned', async () => {
    cloudSession('big.ply')
    const ply = new Uint8Array(buildPointCloudPly(cloud.positions, cloud.normals, null, 'held'))
    const sources: SourceFiles = { scan: { name: 'big.ply', file: new Blob([ply]), held: true, maxPoints: 10 }, reference: null, image: null }
    expect(packsHeldCloud(sources.scan, true)).toBe(false)
    const { manifest, members } = collectProject(sources, null, '0.1.0')
    expect(manifest.scan?.heldCloud).toBe(true)
    expect(manifest.scan?.maxPoints).toBeUndefined()
    const back = unpackProject(packProject(manifest, await readMembers(members)))
    expect(back.members.get('scan.ply')).toEqual(ply)
  })
})

describe('the manifest field', () => {
  it('accepts true and refuses anything else', async () => {
    cloudSession('big.ply')
    const { manifest, members } = collectProject({ scan: { name: 'big.ply', file: new Blob([fileBytes()]) }, reference: null, image: null }, null, '0.1.0')
    const files = await readMembers(members)
    expect(unpackProject(packProject({ ...manifest, scan: { ...manifest.scan!, heldCloud: true } }, files)).manifest.scan?.heldCloud).toBe(true)
    for (const bad of [false, 'yes', 1, null]) {
      const m = { ...manifest, scan: { ...manifest.scan!, heldCloud: bad as unknown as true } }
      expect(() => unpackProject(packProject(m, files))).toThrow(/scan\.heldCloud/)
    }
  })
})
