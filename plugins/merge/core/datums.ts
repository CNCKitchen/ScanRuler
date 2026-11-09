// SPDX-License-Identifier: AGPL-3.0-only
// A layer laid on the target by matching datums: the same features (a face,
// a bore, a point) fitted on both. Each side's datums define a frame through
// computeDatumAlignment; the pose is the layer's frame carried into the
// target's, T^-1 o L.
//
// Both sides are put through the same axis assignment (primary on z+,
// secondary on x+) whatever their specs say: the frame is only a go-between,
// and two sides labelled differently would otherwise disagree for no reason.
// A secondary datum is required on each side — without one nothing clocks the
// rotation about the primary's direction. Coordinates neither datum nor an
// origin point owns are zeroed at the primary's centre (computeDatumAlignment's
// centerOf). Left open (centerOf null) they would keep wherever each scan
// happened to sit in its own frame, and the two frames would disagree by that
// offset. So they agree only where the two primaries' centres are the same
// point of the part: a plane fitted on different patches of a face slides
// along it, and an origin point is what pins that down. That is acceptable
// because a datum pose is only a starting pose: alignDatums (layerAlign.ts)
// always follows it with refineLayer, which closes the slide along the free
// direction, and tries both signs of an axis datum, whose sign a fit does not
// fix and which would otherwise start the layer half a turn wrong.
//
// Pure numerics: no DOM, no Three.js.

import { computeDatumAlignment, type DatumSpec } from '../../../src/core/alignment'
import { rigidCompose, rigidInvert, type Rigid } from '../../../src/core/deviation/rigid'
import type { FitData } from '../../../src/core/types'

export interface DatumSet {
  primary: DatumSpec
  secondary: DatumSpec | null
  origin: FitData | null
}

export const UNDER_CONSTRAINED = 'Needs two datums on each side — one alone leaves the part free to turn or slide.'

function frameOf(s: DatumSet): Rigid | null {
  if (!s.secondary) return null
  try {
    return computeDatumAlignment({ fit: s.primary.fit, axis: 'z+' }, { fit: s.secondary.fit, axis: 'x+' }, s.origin, s.primary.fit.center)
  } catch {
    return null
  }
}

export function datumPose(layer: DatumSet, target: DatumSet): Rigid | { refused: string } {
  const l = frameOf(layer)
  const t = frameOf(target)
  if (!l || !t) return { refused: UNDER_CONSTRAINED }
  return rigidCompose(rigidInvert(t), l)
}
