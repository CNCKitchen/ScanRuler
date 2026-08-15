// SPDX-License-Identifier: AGPL-3.0-only
import type { AlignResult } from './align'
import type { DeviationStats } from './deviation'

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
  const mm = (v: number): string => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(4)} mm`
  const percent = stats.measured ? (stats.withinTolerance / stats.measured) * 100 : 0
  return [
    'ScanRuler — deviation from nominal',
    `Scan:      ${scanName}`,
    `Reference: ${nominalName}`,
    '',
    `Alignment: rigid best fit (6 DOF, no scale), ${align.source === 'auto' ? 'automatic' : 'from picked points'}`,
    `  fit RMS         ${align.rms.toFixed(4)} mm over ${align.matched} of ${align.sampled} sampled points`,
    `  passes          ${align.iterations}${align.ambiguous ? '  (a second starting pose fitted almost as well)' : ''}`,
    '',
    'Deviation, scan to reference surface, signed outwards:',
    `  min             ${mm(stats.min)}`,
    `  max             ${mm(stats.max)}`,
    `  mean            ${mm(stats.mean)}`,
    `  RMS             ${stats.rms.toFixed(4)} mm`,
    `  sigma           ${stats.sigma.toFixed(4)} mm`,
    `  within ±${stats.tolerance} mm   ${percent.toFixed(1)} %`,
    `  matched         ${stats.measured} of ${stats.total} scan points`,
    '',
    `  max search distance  ${maxDistance} mm`,
    `  colour scale         ±${range} mm`,
    '',
  ].join('\n')
}
