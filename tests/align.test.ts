// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { parseSTL } from '../src/core/parsers/stl'
import { buildMeshGraph } from '../src/core/geometry/buildGraph'
import { mulberry32 } from '../src/core/fit/ransac'
import { alignFromPairs, autoAlign } from '../src/core/deviation/align'
import { computeDeviation, deviationStats, suggestRange } from '../src/core/deviation/deviation'
import { NominalSurface } from '../src/core/deviation/surface'
import {
  rigidApply,
  rigidCompose,
  rigidFromAxisAngle,
  rigidInvert,
  type Rigid,
} from '../src/core/deviation/rigid'
import type { MeshGraph, Vec3 } from '../src/core/types'
import { fixture } from './fixtures'

/** The furthest any point of the part ends up from where the other transform
 *  would have put it, in mm. Measured over the actual vertices rather than
 *  from a closed form, so a test never agrees with production code merely
 *  because both derive the answer the same way. */
function poseError(a: Rigid, b: Rigid, positions: Float32Array): number {
  const pa = new Float64Array(3)
  const pb = new Float64Array(3)
  const stride = Math.max(3, Math.floor(positions.length / 3 / 5000) * 3)
  let worst = 0
  for (let v = 0; v < positions.length; v += stride) {
    rigidApply(a, positions[v], positions[v + 1], positions[v + 2], pa)
    rigidApply(b, positions[v], positions[v + 1], positions[v + 2], pb)
    worst = Math.max(worst, Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]))
  }
  return worst
}

const NOMINAL = fixture('side bracket left.stl')
const SCAN = fixture('block-marius.stl')

function load(path: string): MeshGraph {
  const buf = readFileSync(path)
  return buildMeshGraph(
    parseSTL(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)),
  )
}

/** A full-range random pose: any orientation, displaced by a good fraction of
 *  the part's own size. The shipped files are already aligned in GOM, so
 *  without this the automatic match would never be asked a real question. */
function randomPose(rand: () => number, shift: number): Rigid {
  const axis: Vec3 = [rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1]
  const m = rigidFromAxisAngle(axis, (rand() - 0.5) * 2 * Math.PI)
  m.t[0] = (rand() - 0.5) * 2 * shift
  m.t[1] = (rand() - 0.5) * 2 * shift
  m.t[2] = (rand() - 0.5) * 2 * shift
  return m
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

describe.skipIf(!NOMINAL.exists)('best fit to a nominal part', () => {
  // Loaded in beforeAll rather than the describe body: the body runs during
  // collection even when the suite is skipped, so an eager load would throw
  // ENOENT wherever the fixture is absent.
  let nominalGraph: MeshGraph
  let surface: NominalSurface
  beforeAll(() => {
    nominalGraph = load(NOMINAL.path)
    surface = new NominalSurface(nominalGraph.positions, nominalGraph.indices)
  })

  it('recovers a random pose of the nominal against itself', () => {
    const rand = mulberry32(2024)
    for (let trial = 0; trial < 3; trial++) {
      const pose = randomPose(rand, surface.bboxDiagonal * 0.3)
      const result = autoAlign(
        surface,
        moved(nominalGraph.positions, pose),
        rotated(nominalGraph.normals, pose),
        { fineSamples: 8000 },
      )
      // The scan here *is* the nominal, so a correct fit is exact.
      expect(result.meanDistance).toBeLessThan(0.01)
      expect(
        poseError(result.transform, rigidInvert(pose), moved(nominalGraph.positions, pose)),
      ).toBeLessThan(0.05)
    }
  })

  it('solves from three hand-picked pairs and refuses a collinear pick', () => {
    const rand = mulberry32(77)
    const pose = randomPose(rand, surface.bboxDiagonal * 0.3)
    const scanPositions = moved(nominalGraph.positions, pose)
    const scanNormals = rotated(nominalGraph.normals, pose)

    // Four well-spread vertices, "clicked" on both parts, with the sort of
    // slop a hand-placed point has.
    const picks = [0, 5000, 11_000, 17_000].map((v) => v % nominalGraph.vertexCount)
    const jitter = (): number => (rand() - 0.5) * 1.5
    const pairs = picks.map((v) => ({
      scan: [
        scanPositions[v * 3] + jitter(),
        scanPositions[v * 3 + 1] + jitter(),
        scanPositions[v * 3 + 2] + jitter(),
      ] as Vec3,
      nominal: [
        nominalGraph.positions[v * 3],
        nominalGraph.positions[v * 3 + 1],
        nominalGraph.positions[v * 3 + 2],
      ] as Vec3,
    }))

    const result = alignFromPairs(surface, scanPositions, scanNormals, pairs, {
      fineSamples: 8000,
    })
    expect(result.source).toBe('points')
    expect(result.meanDistance).toBeLessThan(0.01)
    expect(poseError(result.transform, rigidInvert(pose), scanPositions)).toBeLessThan(0.05)

    expect(() =>
      alignFromPairs(surface, scanPositions, scanNormals, pairs.slice(0, 2)),
    ).toThrow(/at least three/i)
  })

  describe.skipIf(!SCAN.exists)('against the real scan', () => {
    let scanGraph: MeshGraph
    beforeAll(() => {
      scanGraph = load(SCAN.path)
    })

    it('recovers a random pose of the scan and measures the same part', () => {
      // Aligned in place first: the two files ship in a shared frame, so this
      // is the answer every perturbed run has to reproduce.
      const reference = autoAlign(surface, scanGraph.positions, scanGraph.normals, {
        fineSamples: 20_000,
      })
      const base = computeDeviation(surface, scanGraph.positions, reference.transform)
      const maxDistance = 3
      const baseStats = deviationStats(base, maxDistance, 0.2)
      console.log(
        `in place: rms ${reference.rms.toFixed(4)} mm over ${reference.matched}/${reference.sampled} pairs, ` +
          `map rms ${baseStats.rms.toFixed(4)} mm, ${baseStats.min.toFixed(3)} … ${baseStats.max.toFixed(3)} mm, ` +
          `matched ${baseStats.measured}/${baseStats.total}, suggested range ±${suggestRange(base, maxDistance)} mm`,
      )
      expect(baseStats.measured / baseStats.total).toBeGreaterThan(0.9)

      const rand = mulberry32(4242)
      for (let trial = 0; trial < 4; trial++) {
        const pose = randomPose(rand, surface.bboxDiagonal * 0.3)
        const result = autoAlign(
          surface,
          moved(scanGraph.positions, pose),
          rotated(scanGraph.normals, pose),
          { fineSamples: 20_000 },
        )
        // The recovered transform maps the *displaced* scan, so undo the
        // displacement before comparing it with the in-place answer.
        const err = poseError(
          rigidCompose(result.transform, pose),
          reference.transform,
          scanGraph.positions,
        )
        console.log(
          `trial ${trial}: recovered to ${err.toFixed(4)} mm of the in-place fit, ` +
            `rms ${result.rms.toFixed(4)} mm, ${result.iterations} passes` +
            (result.ambiguous ? ' (flagged ambiguous)' : ''),
        )
        // A displaced scan must land back on the same pose the in-place fit
        // found — well inside the deviation actually being measured.
        expect(err).toBeLessThan(0.05)
        expect(result.rms).toBeLessThan(reference.rms * 1.5 + 0.01)
      }
    })
  })
})
