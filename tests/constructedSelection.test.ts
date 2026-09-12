// SPDX-License-Identifier: AGPL-3.0-only
// A construction that searched a marked surface keeps the marking: it saves
// as a plain array like a fit's and comes back as a Uint32Array.
import { describe, expect, it } from 'vitest'
import { elementFromJson, elementToJson } from '../src/core/project/manifest'
import type { Element } from '../src/state/store'

const settings = { method: 'gaussian', sigma: 3 } as const

describe('a marked surface on a constructed element', () => {
  it('round-trips through the project file', () => {
    const el: Element = {
      id: 7,
      kind: 'plane',
      name: 'Plane 2',
      color: '#0af',
      source: {
        type: 'constructed',
        method: 'plane-symmetry',
        refs: [],
        params: [0, 0, 1, 1, 2, 3, 0.012, 3800, 4000],
        selection: Uint32Array.from([5, 6, 7, 8]),
      },
      status: 'done',
      visible: true,
    }
    const json = JSON.parse(JSON.stringify(elementToJson(el)))
    expect(json.source.selection).toEqual([5, 6, 7, 8])
    expect(json.source.params).toHaveLength(9)
    const back = elementFromJson(json, settings)
    expect(back.source.type).toBe('constructed')
    if (back.source.type !== 'constructed') return
    expect(back.source.selection).toBeInstanceOf(Uint32Array)
    expect(Array.from(back.source.selection!)).toEqual([5, 6, 7, 8])
    expect(back.source.method).toBe('plane-symmetry')
  })

  it('leaves a construction without one as it was', () => {
    const el: Element = {
      id: 8,
      kind: 'point',
      name: 'Point 3',
      color: '#0af',
      source: { type: 'constructed', method: 'point-coords', refs: [], params: [1, 2, 3] },
      status: 'done',
      visible: true,
    }
    const json = JSON.parse(JSON.stringify(elementToJson(el)))
    expect(json.source.selection).toBeUndefined()
    const back = elementFromJson(json, settings)
    expect(back.source.type === 'constructed' && back.source.selection).toBeUndefined()
  })
})
