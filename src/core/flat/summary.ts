// SPDX-License-Identifier: AGPL-3.0-only
// How a flat fit reads as text — the one-line headline for the list row and
// the viewport pin, and the residual detail underneath. Mirrors
// core/summary.ts for the 3D elements; `unit` is 'mm', or 'px' while nothing
// has set a scale, and saying which is the whole reason it is a parameter.

import type { FlatFit } from './types'

export function formatFlatPrimary(fit: FlatFit, unit: string): string {
  switch (fit.kind) {
    case 'point':
      return `X ${fit.at[0].toFixed(3)} · Y ${fit.at[1].toFixed(3)} ${unit}`
    case 'line': {
      const angle = (Math.atan2(fit.dir[1], fit.dir[0]) * 180) / Math.PI
      return `L ${fit.length.toFixed(3)} ${unit} · ${angle.toFixed(2)}°`
    }
    case 'circle':
      return `Ø ${(2 * fit.radius).toFixed(3)} ${unit}`
    case 'arc':
      return `R ${fit.radius.toFixed(3)} ${unit} · ${((fit.sweep * 180) / Math.PI).toFixed(1)}°`
  }
}

/** σ, form error and point count — empty for geometry with no residuals. */
export function formatFlatDetail(fit: FlatFit, unit: string): string {
  if (fit.usedPoints === 0) return ''
  const parts = [`σ ${fit.sigma.toFixed(4)}`]
  if (fit.formError !== undefined) parts.push(`form ${fit.formError.toFixed(4)} ${unit}`)
  parts.push(`${fit.usedPoints} pts`)
  return parts.join(' · ')
}
