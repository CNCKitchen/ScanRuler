// SPDX-License-Identifier: AGPL-3.0-only
// Mesh Tools on a point cloud: its workspace is unavailable, its commands
// are refused up front, and every request it makes of the worker is refused
// with the one refusal text — never answered for an empty mesh.
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { listCommands } from '../../../src/commands/registry'
import { CLOUD_REFUSAL } from '../../../src/core/capabilities'
import { workspaceUnavailable } from '../../../src/app/workspaceAvailability'
import { installPlugins } from '../../../src/plugins/registry'
import { sphereCloud, writePlyCloud } from '../../../tests/cloudFixtures'
import { refused, run, startHeadless, type Headless } from '../../../tests/commandKit'

const CLOUD = new Uint8Array(writePlyCloud(sphereCloud({ radius: 20, step: 2.5 }), 'binary_little_endian'))

/** Every operation Mesh Tools has, as its protocol names them. */
const OPS = [...readFileSync(new URL('../core/protocol.ts', import.meta.url), 'utf8')
  .split('export interface MeshToolsOps')[1]
  .matchAll(/^ {2}'?([a-z-]+)'?: \{ payload:/gm)].map((m) => m[1])

let headless: Headless
beforeAll(async () => {
  installPlugins()
  headless = await startHeadless()
  await run('scan.open', { bytes: CLOUD, name: 'ball.ply', discard: true })
}, 120_000)
afterAll(() => headless.stop())

describe('Mesh Tools on a point cloud', () => {
  it('lists the operations it checks', () => {
    expect(OPS.length).toBeGreaterThanOrEqual(15)
    expect(OPS).toEqual(expect.arrayContaining(['reduce', 'edit', 'describe', 'triangles', 'select', 'set-edited']))
  })

  it('is an unavailable workspace, with the refusal as the reason', () => {
    expect(workspaceUnavailable('mesh')).toBe(CLOUD_REFUSAL)
  })

  it('refuses every worker operation with CLOUD_REFUSAL', async () => {
    const client = headless.session.clientRef.current!
    for (const op of OPS) {
      await expect(client.pluginCall('mesh-tools', op, {}), op).rejects.toThrow(CLOUD_REFUSAL)
    }
  })

  it('flags its commands needsTriangles: the ones that change anything are refused up front', async () => {
    const names = listCommands().filter((c) => c.name.startsWith('mesh.') && !c.readOnly).map((c) => c.name)
    expect(names).toEqual(expect.arrayContaining(['mesh.cut', 'mesh.remove_islands', 'mesh.reduce']))
    expect((await refused('mesh.remove_islands', { size: 1 })).message).toBe(CLOUD_REFUSAL)
    expect((await refused('mesh.cut', { plane: 'XY', offset: 0, keep: 'plus' })).message).toBe(CLOUD_REFUSAL)
  })
})
