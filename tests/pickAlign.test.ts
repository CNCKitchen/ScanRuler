// SPDX-License-Identifier: AGPL-3.0-only
// The picked-point best fit: the fallback for a part the automatic search gets
// wrong. Two things are tested here that the automatic path cannot show —
// restricting the refinement to surface the user selected, and being able to
// stop the fit part-way, which is what the generator form of the whole
// alignment pipeline exists for.

import { describe, expect, it } from 'vitest'
import {
  alignFromPairs,
  alignFromPairsSteps,
  autoAlignSteps,
  MIN_LOCAL_POINTS,
  type PointPair,
} from '../src/core/deviation/align'
import { NominalSurface } from '../src/core/deviation/surface'
import { rigidApply, rigidFromAxisAngle, rigidInvert, type Rigid } from '../src/core/deviation/rigid'
import { buildMeshGraph } from '../src/core/geometry/buildGraph'
import { boxMesh } from './helpers'
import type { Vec3 } from '../src/core/types'

const SIZE = 40
const GRID = 16
const HALF = SIZE / 2
/** Half a millimetre of developer spray on the three faces the scanner saw —
 *  the same contamination the local fine fit exists for, arriving here through
 *  a fit that was started from clicks instead of from a search. */
const PAINT = 0.5

function poseError(a: Rigid, b: Rigid, positions: Float32Array): number {
  const pa = new Float64Array(3)
  const pb = new Float64Array(3)
  let worst = 0
  for (let v = 0; v < positions.length; v += 3) {
    rigidApply(a, positions[v], positions[v + 1], positions[v + 2], pa)
    rigidApply(b, positions[v], positions[v + 1], positions[v + 2], pb)
    worst = Math.max(worst, Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]))
  }
  return worst
}

function moved(positions: Float32Array, pose: Rigid): Float32Array {
  const out = new Float32Array(positions.length)
  const p = new Float64Array(3)
  for (let v = 0; v < positions.length; v += 3) {
    rigidApply(pose, positions[v], positions[v + 1], positions[v + 2], p)
    out[v] = p[0]
    out[v + 1] = p[1]
    out[v + 2] = p[2]
  }
  return out
}

function rotated(normals: Float32Array, pose: Rigid): Float32Array {
  const out = new Float32Array(normals.length)
  const r = pose.r
  for (let v = 0; v < normals.length; v += 3) {
    const x = normals[v], y = normals[v + 1], z = normals[v + 2]
    out[v] = r[0] * x + r[1] * y + r[2] * z
    out[v + 1] = r[3] * x + r[4] * y + r[5] * z
    out[v + 2] = r[6] * x + r[7] * y + r[8] * z
  }
  return out
}

/** The vertex nearest a corner of the cube — where a person clicking on the
 *  part would land, near enough. */
function nearestVertex(positions: Float32Array, target: Vec3): number {
  let best = 0
  let bestDistance = Infinity
  for (let v = 0; v < positions.length / 3; v++) {
    const d = Math.hypot(
      positions[v * 3] - target[0],
      positions[v * 3 + 1] - target[1],
      positions[v * 3 + 2] - target[2],
    )
    if (d < bestDistance) {
      bestDistance = d
      best = v
    }
  }
  return best
}

const nominalGraph = buildMeshGraph({ kind: 'soup', positions: boxMesh(SIZE, GRID) })
const surface = new NominalSurface(nominalGraph.positions, nominalGraph.indices)

// The scan: the same cube, with the +X, +Y and +Z faces standing PAINT proud of
// nominal. Nothing else is wrong with it.
const scanGraph = buildMeshGraph({ kind: 'soup', positions: boxMesh(SIZE, GRID) })
const clean: number[] = []
for (let v = 0; v < scanGraph.vertexCount; v++) {
  let coated = false
  for (let axis = 0; axis < 3; axis++) {
    if (scanGraph.positions[v * 3 + axis] > HALF - 1e-6) {
      scanGraph.positions[v * 3 + axis] += PAINT
      coated = true
    }
  }
  if (!coated) clean.push(v)
}
const cleanVertices = Uint32Array.from(clean)

// A pose of the sort the scanner leaves behind, and the clicks that undo it:
// four corners of a tetrahedron, taken on the scan where it lies and on the
// reference where it belongs. The sprayed corners are half a millimetre out,
// which is exactly the accuracy a click has.
const pose = rigidFromAxisAngle([0.3, 1, 0.2] as Vec3, 0.05)
pose.t[0] = 1.4
pose.t[1] = -1.1
pose.t[2] = 0.8
const truth = rigidInvert(pose)
const positions = moved(scanGraph.positions, pose)
const normals = rotated(scanGraph.normals, pose)

