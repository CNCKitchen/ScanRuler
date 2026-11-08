// SPDX-License-Identifier: AGPL-3.0-only
// Versions of the edited copy in the undo history: bounded by the memory
// they hold, not only by their count.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearHistory, configureHistory, HISTORY_BYTE_BUDGET, historyAction, registerHistory, useHistory } from '../../../src/state/historyStore'
import { editedCopy, editedCopyBytes, type EditedCopy } from '../state/editedCopy'

/** A copy that says it is `mb` MB, without holding it: the history only
 *  asks for its byteLength. */
function fakeCopy(mb: number): EditedCopy {
  const bytes = { byteLength: mb * 1e6 } as Uint8Array
  return { source: { name: 'scan.ply', bytes }, map: new Int32Array(0) }
}

let stops: (() => void)[] = []
beforeEach(() => {
  clearHistory()
  stops = [
    configureHistory({}),
    registerHistory({ sections: [{ key: 'edited', compare: 'identity', capture: () => editedCopy.current, apply: () => {}, bytes: (c) => editedCopyBytes(c as EditedCopy) }] }),
  ]
})
afterEach(() => {
  stops.forEach((stop) => stop())
  editedCopy.current = null
})

describe('the edited copy in the undo history', () => {
  it('keeps no more versions of a large copy than fit the byte budget', () => {
    for (let i = 0; i < 70; i++) historyAction(`edit ${i}`, () => (editedCopy.current = fakeCopy(105)))
    const past = useHistory.getState().past
    const held = new Set<EditedCopy>()
    for (const e of past) for (const side of [e.before, e.after]) if (side.edited) held.add(side.edited as EditedCopy)
    const bytes = [...held].reduce((sum, c) => sum + editedCopyBytes(c), 0)
    expect(bytes).toBeLessThanOrEqual(HISTORY_BYTE_BUDGET)
    expect(past.length).toBeLessThan(64)
    // The newest steps are the ones kept.
    expect(past.at(-1)!.label).toBe('edit 69')
  })

  it('keeps a step however large its copy', () => {
    historyAction('edit', () => (editedCopy.current = fakeCopy(2000)))
    expect(useHistory.getState().past).toHaveLength(1)
  })
})
