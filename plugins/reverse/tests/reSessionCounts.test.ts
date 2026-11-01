// SPDX-License-Identifier: AGPL-3.0-only
// The Reverse session's own bookkeeping over a kernel that does no CAD:
// when the scan is handed over again, and what a build counts while it runs.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { scanSwapped } from '../../../src/app/scanEvents'
import { useStore } from '../../../src/state/store'
import { createReverseSession } from '../app/reSession'
import type { ReClient } from '../core/reClient'
import { useReverse } from '../state/reStore'

vi.mock('../core/wasmSupport', () => ({ kernelUnavailableReason: () => null }))

/** A kernel client that answers at once and counts the scans it is given. */
function fakeClient() {
  const client = {
    sent: 0,
    crashed: new Map(),
    onFailure: null,
    steps: { builds: 0 },
    init: async () => 'fake',
    setScan: async () => void client.sent++,
    dispose() {},
  }
  return client
}

const scene = { scanPositions: () => new Float32Array(9), scanIndices: () => new Uint32Array([0, 1, 2]) }

beforeEach(() => {
  useReverse.getState().reset()
  useReverse.getState().setKernel('loading')
  useStore.setState({ fileName: 'part.stl', triangleCount: 1, appliedAlignment: null })
})

describe('the scan handed to the kernel', () => {
  it('is handed over again once another version of it is swapped in, its name and count the same', async () => {
    const client = fakeClient()
    const session = createReverseSession({ sceneRef: { current: scene as never }, kernel: () => client as unknown as ReClient })
    await session.startKernel()
    expect(await session.syncScan()).toBe('sent')
    expect(await session.syncScan()).toBe('same')
    scanSwapped()
    expect(await session.syncScan()).toBe('sent')
    expect(client.sent).toBe(2)
  })
})

describe('the builds a session counts', () => {
  it('counts a build off once when writing its answer throws, so the next build still reads as building', async () => {
    const client = fakeClient()
    let builds = 0
    Object.assign(client, {
      // The first build answers; the second never does.
      build: () => (++builds === 1 ? Promise.resolve({ results: [], bodies: [] }) : new Promise(() => {})),
    })
    const session = createReverseSession({ sceneRef: { current: null }, kernel: () => client as unknown as ReClient })
    await session.startKernel()
    const finishBuild = useReverse.getState().finishBuild
    useReverse.setState({
      finishBuild: () => {
        throw new Error('the store refused the answer')
      },
    })
    const stop = session.watch()
    try {
      const feature = { id: 1, kind: 'import', name: 'Import 1', file: { key: 'k1', name: 'a.step', size: 13 }, visible: true }
      useReverse.setState((s) => ({ features: [feature as never], buildVersion: s.buildVersion + 1 }))
      await vi.waitFor(() => expect(builds).toBe(1))
      await new Promise((r) => setTimeout(r, 0))
      useReverse.setState({ finishBuild })
      useReverse.setState((s) => ({ buildVersion: s.buildVersion + 1 }))
      await vi.waitFor(() => expect(builds).toBe(2))
      expect(session.buildState()).toBe('building')
    } finally {
      stop()
      useReverse.setState({ finishBuild })
    }
  })
})
