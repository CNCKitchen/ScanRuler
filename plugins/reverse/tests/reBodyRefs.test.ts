// SPDX-License-Identifier: AGPL-3.0-only
// A body named as an answer shows it: by its id rounded as written
// (61.001 for 61.0009765625), where one id alone rounds to it; and a mirror
// kept apart, named by its feature, is the copy it made — the original
// goes by its own name.

import { beforeEach, describe, expect, it } from 'vitest'
// The plugin first: the command modules load in its order.
import '../plugin'
import { bodyFamilyNamed, bodyNamed, itemById, solidsNamed } from '../app/reCommandCore'
import type { Feature } from '../core/features'
import { useReverse } from '../state/reStore'
import { resetReverse } from './reReset'

const body = (id: number, name: string) => ({ id, name, visible: true, volume: 1, faces: 6, closed: true, triangles: 12 })

beforeEach(resetReverse)

describe('a body named as answers show it', () => {
  it('takes an id rounded as written where one id alone rounds to it', () => {
    const items = [{ id: 61 }, { id: 61.0009765625 }, { id: 62.0009765625 }, { id: 62.0014 }]
    expect(itemById(items, 61)).toBe(items[0])
    expect(itemById(items, 61.001)).toBe(items[1])
    expect(itemById(items, 61.00098)).toBe(items[1])
    // Two round to it: none; no fraction: the exact one alone.
    expect(itemById(items, 62.001)).toBeUndefined()
    expect(itemById(items, 62)).toBeUndefined()
    useReverse.setState({ bodies: [body(61, 'Shell'), body(61.0009765625, 'Solid 61.001')] })
    expect(bodyNamed(61.001).id).toBe(61.0009765625)
    expect(bodyNamed('61.001').id).toBe(61.0009765625)
  })

  it('takes a mirror kept apart, by its name, for the copy it made', () => {
    const features = [
      { id: 2, kind: 'extrude', name: 'Front half', sketchId: 1, extent: { kind: 'distance', from: 0, to: 5 }, op: 'new', visible: true },
      { id: 3, kind: 'mirror', name: 'Back half', body: 2, plane: { kind: 'world', axis: 'z', offset: 0 }, join: false, visible: true },
    ] as unknown as Feature[]
    useReverse.setState({ features, bodies: [body(2, 'Solid 2'), body(3, 'Solid 3')] })
    expect(bodyNamed('Back half').id).toBe(3)
    expect(bodyFamilyNamed('Back half').id).toBe(3)
    expect(bodyNamed('Front half').id).toBe(2)
    expect(solidsNamed('Back half')).toBeNull()
  })
})
