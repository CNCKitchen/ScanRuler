// SPDX-License-Identifier: AGPL-3.0-only
// Which builds open which projects. A project is saved as PROJECT_SCHEMA, and
// a build refuses a higher one. Past that, a project from a newer build is
// told by its names: an element kind, a way of making one or a dimension
// type this build does not know is refused with the reload that brings the
// newer build, instead of the project opening with that element failed and
// everything built on it. That only holds while no name is ever taken out —
// a project saved earlier would then be refused as newer — so the names a
// schema 2 project can hold are pinned here.
import { beforeEach, describe, expect, it } from 'vitest'
import { PROJECT_SCHEMA, validateManifest } from '../src/core/project/manifest'
import { NEWER_PROJECT, PROJECT_NAMES } from '../src/core/project/validation'
import { collectProject } from '../src/app/project'
import { useStore } from '../src/state/store'
import { useFlat } from '../src/state/flatStore'
import { useDeviation } from '../src/state/deviationStore'
import { useThickness } from '../src/state/thicknessStore'
import { fresh, sources } from './projectKit'

/** Every name a schema 2 project can hold. Add to these freely; taking one
 *  out strands every project that uses it — map such a name to its new one
 *  on load instead. */
const SCHEMA_2_NAMES: Record<keyof typeof PROJECT_NAMES, string[]> = {
  elementKinds: ['circle', 'cone', 'cylinder', 'line', 'plane', 'point', 'sphere', 'torus'],
  creationMethods: [
    'circle:circle-coords', 'circle:circle-plane-cylinder', 'circle:circle-plane-sphere', 'circle:circle-points',
    'cone:fit', 'cylinder:fit', 'plane:fit', 'sphere:fit', 'torus:fit',
    'line:line-axis', 'line:line-coords', 'line:line-plane-plane', 'line:line-plane-point', 'line:line-project', 'line:line-two-points',
    'plane:plane-angle', 'plane:plane-coords', 'plane:plane-line-plane', 'plane:plane-line-point', 'plane:plane-midplane',
    'plane:plane-offset', 'plane:plane-offset-point', 'plane:plane-symmetry', 'plane:plane-tangent-cylinder',
    'plane:plane-tangent-sphere', 'plane:plane-three-points', 'plane:plane-two-lines',
    'point:pick', 'point:point-center', 'point:point-centroid', 'point:point-coords', 'point:point-line-line',
    'point:point-line-plane', 'point:point-midpoint', 'point:point-project', 'point:point-three-planes',
  ],
  fitMethods: ['gaussian'],
  dimensionTypes: [
    'angle-axis-axis', 'angle-axis-plane', 'angle-plane-plane',
    'dist-axis-axis', 'dist-axis-plane', 'dist-plane-plane', 'dist-point-axis', 'dist-point-plane', 'dist-point-point',
    'form-circularity', 'form-cylindricity', 'form-flatness', 'form-sphericity',
    'loc-coaxiality', 'orient-angularity', 'orient-parallelism', 'orient-perpendicularity', 'size-diameter',
  ],
  flatKinds: ['arc', 'circle', 'line', 'point', 'spline'],
  flatMethods: [
    'flat-arc-edge', 'flat-arc-pick', 'flat-circle-centers', 'flat-circle-edge', 'flat-circle-pick', 'flat-circle-seed',
    'flat-line-edge', 'flat-line-pick', 'flat-line-seed', 'flat-point-center', 'flat-point-intersect',
    'flat-point-midpoint', 'flat-point-pick', 'flat-spline-pick',
  ],
  flatDimensionTypes: ['flat-angle-line-line', 'flat-dist-line-line', 'flat-dist-point-line', 'flat-dist-point-point'],
}

/** A project as this build saves it, with a scan loaded: a JSON copy to edit. */
function project(): any {
  fresh()
  const manifest = JSON.parse(JSON.stringify(collectProject(sources(), null, 'test').manifest))
  expect(manifest.scan).not.toBeNull()
  return manifest
}

