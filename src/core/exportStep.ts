// SPDX-License-Identifier: AGPL-3.0-only
// STEP (ISO 10303-21, AP214) export of the measured elements as analytic
// geometry, in either of two forms.
//
// *Solids and faces* is what CAD wants: a plane comes over as a bounded planar
// face with real edges, a cylinder and a sphere as closed solid bodies with
// lids. Faces can be sketched on, offset and referenced; bodies can be cut
// with and put in an assembly. Each element is a shape representation of its
// own, carrying its name, tied to the part's shape the way the bodies of a
// multi-body file are — see core/stepBrep for the topology itself.
//
// *Construction surfaces* is the older form and still the honest one for
// handing over datums: every element is a trimmed analytic surface or curve in
// a single GEOMETRIC_SET, the way metrology packages pass measured geometry
// along. No topology, nothing to reject, and unmistakably reference geometry
// rather than a part.
//
// All coordinates are millimetres, angles radians.

import type { FitData, Vec3 } from './types'
import { orthoBasis } from './fit/linalg'
import { addScaled } from './vec'
import { esc, num, placement, StepWriter, vec } from './stepWriter'
import { writeCylinderSolid, writePlaneShell, writeSphereSolid } from './stepBrep'

export interface StepElement {
  name: string
  fit: FitData
}

/** Which of the two forms above the file is written in. */
export type StepStyle = 'solids' | 'surfaces'

const TWO_PI = 2 * Math.PI
const HALF_PI = Math.PI / 2

/** The geometric-set item for one element, returning its entity id. */
function writeElement(w: StepWriter, name: string, fit: FitData): number {
  const label = esc(name)
  switch (fit.kind) {
    case 'point':
      return w.add(`CARTESIAN_POINT('${label}',(${vec(fit.center)}))`)

    case 'line': {
      const p = w.add(`CARTESIAN_POINT('',(${vec(fit.center)}))`)
      const d = w.add(`DIRECTION('',(${vec(fit.dir)}))`)
      const v = w.add(`VECTOR('',#${d},1.)`)
      const line = w.add(`LINE('',#${p},#${v})`)
      const h = Math.max(fit.length / 2, 1e-6)
      return w.add(
        `TRIMMED_CURVE('${label}',#${line},(PARAMETER_VALUE(${num(-h)})),(PARAMETER_VALUE(${num(h)})),.T.,.PARAMETER.)`,
      )
    }

    case 'plane': {
      const pl = placement(w, fit.center, fit.normal, fit.basisU)
      const surf = w.add(`PLANE('',#${pl})`)
      const eu = Math.max(fit.extentU, 1e-6)
      const ev = Math.max(fit.extentV, 1e-6)
      return w.add(
        `RECTANGULAR_TRIMMED_SURFACE('${label}',#${surf},${num(-eu)},${num(eu)},${num(-ev)},${num(ev)},.T.,.T.)`,
      )
    }

    case 'cylinder': {
      const length = Math.max(fit.length, 1e-6)
      const bottom = addScaled(fit.center, fit.axis, -length / 2)
      const pl = placement(w, bottom, fit.axis, orthoBasis(fit.axis)[0])
      const surf = w.add(`CYLINDRICAL_SURFACE('',#${pl},${num(Math.max(fit.radius, 1e-6))})`)
      return w.add(
        `RECTANGULAR_TRIMMED_SURFACE('${label}',#${surf},0.,${num(TWO_PI)},0.,${num(length)},.T.,.T.)`,
      )
    }

    case 'sphere': {
      const pl = placement(w, fit.center, [0, 0, 1], [1, 0, 0])
      const surf = w.add(`SPHERICAL_SURFACE('',#${pl},${num(Math.max(fit.radius, 1e-6))})`)
      return w.add(
        `RECTANGULAR_TRIMMED_SURFACE('${label}',#${surf},0.,${num(TWO_PI)},${num(-HALF_PI)},${num(HALF_PI)},.T.,.T.)`,
      )
    }
  }
}

/** Everything that is the same in both forms: the product, its definition and
 *  the unit-carrying geometric context every coordinate is read in. */
