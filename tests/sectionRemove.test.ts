// SPDX-License-Identifier: AGPL-3.0-only
// section.remove: a section deleted by id or name, as the panel's delete key
// does — one undo step, the others kept.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { useStore } from '../src/state/store'
import { boxMesh } from './helpers'
import { refused, run, startHeadless, stlBytes, type Headless } from './commandKit'

let headless: Headless
beforeAll(async () => {
  headless = await startHeadless()
  await run('scan.open', { bytes: stlBytes(boxMesh(20, 4)), name: 'box.stl', discard: true })
}, 120_000)
afterAll(() => headless.stop())

describe('section.remove', () => {
  it('deletes a section by name, keeps the rest, and is undone', async () => {
    await run('section.cut', { across: 'XY', name: 'Low', offset: -2 })
    await run('section.cut', { across: 'XY', name: 'High', offset: 2 })
    const out = await run<{ removed: { name: string }[] }>('section.remove', { section: 'Low' })
    expect(out.removed.map((s) => s.name)).toEqual(['Low'])
    expect(useStore.getState().sections.map((s) => s.name)).toEqual(['High'])
    await run('history.undo')
    expect(useStore.getState().sections.map((s) => s.name).sort()).toEqual(['High', 'Low'])
    expect((await refused('section.remove', { section: 'Nope' })).code).toBe('not_found')
  })
})
