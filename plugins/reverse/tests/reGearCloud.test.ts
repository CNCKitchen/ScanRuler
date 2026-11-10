// SPDX-License-Identifier: AGPL-3.0-only
// A spur gear modelled from its point cloud through the commands alone
// (scripts/gearRecipe.mjs, which the MCP check runs too): a 15-tooth gear's
// cloud, its teeth, radii and bore read back, the model built — the tooth
// patterned round the axis in one sketch — and lying on the cloud.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { run, startHeadless, type Headless } from '../../../tests/commandKit'
import { useStore } from '../../../src/state/store'
import { gearCloud, writePlyCloud } from '../../../tests/cloudFixtures'
import { createReverseSession, installReverseSession } from '../app/reSession'
import { ReClient } from '../core/reClient'
import { localKernel } from './reLocal'
import plugin from '../plugin'
// @ts-expect-error a plain module, shared with the MCP check
import { buildGear } from '../scripts/gearRecipe.mjs'

vi.setConfig({ testTimeout: 300_000 })

const GEAR = new Uint8Array(writePlyCloud(gearCloud({ teeth: 15, tipRadius: 25, rootRadius: 21, width: 12, boreRadius: 6, step: 0.4 }), 'binary_little_endian'))

let headless: Headless
const stops: (() => void)[] = []
beforeAll(async () => {
  plugin.install?.()
  headless = await startHeadless()
  const session = createReverseSession({ sceneRef: { current: null }, kernel: () => new ReClient(localKernel()) })
  stops.push(installReverseSession(session), session.watch())
  await run('scan.open', { bytes: GEAR, name: 'gear.ply', discard: true })
}, 120_000)
afterAll(() => {
  for (const stop of stops) stop()
  headless.stop()
})

describe('a gear from its point cloud', () => {
  it('reads the gear and models it on the cloud', async () => {
    const g = await buildGear((name: string, input: unknown) => run(name, input))
    expect(g.teeth).toBe(15)
    expect(g.tip).toBeCloseTo(25, 1)
    expect(g.root).toBeCloseTo(21, 1)
    expect(g.bore).toBeCloseTo(6, 1)
    expect(g.teethTop - g.bottom).toBeCloseTo(12, 1)
    expect(g.hub).toBeNull()
    expect(g.features).toEqual(['Gear profile', 'Gear', 'Bore profile', 'Bore'])
    // The model lies on the cloud: most of it within a tenth.
    expect(g.compare.share).toBeGreaterThan(0.95)
    expect(g.compare.p95).toBeLessThan(0.2)
    // Every feature built clean, and the sections it read by gone.
    const rows = (await run<{ features: { name: string; status: string; warning?: string }[] }>('reverse.feature.list', {})).features
    expect(rows.filter((f) => f.status !== 'ok' || f.warning)).toEqual([])
    expect(useStore.getState().sections).toEqual([])
    // One body, closed.
    const bodies = (await run<{ bodies: { closed: boolean }[] }>('reverse.body.describe', {})).bodies
    expect(bodies).toHaveLength(1)
  })
})
