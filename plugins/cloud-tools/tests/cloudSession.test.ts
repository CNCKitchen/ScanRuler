// SPDX-License-Identifier: AGPL-3.0-only
// Cloud Tools on the real worker and the undo history: Floating marks the
// specks off a ball, Plane the points past a plane, and Delete takes what is
// marked out of the cloud as one step — the sphere measured on it kept and
// measured again — that undo puts back and redo takes again. On a mesh the
// workspace is unavailable and the worker refuses.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { buildPointCloudPly } from '../../../src/core/exportPointCloud'
import { configureHistory, installHistory, redo, undo, useHistory } from '../../../src/state/historyStore'
import { projectHistoryHooks } from '../../../src/app/useProjectHistory'
import { workspaceUnavailable } from '../../../src/app/workspaceAvailability'
import { installPlugins } from '../../../src/plugins/registry'
import { useShell } from '../../../src/state/shellStore'
import { useStore } from '../../../src/state/store'
import { boxMesh } from '../../../tests/helpers'
import { sphereCloud } from '../../../tests/cloudFixtures'
import { run, startHeadless, stlBytes, type Headless } from '../../../tests/commandKit'
import { CLOUD_WORKSPACE, createCloudSession, type CloudSession } from '../app/cloudSession'
import { MESH_REFUSAL } from '../plugin'
import { useCloudTools } from '../state/cloudStore'

vi.setConfig({ testTimeout: 120_000 })

/** A ball of radius 20 at 1 mm, a scrap of 30 points 10 mm off it and a
 *  speck of dust. */
function ballWithSpecks(): File {
  const ball = sphereCloud({ radius: 20, step: 1 })
  const p = Array.from(ball.positions)
  const n = Array.from(ball.normals)
  for (let i = 0; i < 30; i++) {
    p.push(30 + (i % 6) * 0.8, Math.floor(i / 6) * 0.8, 0)
    n.push(0, 0, 1)
  }
  p.push(-40, 0, 0)
  n.push(1, 0, 0)
  return new File([buildPointCloudPly(Float32Array.from(p), Float32Array.from(n), null, 'ball')], 'ball.ply')
}
const BALL = sphereCloud({ radius: 20, step: 1 }).positions.length / 3

let headless: Headless
let cloud: CloudSession
let stop: () => void
beforeAll(async () => {
  installPlugins()
  headless = await startHeadless()
  const s = headless.session
  const unconfigure = configureHistory(
    projectHistoryHooks(() => ({
      clientRef: s.clientRef,
      sceneRef: s.sceneRef,
      elementScope: s.maps.elementScope,
      deviation: s.maps.deviation,
      deviationRgb: s.maps.deviationRgb,
      referenceMap: s.maps.referenceMap,
      referenceRgb: s.maps.referenceRgb,
      thickness: s.maps.thickness,
      thicknessRgb: s.maps.thicknessRgb,
      imports: s.imports,
      sources: s.sources,
      runFit: s.measure.runFit,
      runDeviation: s.deviation.runDeviation,
      runThickness: s.thickness.runThickness,
      swapScan: s.swap.swapScan,
      remeasureScan: s.swap.remeasureScan,
    })),
  )
  const uninstall = installHistory()
  cloud = createCloudSession({
    clientRef: s.clientRef,
    sceneRef: s.sceneRef,
    imports: s.imports,
    swapScanBuffers: s.swap.swapScanBuffers,
    remapScan: s.swap.remapScan,
    remeasureScan: s.swap.remeasureScan,
  })
  const unwatch = cloud.watch()
  stop = () => {
    unwatch()
    uninstall()
    unconfigure()
    headless.stop()
  }
}, 60_000)
afterAll(() => stop())

async function openBall() {
  useShell.getState().setWorkspace('elements')
  await headless.session.scan.openScan(ballWithSpecks(), 'mm')
  useShell.getState().setWorkspace(CLOUD_WORKSPACE)
}

