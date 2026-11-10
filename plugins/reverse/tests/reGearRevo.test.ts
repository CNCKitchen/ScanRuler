// SPDX-License-Identifier: AGPL-3.0-only
// Acceptance: the Revo gear modelled from its merged point cloud, and again
// from Revo's own mesh of the same merge — the same model either way: the
// tooth count equal, the radii and the face width within 0.3 mm. Skipped
// where the Revo project is absent.
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { run, startHeadless, type Headless } from '../../../tests/commandKit'
import { revo } from '../../../tests/revoFixtures'
import { useStore } from '../../../src/state/store'
import { createReverseSession, installReverseSession } from '../app/reSession'
import { ReClient } from '../core/reClient'
import { localKernel } from './reLocal'
import { resetReverse } from './reReset'
import plugin from '../plugin'
// @ts-expect-error a plain module, shared with the MCP check
import { buildGear } from '../scripts/gearRecipe.mjs'

vi.setConfig({ testTimeout: 900_000 })

const R = revo()
const MM = 0.3

let headless: Headless
const stops: (() => void)[] = []
beforeAll(async () => {
  if (!R.exists) return
  plugin.install?.()
  headless = await startHeadless()
  const session = createReverseSession({ sceneRef: { current: null }, kernel: () => new ReClient(localKernel()) })
  stops.push(installReverseSession(session), session.watch())
}, 120_000)
afterAll(() => {
  for (const stop of stops) stop()
  headless?.stop()
})

const gearOf = async (path: string, name: string) => {
  resetReverse()
  await run('scan.open', { bytes: new Uint8Array(readFileSync(path)), name, discard: true })
  return buildGear((n: string, input: unknown) => run(n, input))
}

describe.skipIf(!R.exists)('the Revo gear, from its cloud and from Revo’s mesh', () => {
  it('comes out the same model either way', async () => {
    const cloud = await gearOf(R.mergeCloud(), 'Merge_02 cloud.ply')
    // Every feature built clean, and no section the recipe read by left in the scene.
    const rows = (await run<{ features: { name: string; status: string; warning?: string }[] }>('reverse.feature.list', {})).features
    expect(rows.filter((f) => f.status !== 'ok' || f.warning).map((f) => `${f.name}: ${f.warning ?? f.status}`)).toEqual([])
    expect(useStore.getState().sections).toEqual([])
    const mesh = await gearOf(R.mergeMesh(), 'Merge_02 mesh.ply')
    const pick = (g: typeof cloud) => ({ teeth: g.teeth, tip: g.tip, root: g.root, bore: g.bore, hub: g.hub, width: g.teethTop - g.bottom, p50: g.compare.p50, p95: g.compare.p95 })
    console.log(`cloud ${JSON.stringify(pick(cloud))}\nmesh  ${JSON.stringify(pick(mesh))}`)
    expect(cloud.teeth).toBe(mesh.teeth)
    expect(Math.abs(cloud.tip - mesh.tip)).toBeLessThan(MM)
    expect(Math.abs(cloud.root - mesh.root)).toBeLessThan(MM)
    expect(Math.abs(cloud.bore - mesh.bore)).toBeLessThan(MM)
    expect(Math.abs(cloud.teethTop - cloud.bottom - (mesh.teethTop - mesh.bottom))).toBeLessThan(MM)
    // What the cloud's model has beyond a plain gear, and how close it lies:
    // the scan's own noise (σ 0.06–0.09 mm on its faces) caps the share
    // within ±0.1 mm near 0.7.
    expect(cloud.lugs).toBe(2)
    expect(cloud.pocket?.count).toBe(8)
    expect(cloud.compare.share).toBeGreaterThan(0.99)
    expect(cloud.compare.withinShare).toBeGreaterThan(0.58)
    expect(cloud.hub).not.toBeNull()
    expect(Math.abs(cloud.hub - mesh.hub)).toBeLessThan(MM)
  })
})
