// SPDX-License-Identifier: AGPL-3.0-only
import type { ElementKind, ElementSource, FitData, FitSettings, SigmaPreset, Vec3 } from './types'
import type { EvaluatedDimension } from './dimensions'
import { describeConstruction } from './elements/construct'
import { extendedSpans, isExtendable, isExtended, type Extension } from './elements/extend'

export const SIGMA_LABELS: Record<SigmaPreset, string> = {
  0: 'All points',
  3: '3 sigma',
  2: '2 sigma',
  1: '1 sigma',
}

/** A finished element: name plus the geometry that was measured for it. */
export interface MeasuredElement {
  id: number
  name: string
  kind: ElementKind
  fit: FitData
}

/** Narrow a list of store elements down to the ones that carry a fit. */
export function measuredElements<
  T extends { id: number; name: string; kind: ElementKind; fit?: FitData },
>(elements: readonly T[]): MeasuredElement[] {
  const out: MeasuredElement[] = []
  for (const e of elements) {
    if (e.fit) out.push({ id: e.id, name: e.name, kind: e.kind, fit: e.fit })
  }
  return out
}

export function formatVec(v: Vec3): string {
  return `(${v[0].toFixed(4)}, ${v[1].toFixed(4)}, ${v[2].toFixed(4)})`
}

/** Whether a geometry was measured on the scan (fitted) rather than picked or
 *  constructed — the ones whose sigma means something. */
const isFitted = (fit: FitData): boolean => fit.usedPoints > 0

/** The one number that identifies an element in a list. */
export function formatPrimary(fit: FitData): string {
  switch (fit.kind) {
    case 'sphere':
    case 'cylinder':
    case 'circle':
      return `Ø ${(fit.radius * 2).toFixed(3)} mm`
    case 'plane':
      return isFitted(fit) ? `σ ${fit.sigma.toFixed(4)} mm` : ''
    case 'point':
      return `(${fit.center.map((v) => v.toFixed(1)).join(', ')})`
    case 'line':
      return ''
  }
}

/** What the peak-to-peak form deviation of a kind is called in GD&T — the
 *  name the summary and the report label it with. Null for the kinds that
 *  have no surface form to speak of. */
export function formErrorLabel(kind: ElementKind): string | null {
  switch (kind) {
    case 'plane':
      return 'flatness'
    case 'cylinder':
      return 'cylindricity'
    case 'sphere':
      return 'sphericity'
    case 'circle':
      return 'circularity'
    default:
      return null
  }
}

/** The supporting numbers, for the panel's detail line and the summary. */
export function formatDetail(fit: FitData): string {
  const points = `${fit.usedPoints.toLocaleString('en-US')} of ${fit.regionSize.toLocaleString('en-US')} points`
  const form =
    fit.formError !== undefined ? ` · ${formErrorLabel(fit.kind) ?? 'form'} ${fit.formError.toFixed(4)} mm` : ''
  switch (fit.kind) {
    case 'sphere':
      return `σ ${fit.sigma.toFixed(4)} mm${form} · ${points}`
    case 'cylinder':
      return `σ ${fit.sigma.toFixed(4)} mm${form} · length ${fit.length.toFixed(3)} mm · arc ${Math.round(fit.coverage)}° · ${points}`
    case 'plane':
      return isFitted(fit)
        ? `${(fit.extentU * 2).toFixed(2)} × ${(fit.extentV * 2).toFixed(2)} mm patch${form} · ${points}`
        : `${(fit.extentU * 2).toFixed(2)} × ${(fit.extentV * 2).toFixed(2)} mm patch`
    case 'circle':
      return isFitted(fit)
        ? `σ ${fit.sigma.toFixed(4)} mm${form} · from ${fit.usedPoints} points`
        : `center (${fit.center.map((v) => v.toFixed(3)).join(', ')})`
    case 'point':
      return `at (${fit.center.map((v) => v.toFixed(3)).join(', ')})`
    case 'line':
      return `direction (${fit.dir.map((v) => v.toFixed(4)).join(', ')})`
  }
}

