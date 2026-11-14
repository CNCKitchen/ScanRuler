// SPDX-License-Identifier: AGPL-3.0-only
// Reverse engineer on a point-cloud scan: the workspace opens, its commands
// run on the points — a section read for its teeth — and only those that
// need a surface (volume compare, the patch network) refuse, naming Mesh
// this cloud.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { CLOUD_REFUSAL } from '../../../src/core/capabilities'
import { workspaceUnavailable } from '../../../src/app/workspaceAvailability'
import { useStore } from '../../../src/state/store'
import { gearCloud, writePlyCloud } from '../../../tests/cloudFixtures'
import { refused, run, startHeadless, type Headless } from '../../../tests/commandKit'
import { createReverseSession, installReverseSession, type ReverseSession } from '../app/reSession'
import { ReClient } from '../core/reClient'
import { localKernel } from './reLocal'
import plugin from '../plugin'
import { reverseCommands } from '../app/reCommands'
import { resetReverse } from './reReset'

vi.setConfig({ testTimeout: 180_000 })

const GEAR = new Uint8Array(writePlyCloud(gearCloud({ teeth: 15, tipRadius: 25, rootRadius: 21, width: 12, boreRadius: 6, step: 0.4 }), 'binary_little_endian'))

/** Every `teeth` count anywhere in an answer. */
const teethIn = (x: unknown): number[] =>
  x && typeof x === 'object' ? Object.entries(x).flatMap(([k, v]) => (k === 'teeth' && typeof v === 'number' ? [v] : teethIn(v))) : []

let headless: Headless
let session: ReverseSession
const stops: (() => void)[] = []
beforeAll(async () => {
  plugin.install?.()
  headless = await startHeadless()
  session = createReverseSession({ sceneRef: { current: null }, kernel: () => new ReClient(localKernel()) })
  stops.push(installReverseSession(session), session.watch())
  await run('scan.open', { bytes: GEAR, name: 'gear.ply', discard: true })
}, 120_000)
afterAll(() => {
  for (const stop of stops) stop()
  headless.stop()
})
beforeEach(resetReverse)

describe('Reverse engineer on a point cloud', () => {
  it('opens on a cloud', () => {
    expect(useStore.getState().scanIsCloud).toBe(true)
    expect(plugin.workspace?.unavailable?.() ?? null).toBeNull()
    expect(workspaceUnavailable('reverse')).toBeNull()
  })

  it('reads a section of the cloud for its teeth', async () => {
    await run('section.cut', { across: 'XY', offset: 0.05, name: 'Mid' })
    const fit = await run('reverse.section.fit', { section: 'Mid', periodic: true })
    expect(teethIn(fit)).toContain(15)
  })

  it('refuses only what needs a surface, naming Mesh this cloud', async () => {
    expect((await refused('reverse.body.volume_compare', {})).message).toBe(CLOUD_REFUSAL)
    expect((await refused('reverse.network.read', { feature: 'Network 1' })).message).toBe(CLOUD_REFUSAL)
    const flagged = reverseCommands.filter((c) => c.needsTriangles).map((c) => c.name).sort()
    expect(flagged).toEqual(['body.volume_compare', 'network.create', 'network.edit', 'network.read', 'network.suggest_creases'])
  })
})
