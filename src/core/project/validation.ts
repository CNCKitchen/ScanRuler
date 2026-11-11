// SPDX-License-Identifier: AGPL-3.0-only
// Runtime checks at the archive boundary. TypeScript types alone do not make
// JSON safe to hand to stores, geometry code or React renderers.
// The checks are exported for the plugins' parts, which a plugin checks
// itself when a project is opened (see app/projectSections.ts).

import { dimensionTypes } from '../dimensions'
import { CREATION_METHODS } from '../elements/construct'
import { FLAT_METHODS } from '../flat/construct'
import { FLAT_DIMENSION_TYPES } from '../flat/dimensions'
import { meshUnitsOf } from '../meshUnits'
import { SCALE_MAX, SCALE_MIN } from '../scanScale'
import type { FitMethodId } from '../types'

export type RecordValue = Record<string, unknown>
export function invalid(path: string): never { throw new Error(`Malformed project: ${path}.`) }

/** What a project saved by a newer build is refused with: by its
 *  schemaVersion (manifest.ts), or by a name in it this build has none for. */
export const NEWER_PROJECT = 'This project was saved by a newer version of ScanRuler — please reload the app to open it.'

/** A name this build does not know — an element kind, a way of making an
 *  element, a dimension type — comes from a newer build, not a damaged
 *  file: no name has ever been taken out of these lists (a test holds them
 *  to that), so every project an older build saved names only known ones.
 *  Refused whole, with the reload that brings the newer build, rather than
 *  opened with the element failing and everything built on it. */
function known(value: unknown, names: ReadonlySet<string>, what: string): void {
  if (typeof value !== 'string') invalid(what)
  if (!names.has(value)) throw new Error(`${NEWER_PROJECT} It has ${what} "${value}", which this version does not know.`)
}

/** Every name a project can hold that a newer build may add to: the open
 *  lists the checks above refuse an unknown entry of. */
export const PROJECT_NAMES = {
  elementKinds: new Set<string>(CREATION_METHODS.map((m) => m.kind)),
  /** A 3D element's way of being made, by kind: `fit` and `pick` are ways
   *  for more than one kind. */
  creationMethods: new Set<string>(CREATION_METHODS.map((m) => `${m.kind}:${m.id}`)),
  fitMethods: new Set<string>(['gaussian'] satisfies FitMethodId[]),
  dimensionTypes: new Set<string>(dimensionTypes().map((t) => t.id)),
  flatKinds: new Set<string>(FLAT_METHODS.map((m) => m.kind)),
  flatMethods: new Set<string>(FLAT_METHODS.map((m) => m.id)),
  flatDimensionTypes: new Set<string>(FLAT_DIMENSION_TYPES.map((t) => t.id)),
} as const
export function object(value: unknown, path: string): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(path)
  return value as RecordValue
}
export function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) invalid(path)
  return value
}
export function fields(value: RecordValue, names: string, type: 'number' | 'string' | 'boolean', path: string): void {
  for (const name of names.split(' ')) {
    if (typeof value[name] !== type || (type === 'number' && !Number.isFinite(value[name]))) invalid(`${path}.${name}`)
  }
}
export function indices(value: unknown, path: string): void {
  for (const index of array(value, path)) if (!Number.isSafeInteger(index) || (index as number) < 0) invalid(path)
}
export function vector(value: unknown, size: number, path: string): void {
  const values = array(value, path)
  if (values.length !== size || !values.every((v) => typeof v === 'number' && Number.isFinite(v))) invalid(path)
}
/** A fitted element's guide: each part optional, each as element.fit takes it. */
function fitGuide(value: unknown): void {
  const g = object(value, 'element.guide')
  if (g.side !== undefined && g.side !== 'inside' && g.side !== 'outside') invalid('element.guide.side')
  if (g.radius !== undefined) {
    const r = object(g.radius, 'element.guide.radius')
    for (const key of ['min', 'max'])
      if (r[key] !== undefined && !(typeof r[key] === 'number' && Number.isFinite(r[key]) && r[key] > 0)) invalid(`element.guide.radius.${key}`)
  }
  if (g.axis !== undefined) vector(g.axis, 3, 'element.guide.axis')
  if (g.within !== undefined) {
    const w = object(g.within, 'element.guide.within')
    vector(w.min, 3, 'element.guide.within.min')
    vector(w.max, 3, 'element.guide.within.max')
  }
}
export function entries(value: unknown, path: string, visit?: (entry: RecordValue) => void): void {
  const ids = new Set<number>()
  for (const item of array(value, path)) {
    const entry = object(item, path)
    if (!Number.isSafeInteger(entry.id) || (entry.id as number) < 0 || ids.has(entry.id as number)) invalid(`${path} IDs`)
    ids.add(entry.id as number)
    visit?.(entry)
  }
}
/** A number in [lo, hi]; an integer as well when `integer` says so. */
function inRange(value: unknown, lo: number, hi: number, path: string, integer = false): void {
  if (typeof value !== 'number' || !(value >= lo && value <= hi) || (integer && !Number.isInteger(value))) invalid(path)
}
function positive(value: RecordValue, names: string, path: string): void {
  for (const name of names.split(' ')) if (!((value[name] as number) > 0)) invalid(`${path}.${name}`)
}
function oneOf(value: unknown, allowed: readonly unknown[], path: string): void {
  if (!allowed.includes(value)) invalid(path)
}
/** Stepped colours, or null for a smooth scale. */
function bands(value: unknown, path: string): void {
  if (value !== null) inRange(value, 2, MAX_BANDS, path, true)
}
/** The bounds settings are held to when a project is read. Past what the
 *  panels and agent commands set, they still stop a crafted file from
 *  starting a measurement with a billion rays or a scale of zero width. */