const CORNERS: Vec3[] = [
  [-HALF, -HALF, -HALF],
  [HALF, -HALF, -HALF],
  [-HALF, HALF, -HALF],
  [-HALF, -HALF, HALF],
]
const pairs: PointPair[] = CORNERS.map((corner) => {
  const v = nearestVertex(nominalGraph.positions, corner)
  return {
    scan: [positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]] as Vec3,
    nominal: [
      nominalGraph.positions[v * 3],
      nominalGraph.positions[v * 3 + 1],
      nominalGraph.positions[v * 3 + 2],
    ] as Vec3,
  }
})

describe('best fit from picked points', () => {
  it('refines on the selected surface only, and lands where the whole scan cannot', () => {
    const selected = alignFromPairs(surface, positions, normals, pairs, {}, cleanVertices)
    const whole = alignFromPairs(surface, positions, normals, pairs, {})

    const selectedError = poseError(selected.transform, truth, positions)
    const wholeError = poseError(whole.transform, truth, positions)
    console.log(
      `selected surface: ${selectedError.toFixed(4)} mm from truth, ` +
        `whole scan: ${wholeError.toFixed(4)} mm`,
    )

    expect(selected.source).toBe('points')
    expect(selected.selected).toBe(cleanVertices.length)
    // Nothing selected is not the same statement as something selected: the
    // whole-scan fit must not claim a selection it never had.
    expect(whole.selected).toBeUndefined()
    // The clean faces are the part, so the fit on them is the truth. Including
    // the sprayed ones costs a share of the coat on each axis, because the fit
    // splits the difference between a face standing proud and the one opposite.
    expect(selectedError).toBeLessThan(0.05)
    expect(wholeError).toBeGreaterThan(PAINT / 4)
    expect(selectedError).toBeLessThan(wholeError / 3)
  })

  it('treats an empty selection as the whole scan', () => {
    const empty = alignFromPairs(surface, positions, normals, pairs, {}, new Uint32Array(0))
    const none = alignFromPairs(surface, positions, normals, pairs, {})
    expect(empty.selected).toBeUndefined()
    expect(empty.transform.t).toEqual(none.transform.t)
    expect(empty.rms).toBe(none.rms)
  })

  it('refuses a selection too small to place a part with', () => {
    const few = cleanVertices.slice(0, MIN_LOCAL_POINTS - 1)
    expect(() => alignFromPairs(surface, positions, normals, pairs, {}, few)).toThrow(
      /at least 50 selected points/,
    )
  })

  it('needs three pairs that are not in a line', () => {
    expect(() => alignFromPairs(surface, positions, normals, pairs.slice(0, 2), {})).toThrow(
      /three point pairs/,
    )
  })
})

describe('a fit that can be stopped', () => {
  // Every alignment is a generator underneath, so the worker can hand control
  // back between passes and hear the "stop" that would otherwise be stuck
  // behind a minute of arithmetic. What that has to buy: a seam often enough to
  // stop at, and exactly the same answer when nobody stops it.
  it('yields between passes and gives the same answer run straight through', () => {
    const steps = alignFromPairsSteps(surface, positions, normals, pairs, {}, cleanVertices)
    let seams = 0
    let step = steps.next()
    while (!step.done) {
      seams++
      step = steps.next()
    }
    // A picked-point fit is one ICP run, so the seams are its passes exactly —
    // which is the granularity a stop has to land at.
    expect(seams).toBe(step.value.iterations)
    expect(seams).toBeGreaterThan(1)
    expect(step.value.transform.t).toEqual(
      alignFromPairs(surface, positions, normals, pairs, {}, cleanVertices).transform.t,
    )
  })

  it('can be abandoned part-way, with no answer and nothing half-applied', () => {
    const steps = autoAlignSteps(surface, positions, normals, { coarseSamples: 300 })
    expect(steps.next().done).toBe(false)
    expect(steps.next().done).toBe(false)
    // What the worker does when the stop arrives: drop the generator. The
    // result it would have produced is simply never asked for.
    expect(steps.return(undefined as never).done).toBe(true)
    expect(steps.next().done).toBe(true)
  })
})
