// SPDX-License-Identifier: AGPL-3.0-only
// How flat elements come to be: picked point by point, or constructed from
// existing elements. The method table is what the panel's UI is generated
// from, the evaluator is what the store re-runs when a source element moves —
// the same shape as elements/construct.ts, cut down to the flat kinds.

import { FitError } from '../fit/errors'
import {
  fitArcPoints,
  fitArcRegion,
  fitCirclePoints,
  fitCircleRegion,
  fitLinePoints,
  fitLineRegion,
  flatPoint,
} from './fit'
import { flatRefLine, flatRefPoint, type FlatRefRole } from './refs'
import type { FlatFit, FlatElementKind, Vec2 } from './types'
import { cross2, mid2, sub2 } from './vec2'

export interface FlatMethod {
  id: string
  kind: FlatElementKind
  /** How the geometry is collected: `pick` takes clicks on the image and fits
   *  once there are enough, `edge` takes dragged regions and consumes the
   *  detected edge points inside them, `construct` assembles from other
   *  elements. Edge picks flow through the same draft — the collected points
   *  ARE the picks, there are just very many of them. Per kind, the first
   *  method listed is the default the kind button opens with: picking, since
   *  a hand pick is right wherever the edge detector is not. */
  mode: 'pick' | 'edge' | 'construct'
  label: string
  /** One line for the creation UI. */
  hint: string
  minPicks?: number
  slots?: { role: FlatRefRole; label: string }[]
}

export const FLAT_METHODS: readonly FlatMethod[] = [
  {
    id: 'flat-point-pick',
    kind: 'point',
    mode: 'pick',
    label: 'Picked point',
    hint: 'Click the point on the image. Clicking again moves it.',
    minPicks: 1,
  },
  {
    id: 'flat-point-midpoint',
    kind: 'point',
    mode: 'construct',
    label: 'Midpoint',
    hint: 'Halfway between two points or centers.',
    slots: [
      { role: 'point', label: 'From' },
      { role: 'point', label: 'To' },
    ],
  },
  {
    id: 'flat-point-intersect',
    kind: 'point',
    mode: 'construct',
    label: 'Line intersection',
    hint: 'Where two lines cross — the corner two edges meet at, however rounded the part is there.',
    slots: [
      { role: 'line', label: 'Line A' },
      { role: 'line', label: 'Line B' },
    ],
  },
  {
    id: 'flat-point-center',
    kind: 'point',
    mode: 'construct',
    label: 'Center point',
    hint: 'The center of a circle or arc, as a point of its own.',
    slots: [{ role: 'point', label: 'From' }],
  },
  {
    id: 'flat-line-pick',
    kind: 'line',
    mode: 'pick',
    label: 'Through points',
    hint: 'Click two or more points along the edge — more points give the best-fit line.',
    minPicks: 2,
  },
  {
    id: 'flat-line-edge',
    kind: 'line',
    mode: 'edge',
    label: 'From edge region',
    hint: 'Drag a box along the edge — every detected edge point inside it feeds the fit, strays from other edges are voted out.',
    minPicks: 8,
  },
  {
    id: 'flat-circle-pick',
    kind: 'circle',
    mode: 'pick',
    label: 'Through points',
    hint: 'Click three or more points around the circle — more points give the best fit.',
    minPicks: 3,
  },
  {
    id: 'flat-circle-edge',
    kind: 'circle',
    mode: 'edge',
    label: 'From edge region',
    hint: 'Drag a box over the circle — every detected edge point inside it feeds the fit, strays are voted out.',
    minPicks: 12,
  },
  {
    id: 'flat-arc-pick',
    kind: 'arc',
    mode: 'pick',
    label: 'Through points',
    hint: 'Click three or more points along the arc — the fit covers what the points cover.',
    minPicks: 3,
  },
  {
    id: 'flat-arc-edge',
    kind: 'arc',
    mode: 'edge',
    label: 'From edge region',
    hint: 'Drag a box along the arc — every detected edge point inside it feeds the fit, strays are voted out.',
    minPicks: 12,
  },
]

export function flatMethodsForKind(kind: FlatElementKind): FlatMethod[] {
  return FLAT_METHODS.filter((m) => m.kind === kind)
}

export function flatMethod(id: string): FlatMethod {
  const m = FLAT_METHODS.find((x) => x.id === id)
  if (!m) throw new Error(`Unknown flat method "${id}".`)
  return m
}

/** Fit a pick-mode method from its collected points. */
export function evaluateFlatPicks(methodId: string, points: readonly Vec2[]): FlatFit {
  switch (methodId) {
    case 'flat-point-pick': {
      if (points.length < 1) throw new FitError('Click the point first.')
      return flatPoint(points[points.length - 1])
    }
    case 'flat-line-pick':
      return fitLinePoints(points)
    case 'flat-circle-pick':
      return fitCirclePoints(points)
    case 'flat-arc-pick':
      return fitArcPoints(points)
    case 'flat-line-edge':
      return fitLineRegion(points)
    case 'flat-circle-edge':
      return fitCircleRegion(points)
    case 'flat-arc-edge':
      return fitArcRegion(points)
    default:
      throw new Error(`"${methodId}" is not a pick method.`)
  }
}

/**
 * Evaluate a construction from its already-resolved references, in slot
 * order. Throws FitError with a user-facing message when the construction is
 * degenerate — the caller shows it and keeps the draft open.
 */
export function evaluateFlatConstruction(methodId: string, refs: readonly FlatFit[]): FlatFit {
  switch (methodId) {
    case 'flat-point-midpoint': {
      const a = flatRefPoint(refs[0])
      const b = flatRefPoint(refs[1])
      if (!a || !b) throw new FitError('Both references must provide a point.')
      return flatPoint(mid2(a, b))
    }
    case 'flat-point-intersect': {
      const a = flatRefLine(refs[0])
      const b = flatRefLine(refs[1])
      if (!a || !b) throw new FitError('Both references must be lines.')
      const denom = cross2(a.dir, b.dir)
      // sin of the angle between unit directions — parallel lines never meet.
      if (Math.abs(denom) < 1e-9) {
        throw new FitError('The lines are parallel — they do not intersect.')
      }
      const t = cross2(sub2(b.origin, a.origin), b.dir) / denom
      return flatPoint([a.origin[0] + t * a.dir[0], a.origin[1] + t * a.dir[1]])
    }
    case 'flat-point-center': {
      const p = flatRefPoint(refs[0])
      if (!p) throw new FitError('The reference must provide a point.')
      return flatPoint(p)
    }
    default:
      throw new Error(`"${methodId}" is not a construction.`)
  }
}