const MAX_CONE_RAYS = 256
const MAX_BANDS = 256
/** What a member of the archive may be named — checked on open, and on
 *  save too (packProject), so a project that saves also opens. */
export function isMemberName(name: string): boolean {
  return /^[\w .-]+$/.test(name) && name !== 'project.json'
}

function file(value: unknown, path: string): void {
  if (value === null) return
  const entry = object(value, path)
  fields(entry, 'fileName member', 'string', path)
  if (!entry.fileName || !isMemberName(entry.member as string)) invalid(`${path}.member`)
  if (entry.units !== undefined && !meshUnitsOf(entry.units)) invalid(`${path}.units`)
}
function rigid(value: unknown, path: string): void {
  if (value === null) return
  const transform = object(value, path)
  for (const [key, size] of [['r', 9], ['t', 3]] as const) {
    const values = array(transform[key], path)
    if (values.length !== size || !values.every((v) => typeof v === 'number' && Number.isFinite(v))) invalid(path)
  }
}
/** A sheet's alignment: two picks in image pixels, or none. An empty
 *  object passed for one and crashed datumFrame as the sheet was drawn. */
function datum(value: unknown, path: string): void {
  if (value === undefined || value === null) return
  const d = object(value, path)
  vector(d.originPx, 2, `${path}.originPx`)
  vector(d.xRefPx, 2, `${path}.xRefPx`)
}
function sheet(value: unknown, path: string): void {
  const s = object(value, path)
  datum(s.datum, `${path}.datum`)
  if (s.mirror !== undefined && typeof s.mirror !== 'boolean') invalid(`${path}.mirror`)
  fields(s, 'nextId nextDimId nextCountId', 'number', path)
  fields(s, 'calSource', 'string', path)
  object(s.nameCounts, `${path}.nameCounts`)
  object(s.dimCounts, `${path}.dimCounts`)
  entries(s.elements, `${path}.elements`, (e) => {
    fields(e, 'kind name color', 'string', path)
    fields(e, 'visible', 'boolean', path)
    known(e.kind, PROJECT_NAMES.flatKinds, '2D element kind')
    // A failed construction is saved with a null fit and its source intact.
    if (e.fit !== null) {
      const fit = object(e.fit, `${path}.fit`)
      if (fit.kind !== e.kind) invalid(`${path}.fit.kind`)
      fields(fit, 'sigma usedPoints', 'number', `${path}.fit`)
      if (fit.kind === 'point') vector(fit.at, 2, `${path}.fit.at`)
      else if (fit.kind === 'spline') {
        for (const key of ['points', 'tangents']) for (const p of array(fit[key], `${path}.fit.${key}`)) vector(p, 2, `${path}.fit.${key}`)
      } else vector(fit.center, 2, `${path}.fit.center`)
    }
    const source = object(e.source, `${path}.source`)
    fields(source, 'method', 'string', `${path}.source`)
    known(source.method, PROJECT_NAMES.flatMethods, '2D element method')
    if (source.type === 'picks') for (const p of array(source.picks, `${path}.picks`)) vector(p, 2, `${path}.picks`)
    else if (source.type === 'construct') indices(source.refs, `${path}.refs`)
    else invalid(`${path}.source.type`)
  })
  entries(s.dimensions, `${path}.dimensions`, (e) => {
    fields(e, 'type name', 'string', path)
    known(e.type, PROJECT_NAMES.flatDimensionTypes, '2D dimension type')
    indices(e.refs, `${path}.refs`)
  })
  entries(s.counts, `${path}.counts`, (e) => {
    fields(e, 'name color', 'string', path)
    for (const p of array(e.picks, `${path}.counts.picks`)) vector(p, 2, `${path}.counts.picks`)
  })
  if (s.notes !== undefined) entries(s.notes, `${path}.notes`, (e) => { fields(e, 'text', 'string', path); vector(e.at, 2, `${path}.notes.at`) })
  if (s.pxPerMm !== null) {
    const scale = object(s.pxPerMm, `${path}.pxPerMm`)
    fields(scale, 'x y', 'number', path)
    if ((scale.x as number) <= 0 || (scale.y as number) <= 0) invalid(`${path}.pxPerMm`)
  }
}

