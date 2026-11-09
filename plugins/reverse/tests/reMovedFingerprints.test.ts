// SPDX-License-Identifier: AGPL-3.0-only
// A datum alignment moves the part, and with it every face and edge the
// features name by fingerprint — not only the few it moved by hand, which
// left a fillet's edges and a shell's faces where they used to be (issue 34).
import { describe, expect, it } from 'vitest'
import { movedFingerprints, type EdgeFingerprint, type FaceFingerprint } from '../core/topo'
import type { Rigid } from '../../../src/core/deviation/rigid'

// 10 mm along X.
const shift: Rigid = { r: Float64Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1]), t: Float64Array.from([10, 0, 0]) }
const face: FaceFingerprint = { kind: 'plane', centroid: [1, 2, 3], dir: [0, 0, 1], area: 50, origin: 2 } as FaceFingerprint
const edge: EdgeFingerprint = { kind: 'line', mid: [4, 5, 6], dir: [1, 0, 0], length: 8, faces: [{ kind: 'plane', dir: [0, 0, 1] }] } as EdgeFingerprint

describe('movedFingerprints', () => {
  it('carries every fingerprint, wherever a feature keeps it, once', () => {
    const fillet = { kind: 'fillet', edges: [edge], edgesWhere: [{ where: { near: 'x' }, found: [edge] }] }
    const hole = { kind: 'hole', axis: { kind: 'point', face, at: [1, 1, 1] } }
    const out = movedFingerprints({ fillet, hole }, shift)
    expect(out.fillet.edges[0].mid).toEqual([14, 5, 6])
    expect(out.fillet.edgesWhere[0].found[0].mid).toEqual([14, 5, 6])
    expect(out.hole.axis.face.centroid).toEqual([11, 2, 3])
    expect(out.hole.axis.at).toEqual([11, 1, 1])
    // Nothing moved twice, and the originals untouched.
    expect(edge.mid).toEqual([4, 5, 6])
  })

  it('leaves what is no fingerprint alone: sketch points, numbers, names', () => {
    const sketch = { entities: [{ kind: 'line', a: [0, 0], b: [5, 0], source: { body: 3, edge } }], name: 'S', depth: 4 }
    const out = movedFingerprints(sketch, shift)
    expect(out.entities[0].a).toEqual([0, 0])
    expect(out.entities[0].source.edge.mid).toEqual([14, 5, 6])
    expect(out.name).toBe('S')
    expect(out.depth).toBe(4)
  })
})
