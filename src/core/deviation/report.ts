// SPDX-License-Identifier: AGPL-3.0-only
import type { AlignResult, AlignSource } from './align'
import type { DeviationStats } from './deviation'
import { describeTarget, type ElementTarget, type MaterialSide } from './elementField'

const SOURCE: Record<AlignSource, string> = {
  auto: 'automatic',
  points: 'from picked points',
  local: 'local fine fit on marked surface',
}

const mm = (v: number): string => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(4)} mm`

/** The figures every deviation map reports, however it was measured. */
function statLines(stats: DeviationStats): string[] {
  const percent = stats.measured ? (stats.withinTolerance / stats.measured) * 100 : 0
  return [
    `  min             ${mm(stats.min)}`,
    `  max             ${mm(stats.max)}`,
    `  mean            ${mm(stats.mean)}`,
    `  RMS             ${stats.rms.toFixed(4)} mm`,
    `  sigma           ${stats.sigma.toFixed(4)} mm`,
    `  within ±${stats.tolerance} mm   ${percent.toFixed(1)} %`,
    `  matched         ${stats.measured} of ${stats.total} scan points`,
  ]
}

/** Plain-text summary of a deviation measurement, for the clipboard: what was
 *  compared against what, how well it was aligned, and the numbers — enough to
 *  paste into a build log and still know months later what it refers to. */
export function buildDeviationReport(
  scanName: string,
  nominalName: string,
  align: AlignResult,
  stats: DeviationStats,
  range: number,
  maxDistance: number,
): string {
  return [
    'ScanRuler — deviation from nominal',
    `Scan:      ${scanName}`,
    `Reference: ${nominalName}`,
    '',
    `Alignment: rigid best fit (6 DOF, no scale), ${SOURCE[align.source]}`,
    `  fit RMS         ${align.rms.toFixed(4)} mm over ${align.matched} of ${align.sampled} sampled points`,
    `  passes          ${align.iterations}${align.ambiguous ? '  (a second starting pose fitted almost as well)' : ''}`,
    // Which surface a fit was measured on decides what the whole map means, so
    // a local fit says so here rather than passing for a whole-part best fit.
    ...(align.source === 'local'
      ? [
          `  marked surface  ${align.selected ?? 0} scan points, hand-marked`,
          `  search limit    ${align.searchDistance ?? 0} mm`,
          ...(align.underconstrained
            ? ['  NOTE: the marked surface faces one way — the fit is free to slide along it']
            : []),
        ]
      : []),
    '',
    'Deviation, scan to reference surface, signed outwards:',
    '  positive = outside the reference, negative = inside it',
    ...statLines(stats),
    '',
    `  max search distance  ${maxDistance} mm`,
    `  colour scale         ±${range} mm`,
    '',
  ].join('\n')
}

/** The same summary for a map measured against one fitted element. There is no
 *  alignment to account for — the element was fitted on this scan, in this
 *  frame — but what bounded the measurement takes its place, because the region
 *  and the facing limit are what a reading off this map has to be read against. */
export function buildElementReport(
  scanName: string,
  elementName: string,
  target: ElementTarget,
  side: MaterialSide,
  stats: DeviationStats,
  range: number,
  maxDistance: number,
  facingDeg: number | null,
): string {
  return [
    'ScanRuler — deviation from a fitted element',
    `Scan:    ${scanName}`,
    `Element: ${elementName} — ${describeTarget(target)}`,
    '',
    'Measured in scan coordinates — the element was fitted on this scan, so',
    'there is no alignment between the two and none has been applied.',
    `  form deviation of the element itself   ${target.sigma.toFixed(4)} mm sigma`,
    `  measured on                            ${target.usedPoints} of ${target.regionSize} points`,
    `  material side                          ${side === 1 ? "the element's outward side" : 'the inner side — a bore or a shell'}`,
    '',
    'Deviation, scan to element, signed towards the material:',
    '  positive = too much material, negative = too little',
    ...statLines(stats),
    '',
    `  region               the element as drawn`,
    `  max search distance  ${maxDistance} mm`,
    `  facing limit         ${facingDeg === null ? 'off — any surface within the element counts' : `${facingDeg}°`}`,
    `  colour scale         ±${range} mm`,
    '',
  ].join('\n')
}
