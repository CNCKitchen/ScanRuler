// SPDX-License-Identifier: AGPL-3.0-only
// A fit told what surface it is after (element.fit's side, radius, axis,
// within) keeps that guide as part of its recipe: a small bore beside a large
// curved face is found from its seeds only with it, so every re-fit — the
// element re-opened, the project opened again — runs with it. It goes into
// the element and the project file, and moves and scales with the part, as
// the fit does.
import { beforeEach, describe, expect, it } from 'vitest'
import { lostSurfaces } from '../src/app/useProject'
import { collectProject } from '../src/app/project'
import { rigidFromAxisAngle } from '../src/core/deviation/rigid'
import { moveGuide, scaleGuide, type FitGuide } from '../src/core/fit/guide'
import { elementFromJson, validateManifest } from '../src/core/project/manifest'
import type { CylinderFit, Vec3 } from '../src/core/types'
import { useStore } from '../src/state/store'
import { fresh, sources } from './projectKit'

const store = () => useStore.getState()
const GUIDE: FitGuide = { side: 'inside', radius: { min: 2, max: 2.5 }, axis: [0, 0, 1], within: { min: [-5, -5, 0], max: [5, 5, 10] } }

const bore = (): CylinderFit & { region: Uint32Array } => ({
  kind: 'cylinder',
  center: [0, 0, 5],
  axis: [0, 0, 1],
  radius: 2.12,
  length: 8,
  coverage: 360,
  sigma: 0.01,
  usedPoints: 400,
  regionSize: 400,
  region: Uint32Array.from([3, 4, 5]),
})

/** A cylinder fitted from one seed with the guide, as element.fit makes it. */
function guidedBore(): number {
  store().startDraft('cylinder')
  store().setDraftPicks([[3, 4, 5]], [[0, 2.1, 5]])
  store().setDraftGuide(GUIDE)
  store().resolveDraft(bore())
  const id = store().commitDraft()
  if (id === null) throw new Error('the bore was not created')
  return id
}

const sourceOf = (id: number) => store().elements.find((e) => e.id === id)!.source

beforeEach(() => fresh())

describe('a fit’s guide', () => {
  it('goes into the element, and back into the box when it is re-opened', () => {
    const id = guidedBore()
    const source = sourceOf(id)
    expect(source.type === 'fitted' && source.guide).toEqual(GUIDE)
    store().editElement(id)
    expect(store().draft?.guide).toEqual(GUIDE)
    // A change of the picks or of the settings re-fits with it still.
    store().setDraftPicks([[3, 4, 5], [6, 7, 8]], [])
    expect(store().draft?.guide).toEqual(GUIDE)
    store().cancelDraft()
  })

  it('is not there for a fit without one', () => {
    store().startDraft('cylinder')
    store().setDraftPicks([[3, 4, 5]], [[0, 2.1, 5]])
    store().resolveDraft(bore())
    const source = sourceOf(store().commitDraft()!)
    expect(source.type === 'fitted' && 'guide' in source).toBe(false)
  })

  it('a new box starts without the last one’s', () => {
    guidedBore()
    store().startDraft('cylinder')
    expect(store().draft?.guide).toBeUndefined()
    store().cancelDraft()
  })

  it('is saved with the project and opens with it', () => {
    const id = guidedBore()
    const { manifest } = collectProject(sources(), null, '0.1.0')
    const json = JSON.parse(JSON.stringify(manifest))
    expect(() => validateManifest(json)).not.toThrow()
    const saved = json.scan.elements.find((e: { id: number }) => e.id === id)
    expect(saved.source.guide).toEqual(GUIDE)
    const back = elementFromJson(saved, { method: 'gaussian', sigma: 3 })
    expect(back.source.type === 'fitted' && back.source.guide).toEqual(GUIDE)
  })

  it('a malformed one is refused when the project is read', () => {
    const id = guidedBore()
    const { manifest } = collectProject(sources(), null, '0.1.0')
    const bad = (guide: unknown) => {
      const json = JSON.parse(JSON.stringify(manifest))
      json.scan.elements.find((e: { id: number }) => e.id === id).source.guide = guide
      return () => validateManifest(json)
    }
    expect(bad({ side: 'under' })).toThrow('element.guide.side')
    expect(bad({ radius: { min: -1 } })).toThrow('element.guide.radius.min')
    expect(bad({ axis: [0, 1] })).toThrow('element.guide.axis')
    expect(bad({ within: { min: [0, 0, 0] } })).toThrow('element.guide.within.max')
    expect(bad({})).not.toThrow()
  })

  it('turns and moves with an alignment, its box still holding what it held', () => {
    const id = guidedBore()
    const m = rigidFromAxisAngle([1, 0, 0], Math.PI / 2)
    m.t[0] = 10
    store().applyAlignment(m)
    const source = sourceOf(id)
    const g = source.type === 'fitted' ? source.guide! : null
    expect(g!.axis![0]).toBeCloseTo(0)
    expect(Math.abs(g!.axis![1])).toBeCloseTo(1)
    expect(g!.axis![2]).toBeCloseTo(0)
    // The fit's centre, moved by the same motion, lies in the moved box.
    const fit = store().elements.find((e) => e.id === id)!.fit as CylinderFit
    for (let k = 0; k < 3; k++) {
      expect(fit.center[k]).toBeGreaterThanOrEqual(g!.within!.min[k] - 1e-9)
      expect(fit.center[k]).toBeLessThanOrEqual(g!.within!.max[k] + 1e-9)
    }
    expect(g!.radius).toEqual(GUIDE.radius)
    expect(g!.side).toBe('inside')
  })

  it('scales with the part', () => {
    const id = guidedBore()
    store().applyScale(2, null)
    const source = sourceOf(id)
    expect(source.type === 'fitted' && source.guide).toEqual({ ...GUIDE, radius: { min: 4, max: 5 }, within: { min: [-10, -10, 0], max: [10, 10, 20] } })
  })
})

describe('moveGuide and scaleGuide', () => {
  it('leave what they do not move as it is', () => {
    expect(moveGuide({ side: 'outside' }, rigidFromAxisAngle([0, 0, 1], 1))).toEqual({ side: 'outside' })
    expect(scaleGuide({ axis: [0, 1, 0] }, 3)).toEqual({ axis: [0, 1, 0] })
    expect(scaleGuide({ radius: { max: 1 } }, 3)).toEqual({ radius: { max: 3 } })
  })

  it('turn a box into the box round its turned corners', () => {
    const turned = moveGuide({ within: { min: [0, 0, 0], max: [2, 1, 1] } }, rigidFromAxisAngle([0, 0, 1], Math.PI / 4))
    const s = Math.SQRT1_2
    const near = (a: Vec3, b: Vec3) => a.forEach((v, k) => expect(v).toBeCloseTo(b[k]))
    near(turned.within!.min, [-s, 0, 0])
    near(turned.within!.max, [2 * s, 3 * s, 1])
  })
})

describe('the status line on opening', () => {
  it('names the elements whose surface was not found again', () => {
    expect(lostSurfaces([])).toBe('')
    expect(lostSurfaces([{ name: 'Bore', failed: 'No cylinder here.' }])).toBe(
      ' The surface of Bore could not be found again — its saved fit stands (No cylinder here.).',
    )
    expect(lostSurfaces([{ name: 'A', failed: 'x' }, { name: 'B', failed: 'y' }, { name: 'C', failed: 'z' }])).toBe(
      ' The surfaces of A, B and C could not be found again — their saved fits stand (x).',
    )
  })
})
