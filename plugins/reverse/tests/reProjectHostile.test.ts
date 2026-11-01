// SPDX-License-Identifier: AGPL-3.0-only
// The Reverse engineer part of a project as a file shapes it: what a saved
// project reads back as, and what a hostile file cannot make of the store.
import { beforeEach, describe, expect, it } from 'vitest'
import { snapshotKey } from '../../../src/app/projectSnapshot'
import { collectReversePart, reverseSection } from '../app/projectSection'
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

describe('a Reverse project file with hostile counters', () => {
  const part = (nextFeatureId: number, extra: object = {}) => ({
    version: 3,
    features: [{ id: 7, kind: 'import', name: 'Import 1', file: { key: 'k', name: 'a.step', size: 1 }, visible: true }],
    nextFeatureId,
    nextOfKind: {},
    elementsShown: true,
    ...extra,
  })
  const load = (value: unknown) => reverseSection.prepare(value as never, { manifest: {} as never, members: new Map() })()

  it('never hands out an id a feature or a parameter already has', () => {
    for (const bad of [7, 3, -3, 0.5, 0]) {
      load(part(bad, { parameters: [{ id: 4, name: 'a', kind: 'number', expression: '1' }], nextParameterId: 2 }))
      expect(useReverse.getState().nextFeatureId).toBe(8)
      expect(useReverse.getState().nextParameterId).toBe(5)
    }
    load(part(20))
    expect(useReverse.getState().nextFeatureId).toBe(20)
  })

  it('refuses a name counter that is not a whole number', () => {
    expect(() => load(part(8, { nextOfKind: { extrude: 0.5 } }))).toThrow()
  })
})
