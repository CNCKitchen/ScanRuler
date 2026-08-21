// SPDX-License-Identifier: AGPL-3.0-only
// How a flat measuring session leaves the tool as text: a clipboard report a
// person pastes somewhere, and a CSV a spreadsheet ingests. Both say what the
// numbers rest on — the scale, where it came from, and whether coordinates
// are in the part's frame — because a figure without its traceability line is
// how wrong numbers get trusted.

import type { FlatDatum, FlatFrame } from './datum'
import { fitInFrame } from './datum'
import type { FlatDimensionValue } from './dimensions'
import type { FlatElement } from './elements'
import type { PixelsPerMm } from './image'
import { formatFlatDetail, formatFlatPrimary } from './summary'
import type { FlatFit } from './types'

export interface EvaluatedFlatDimension {
  title: string
  value: FlatDimensionValue
}

export interface FlatReportInput {
  imageName: string
  imageWidth: number
  imageHeight: number
  calSource: 'none' | 'metadata' | 'measured'
  pxPerMm: PixelsPerMm | null
  datum: FlatDatum | null
  frame: FlatFrame | null
  unit: string
  elements: readonly FlatElement[]
  dimensions: readonly EvaluatedFlatDimension[]
  counts?: readonly { name: string; picks: readonly unknown[] }[]
}

function scaleLine(r: FlatReportInput): string {
  if (r.calSource === 'measured' && r.pxPerMm) {
    return r.pxPerMm.x === r.pxPerMm.y
      ? `Scale: CALIBRATED, ${r.pxPerMm.x.toFixed(4)} px/mm`
      : `Scale: CALIBRATED, X ${r.pxPerMm.x.toFixed(4)} / Y ${r.pxPerMm.y.toFixed(4)} px/mm`
  }
  if (r.calSource === 'metadata' && r.pxPerMm) {
    return `Scale: UNCALIBRATED — nominal ${(r.pxPerMm.x * 25.4).toFixed(0)} dpi from file metadata`
  }
  return 'Scale: UNCALIBRATED — no scale, all values in PIXELS'
}

export function buildFlatReport(r: FlatReportInput): string {
  const lines: string[] = []
  lines.push(`ScanRuler 2D measurement — ${r.imageName} (${r.imageWidth} × ${r.imageHeight} px)`)
  lines.push(scaleLine(r))
  lines.push(
    r.frame
      ? 'Coordinates: part datum frame (origin and +X as picked)'
      : 'Coordinates: image frame, origin bottom-left, y up',
  )
  if (r.elements.length > 0) {
    lines.push('')
    lines.push('Elements')
    for (const el of r.elements) {
      if (!el.fit) {
        lines.push(`  ${el.name}: no fit — ${el.error ?? 'unavailable'}`)
        continue
      }
      const shown = fitInFrame(el.fit, r.frame)
      const detail = formatFlatDetail(shown, r.unit)
      lines.push(`  ${el.name}: ${formatFlatPrimary(shown, r.unit)}${detail ? ` (${detail})` : ''}`)
    }
  }
  if (r.dimensions.length > 0) {
    lines.push('')
    lines.push('Dimensions')
    for (const d of r.dimensions) {
      if (d.value.invalid) {
        lines.push(`  ${d.title} — ${d.value.label}: invalid (${d.value.invalid})`)
        continue
      }
      const extras = [d.value.detail, d.value.warning && `⚠ ${d.value.warning}`]
        .filter(Boolean)
        .join(' — ')
      lines.push(`  ${d.title} — ${d.value.label}: ${d.value.value}${extras ? ` (${extras})` : ''}`)
    }
  }
  if (r.counts && r.counts.length > 0) {
    lines.push('')
    lines.push('Counts')
    for (const c of r.counts) lines.push(`  ${c.name}: ${c.picks.length}`)
  }
  return lines.join('\n')
}

const csv = (v: string | number | undefined | null): string => {
  if (v === undefined || v === null) return ''
  const s = String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function fitColumns(fit: FlatFit): (number | '')[] {
  const deg = (rad: number) => (rad * 180) / Math.PI
  switch (fit.kind) {
    case 'point':
      return [fit.at[0], fit.at[1], '', '', '', '']
    case 'line':
      return [fit.center[0], fit.center[1], '', fit.length, deg(Math.atan2(fit.dir[1], fit.dir[0])), '']
    case 'circle':
      return [fit.center[0], fit.center[1], 2 * fit.radius, '', '', '']
    case 'arc':
      return [fit.center[0], fit.center[1], 2 * fit.radius, '', deg(fit.start), deg(fit.sweep)]
  }
}

/** One CSV with two sections: elements, then dimensions. Numeric columns stay
 *  raw (no unit suffixes) — the header row carries the unit once. */
export function buildFlatCsv(r: FlatReportInput): string {
  const rows: string[] = []
  rows.push(`# ${r.imageName} — ${scaleLine(r)} — ${r.frame ? 'datum frame' : 'image frame'}`)
  rows.push(
    ['name', 'kind', `x_${r.unit}`, `y_${r.unit}`, `diameter_${r.unit}`, `length_${r.unit}`, 'angle_deg', 'sweep_deg', `sigma_${r.unit}`, `form_${r.unit}`, 'points', 'note']
      .map(csv)
      .join(','),
  )
  for (const el of r.elements) {
    if (!el.fit) {
      rows.push([el.name, el.kind, '', '', '', '', '', '', '', '', '', el.error ?? 'no fit'].map(csv).join(','))
      continue
    }
    const shown = fitInFrame(el.fit, r.frame)
    const cols = fitColumns(shown)
    rows.push(
      [
        el.name,
        el.kind,
        ...cols.map((c) => (c === '' ? '' : (c as number).toFixed(4))),
        shown.sigma.toFixed(5),
        shown.formError !== undefined ? shown.formError.toFixed(5) : '',
        shown.usedPoints,
        '',
      ]
        .map(csv)
        .join(','),
    )
  }
  if (r.dimensions.length > 0) {
    rows.push('')
    rows.push(['dimension', 'label', `value_${r.unit === 'px' ? 'px_or_deg' : 'mm_or_deg'}`, 'note'].map(csv).join(','))
    for (const d of r.dimensions) {
      rows.push(
        [
          d.title,
          d.value.label,
          d.value.raw !== undefined ? d.value.raw.toFixed(4) : '',
          d.value.invalid ?? d.value.warning ?? '',
        ]
          .map(csv)
          .join(','),
      )
    }
  }
  if (r.counts && r.counts.length > 0) {
    rows.push('')
    rows.push(['count', 'features'].map(csv).join(','))
    for (const c of r.counts) rows.push([c.name, c.picks.length].map(csv).join(','))
  }
  return rows.join('\n')
}
