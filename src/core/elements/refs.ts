// SPDX-License-Identifier: AGPL-3.0-only
import type { ElementKind, FitData, PlaneFit, Vec3 } from '../types'

/** The proxy geometry an element contributes to a measurement — the standard
 *  metrology reduction: spheres and points act as a point, cylinders and
 *  lines as an axis, planes as a plane. */
export type RefRole = 'point' | 'axis' | 'plane'

export const ROLE_PROVIDERS: Record<RefRole, readonly ElementKind[]> = {
  point: ['point', 'sphere'],
  axis: ['line', 'cylinder'],
  plane: ['plane'],
}

export function providesRole(kind: ElementKind, role: RefRole): boolean {
  return ROLE_PROVIDERS[role].includes(kind)
}

/** The one role an element kind plays in a measurement. */
export function roleOf(kind: ElementKind): RefRole {
  if (kind === 'plane') return 'plane'
  if (kind === 'line' || kind === 'cylinder') return 'axis'
  return 'point'
}

/** The point an element stands for, or null if it has none. */
export function refPoint(fit: FitData): Vec3 | null {
  return fit.kind === 'point' || fit.kind === 'sphere' ? fit.center : null
}

export interface AxisRef {
  origin: Vec3
  dir: Vec3
  /** Half of the measured/drawn extent, for "off the measured section"
   *  checks. The axis itself is infinite. */
  halfLength: number
}

export function refAxis(fit: FitData): AxisRef | null {
  if (fit.kind === 'cylinder') return { origin: fit.center, dir: fit.axis, halfLength: fit.length / 2 }
  if (fit.kind === 'line') return { origin: fit.center, dir: fit.dir, halfLength: fit.length / 2 }
  return null
}

export function refPlane(fit: FitData): PlaneFit | null {
  return fit.kind === 'plane' ? fit : null
}
