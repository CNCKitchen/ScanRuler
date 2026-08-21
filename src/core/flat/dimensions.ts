// SPDX-License-Identifier: AGPL-3.0-only
// Measurements between flat elements — the 2D counterpart of
// core/dimensions.ts, and the same shape throughout: a type table the
// creation UI is generated from, and a pure evaluator that returns invalid
// results rather than throwing, so a broken reference never takes the panel
// down. Every element acts as a point or a line (see flat/refs.ts).

import { flatRefLine, flatRefPoint, type FlatRefRole } from './refs'
import type { FlatFit, Vec2 } from './types'
import { acuteAngle2, dot2, footOnLine2, len2, scale2, sub2 } from './vec2'

export type FlatDimensionGroup = 'distance' | 'angle'

export interface FlatDimensionTypeInfo {
  id: string
  group: FlatDimensionGroup
  label: string
  /** What the value means, for the creation UI. */
  hint: string
  slots: { role: FlatRefRole; label: string }[]
}

export const FLAT_DIMENSION_TYPES: readonly FlatDimensionTypeInfo[] = [
  {
    id: 'flat-dist-point-point',
    group: 'distance',
    label: 'Point – Point',
    hint: 'Straight-line distance between two points or centers.',
    slots: [
      { role: 'point', label: 'From' },
      { role: 'point', label: 'To' },
    ],
  },
  {
    id: 'flat-dist-point-line',
    group: 'distance',
    label: 'Point – Line',
    hint: 'Perpendicular distance from a point to a line.',
    slots: [
      { role: 'point', label: 'Point' },
      { role: 'line', label: 'Line' },
    ],
  },
  {
    id: 'flat-dist-line-line',
    group: 'distance',
    label: 'Line – Line',
    hint: 'Distance between two near-parallel lines — the width of a slot or a wall.',
    slots: [
      { role: 'line', label: 'From' },
      { role: 'line', label: 'To' },
    ],
  },
  {
    id: 'flat-angle-line-line',
    group: 'angle',
    label: 'Line – Line',
    hint: 'Angle between two lines (0–90°).',
    slots: [
      { role: 'line', label: 'Line A' },
      { role: 'line', label: 'Line B' },
    ],
  },
]

export function flatDimensionTypeInfo(id: string): FlatDimensionTypeInfo {
  const info = FLAT_DIMENSION_TYPES.find((t) => t.id === id)
  if (!info) throw new Error(`Unknown flat dimension type "${id}".`)
  return info
}

/** A stored dimension: references elements by id, values are recomputed.
 *  Named like the 3D ones — "Distance 2", "Angle 1" — and hideable in the
 *  viewport without losing the row. */
export interface FlatDimension {
  id: number
  type: string
  name: string
  refs: number[]
  visible: boolean
}

export interface FlatDimensionValue {
  /** 'Center distance', 'Line angle', … */
  label: string
  /** Formatted, e.g. "12.345 mm" — undefined when the dimension is invalid. */
  value?: string
  raw?: number
  /** Distance line to draw in the viewport; angles carry an arc instead. */
  segment?: [Vec2, Vec2]
  /** How to draw an angle: two rays from a vertex, with the reported angle
   *  between exactly these directions. */
  arc?: { vertex: Vec2; dirA: Vec2; dirB: Vec2 }
  /** The value is shown but deserves a caveat. */
  warning?: string
  /** No value can be given, and this is why. */
  invalid?: string
  /** Supporting numbers: ΔX/ΔY for point–point, the fold angle for
   *  near-parallel pairs. */
  detail?: string
}

/** Beyond this fold angle, "parallel" distances stop being reported. */
export const FLAT_PARALLEL_MAX_DEG = 3
/** Beyond this fold angle, a parallel distance carries a warning. */
export const FLAT_PARALLEL_WARN_DEG = 0.5
/** How far past the measured segment a perpendicular foot may land before
 *  the dimension warns that it left the measured edge. */
const EXTENT_MARGIN = 1.3

const mm = (v: number): string => `${v.toFixed(3)} mm`
const deg = (v: number): string => `${v.toFixed(2)}°`

const invalid = (label: string, why: string): FlatDimensionValue => ({ label, invalid: why })

function deltaDetail(a: Vec2, b: Vec2): string {
  const f = (v: number) => {
    const s = v.toFixed(3)
    // A delta a hair under zero must not print as "-0.000".
    return s === '-0.000' ? '+0.000' : v >= 0 ? `+${s}` : s
  }
  return `ΔX ${f(b[0] - a[0])} · ΔY ${f(b[1] - a[1])} mm`
}

/**
 * Compute a flat dimension's value from the already-resolved geometries of
 * its references, in slot order.
 */