/** What buildSummary needs of an element — store elements satisfy this. */
export interface SummaryElement {
  id: number
  name: string
  kind: ElementKind
  source: ElementSource
  fit?: FitData
  /** Only ever reported beside the measurement, never folded into it. */
  extend?: Extension
  message?: string
}

export function buildSummary(
  fileName: string,
  settings: FitSettings,
  elements: readonly SummaryElement[],
  dimensions: readonly EvaluatedDimension[],
): string {
  const nameOf = (id: number): string => elements.find((e) => e.id === id)?.name ?? '?'
  const lines = [
    `ScanRuler — ${fileName}`,
    `Method: Gaussian best-fit, used points: ${SIGMA_LABELS[settings.sigma]}`,
    '',
  ]
  for (const el of elements) {
    lines.push(`${el.name}`)
    if (el.source.type === 'constructed') {
      lines.push(
        `  constructed: ${describeConstruction(el.source.method, el.source.refs.map(nameOf), el.source.params)}`,
      )
    }
    const f = el.fit
    if (!f) {
      lines.push(`  no geometry — ${el.message ?? 'unavailable'}`)
      continue
    }
    if (f.kind === 'sphere') {
      lines.push(`  diameter: ${(f.radius * 2).toFixed(4)} mm`)
      lines.push(`  center: ${formatVec(f.center)}`)
    } else if (f.kind === 'cylinder') {
      lines.push(`  diameter: ${(f.radius * 2).toFixed(4)} mm`)
      lines.push(`  axis point: ${formatVec(f.center)}`)
      lines.push(`  axis direction: ${formatVec(f.axis)}`)
      lines.push(`  length: ${f.length.toFixed(4)} mm, arc: ${Math.round(f.coverage)}°`)
    } else if (f.kind === 'plane') {
      lines.push(`  point: ${formatVec(f.center)}`)
      lines.push(`  normal: ${formatVec(f.normal)}`)
      lines.push(`  patch: ${(f.extentU * 2).toFixed(2)} × ${(f.extentV * 2).toFixed(2)} mm`)
    } else if (f.kind === 'circle') {
      lines.push(`  diameter: ${(f.radius * 2).toFixed(4)} mm`)
      lines.push(`  center: ${formatVec(f.center)}`)
      lines.push(`  normal: ${formatVec(f.normal)}`)
    } else if (f.kind === 'point') {
      lines.push(`  point: ${formatVec(f.center)}`)
    } else {
      lines.push(`  point: ${formatVec(f.center)}`)
      lines.push(`  direction: ${formatVec(f.dir)}`)
    }
    if (isFitted(f)) {
      lines.push(
        `  sigma: ${f.sigma.toFixed(4)} mm, used points: ${f.usedPoints} of ${f.regionSize}`,
      )
      if (f.formError !== undefined) {
        lines.push(`  ${formErrorLabel(f.kind) ?? 'form'} (peak-to-peak): ${f.formError.toFixed(4)} mm`)
      }
    }
    // What is on screen and in the STEP file, when that is no longer the same
    // as what was measured.
    if (isExtendable(f) && isExtended(el.extend)) {
      const spans = extendedSpans(f, el.extend)
      lines.push(
        f.kind === 'cylinder'
          ? `  drawn: ${spans[0].toFixed(4)} mm long`
          : `  drawn: ${spans[0].toFixed(2)} × ${spans[1].toFixed(2)} mm`,
      )
    }
  }
  if (dimensions.length) lines.push('')
  for (const { dim, title, value } of dimensions) {
    if (value.invalid) {
      lines.push(`${dim.name} (${title}) — ${value.label}: no value — ${value.invalid}`)
      continue
    }
    lines.push(`${dim.name} (${title}) — ${value.label}: ${value.value}`)
    if (value.detail) lines.push(`  ${value.detail}`)
    if (value.warning) lines.push(`  ⚠ ${value.warning}`)
  }
  return lines.join('\n')
}
