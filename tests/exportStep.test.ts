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

describe('STEP export as construction surfaces', () => {
  const text = buildStepFile(ALL, 'scan.stl', STAMP, 'surfaces')

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
    const quoted = buildStepFile([{ name: "it's", fit: point }], "o'scan.stl", STAMP, 'surfaces')
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
      'surfaces',
    )
    expect(wire).toContain('GEOMETRIC_CURVE_SET(')
    expect(wire).toContain('GEOMETRICALLY_BOUNDED_WIREFRAME_SHAPE_REPRESENTATION')
    expect(wire).not.toContain('GEOMETRICALLY_BOUNDED_SURFACE_SHAPE_REPRESENTATION')
  })
})

/** The instance table, so the topology can be walked rather than pattern
 *  matched: a B-rep is only correct as a graph. */
function parse(text: string): Map<number, string> {
  const entities = new Map<number, string>()
  for (const line of text.split('\n')) {
    const m = /^#(\d+)=(.*);$/.exec(line)
    if (m) entities.set(Number(m[1]), m[2])
  }
  return entities
}

const refs = (entity: string): number[] => [...entity.matchAll(/#(\d+)/g)].map((m) => Number(m[1]))

const idsOf = (entities: Map<number, string>, type: string): number[] =>
  [...entities].filter(([, e]) => e.startsWith(`${type}(`)).map(([id]) => id)

/** Every oriented use of an edge under one face, as "edge id, which way". */
function edgeUses(entities: Map<number, string>, faceId: number): { edge: number; fwd: boolean }[] {
  const face = entities.get(faceId)!
  const bounds = refs(face).slice(0, -1)
  const uses: { edge: number; fwd: boolean }[] = []
  for (const b of bounds) {
    const loop = entities.get(refs(entities.get(b)!)[0])!
    for (const o of refs(loop)) {
      const oriented = entities.get(o)!
      uses.push({ edge: refs(oriented)[0], fwd: oriented.endsWith('.T.)') })
    }
  }
  return uses
}

describe('STEP export as solids and faces', () => {
  const text = buildStepFile(ALL, 'scan.stl', STAMP, 'solids')
  const entities = parse(text)

  it('is what an export writes when no form is asked for', () => {
    expect(buildStepFile(ALL, 'scan.stl', STAMP)).toBe(text)
  })

  it('is a well-formed Part 21 file with every id defined exactly once', () => {
    expect(text.startsWith('ISO-10303-21;')).toBe(true)
    expect(text.trimEnd().endsWith('END-ISO-10303-21;')).toBe(true)
    const defined = new Set<string>()
    for (const m of text.matchAll(/^#(\d+)=/gm)) {
      expect(defined.has(m[1])).toBe(false)
      defined.add(m[1])
    }
    for (const m of text.matchAll(/#(\d+)/g)) expect(defined.has(m[1])).toBe(true)
  })

  it('gives the cylinder a wall and two lids in one closed shell', () => {
    const solid = [...entities].find(([, e]) => e.startsWith("MANIFOLD_SOLID_BREP('Cylinder 1'"))
    expect(solid).toBeTruthy()
    const shell = entities.get(refs(solid![1])[0])!
    expect(shell.startsWith('CLOSED_SHELL(')).toBe(true)
    const faces = refs(shell)
    expect(faces).toHaveLength(3)
    const surfaces = faces.map((f) => entities.get(refs(entities.get(f)!).at(-1)!)!)
    expect(surfaces.filter((s) => s.startsWith('CYLINDRICAL_SURFACE('))).toHaveLength(1)
    expect(surfaces.filter((s) => s.startsWith('PLANE('))).toHaveLength(2)
    expect(surfaces.find((s) => s.startsWith('CYLINDRICAL_SURFACE('))).toContain(',4.)')
  })

  it('gives the sphere two hemispheres on one spherical surface', () => {
    const solid = [...entities].find(([, e]) => e.startsWith("MANIFOLD_SOLID_BREP('Sphere 1'"))
    expect(solid).toBeTruthy()
    const faces = refs(entities.get(refs(solid![1])[0])!)
    expect(faces).toHaveLength(2)
    const surfaces = faces.map((f) => refs(entities.get(f)!).at(-1)!)
    expect(new Set(surfaces).size).toBe(1)
    expect(entities.get(surfaces[0])!).toContain('SPHERICAL_SURFACE(')
    expect(entities.get(surfaces[0])!).toContain(',12.5)')
  })

  it('closes every shell: each edge used twice, once each way', () => {
    const shells = idsOf(entities, 'CLOSED_SHELL')
    expect(shells).toHaveLength(2)
    for (const shell of shells) {
      const uses = refs(entities.get(shell)!).flatMap((f) => edgeUses(entities, f))
      const byEdge = new Map<number, boolean[]>()
      for (const u of uses) byEdge.set(u.edge, [...(byEdge.get(u.edge) ?? []), u.fwd])
      expect(byEdge.size).toBeGreaterThan(0)
      for (const senses of byEdge.values()) {
        expect(senses).toHaveLength(2)
        expect(senses[0]).not.toBe(senses[1])
      }
    }
  })

  it('gives the plane a four-edged face on an open shell', () => {
    const model = [...entities].find(([, e]) => e.startsWith("SHELL_BASED_SURFACE_MODEL('Plane 1'"))
    expect(model).toBeTruthy()
    const shell = entities.get(refs(model![1])[0])!
    expect(shell.startsWith('OPEN_SHELL(')).toBe(true)
    const faceId = refs(shell)[0]
    expect(entities.get(faceId)!).toContain("ADVANCED_FACE('Plane 1'")
    expect(entities.get(refs(entities.get(faceId)!).at(-1)!)!.startsWith('PLANE(')).toBe(true)
    const uses = edgeUses(entities, faceId)
    expect(uses).toHaveLength(4)
    expect(uses.every((u) => u.fwd)).toBe(true)
  })

  it('puts the corners of the plane at its measured extents', () => {
    // The patch is 14 × 6 about (5,5,0) in the XY plane.
    const corners = [...entities.values()]
      .filter((e) => e.startsWith("CARTESIAN_POINT('',"))
      .map((e) => e.match(/\(([-\d.,E]+)\)\)$/)?.[1])
      .filter((s): s is string => s !== undefined)
    for (const c of ['-2.,2.,0.', '12.,2.,0.', '12.,8.,0.', '-2.,8.,0.']) {
      expect(corners).toContain(c)
    }
  })

  it('gives every element its own named representation off one root', () => {
    const root = idsOf(entities, 'SHAPE_REPRESENTATION')
    expect(root).toHaveLength(1)
    const links = idsOf(entities, 'SHAPE_REPRESENTATION_RELATIONSHIP')
    // Three bodies and one wireframe set for the point and the line.
    expect(links).toHaveLength(4)
    for (const l of links) expect(refs(entities.get(l)!)[0]).toBe(root[0])
    expect(text).toContain("ADVANCED_BREP_SHAPE_REPRESENTATION('Cylinder 1'")
    expect(text).toContain("ADVANCED_BREP_SHAPE_REPRESENTATION('Sphere 1'")
    expect(text).toContain("MANIFOLD_SURFACE_SHAPE_REPRESENTATION('Plane 1'")
    expect(text).toContain('GEOMETRICALLY_BOUNDED_WIREFRAME_SHAPE_REPRESENTATION')
    expect(text).toContain("TRIMMED_CURVE('Line 1'")
    expect(text).toContain("CARTESIAN_POINT('Point 1',(-1.5,0.,2.))")
    expect(text).toContain('SI_UNIT(.MILLI.,.METRE.)')
  })

  it('writes no bodies for a file of points and lines alone', () => {
    const wire = buildStepFile(
      [
        { name: 'Point 1', fit: point },
        { name: 'Line 1', fit: line },
      ],
      'scan.stl',
      STAMP,
      'solids',
    )
    expect(wire).not.toContain('MANIFOLD_SOLID_BREP')
    expect(wire).toContain('GEOMETRICALLY_BOUNDED_WIREFRAME_SHAPE_REPRESENTATION')
  })
})
