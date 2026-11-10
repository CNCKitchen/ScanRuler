// SPDX-License-Identifier: AGPL-3.0-only
// Mesh this cloud: a point-cloud scan made a mesh in place, as one undo
// step; undone, the cloud is back with every point.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { useStore } from '../../../src/state/store'
import { cloudMesher } from '../../../src/app/cloudMesher'
import { cylinderCloud, writePlyCloud } from '../../../tests/cloudFixtures'
import { boxMesh } from '../../../tests/helpers'
import { refused, run, startHeadless, stlBytes, undoLabels, type Headless } from '../../../tests/commandKit'
import { configureHistory, installHistory } from '../../../src/state/historyStore'
import { projectHistoryHooks } from '../../../src/app/useProjectHistory'
import { createMeshToolsSession, installMeshToolsSession } from '../app/meshToolsSession'
import plugin from '../plugin'

const CLOUD = new Uint8Array(writePlyCloud(cylinderCloud({ radius: 10, length: 20, step: 0.5 }), 'binary_little_endian'))

let headless: Headless
const stops: (() => void)[] = []
beforeAll(async () => {
  plugin.install?.()
  headless = await startHeadless()
  const s = headless.session
  const session = createMeshToolsSession({
    clientRef: s.clientRef,
    sceneRef: { current: null },
    sources: s.sources,
    imports: s.imports,
    swapScan: s.swap.swapScan,
    remapScan: s.swap.remapScan,
    remeasureScan: s.swap.remeasureScan,
  })
  // The undo history wired to the session as the app wires it, so a step
  // across a scan swap loads the scan from its other side.
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
  stops.push(installMeshToolsSession(session), session.watch(), unconfigure, installHistory())
}, 120_000)
afterAll(() => {
  for (const stop of stops) stop()
  headless.stop()
})

describe('Mesh this cloud', () => {
  it('is offered to the app', () => {
    expect(cloudMesher()).toMatchObject({ label: 'Mesh this cloud', command: 'mesh.mesh_cloud' })
  })

  it('makes the cloud a mesh as one undo step; undo brings the cloud back', async () => {
    await run('scan.open', { bytes: CLOUD, name: 'tube.ply', discard: true })
    const points = useStore.getState().vertexCount
    expect(useStore.getState().scanIsCloud).toBe(true)
    const out = await run<{ triangles: number; cell: number }>('mesh.mesh_cloud', {})
    expect(out.triangles).toBeGreaterThan(0)
    expect(out.cell).toBeCloseTo(1, 1)
    expect(useStore.getState().scanIsCloud).toBe(false)
    expect(useStore.getState().triangleCount).toBe(out.triangles)
    expect(useStore.getState().statusText).toMatch(/Ctrl\+Z returns the cloud/)
    expect(undoLabels().at(-1)).toBe('Agent: mesh this cloud')
    await run('history.undo')
    expect(useStore.getState().scanIsCloud).toBe(true)
    expect(useStore.getState().vertexCount).toBe(points)
  }, 120_000)

  it('refuses a mesh', async () => {
    await run('scan.open', { bytes: stlBytes(boxMesh(10, 2)), name: 'box.stl', discard: true })
    expect((await refused('mesh.mesh_cloud', {})).message).toBe('The scan is a mesh already.')
  }, 60_000)
})
