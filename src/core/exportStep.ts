// SPDX-License-Identifier: AGPL-3.0-only
// STEP (ISO 10303-21, AP214) export of the measured elements as analytic
// geometry: planes as trimmed planar patches, cylinders and spheres as trimmed
// surfaces of revolution, lines as trimmed lines, points as points. The
// geometry goes into one GEOMETRIC_SET — construction geometry, the way
// metrology packages hand measured datums to CAD — so no B-rep topology is
// needed and every consumer that reads AP214 sees exact analytic surfaces,
// not tessellations. All coordinates are millimetres, angles radians.

import type { FitData, Vec3 } from './types'
import { orthoBasis } from './fit/linalg'
import { addScaled } from './vec'

export interface StepElement {
  name: string
  fit: FitData
}

const TWO_PI = 2 * Math.PI
const HALF_PI = Math.PI / 2

/** A STEP real: always carries a decimal point, exponent uppercased. */
function num(v: number): string {
  if (!Number.isFinite(v) || Object.is(v, -0)) v = 0
  let s = v.toPrecision(12)
  if (s.includes('e') || s.includes('E')) {
    const [mantRaw, expRaw] = s.toLowerCase().split('e')
    let mant = trimZeros(mantRaw)
    if (!mant.includes('.')) mant += '.'
    return `${mant}E${expRaw}`
  }
  s = trimZeros(s)
  if (!s.includes('.')) s += '.'
  return s
}

function trimZeros(s: string): string {
  if (!s.includes('.')) return s
  return s.replace(/0+$/, '')
}

function vec(v: Vec3): string {
  return `${num(v[0])},${num(v[1])},${num(v[2])}`
}

/** STEP string literal payload: quotes doubled, non-ASCII replaced — element
 *  names are plain ASCII, this only guards pasted file names. */
function esc(s: string): string {
  return s
    .replace(/'/g, "''")
    .replace(/\\/g, '\\\\')
    // eslint-disable-next-line no-control-regex
    .replace(/[^\x20-\x7e]/g, '?')
}

class StepWriter {
  lines: string[] = []
  private id = 0

  add(entity: string): number {
    const id = ++this.id
    this.lines.push(`#${id}=${entity};`)
    return id
  }
}

/** Location + z axis + x reference direction. */
function placement(w: StepWriter, origin: Vec3, z: Vec3, x: Vec3): number {
  const o = w.add(`CARTESIAN_POINT('',(${vec(origin)}))`)
  const az = w.add(`DIRECTION('',(${vec(z)}))`)
  const ax = w.add(`DIRECTION('',(${vec(x)}))`)
  return w.add(`AXIS2_PLACEMENT_3D('',#${o},#${az},#${ax})`)
}

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

/**
 * The complete STEP file for the given elements.
 *
 * `sourceName` is the scan the elements were measured on (recorded in the
 * product name), `timestamp` an ISO date-time for the header.
 */
export function buildStepFile(
  elements: StepElement[],
  sourceName: string,
  timestamp: string,
): string {
  const w = new StepWriter()

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
