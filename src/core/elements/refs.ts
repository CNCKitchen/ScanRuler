// SPDX-License-Identifier: AGPL-3.0-only
import type { ElementKind, FitData, PlaneFit, Vec3 } from '../types'

/** The proxy geometry an element contributes to a measurement — the standard
 *  metrology reduction: spheres, points and circles act as a point, cylinders
 *  and lines as an axis, planes as a plane. A circle is on both lists: its
 *  center is the point it stands for, but its normal is a perfectly good axis
 *  for whoever asks for one in a dropdown. */
export type RefRole = 'point' | 'axis' | 'plane'

export const ROLE_PROVIDERS: Record<RefRole, readonly ElementKind[]> = {
  point: ['point', 'sphere', 'circle'],
  axis: ['line', 'cylinder', 'circle'],
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
  return fit.kind === 'point' || fit.kind === 'sphere' || fit.kind === 'circle'
    ? fit.center
    : null
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
  // A circle's axis is its normal through the center. The radius stands in for
  // the measured extent — the circle was measured in its own plane, so a foot
  // landing much further out than that along the axis deserves the warning.
  if (fit.kind === 'circle') return { origin: fit.center, dir: fit.normal, halfLength: fit.radius }
  return null
}

export function refPlane(fit: FitData): PlaneFit | null {
  return fit.kind === 'plane' ? fit : null
}
