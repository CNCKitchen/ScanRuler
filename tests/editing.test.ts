// SPDX-License-Identifier: AGPL-3.0-only
// Re-opening what has already been created: an element or a dimension goes
// back into the box it was made in, comes out changed, and everything measured
// against it follows without being rebuilt.
import { beforeEach, describe, expect, it } from 'vitest'
import { blockedRefs, draftColorOf, useStore } from '../src/state/store'
import { evaluateDimensions } from '../src/core/dimensions'
import type { Vec3 } from '../src/core/types'

const store = () => useStore.getState()

/** A picked point element, the way the viewport creates one. */
function pickPoint(center: Vec3): number {
  store().startDraft('point')
  store().resolveDraft({
    kind: 'point',
    center,
    sigma: 0,
    usedPoints: 0,
    regionSize: 0,
    region: new Uint32Array(0),
  })
  const id = store().commitDraft()
  if (id === null) throw new Error('point was not created')
  return id
}

/** A constructed element from the given method, references and parameters. */
function construct(kind: 'point' | 'line' | 'plane', method: string, refs: number[], params: number[] = []): number {
  store().startDraft(kind)
  store().setDraftMethod(method)
  refs.forEach((r, i) => store().setDraftRef(i, r))
  params.forEach((p, i) => store().setDraftParam(i, p))
  const id = store().commitDraft()
  if (id === null) throw new Error(`${method} was not created: ${store().draft?.message}`)
  return id
}

const elementById = (id: number) => store().elements.find((e) => e.id === id)!

beforeEach(() => {
  store().beginLoad('test.stl')
  store().finishLoad(0, 0, 100, [0, 0, 0])
})

describe('editing an element', () => {
  it('re-opens a construction with its sources and numbers, and writes it back in place', () => {
    const a = pickPoint([0, 0, 0])
    const b = pickPoint([10, 0, 0])
    const c = pickPoint([0, 20, 0])
    const line = construct('line', 'line-two-points', [a, b])
    const before = elementById(line)
    const wasAt = store().elements.indexOf(before)
    expect(before.fit).toMatchObject({ kind: 'line', center: [5, 0, 0] })

    store().editElement(line)
    const draft = store().draft!
    expect(draft.editId).toBe(line)
    expect(draft.method).toBe('line-two-points')
    expect(draft.refs).toEqual([a, b])
    // The preview stands before anything is touched.
    expect(draft.status).toBe('ready')
    expect(draft.name).toBe(before.name)

    store().setDraftRef(1, c)
    store().setDraftName('Long axis')
    expect(store().commitDraft()).toBe(line)

    const after = elementById(line)
    expect(store().elements).toHaveLength(4)
    expect(after.name).toBe('Long axis')
    // Same element, same colour, same place in the list — new geometry.
    expect(after.color).toBe(before.color)
    expect(store().elements.indexOf(after)).toBe(wasAt)
    expect(after.fit).toMatchObject({ kind: 'line', center: [0, 10, 0] })
    expect(after.source).toEqual({ type: 'constructed', method: 'line-two-points', refs: [a, c], params: [] })
    expect(store().draft).toBeNull()
  })

  it('carries the change through everything built on the edited element', () => {
    const a = pickPoint([0, 0, 0])
    const b = pickPoint([10, 0, 0])
    const far = pickPoint([20, 0, 0])
    const mid = construct('point', 'point-midpoint', [a, b])
    const line = construct('line', 'line-two-points', [a, mid])
    expect(elementById(line).fit).toMatchObject({ center: [2.5, 0, 0] })

    store().editElement(mid)
    store().setDraftRef(1, far)
    store().commitDraft()

    expect(elementById(mid).fit).toMatchObject({ center: [10, 0, 0] })
    // The line was never re-opened — it re-evaluated itself off the new midpoint.
    expect(elementById(line).fit).toMatchObject({ center: [5, 0, 0] })
  })

  it('re-measures the dimensions that reference it, without touching them', () => {
    const a = pickPoint([0, 0, 0])
    const b = pickPoint([10, 0, 0])
    store().startDimension('dist-point-point')
    store().setDimensionRef(0, a)
    store().setDimensionRef(1, b)
    store().commitDimension()
    const dim = store().dimensions[0]
    expect(evaluateDimensions([dim], store().elements)[0].value.raw).toBeCloseTo(10, 9)

    // b is a picked point: re-picking it is a click on the scan, which lands
    // as a fresh preview on the open draft.
    store().editElement(b)
    store().setDraftPicks([[1, 2, 3]])
    store().resolveDraft({
      kind: 'point',
      center: [25, 0, 0],
      sigma: 0,
      usedPoints: 0,
      regionSize: 0,
      region: new Uint32Array(0),
    })
    store().commitDraft()

    expect(store().dimensions).toEqual([dim])
    expect(evaluateDimensions(store().dimensions, store().elements)[0].value.raw).toBeCloseTo(25, 9)
  })

  it('brings a fitted element back as the seeds it was measured on', () => {
    const a = pickPoint([0, 0, 0])
    useStore.setState((s) => ({
      elements: [
        ...s.elements,
        {
          id: 9001,
          kind: 'plane' as const,
          name: 'Plane 1',
          color: '#123456',
          source: { type: 'fitted' as const, seeds: [1, 2, 3, 4, 5, 6] },
          status: 'done' as const,
          visible: true,
          fit: {
            kind: 'plane' as const,
            center: [0, 0, 0] as Vec3,
            normal: [0, 0, 1] as Vec3,
            basisU: [1, 0, 0] as Vec3,
            basisV: [0, 1, 0] as Vec3,
            extentU: 5,
            extentV: 5,
            sigma: 0.01,
            usedPoints: 100,
            regionSize: 120,
          },
        },
      ],
    }))
    expect(a).toBeGreaterThan(0)

    store().editElement(9001)
    const draft = store().draft!
    expect(draft.method).toBe('fit')
    expect(draft.picks).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ])
    expect(draft.status).toBe('ready')
    // A re-opened element is drawn in its own colour, not the next free one.
    expect(draftColorOf(useStore.getState())).toBe('#123456')
    expect(store().selectMode).toBe('auto')
  })

  it('opens a hand-marked element with its marking, and with the marking tools out', () => {
    useStore.setState((s) => ({
      elements: [
        ...s.elements,
        {
          id: 9002,
          kind: 'sphere' as const,
          name: 'Sphere 1',
          color: '#654321',
          source: { type: 'fitted' as const, seeds: [], selection: new Uint32Array([4, 5, 6]) },
          status: 'done' as const,
          visible: true,
          fit: {
            kind: 'sphere' as const,
            center: [0, 0, 0] as Vec3,
            radius: 8,
            sigma: 0.01,
            usedPoints: 100,
            regionSize: 120,
          },
        },
      ],
    }))
    store().editElement(9002)
    expect(store().draft!.selection).toEqual(new Uint32Array([4, 5, 6]))
    expect(store().selectMode).toBe('paint')
  })

  it('refuses to build an element on itself or on anything built on it', () => {
    const a = pickPoint([0, 0, 0])
    const b = pickPoint([10, 0, 0])
    const mid = construct('point', 'point-midpoint', [a, b])
    const line = construct('line', 'line-two-points', [a, mid])

    expect([...blockedRefs(mid, store().elements)].sort()).toEqual([mid, line].sort())
    expect(blockedRefs(undefined, store().elements).size).toBe(0)

    store().editElement(mid)
    store().setDraftRef(0, mid)
    store().setDraftRef(1, line)
    expect(store().draft!.refs).toEqual([a, b])
  })

  it('closes the editor when the element being edited is deleted', () => {
    const a = pickPoint([0, 0, 0])
    store().editElement(a)
    expect(store().draft).not.toBeNull()
    store().removeElement(a)
    expect(store().draft).toBeNull()
  })
})

