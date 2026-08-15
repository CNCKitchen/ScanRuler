// SPDX-License-Identifier: AGPL-3.0-only
import type { ThicknessMethod, ThicknessStats } from './thickness'

/** How the measurement was taken and how it is being read — the settings a
 *  report has to carry, or the numbers in it mean nothing six months later. */
export interface ThicknessSettings {
  method: ThicknessMethod
  maxThickness: number
  coneRays: number
  coneAngleDeg: number
  normalDeviationDeg: number | null
  low: number
  high: number
}

/** Plain-text summary of a wall thickness measurement, for the clipboard:
 *  what was measured, how, and the numbers — enough to paste into a build log
 *  and still know months later what it refers to. */
export function buildThicknessReport(
  scanName: string,
  stats: ThicknessStats,
  settings: ThicknessSettings,
): string {
  const mm = (v: number): string => `${v.toFixed(4)} mm`
  const percent = stats.measured ? (stats.belowLimit / stats.measured) * 100 : 0
  const method =
    settings.method === 'sphere'
      ? 'sphere grown at the midpoint of the ray along the inward normal, measured across'
      : settings.coneRays > 0
        ? `shortest of ${settings.coneRays} rays through a ${settings.coneAngleDeg}° cone about the inward normal`
        : 'ray along the inward surface normal'

  return [
    'ScanRuler — wall thickness',
    `Part: ${scanName}`,
    '',
    `Method: ${method}`,
    `  max. thickness searched  ${settings.maxThickness} mm`,
    `  far surface must face back within  ${
      settings.normalDeviationDeg === null ? 'not checked' : `${settings.normalDeviationDeg}°`
    }`,
    '',
    'Wall thickness at each scan point:',
    `  min             ${mm(stats.min)}`,
    `  max             ${mm(stats.max)}`,
    `  mean            ${mm(stats.mean)}`,
    `  sigma           ${mm(stats.sigma)}`,
    `  under ${stats.limit} mm      ${percent.toFixed(1)} %  (${stats.belowLimit} points)`,
    `  measured        ${stats.measured} of ${stats.total} scan points`,
    '',
    `  colour scale         ${settings.low} … ${settings.high} mm`,
    '',
  ].join('\n')
}
