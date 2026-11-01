// SPDX-License-Identifier: AGPL-3.0-only
// The Reverse engineer part of a project as a file shapes it: what a saved
// project reads back as, and what a hostile file cannot make of the store.
import { beforeEach, describe, expect, it } from 'vitest'
import { snapshotKey } from '../../../src/app/projectSnapshot'
import { collectReversePart } from '../app/projectSection'
import { useReverse } from '../state/reStore'

beforeEach(() => useReverse.getState().reset())

describe('a Reverse project file', () => {
  it('reads as saved when captured twice with an Import unchanged', () => {
    const feature = { id: 1, kind: 'import', name: 'Import 1', file: { key: 'k1', name: 'a.step', size: 13 } }
    useReverse.setState({ features: [feature as never], rolledBack: [], stepFiles: { k1: 'ISO-10303-21;' } })
    const capture = () => {
      const members: { name: string; bytes: Uint8Array }[] = []
      const part = collectReversePart({ addMember: (name, bytes) => members.push({ name, bytes }) })
      return { manifest: { reverse: part } as never, members }
    }
    const key = snapshotKey()
    expect(key(capture())).toBe(key(capture()))
  })
})