describe('editing a dimension', () => {
  const twoAxes = (): [number, number] => {
    const a = pickPoint([0, 0, 0])
    const b = pickPoint([10, 0, 0])
    const c = pickPoint([0, 10, 0])
    const d = pickPoint([0, 10, 10])
    return [construct('line', 'line-two-points', [a, b]), construct('line', 'line-two-points', [c, d])]
  }

  it('re-opens with its type, references and anchor, and replaces the row', () => {
    const a = pickPoint([0, 0, 0])
    const b = pickPoint([10, 0, 0])
    const c = pickPoint([0, 30, 0])
    store().startDimension('dist-point-point')
    store().setDimensionRef(0, a)
    store().setDimensionRef(1, b)
    store().commitDimension()
    const id = store().dimensions[0].id

    store().editDimension(id)
    expect(store().dimDraft).toMatchObject({ editId: id, type: 'dist-point-point', refs: [a, b] })

    store().setDimensionRef(1, c)
    store().setDimensionName('Bore spacing')
    store().commitDimension()

    expect(store().dimensions).toHaveLength(1)
    const dim = store().dimensions[0]
    expect(dim.id).toBe(id)
    expect(dim.name).toBe('Bore spacing')
    expect(dim.refs).toEqual([a, c])
    expect(evaluateDimensions([dim], store().elements)[0].value.raw).toBeCloseTo(30, 9)
    expect(store().dimDraft).toBeNull()
  })

  it('renames a dimension that changes from a distance into an angle', () => {
    const [x, y] = twoAxes()
    store().startDimension('dist-axis-axis')
    store().setDimensionRef(0, x)
    store().setDimensionRef(1, y)
    store().commitDimension()
    const id = store().dimensions[0].id
    expect(store().dimensions[0].name).toBe('Distance 1')

    store().editDimension(id)
    store().setDimensionType('angle-axis-axis')
    // The two slots take the same roles, so the references survive the switch.
    expect(store().dimDraft!.refs).toEqual([x, y])
    store().commitDimension()

    expect(store().dimensions[0].id).toBe(id)
    expect(store().dimensions[0].name).toBe('Angle 1')
    expect(store().dimensions[0].type).toBe('angle-axis-axis')
  })

  it('keeps a name given by hand when the group changes', () => {
    const [x, y] = twoAxes()
    store().startDimension('dist-axis-axis')
    store().setDimensionRef(0, x)
    store().setDimensionRef(1, y)
    store().commitDimension()
    const id = store().dimensions[0].id

    store().editDimension(id)
    store().setDimensionName('Spindle tilt')
    store().setDimensionType('angle-axis-axis')
    store().commitDimension()
    expect(store().dimensions[0].name).toBe('Spindle tilt')
  })

  it('closes the editor when the dimension being edited is deleted', () => {
    const a = pickPoint([0, 0, 0])
    const b = pickPoint([10, 0, 0])
    store().startDimension('dist-point-point')
    store().setDimensionRef(0, a)
    store().setDimensionRef(1, b)
    store().commitDimension()
    const id = store().dimensions[0].id

    store().editDimension(id)
    store().removeDimension(id)
    expect(store().dimDraft).toBeNull()
  })
})
