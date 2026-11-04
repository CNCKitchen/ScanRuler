// SPDX-License-Identifier: AGPL-3.0-only
import type { Vec3 } from '../../../src/core/types'

export interface BridgeStrokeSample {
  distance: number
  point: Vec3 | null
}

export function bridgeStrokePoints(samples: BridgeStrokeSample[], firstCount: number, secondCount: number): Vec3[] {
  if (!Number.isInteger(firstCount) || !Number.isInteger(secondCount) || firstCount < 2 || secondCount < 2 || firstCount + secondCount > 10) {
    throw new Error('Choose at least two points per side and no more than ten total.')
  }
  if (samples.length >= 4096) throw new Error('The drawn crossing is too long. Draw a shorter, direct crossing.')
  if (!samples.length || !samples[0].point || !samples[samples.length - 1].point) {
    throw new Error('Start and finish the line on existing surface, well back from the gap.')
  }
  const firstGap = samples.findIndex((sample) => sample.point === null)
  if (firstGap < 0) throw new Error('The line must cross a visible gap. Turn the view so the missing area is visible, then draw across it.')
  let otherSide = firstGap
  while (otherSide < samples.length && samples[otherSide].point === null) otherSide++
  if (samples.slice(otherSide).some((sample) => sample.point === null)) {
    throw new Error('The line crosses more than one gap. Draw across just one opening.')
  }
  const select = (side: BridgeStrokeSample[], count: number): Vec3[] => {
    const start = side[0].distance, span = side[side.length - 1].distance - start
    if (side.length < count || span < Math.max(12, (count - 1) * 4)) {
      throw new Error('Not enough existing surface was traced on each side. Extend the line farther back from both rims, or zoom in.')
    }
    return Array.from({ length: count }, (_, i) => {
      const target = start + span * i / (count - 1)
      const nearest = side.reduce((best, sample) => Math.abs(sample.distance - target) < Math.abs(best.distance - target) ? sample : best)
      if (!nearest.point) throw new Error('The crossing contains an unexpected gap in its surface samples. Draw it again.')
      return [...nearest.point]
    })
  }
  return [...select(samples.slice(0, firstGap), firstCount), ...select(samples.slice(otherSide), secondCount)]
}
