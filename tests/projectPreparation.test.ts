// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it } from 'vitest'
import { collectProject, emptySources, prepareProjectState } from '../src/app/project'
import { useStore } from '../src/state/store'

describe('project preparation', () => {
  beforeEach(() => {
    useStore.setState(useStore.getInitialState(), true)
  })
  it('does not write to the stores until committed', () => {
    const { manifest } = collectProject(emptySources(), null, 'test')
    const before = useStore.getState()
    prepareProjectState(manifest)
    expect(useStore.getState()).toBe(before)
  })
  it('rejects missing workspace arrays before touching the session', () => {
    const { manifest } = collectProject(emptySources(), null, 'test')
    const invalid = JSON.parse(JSON.stringify(manifest))
    invalid.flat = {}
    const before = useStore.getState()
    expect(() => prepareProjectState(invalid)).toThrow('Malformed project: flat entries.')
    expect(useStore.getState()).toBe(before)
  })
})
