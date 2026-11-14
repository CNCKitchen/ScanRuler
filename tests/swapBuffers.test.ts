// SPDX-License-Identifier: AGPL-3.0-only
// The scan put in place from a point cloud in memory (app/scanSwap
// swapScanBuffers): the same graph as swapping in the PLY written from it,
// shown in the pose it is given, kept as that PLY for the history and the
// project, and announced to the worker's plugins.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { buildPointCloudPly } from '../src/core/exportPointCloud'
import { parsePLY } from '../src/core/parsers/ply'
import { rigidApplyToPoints, rigidFromAxisAngle, rigidRotateVectors, type Rigid } from '../src/core/deviation/rigid'
import { workerPlugins } from '../src/core/workerPlugins'
import type { WorkerPlugin } from '../src/core/workerPluginApi'
import { collectProject } from '../src/app/project'
import { packProject, readMembers, unpackProject } from '../src/core/project/archive'
import type { ScanSource } from '../src/app/scanSwap'
import { useStore } from '../src/state/store'
import { planeCloud, cylinderCloud, type Cloud } from './cloudFixtures'
import { run, startHeadless, type Headless } from './commandKit'

let headless: Headless
beforeAll(async () => {
  headless = await startHeadless()
}, 60_000)
afterAll(() => headless.stop())

const BIG = 1e9
const pose: Rigid = rigidFromAxisAngle([0.3, 0.5, 0.8], 0.7)
const copyOf = (c: Cloud): Cloud => ({ positions: new Float32Array(c.positions), normals: new Float32Array(c.normals) })
const plyOf = (c: Cloud, name: string) => new File([buildPointCloudPly(c.positions, c.normals, null, name)], name)

/** What the worker holds as the scan: every vertex, with its normal. */
async function held() {
  const q = await headless.session.clientRef.current!.query({ min: [-BIG, -BIG, -BIG], max: [BIG, BIG, BIG], limit: 1e7 })
  return { positions: q.positions, normals: q.normals }
}

/** Points with their normals as a sorted list of keys, order-free. */
function keys(positions: Float32Array, normals: Float32Array): string[] {
  const out: string[] = []
  for (let i = 0; i < positions.length; i += 3) {
    const r = (a: Float32Array) => [a[i], a[i + 1], a[i + 2]].map((x) => x.toFixed(3)).join(',')
    out.push(`${r(positions)}|${r(normals)}`)
  }
  return out.sort()
}

async function openCloud(c: Cloud) {
  await run('scan.open', { bytes: new Uint8Array(buildPointCloudPly(c.positions, c.normals, null, 'a')), name: 'a.ply', discard: true })
}

describe('swapping the scan in from buffers', () => {
  const next = cylinderCloud({ radius: 4, length: 10, step: 1 })

  it('makes the same scan as swapping in the PLY written from the buffers', async () => {
    await openCloud(planeCloud({ size: 10, step: 1 }))
    const { swap } = headless.session
    const file = plyOf(next, 'b.ply')
    await swap.swapScan({ name: 'b.ply', file, units: 'mm', scale: 1 }, null)
    const viaFile = await held()
    const countFile = useStore.getState().vertexCount

    await openCloud(planeCloud({ size: 10, step: 1 }))
    const source: ScanSource = { name: 'b.ply', file, units: 'mm', scale: 1 }
    await swap.swapScanBuffers(source, copyOf(next), null)
    const viaBuffers = await held()
    const s = useStore.getState()
    expect(s.scanIsCloud).toBe(true)
    expect(s.vertexCount).toBe(countFile)
    expect(s.triangleCount).toBe(0)
    expect(keys(viaBuffers.positions, viaBuffers.normals)).toEqual(keys(viaFile.positions, viaFile.normals))
    expect(headless.session.sources.current.scan).toBe(source)
  })

  it('keeps the alignment it is given and shows the input moved by it', async () => {
    await openCloud(planeCloud({ size: 10, step: 1 }))
    useStore.setState({ appliedAlignment: pose })
    const input = copyOf(next)
    await headless.session.swap.swapScanBuffers({ name: 'b.ply', file: plyOf(next, 'b.ply'), units: 'mm', scale: 1 }, copyOf(next), pose)
    expect(useStore.getState().appliedAlignment).toBe(pose)
    const moved = copyOf(input)
    rigidApplyToPoints(pose, moved.positions)
    rigidRotateVectors(pose, moved.normals)
    const shown = await held()
    expect(keys(shown.positions, shown.normals)).toEqual(keys(moved.positions, moved.normals))
  })

  it('crosses undo and redo by re-reading the source it keeps', async () => {
    const before = planeCloud({ size: 10, step: 1 })
    await openCloud(before)
    const { swap, sources } = headless.session
    const previous = sources.current.scan as ScanSource
    const source: ScanSource = { name: 'b.ply', file: plyOf(next, 'b.ply'), units: 'mm', scale: 1 }
    await swap.swapScanBuffers(source, copyOf(next), pose)
    const after = await held()
    // Undo: the scan from before; redo: the one in the history's source, in the pose.
    await swap.swapScan(previous, null)
    const undone = await held()
    expect(keys(undone.positions, undone.normals)).toEqual(keys(before.positions, before.normals))
    await swap.swapScan(source, pose)
    const redone = await held()
    expect(keys(redone.positions, redone.normals)).toEqual(keys(after.positions, after.normals))
  })

  it('is kept as a PLY the project writes and reads back identical', async () => {
    await openCloud(planeCloud({ size: 10, step: 1 }))
    const source: ScanSource = { name: 'b.ply', file: plyOf(next, 'b.ply'), units: 'mm', scale: 1 }
    await headless.session.swap.swapScanBuffers(source, copyOf(next), null)
    const kept = headless.session.sources.current.scan!
    const { manifest, members } = collectProject({ scan: kept, reference: null, image: null }, null, '0.1.0')
    const back = unpackProject(packProject(manifest, await readMembers(members)))
    const bytes = back.members.get(manifest.scan!.member)!
    const parsed = parsePLY(bytes.slice().buffer as ArrayBuffer, () => {})
    expect(Array.from(parsed.positions)).toEqual(Array.from(next.positions))
    expect(Array.from(parsed.normals!)).toEqual(Array.from(next.normals))
  })

  it('tells the worker plugins the scan was replaced', async () => {
    await openCloud(planeCloud({ size: 10, step: 1 }))
    const scanReplaced = vi.fn()
    const spy: WorkerPlugin = { id: 'zz-spy', acceptsClouds: true, handle: () => ({}) as never, scanReplaced }
    ;(workerPlugins as WorkerPlugin[]).push(spy)
    try {
      await headless.session.swap.swapScanBuffers({ name: 'b.ply', file: plyOf(next, 'b.ply'), units: 'mm', scale: 1 }, copyOf(next), null)
      expect(scanReplaced).toHaveBeenCalledTimes(1)
    } finally {
      ;(workerPlugins as WorkerPlugin[]).splice(workerPlugins.indexOf(spy), 1)
    }
  })
})