function writeContext(w: StepWriter, sourceName: string): { shape: number; geomCtx: number } {
  const appCtx = w.add(`APPLICATION_CONTEXT('automotive design')`)
  w.add(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2010,#${appCtx})`)
  const prodCtx = w.add(`PRODUCT_CONTEXT('',#${appCtx},'mechanical')`)
  const product = w.add(
    `PRODUCT('Measured elements','Measured elements — ${esc(sourceName)}','',(#${prodCtx}))`,
  )
  w.add(`PRODUCT_RELATED_PRODUCT_CATEGORY('part','',(#${product}))`)
  const formation = w.add(`PRODUCT_DEFINITION_FORMATION('','',#${product})`)
  const defCtx = w.add(`PRODUCT_DEFINITION_CONTEXT('part definition',#${appCtx},'design')`)
  const definition = w.add(`PRODUCT_DEFINITION('design','',#${formation},#${defCtx})`)
  const shape = w.add(`PRODUCT_DEFINITION_SHAPE('','',#${definition})`)

  const lengthUnit = w.add(`(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))`)
  const angleUnit = w.add(`(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))`)
  const solidUnit = w.add(`(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT())`)
  const uncertainty = w.add(
    `UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-3),#${lengthUnit},'distance_accuracy_value','')`,
  )
  const geomCtx = w.add(
    `(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#${uncertainty}))GLOBAL_UNIT_ASSIGNED_CONTEXT((#${lengthUnit},#${angleUnit},#${solidUnit}))REPRESENTATION_CONTEXT('','3D'))`,
  )
  return { shape, geomCtx }
}

/** Trimmed surfaces and curves, all in one geometric set. */
function writeSurfaceBody(w: StepWriter, elements: StepElement[], shape: number, geomCtx: number): void {
  const items = elements.map((el) => writeElement(w, el.name, el.fit))
  const hasSurface = elements.some((el) => ['plane', 'cylinder', 'sphere'].includes(el.fit.kind))
  const set = w.add(
    `${hasSurface ? 'GEOMETRIC_SET' : 'GEOMETRIC_CURVE_SET'}('elements',(${items.map((i) => `#${i}`).join(',')}))`,
  )
  const rep = w.add(
    `${
      hasSurface
        ? 'GEOMETRICALLY_BOUNDED_SURFACE_SHAPE_REPRESENTATION'
        : 'GEOMETRICALLY_BOUNDED_WIREFRAME_SHAPE_REPRESENTATION'
    }('elements',(#${set}),#${geomCtx})`,
  )
  w.add(`SHAPE_DEFINITION_REPRESENTATION(#${shape},#${rep})`)
}

/**
 * Solid bodies, sheet faces and — for the points and lines, which are neither
 * — one wireframe set.
 *
 * Each goes in a representation of its own, because the three kinds may not
 * share one: a representation of solids is an ADVANCED_BREP_SHAPE_
 * REPRESENTATION and nothing else may be in it. They hang off a plain root
 * representation through SHAPE_REPRESENTATION_RELATIONSHIP, which is how a
 * multi-body part is assembled in any file a CAD system writes, and it puts
 * each element in the tree under its own name.
 */
function writeSolidBody(w: StepWriter, elements: StepElement[], shape: number, geomCtx: number): void {
  const origin = placement(w, [0, 0, 0] as Vec3, [0, 0, 1] as Vec3, [1, 0, 0] as Vec3)
  const root = w.add(`SHAPE_REPRESENTATION('elements',(#${origin}),#${geomCtx})`)
  w.add(`SHAPE_DEFINITION_REPRESENTATION(#${shape},#${root})`)

  const relate = (rep: number) => w.add(`SHAPE_REPRESENTATION_RELATIONSHIP('','',#${root},#${rep})`)
  const curves: number[] = []

  for (const el of elements) {
    const label = esc(el.name)
    switch (el.fit.kind) {
      case 'plane':
        relate(
          w.add(
            `MANIFOLD_SURFACE_SHAPE_REPRESENTATION('${label}',(#${writePlaneShell(w, el.name, el.fit)}),#${geomCtx})`,
          ),
        )
        break
      case 'cylinder':
        relate(
          w.add(
            `ADVANCED_BREP_SHAPE_REPRESENTATION('${label}',(#${writeCylinderSolid(w, el.name, el.fit)}),#${geomCtx})`,
          ),
        )
        break
      case 'sphere':
        relate(
          w.add(
            `ADVANCED_BREP_SHAPE_REPRESENTATION('${label}',(#${writeSphereSolid(w, el.name, el.fit)}),#${geomCtx})`,
          ),
        )
        break
      default:
        // A point is a point and a line is a line in either form — there is no
        // body to make of them.
        curves.push(writeElement(w, el.name, el.fit))
    }
  }

  if (curves.length === 0) return
  const set = w.add(`GEOMETRIC_CURVE_SET('elements',(${curves.map((i) => `#${i}`).join(',')}))`)
  relate(
    w.add(`GEOMETRICALLY_BOUNDED_WIREFRAME_SHAPE_REPRESENTATION('elements',(#${set}),#${geomCtx})`),
  )
}

/**
 * The complete STEP file for the given elements.
 *
 * `sourceName` is the scan the elements were measured on (recorded in the
 * product name), `timestamp` an ISO date-time for the header, `style` which of
 * the two forms above to write.
 */
export function buildStepFile(
  elements: StepElement[],
  sourceName: string,
  timestamp: string,
  style: StepStyle = 'solids',
): string {
  const w = new StepWriter()
  const { shape, geomCtx } = writeContext(w, sourceName)
  if (style === 'solids') writeSolidBody(w, elements, shape, geomCtx)
  else writeSurfaceBody(w, elements, shape, geomCtx)

  return [
    'ISO-10303-21;',
    'HEADER;',
    `FILE_DESCRIPTION(('Measured elements exported from ScanRuler'),'2;1');`,
    `FILE_NAME('${esc(sourceName)}','${esc(timestamp)}',(''),(''),'ScanRuler','ScanRuler','');`,
    `FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));`,
    'ENDSEC;',
    'DATA;',
    ...w.lines,
    'ENDSEC;',
    'END-ISO-10303-21;',
    '',
  ].join('\n')
}
