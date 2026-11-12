// SPDX-License-Identifier: AGPL-3.0-only
// Cancel reaches every wrap asked for, not only the latest: one still waiting
// behind another rejects WrapCancelled as the running one does, and a wrap
// asked for after the cancel runs as ever.
import { expect, it, vi } from 'vitest'
import { buildMeshGraph } from '../../../src/core/geometry/buildGraph'
import { WrapCancelled, WrapClient } from '../core/wrapClient'
import { boxMesh } from '../../../tests/helpers'

vi.setConfig({ testTimeout: 120_000 })

const box = () => {
  const g = buildMeshGraph({ kind: 'soup', positions: boxMesh(20, 4) })
  return [g.positions.slice(), g.indices.slice()] as const
}
const settings = { gap: 4, grow: 0, edges: 'smooth' as const }

it('cancels every wrap in flight, and none asked for after', async () => {
  const client = new WrapClient()
  const first = client.run(...box(), settings, () => {})
  const second = client.run(...box(), settings, () => {})
  client.cancel()
  await expect(first).rejects.toBeInstanceOf(WrapCancelled)
  await expect(second).rejects.toBeInstanceOf(WrapCancelled)
  const after = await client.run(...box(), settings, () => {})
  expect(after.indices.length).toBeGreaterThan(0)
})