describe('Cloud Tools on a cloud', () => {
  it('marks the specks, deletes them as one step, and undo and redo cross it', async () => {
    await openBall()
    expect(workspaceUnavailable(CLOUD_WORKSPACE)).toBeNull()
    await run('element.fit', { kind: 'sphere', at: { point: [0, 0, 20] } })
    const sphere = useStore.getState().elements[0]
    expect(sphere.kind).toBe('sphere')
    const total = useStore.getState().vertexCount
    expect(total).toBe(BALL + 31)

    expect((await cloud.markFloating(0))!.floating).toBe(0)
    const found = (await cloud.markFloating(10))!
    expect(found.floating).toBe(2)
    expect(found.points).toBe(31)
    expect(cloud.marked().length).toBe(31)

    const steps = useHistory.getState().past.length
    expect(await cloud.deleteMarked()).toBe(true)
    expect(useStore.getState().vertexCount).toBe(BALL)
    expect(useHistory.getState().past.length).toBe(steps + 1)
    expect(useHistory.getState().past.at(-1)!.label).toBe('Cloud Tools: delete points')
    // The sphere is still measured, on the cloud as it is now.
    const kept = useStore.getState().elements.find((e) => e.id === sphere.id)!
    expect(kept).toBeDefined()
    expect(Math.abs((kept.fit as { radius: number }).radius - 20)).toBeLessThan(0.1)
    expect((await cloud.markFloating(10))!.floating).toBe(0)

    await undo()
    expect(useStore.getState().vertexCount).toBe(total)
    expect(useStore.getState().elements.some((e) => e.id === sphere.id)).toBe(true)
    await redo()
    expect(useStore.getState().vertexCount).toBe(BALL)
  })

  it('marks the points past a plane and deletes them', async () => {
    await openBall()
    const below = await cloud.markPastPlane({ origin: [0, 0, 0], normal: [0, 0, -1] })
    expect(below).toBeGreaterThan(BALL * 0.4)
    expect(below).toBeLessThan(BALL * 0.6)
    expect(await cloud.deleteMarked()).toBe(true)
    const q = await headless.session.clientRef.current!.query({ min: [-1e9, -1e9, -1e9], max: [1e9, 1e9, 1e9], limit: 1e7 })
    const p = q.positions
    let lowest = Infinity
    for (let i = 2; i < p.length; i += 3) lowest = Math.min(lowest, p[i])
    expect(lowest).toBeGreaterThanOrEqual(0)
  })

  it('marks again as a read ends, though the import queue lets it go a moment after', async () => {
    // The panel marks again, quietly, once the store says a cloud is in and
    // nothing is busy: React renders a store's change in a microtask and
    // runs the effect there — before the import queue has let the read go.
    // Refused then, nothing asked again and the pieces were never found.
    await openBall()
    useCloudTools.getState().setFloating(null)
    let asked: Promise<unknown> | null = null
    let queueBusy: boolean | null = null
    let reading = false
    const unwatch = useStore.subscribe(() =>
      queueMicrotask(() => {
        const s = useStore.getState()
        reading ||= s.busy
        if (asked || !reading || !s.fileName || !s.scanIsCloud || s.busy) return
        queueBusy = headless.session.imports.busy
        asked = cloud.markFloating(10, { quiet: true })
      }),
    )
    try {
      await headless.session.scan.openScan(ballWithSpecks(), 'mm')
    } finally {
      unwatch()
    }
    expect(queueBusy).toBe(true)
    expect(await asked).toMatchObject({ floating: 2, points: 31 })
    expect(useCloudTools.getState().floating).toMatchObject({ floating: 2, percent: 10 })
    expect(useStore.getState().errorText).toBeNull()
  })

  it('refuses to delete nothing, and leaves the history alone', async () => {
    await openBall()
    const steps = useHistory.getState().past.length
    expect(await cloud.deleteMarked(new Uint32Array(0))).toBe(false)
    expect(useStore.getState().errorText).toBe('Nothing is marked to delete.')
    expect(useHistory.getState().past.length).toBe(steps)
  })
})

describe('Cloud Tools on a mesh', () => {
  it('is unavailable, and the worker refuses', async () => {
    useShell.getState().setWorkspace('elements')
    await run('scan.open', { bytes: stlBytes(boxMesh(10)), name: 'box.stl', units: 'mm', discard: true })
    expect(workspaceUnavailable(CLOUD_WORKSPACE)).toBe(MESH_REFUSAL)
    await expect(headless.session.clientRef.current!.pluginCall('cloud-tools', 'floating', { percent: 10 })).rejects.toThrow('this scan is a mesh')
  })
})
