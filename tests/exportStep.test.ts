// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { buildStepFile, type StepElement } from '../src/core/exportStep'
import type { CylinderFit, LineFit, PlaneFit, PointFit, SphereFit } from '../src/core/types'

const NO_STATS = { sigma: 0, usedPoints: 0, regionSize: 0 }

const sphere: SphereFit = { kind: 'sphere', center: [1, 2, 3], radius: 12.5, ...NO_STATS }
const cylinder: CylinderFit = {
  kind: 'cylinder',
  center: [0, 0, 10],
  axis: [0, 0, 1],
  radius: 4,
  length: 20,
  coverage: 360,
  ...NO_STATS,
}
const plane: PlaneFit = {
  kind: 'plane',
  center: [5, 5, 0],
  normal: [0, 0, 1],
  basisU: [1, 0, 0],
  basisV: [0, 1, 0],
  extentU: 7,
  extentV: 3,
  ...NO_STATS,
}
const line: LineFit = { kind: 'line', center: [0, 0, 0], dir: [1, 0, 0], length: 30, ...NO_STATS }
const point: PointFit = { kind: 'point', center: [-1.5, 0, 2], ...NO_STATS }

const ALL: StepElement[] = [
  { name: 'Sphere 1', fit: sphere },
  { name: 'Cylinder 1', fit: cylinder },
  { name: 'Plane 1', fit: plane },
  { name: 'Line 1', fit: line },
  { name: 'Point 1', fit: point },
]

const STAMP = '2026-08-15T12:00:00'

describe('STEP export', () => {
  const text = buildStepFile(ALL, 'scan.stl', STAMP)

  it('is a well-formed Part 21 file', () => {
    expect(text.startsWith('ISO-10303-21;')).toBe(true)
    expect(text.trimEnd().endsWith('END-ISO-10303-21;')).toBe(true)
    expect(text).toContain('HEADER;')
    expect(text).toContain('DATA;')
    expect((text.match(/ENDSEC;/g) ?? []).length).toBe(2)
    expect(text).toContain("FILE_SCHEMA(('AUTOMOTIVE_DESIGN")
  })

  it('every referenced entity id is defined exactly once', () => {
    const defined = new Set<string>()
    for (const m of text.matchAll(/^#(\d+)=/gm)) {
      expect(defined.has(m[1])).toBe(false)
      defined.add(m[1])
    }
    expect(defined.size).toBeGreaterThan(20)
    for (const m of text.matchAll(/#(\d+)/g)) {
      expect(defined.has(m[1])).toBe(true)
    }
  })

  it('writes each element as its analytic geometry, named', () => {
    expect(text).toContain("SPHERICAL_SURFACE('',")
    expect(text).toMatch(/RECTANGULAR_TRIMMED_SURFACE\('Sphere 1'/)
    expect(text).toContain("CYLINDRICAL_SURFACE('',")
    expect(text).toMatch(/RECTANGULAR_TRIMMED_SURFACE\('Cylinder 1'/)
    expect(text).toMatch(/PLANE\('',#\d+\)/)
    expect(text).toMatch(/RECTANGULAR_TRIMMED_SURFACE\('Plane 1',#\d+,-7\.,7\.,-3\.,3\./)
    expect(text).toMatch(/TRIMMED_CURVE\('Line 1'/)
    expect(text).toContain("CARTESIAN_POINT('Point 1',(-1.5,0.,2.))")
  })

  it('declares millimetre units and a mixed geometric set', () => {
    expect(text).toContain('SI_UNIT(.MILLI.,.METRE.)')
    expect(text).toContain('GEOMETRIC_SET(')
    expect(text).toContain('GEOMETRICALLY_BOUNDED_SURFACE_SHAPE_REPRESENTATION')
    expect(text).toContain('SHAPE_DEFINITION_REPRESENTATION')
  })

  it('trims the cylinder over its full turn and measured length', () => {
    const m = text.match(/RECTANGULAR_TRIMMED_SURFACE\('Cylinder 1',#\d+,0\.,([\d.]+),0\.,20\./)
    expect(m).toBeTruthy()
    expect(Number(m![1])).toBeCloseTo(2 * Math.PI, 9)
  })

  it('escapes quotes in names', () => {
    const quoted = buildStepFile([{ name: "it's", fit: point }], "o'scan.stl", STAMP)
    expect(quoted).toContain("CARTESIAN_POINT('it''s'")
    expect(quoted).toContain("o''scan.stl")
  })

  it('falls back to a wireframe representation without surfaces', () => {
    const wire = buildStepFile(
      [
        { name: 'Point 1', fit: point },
        { name: 'Line 1', fit: line },
      ],
      'scan.stl',
      STAMP,
    )
    expect(wire).toContain('GEOMETRIC_CURVE_SET(')
    expect(wire).toContain('GEOMETRICALLY_BOUNDED_WIREFRAME_SHAPE_REPRESENTATION')
    expect(wire).not.toContain('GEOMETRICALLY_BOUNDED_SURFACE_SHAPE_REPRESENTATION')
  })
})