export function evaluateFlatDimension(type: string, fits: readonly FlatFit[]): FlatDimensionValue {
  switch (type) {
    case 'flat-dist-point-point': {
      const a = flatRefPoint(fits[0])
      const b = flatRefPoint(fits[1])
      if (!a || !b) return invalid('Distance', 'A reference is not a point.')
      const d = len2(sub2(b, a))
      return {
        label: 'Center distance',
        value: mm(d),
        raw: d,
        segment: [a, b],
        detail: deltaDetail(a, b),
      }
    }

    case 'flat-dist-point-line': {
      const p = flatRefPoint(fits[0])
      const line = flatRefLine(fits[1])
      if (!p || !line) return invalid('Distance to line', 'A reference is missing.')
      const { foot, t } = footOnLine2(p, line.origin, line.dir)
      const d = len2(sub2(p, foot))
      return {
        label: 'Distance to line',
        value: mm(d),
        raw: d,
        segment: [p, foot],
        warning:
          Math.abs(t) > line.halfLength * EXTENT_MARGIN
            ? 'The perpendicular foot lies beyond the measured section of the line.'
            : undefined,
      }
    }

    case 'flat-dist-line-line': {
      const a = flatRefLine(fits[0])
      const b = flatRefLine(fits[1])
      if (!a || !b) return invalid('Line distance', 'A reference is missing.')
      const fold = acuteAngle2(a.dir, b.dir)
      if (fold > FLAT_PARALLEL_MAX_DEG) {
        return invalid(
          'Line distance',
          `The lines are ${deg(fold)} apart — a distance between non-parallel lines has no meaning. Use an angle dimension instead.`,
        )
      }
      // Near-parallel: measured from the middle of line A, which is stable
      // however slight the residual skew is.
      const { foot, t } = footOnLine2(a.origin, b.origin, b.dir)
      const warnings: string[] = []
      if (fold > FLAT_PARALLEL_WARN_DEG)
        warnings.push(
          `The lines are ${deg(fold)} off parallel — the value depends on where along them it is taken.`,
        )
      if (Math.abs(t) > b.halfLength * EXTENT_MARGIN)
        warnings.push('Measured beyond the fitted section of the second line.')
      const d = len2(sub2(a.origin, foot))
      return {
        label: 'Line distance',
        value: mm(d),
        raw: d,
        segment: [a.origin, foot],
        detail: `Lines ${deg(fold)} apart`,
        warning: warnings.length ? warnings.join(' ') : undefined,
      }
    }

    case 'flat-angle-line-line': {
      const a = flatRefLine(fits[0])
      const b = flatRefLine(fits[1])
      if (!a || !b) return invalid('Line angle', 'A reference is missing.')
      const v = acuteAngle2(a.dir, b.dir)
      // Hinge the arc where the lines cross, with B's direction flipped onto
      // A's side so the drawn opening is the reported acute angle. Parallel
      // lines never cross — hinge halfway between the segments instead.
      const denom = a.dir[0] * b.dir[1] - a.dir[1] * b.dir[0]
      let vertex: Vec2
      if (Math.abs(denom) > 1e-9) {
        const r = sub2(b.origin, a.origin)
        const t = (r[0] * b.dir[1] - r[1] * b.dir[0]) / denom
        vertex = [a.origin[0] + t * a.dir[0], a.origin[1] + t * a.dir[1]]
      } else {
        vertex = [(a.origin[0] + b.origin[0]) / 2, (a.origin[1] + b.origin[1]) / 2]
      }
      const dirB = dot2(a.dir, b.dir) < 0 ? scale2(b.dir, -1) : b.dir
      return {
        label: 'Line angle',
        value: deg(v),
        raw: v,
        detail: v < 90 ? `Supplement ${deg(180 - v)}` : undefined,
        arc: { vertex, dirA: a.dir, dirB },
      }
    }

    default:
      return invalid('Dimension', `Unknown flat dimension type "${type}".`)
  }
}

/** The slice of an element a dimension needs to resolve and title itself. */
export interface FlatNamedGeometry {
  id: number
  name: string
  fit: FlatFit | null
}

export interface EvaluatedFlat {
  dim: FlatDimension
  /** "Circle 1 → Line 2" */
  title: string
  value: FlatDimensionValue
}

/** Resolve every dimension against the current elements. A dimension whose
 *  reference lost its geometry reads as invalid rather than disappearing. */
export function evaluateFlatDimensions(
  dims: readonly FlatDimension[],
  elements: readonly FlatNamedGeometry[],
): EvaluatedFlat[] {
  return dims.map((dim) => {
    const els = dim.refs.map((id) => elements.find((e) => e.id === id))
    const title = els.map((e) => e?.name ?? '?').join(' → ')
    const fits = els.map((e) => e?.fit)
    const value = fits.every((f): f is FlatFit => f !== undefined && f !== null)
      ? evaluateFlatDimension(dim.type, fits)
      : {
          label: flatDimensionTypeInfo(dim.type).label,
          invalid: 'A referenced element is unavailable.',
        }
    return { dim, title, value }
  })
}
