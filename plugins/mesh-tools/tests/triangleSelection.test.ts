// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it } from 'vitest'
import { triangleMask, selectedTriangles, selectionBoundary, visibleTriangles } from '../core/triangleSelection'
import { withoutTriangles } from '../core/pieces'
import { useDeleteSelection } from '../state/deleteStore'

const indices = new Uint32Array([0, 1, 2, 0, 2, 3])
const positions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0])
const edges = (array: Uint32Array) => {
  const out: string[] = []
  for (let i = 0; i < array.length; i += 2) out.push(`${array[i]}-${array[i + 1]}`)
  return out.sort()
}

describe('triangle selection', () => {
  it('selects exact triangle IDs, never their vertex-induced neighbours', () => {
    const mask = triangleMask(2, new Uint32Array([0, 0]))
    expect(Array.from(mask)).toEqual([1, 0])
    expect(Array.from(selectedTriangles(mask))).toEqual([0])
    expect(() => triangleMask(2, new Uint32Array([2]))).toThrow('no triangle')
  })
  it('decodes frontmost pixel IDs including the high bytes, ignoring background', () => {
    const pixels = new Uint8Array([0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 0, 1, 0])
    const mask = visibleTriangles(pixels, 65537)
    expect(Array.from(selectedTriangles(mask))).toEqual([0, 255, 65536])
  })
  it('shows the selected open rim and shared selection boundary', () => {
    expect(edges(selectionBoundary(indices, 4, new Uint8Array([1, 0])))).toEqual(['0-1', '0-2', '1-2'])
    expect(edges(selectionBoundary(indices, 4, new Uint8Array([1, 1])))).toEqual(['0-1', '0-3', '1-2', '2-3'])
    expect(selectionBoundary(indices, 4, new Uint8Array(2))).toHaveLength(0)
  })
  it('distinguishes non-manifold selected/unselected transitions', () => {
    const junction = new Uint32Array([0, 1, 2, 1, 0, 3, 0, 1, 4])
    expect(edges(selectionBoundary(junction, 5, new Uint8Array([1, 1, 0])))).toContain('0-1')
  })
  it('does not invent boundaries between disconnected, overlapping surfaces', () => {
    const overlapping = new Uint32Array([0, 1, 2, 3, 4, 5])
    expect(edges(selectionBoundary(overlapping, 6, new Uint8Array([1, 0])))).toEqual(['0-1', '0-2', '1-2'])
  })
  it('refuses mismatched masks', () => {
    expect(() => selectionBoundary(indices, 4, new Uint8Array(1))).toThrow('different mesh')
  })
  it('preserves kept triangles, shared vertices, and exact original coordinates', () => {
    const kept = withoutTriangles(positions, indices, 4, new Uint8Array([1, 0]))
    expect(Array.from(kept.vertexMap)).toEqual([0, -1, 1, 2])
    expect(Array.from(kept.positions)).toEqual([0, 0, 0, 1, 1, 0, 0, 1, 0])
    expect(Array.from(kept.indices)).toEqual([0, 1, 2])
  })
})

describe('deletion approval state', () => {
  beforeEach(() => useDeleteSelection.getState().reset())
  it('requires distinct preview/request stages and cancellation preserves selection', () => {
    const s = useDeleteSelection.getState()
    s.setSelection(new Uint8Array([1, 0]))
    s.setStage(1)
    expect(useDeleteSelection.getState().stage).toBe(1)
    s.setStage(2)
    expect(useDeleteSelection.getState().stage).toBe(2)
    s.setStage(0)
    expect(useDeleteSelection.getState().count).toBe(1)
  })
  it('invalidates approval after selection, mode or gesture changes', () => {
    const s = useDeleteSelection.getState()
    for (const change of [
      () => s.setSelection(new Uint8Array([0, 1])),
      () => s.setGesture('brush'),
      () => s.setRemove(true),
      () => s.setMode('through'),
      () => s.reset(),
    ]) {
      s.setStage(2)
      change()
      expect(useDeleteSelection.getState().stage).toBe(0)
    }
  })
})
