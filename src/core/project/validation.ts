// SPDX-License-Identifier: AGPL-3.0-only
import { meshUnitsOf } from '../meshUnits'
// Runtime checks at the archive boundary. TypeScript types alone do not make
// JSON safe to hand to stores, geometry code or React renderers.
// The checks are exported for the plugins' parts, which a plugin checks
// itself when a project is opened (see app/projectSections.ts).
export type RecordValue = Record<string, unknown>
export function invalid(path: string): never { throw new Error(`Malformed project: ${path}.`) }
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
export function entries(value: unknown, path: string, visit?: (entry: RecordValue) => void): void {
  const ids = new Set<number>()
  for (const item of array(value, path)) {
    const entry = object(item, path)
    if (!Number.isSafeInteger(entry.id) || (entry.id as number) < 0 || ids.has(entry.id as number)) invalid(`${path} IDs`)
    ids.add(entry.id as number)
    visit?.(entry)
  }
}
function file(value: unknown, path: string): void {
  if (value === null) return
  const entry = object(value, path)
  fields(entry, 'fileName member', 'string', path)
  if (!entry.fileName || !/^[\w .-]+$/.test(entry.member as string) || entry.member === 'project.json') invalid(`${path}.member`)
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
function sheet(value: unknown, path: string): void {
  const s = object(value, path)
  fields(s, 'nextId nextDimId nextCountId', 'number', path)
  fields(s, 'calSource', 'string', path)
  object(s.nameCounts, `${path}.nameCounts`)
  object(s.dimCounts, `${path}.dimCounts`)
  entries(s.elements, `${path}.elements`, (e) => {
    fields(e, 'kind name color', 'string', path)
    fields(e, 'visible', 'boolean', path)
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
    if (source.type === 'picks') for (const p of array(source.picks, `${path}.picks`)) vector(p, 2, `${path}.picks`)
    else if (source.type === 'construct') indices(source.refs, `${path}.refs`)
    else invalid(`${path}.source.type`)
  })
  entries(s.dimensions, `${path}.dimensions`, (e) => { fields(e, 'type name', 'string', path); indices(e.refs, `${path}.refs`) })
  entries(s.counts, `${path}.counts`, (e) => { fields(e, 'name color', 'string', path); array(e.picks, `${path}.picks`) })
  if (s.notes !== undefined) entries(s.notes, `${path}.notes`, (e) => { fields(e, 'text', 'string', path); array(e.at, `${path}.at`) })
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
  if (m.scan !== null) {
    const s = object(m.scan, 'scan')
    file(s, 'scan')
    fields(s, 'nextId nextNumber nextDimensionId', 'number', 'scan')
    fields(s, 'selectMode', 'string', 'scan')
    fields(s, 'showOverlays', 'boolean', 'scan')
    object(s.nextOfKind, 'scan.nextOfKind')
    object(s.nextOfDimGroup, 'scan.nextOfDimGroup')
    const settings = object(s.settings, 'scan.settings')
    fields(settings, 'method', 'string', 'scan.settings')
    fields(settings, 'sigma', 'number', 'scan.settings')
    rigid(s.appliedAlignment, 'scan.appliedAlignment')
    entries(s.elements, 'scan.elements', (e) => {
      fields(e, 'kind name color status', 'string', 'element')
      fields(e, 'visible', 'boolean', 'element')
      const source = object(e.source, 'element.source')
      if (!['picked', 'fitted', 'constructed'].includes(source.type as string)) invalid('element.source.type')
      if (source.type === 'fitted') indices(source.seeds, 'element.seeds')
      if (source.type === 'constructed') { indices(source.refs, 'element.refs'); array(source.params, 'element.params') }
      if (source.selection !== undefined) indices(source.selection, 'element.selection')
      if (!['point', 'line', 'plane', 'sphere', 'cylinder', 'cone', 'circle', 'torus'].includes(e.kind as string)) invalid('element.kind')
      if (e.fit !== undefined) {
        const fit = object(e.fit, 'element.fit')
        if (fit.kind !== e.kind) invalid('element.fit.kind')
        fields(fit, 'sigma usedPoints regionSize', 'number', 'element.fit')
        vector(fit.center, 3, 'element.fit.center')
        for (const key of ['axis', 'normal', 'dir', 'basisU', 'basisV']) if (fit[key] !== undefined) vector(fit[key], 3, `element.fit.${key}`)
      }
    })
    entries(s.dimensions, 'scan.dimensions', (e) => { fields(e, 'type name', 'string', 'dimension'); indices(e.refs, 'dimension.refs') })
    if (s.sections !== undefined) entries(s.sections, 'scan.sections', (e) => object(e.frame, 'section.frame'))
  }
  const d = object(m.deviation, 'deviation')
  fields(d, 'localMaxDistance range maxDistance tolerance nextProbeId targetSide', 'number', 'deviation')
  fields(d, 'rangeAuto maxDistanceAuto showElement showHistogram showNominal showScan showMap split', 'boolean', 'deviation')
  if (!['reference', 'element'].includes(d.source as string) || !['all', 'marked'].includes(d.targetScope as string)) invalid('deviation source or scope')
  file(d.reference, 'deviation.reference')
  array(d.pairs, 'deviation.pairs')
  entries(d.probes, 'deviation.probes')
  if (d.scope !== null) indices(d.scope, 'deviation.scope')
  for (const key of ['align', 'globalAlign']) if (d[key] !== null) rigid(object(d[key], `deviation.${key}`).transform, `deviation.${key}.transform`)
  const t = object(m.thickness, 'thickness')
  fields(t, 'maxThickness coneRays coneAngleDeg low high limit nextProbeId', 'number', 'thickness')
  fields(t, 'measured maxThicknessAuto scaleAuto showHistogram', 'boolean', 'thickness')
  fields(t, 'method', 'string', 'thickness')
  entries(t.probes, 'thickness.probes')
  const f = object(m.flat, 'flat')
  file(f.image, 'flat.image')
  sheet(f, 'flat')
  fields(f, 'edgeSensitivity', 'number', 'flat')
  fields(f, 'splitAxes showEdges snapToEdge showGrid', 'boolean', 'flat')
  if (f.sheets !== undefined) for (const [key, value] of Object.entries(object(f.sheets, 'flat.sheets'))) sheet(value, `flat.sheets.${key}`)

}
