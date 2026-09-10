// SPDX-License-Identifier: AGPL-3.0-only
// What was measured on a section's sheet, stood back up in the part: every
// 2D element lifted through the section's frame into the plane it was cut
// in, as geometry the 3D viewport can draw beside the cut and the STEP
// export can hand to CAD. A section's elements belong to the section — they
// are drawn in its colour, hidden with it, and written under its name.
//
// The sheet's (u, v) are millimetres along the frame's in-plane axes, so a
// point lifts to origin + u·U + v·V and a direction to du·U + dv·V. A circle
// takes the cutting plane's normal for its own; an arc keeps its angles,
// which count from +U towards +V — counter-clockwise about the normal, since
// U × V = normal — and the same sense a STEP circle is parameterised in.
//
// Nothing here is stored: the sheet stays the truth, and the lift is taken
// again from the frame in force, so a datum alignment that carries the
// section carries what was measured on it too.

import { splineBezierForm } from '../flat/spline'
import type { FlatFit, Vec2 } from '../flat/types'
import type { CircleFit, FitBase, LineFit, PointFit, Vec3 } from '../types'
import { orthoBasis } from '../fit/linalg'
import { addScaled, cross, scale } from '../vec'
import type { SectionFrame } from './frame'

/** Part of a circle in space: from `start` radians, sweeping `sweep`
 *  counter-clockwise about `normal`, angles counted from `basisU`. Not an
 *  element kind of its own — the 3D workspace measures whole circles — but
 *  what a section's arc is once it is stood back up. */
export interface ArcGeometry extends FitBase {
  kind: 'arc'
  center: Vec3
  normal: Vec3
  basisU: Vec3
  radius: number
  start: number
  sweep: number
}

/** A sheet spline in space: its cubic Béziers pole for pole — 3s + 1 poles
 *  for s segments, segment k through poles 3k to 3k + 3 — on the sheet's
 *  chord-length knots, s + 1 of them. The form a STEP B-spline is written in
 *  directly, and what the 3D viewport samples. */
export interface SplineGeometry extends FitBase {
  kind: 'spline'
  poles: Vec3[]
  knots: number[]
  closed: boolean
}

/** A section element in the part: what the sheet's five kinds become. */
export type SectionGeometry = PointFit | LineFit | CircleFit | ArcGeometry | SplineGeometry

/** A sheet point in the part. */
export function liftPoint(frame: SectionFrame, p: Vec2): Vec3 {
  return addScaled(addScaled(frame.origin, frame.basisU, p[0]), frame.basisV, p[1])
}

/** A sheet direction in the part — unit if the sheet's was. */
export function liftDir(frame: SectionFrame, d: Vec2): Vec3 {
  return addScaled(scale(frame.basisU, d[0]), frame.basisV, d[1])
}

/** One sheet fit stood up in its section's plane. The residuals come along
 *  as they were measured — a lifted fit is the same fit, seen from the part. */
export function liftFlatFit(frame: SectionFrame, fit: FlatFit): SectionGeometry {
  const stats: FitBase = { sigma: fit.sigma, usedPoints: fit.usedPoints, regionSize: 0 }
  if (fit.formError !== undefined) stats.formError = fit.formError
  switch (fit.kind) {
    case 'point':
      return { kind: 'point', center: liftPoint(frame, fit.at), ...stats }
    case 'line':
      return {
        kind: 'line',
        center: liftPoint(frame, fit.center),
        dir: liftDir(frame, fit.dir),
        length: fit.length,
        ...stats,
      }
    case 'circle':
      return {
        kind: 'circle',
        center: liftPoint(frame, fit.center),
        normal: frame.normal,
        radius: fit.radius,
        ...stats,
      }
    case 'arc':
      return {
        kind: 'arc',
        center: liftPoint(frame, fit.center),
        normal: frame.normal,
        basisU: frame.basisU,
        radius: fit.radius,
        start: fit.start,
        sweep: fit.sweep,
        ...stats,
      }
    case 'spline': {
      // The lift is affine, so the Bézier poles lift like any point and the
      // curve through them is the sheet's curve, stood up.
      const { poles, knots } = splineBezierForm(fit)
      return {
        kind: 'spline',
        poles: poles.map((p) => liftPoint(frame, p)),
        knots,
        closed: fit.closed,
        ...stats,
      }
    }
  }
}

/** An arc that has come all the way round is a circle — what the export
 *  writes it as, and what the sheet would have called it. */
export const FULL_TURN = 2 * Math.PI
export function isFullTurn(sweep: number): boolean {
  return sweep >= FULL_TURN - 1e-6
}

/**
 * The stroke that draws a section element: x,y,z per vertex, in order, a
 * closed ring for a circle (its first vertex repeated at the end), the swept
 * part alone for an arc, the measured segment for a line. A point has no
 * stroke — it is a marker — and returns null. `segments` is how many a full
 * turn is divided into; an arc gets its share of them, never fewer than two,
 * and a spline a sixth of them per Bézier — sixteen at the default.
 */
export function sectionStroke(g: SectionGeometry, segments = 96): number[] | null {
  switch (g.kind) {
    case 'point':
      return null
    case 'spline': {
      const per = Math.max(2, Math.round(segments / 6))
      const out: number[] = [...g.poles[0]]
      for (let k = 0; k + 3 < g.poles.length; k += 3) {
        const [b0, b1, b2, b3] = g.poles.slice(k, k + 4)
        for (let i = 1; i <= per; i++) {
          const u = i / per
          const v = 1 - u
          const w0 = v * v * v
          const w1 = 3 * v * v * u
          const w2 = 3 * v * u * u
          const w3 = u * u * u
          for (let c = 0; c < 3; c++) out.push(w0 * b0[c] + w1 * b1[c] + w2 * b2[c] + w3 * b3[c])
        }
      }
      return out
    }
    case 'line': {
      const a = addScaled(g.center, g.dir, -g.length / 2)
      const b = addScaled(g.center, g.dir, g.length / 2)
      return [...a, ...b]
    }
    case 'circle': {
      const u = orthoBasis(g.normal)[0]
      return ring(g.center, g.normal, u, g.radius, 0, FULL_TURN, segments)
    }
    case 'arc': {
      const n = Math.max(2, Math.ceil((segments * g.sweep) / FULL_TURN))
      return ring(g.center, g.normal, g.basisU, g.radius, g.start, g.sweep, n)
    }
  }
}

function ring(
  center: Vec3,
  normal: Vec3,
  basisU: Vec3,
  radius: number,
  start: number,
  sweep: number,
  segments: number,
): number[] {
  const v = cross(normal, basisU)
  const out: number[] = []
  for (let i = 0; i <= segments; i++) {
    const a = start + (sweep * i) / segments
    const p = addScaled(addScaled(center, basisU, radius * Math.cos(a)), v, radius * Math.sin(a))
    out.push(p[0], p[1], p[2])
  }
  return out
}