const constructed = (kind: string, method: string) => ({
  id: 1,
  kind,
  name: `${kind} 1`,
  color: '#123456',
  status: 'done',
  visible: true,
  source: { type: 'constructed', method, refs: [], params: [0, 0, 0] },
})

const flatElement = (kind: string, method: string) => ({
  id: 1,
  kind,
  name: `${kind} 1`,
  color: '#123456',
  visible: true,
  source: { type: 'picks', method, picks: [[1, 2]] },
  fit: null,
})

describe('project schema', () => {
  beforeEach(() => {
    useStore.setState(useStore.getInitialState(), true)
    useFlat.setState(useFlat.getInitialState(), true)
    useDeviation.setState(useDeviation.getInitialState(), true)
    useThickness.setState(useThickness.getInitialState(), true)
  })

  it('saves as schema 2 and opens schema 1 and 2', () => {
    const manifest = project()
    expect(PROJECT_SCHEMA).toBe(2)
    expect(manifest.schemaVersion).toBe(2)
    expect(() => validateManifest(manifest)).not.toThrow()
    expect(() => validateManifest({ ...manifest, schemaVersion: 1 })).not.toThrow()
    expect(() => validateManifest({ ...manifest, schemaVersion: 3 })).toThrow(NEWER_PROJECT)
  })

  it('still knows every name a schema 2 project can hold', () => {
    for (const [list, names] of Object.entries(SCHEMA_2_NAMES)) {
      const known = PROJECT_NAMES[list as keyof typeof PROJECT_NAMES]
      for (const name of names) expect(known.has(name), `${list}: ${name}`).toBe(true)
    }
  })

  it('opens a project made with every construction and dimension it knows', () => {
    const manifest = project()
    manifest.scan.elements = SCHEMA_2_NAMES.creationMethods
      .filter((m) => !m.endsWith(':fit') && !m.endsWith(':pick'))
      .map((m, i) => ({ ...constructed(...(m.split(':') as [string, string])), id: i + 1 }))
    manifest.scan.dimensions = SCHEMA_2_NAMES.dimensionTypes.map((type, i) => ({ id: i + 1, type, name: `D${i + 1}`, refs: [1] }))
    expect(() => validateManifest(manifest)).not.toThrow()
  })

  it.each([
    ['an element kind', (m: any) => void (m.scan.elements = [constructed('ellipsoid', 'point-coords')]), 'element kind "ellipsoid"'],
    ['a construction', (m: any) => void (m.scan.elements = [constructed('plane', 'plane-bisector')]), 'construction "plane:plane-bisector"'],
    ['a construction of another kind', (m: any) => void (m.scan.elements = [constructed('line', 'point-coords')]), 'construction "line:point-coords"'],
    ['a dimension type', (m: any) => void (m.scan.dimensions = [{ id: 1, type: 'form-straightness', name: 'S1', refs: [1] }]), 'dimension type "form-straightness"'],
    ['a fit method', (m: any) => void (m.scan.settings.method = 'chebyshev'), 'fit method "chebyshev"'],
    ['a 2D element kind', (m: any) => void (m.flat.elements = [flatElement('ellipse', 'flat-point-pick')]), '2D element kind "ellipse"'],
    ['a 2D method', (m: any) => void (m.flat.elements = [flatElement('point', 'flat-point-tangent')]), '2D element method "flat-point-tangent"'],
    ['a 2D dimension type', (m: any) => void (m.flat.dimensions = [{ id: 1, type: 'flat-radius', name: 'R1', refs: [1], visible: true }]), '2D dimension type "flat-radius"'],
  ])('refuses %s it does not know as from a newer build', (_what, change, named) => {
    const manifest = project()
    change(manifest)
    expect(() => validateManifest(manifest)).toThrow(NEWER_PROJECT)
    expect(() => validateManifest(manifest)).toThrow(named)
  })

  it('still calls a name of the wrong type malformed', () => {
    const manifest = project()
    manifest.scan.dimensions = [{ id: 1, type: 7, name: 'D1', refs: [1] }]
    expect(() => validateManifest(manifest)).toThrow('Malformed project')
  })
})
