// SPDX-License-Identifier: AGPL-3.0-only
import type { FlatElementKind, FlatFit, Vec2 } from './types'

/** The proxy geometry a flat element contributes to a measurement — the 2D
 *  half of the metrology reduction in elements/refs.ts: points, circles and
 *  arcs act as a point (their center), lines as a line. */
export type FlatRefRole = 'point' | 'line'

export const FLAT_ROLE_PROVIDERS: Record<FlatRefRole, readonly FlatElementKind[]> = {
  point: ['point', 'circle', 'arc'],
  line: ['line'],
}

/** The one role a flat element kind plays in a measurement. */
export function flatRoleOf(kind: FlatElementKind): FlatRefRole {
  return kind === 'line' ? 'line' : 'point'
}

/** The point an element stands for, or null if it has none. */
export function flatRefPoint(fit: FlatFit): Vec2 | null {
  if (fit.kind === 'point') return fit.at
  if (fit.kind === 'circle' || fit.kind === 'arc') return fit.center
  return null
}

export interface FlatLineRef {
  origin: Vec2
  dir: Vec2
  /** Half of the measured extent, for "off the measured section" checks. The
   *  line itself is infinite. */
  halfLength: number
}

export function flatRefLine(fit: FlatFit): FlatLineRef | null {
  if (fit.kind !== 'line') return null
  return { origin: fit.center, dir: fit.dir, halfLength: fit.length / 2 }
}