export function validateProjectParts(raw: unknown): void {
  const m = object(raw, 'root')
  // Reject non-finite numbers even in optional/nested recipes. The depth cap
  // also prevents corrupt JSON from exhausting the stack during conversion.
  const inspect = (value: unknown, depth: number): void => {
    if (depth > 64) invalid('nesting depth')
    if (typeof value === 'number' && !Number.isFinite(value)) invalid('non-finite number')
    if (Array.isArray(value)) {
      for (const item of value) inspect(item, depth + 1)
    } else if (value && typeof value === 'object') {
      for (const key of Object.keys(value)) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') invalid('reserved property')
        inspect((value as RecordValue)[key], depth + 1)
      }
    }
  }
  inspect(m, 0)
  fields(m, 'appVersion workspace', 'string', 'root')
  if (m.name !== undefined) fields(m, 'name', 'string', 'root')
  if (m.scan !== null) {
    const s = object(m.scan, 'scan')
    file(s, 'scan')
    if (s.companions !== undefined) for (const c of array(s.companions, 'scan.companions')) file(c, 'scan.companions')
    fields(s, 'nextId nextNumber nextDimensionId', 'number', 'scan')
    fields(s, 'selectMode', 'string', 'scan')
    fields(s, 'showOverlays', 'boolean', 'scan')
    object(s.nextOfKind, 'scan.nextOfKind')
    object(s.nextOfDimGroup, 'scan.nextOfDimGroup')
    const settings = object(s.settings, 'scan.settings')
    fields(settings, 'method', 'string', 'scan.settings')
    known(settings.method, PROJECT_NAMES.fitMethods, 'fit method')
    fields(settings, 'sigma', 'number', 'scan.settings')
    rigid(s.appliedAlignment, 'scan.appliedAlignment')
    if (s.scale !== undefined && !(typeof s.scale === 'number' && s.scale >= SCALE_MIN && s.scale <= SCALE_MAX)) invalid('scan.scale')
    if (s.scaled !== undefined) {
      const scaled = object(s.scaled, 'scan.scaled')
      if (!(typeof scaled.factor === 'number' && scaled.factor > 0 && Number.isFinite(scaled.factor))) invalid('scan.scaled.factor')
      for (const r of array(scaled.references, 'scan.scaled.references')) {
        const ref = object(r, 'scan.scaled.references')
        fields(ref, 'label', 'string', 'scan.scaled.references')
        fields(ref, 'measured true', 'number', 'scan.scaled.references')
      }
    }
    entries(s.elements, 'scan.elements', (e) => {
      fields(e, 'kind name color status', 'string', 'element')
      fields(e, 'visible', 'boolean', 'element')
      const source = object(e.source, 'element.source')
      if (!['picked', 'fitted', 'constructed'].includes(source.type as string)) invalid('element.source.type')
      if (source.type === 'fitted') indices(source.seeds, 'element.seeds')
      if (source.type === 'constructed') { indices(source.refs, 'element.refs'); array(source.params, 'element.params') }
      if (source.selection !== undefined) indices(source.selection, 'element.selection')
      known(e.kind, PROJECT_NAMES.elementKinds, 'element kind')
      if (source.type === 'constructed') known(`${e.kind}:${source.method}`, PROJECT_NAMES.creationMethods, 'construction')
      if (source.type === 'fitted' && source.settings !== undefined) {
        known(object(source.settings, 'element.settings').method, PROJECT_NAMES.fitMethods, 'fit method')
      }
      if (source.type === 'fitted' && source.guide !== undefined) fitGuide(source.guide)
      if (e.fit !== undefined) {
        const fit = object(e.fit, 'element.fit')
        if (fit.kind !== e.kind) invalid('element.fit.kind')
        fields(fit, 'sigma usedPoints regionSize', 'number', 'element.fit')
        vector(fit.center, 3, 'element.fit.center')
        for (const key of ['axis', 'normal', 'dir', 'basisU', 'basisV']) if (fit[key] !== undefined) vector(fit[key], 3, `element.fit.${key}`)
      }
    })
    entries(s.dimensions, 'scan.dimensions', (e) => {
      fields(e, 'type name', 'string', 'dimension')
      known(e.type, PROJECT_NAMES.dimensionTypes, 'dimension type')
      indices(e.refs, 'dimension.refs')
    })
    if (s.sections !== undefined) entries(s.sections, 'scan.sections', (e) => object(e.frame, 'section.frame'))
  }
  const d = object(m.deviation, 'deviation')
  fields(d, 'localMaxDistance range maxDistance tolerance nextProbeId targetSide', 'number', 'deviation')
  fields(d, 'rangeAuto maxDistanceAuto showElement showHistogram showNominal showScan showMap split', 'boolean', 'deviation')
  if (!['reference', 'element'].includes(d.source as string) || !['all', 'marked'].includes(d.targetScope as string)) invalid('deviation source or scope')
  if (d.mapFacingDeg !== undefined && d.mapFacingDeg !== null && typeof d.mapFacingDeg !== 'number') invalid('deviation.mapFacingDeg')
  file(d.reference, 'deviation.reference')
  positive(d, 'range maxDistance tolerance', 'deviation')
  bands(d.bands, 'deviation.bands')
  oneOf(d.targetSide, [1, -1], 'deviation.targetSide')
  for (const pair of array(d.pairs, 'deviation.pairs')) {
    const p = object(pair, 'deviation.pairs')
    vector(p.scan, 3, 'deviation.pairs.scan')
    vector(p.nominal, 3, 'deviation.pairs.nominal')
  }
  entries(d.probes, 'deviation.probes')
  if (d.scope !== null) indices(d.scope, 'deviation.scope')
  for (const key of ['align', 'globalAlign']) if (d[key] !== null) rigid(object(d[key], `deviation.${key}`).transform, `deviation.${key}.transform`)
  const t = object(m.thickness, 'thickness')
  fields(t, 'maxThickness coneRays coneAngleDeg low high limit nextProbeId', 'number', 'thickness')
  fields(t, 'measured maxThicknessAuto scaleAuto showHistogram', 'boolean', 'thickness')
  fields(t, 'method', 'string', 'thickness')
  // A thickness map marked measured is measured again as the project opens,
  // with these settings, so they are held to what the measurement can run.
  oneOf(t.method, ['ray', 'sphere'], 'thickness.method')
  inRange(t.coneRays, 0, MAX_CONE_RAYS, 'thickness.coneRays', true)
  positive(t, 'maxThickness', 'thickness')
  inRange(t.coneAngleDeg, 0, 90, 'thickness.coneAngleDeg')
  if (t.normalDeviationDeg !== null) inRange(t.normalDeviationDeg, 0, 180, 'thickness.normalDeviationDeg')
  bands(t.bands, 'thickness.bands')
  entries(t.probes, 'thickness.probes')
  const f = object(m.flat, 'flat')
  file(f.image, 'flat.image')
  sheet(f, 'flat')
  fields(f, 'edgeSensitivity', 'number', 'flat')
  inRange(f.edgeSensitivity, 0, 1, 'flat.edgeSensitivity')
  if (f.turns !== undefined) inRange(f.turns, -1e6, 1e6, 'flat.turns', true)
  if (f.mirror !== undefined && typeof f.mirror !== 'boolean') invalid('flat.mirror')
  if (f.subject !== undefined) {
    const subject = object(f.subject, 'flat.subject')
    if (subject.kind === 'section') indices([subject.id], 'flat.subject.id')
    else if (subject.kind !== 'image') invalid('flat.subject.kind')
  }
  fields(f, 'splitAxes showEdges snapToEdge showGrid', 'boolean', 'flat')
  if (f.sheets !== undefined) for (const [key, value] of Object.entries(object(f.sheets, 'flat.sheets'))) sheet(value, `flat.sheets.${key}`)

}
