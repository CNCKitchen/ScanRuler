// SPDX-License-Identifier: AGPL-3.0-only
// Measuring a slice of the vertices gives what the whole measurement gives for them,
// which is what lets the work be cut up for several workers.
import { describe, expect, it } from 'vitest'
import { buildSolidIndex, computeThickness, type ThicknessOptions } from '../src/core/thickness/thickness'

/** Two concentric spheres, 2 mm apart: the inner one wound inwards. */
function shell(nu: number, nv: number) {
  const pos: number[] = []
  const idx: number[] = []
  const nrm: number[] = []
  for (const [R, flip] of [[50, false], [48, true]] as const) {
    const base = pos.length / 3
    for (let j = 0; j <= nv; j++) for (let i = 0; i < nu; i++) {
      const th = (Math.PI * j) / nv, ph = (2 * Math.PI * i) / nu
      const n = [Math.sin(th) * Math.cos(ph), Math.sin(th) * Math.sin(ph), Math.cos(th)]
      pos.push(R * n[0], R * n[1], R * n[2])
      nrm.push(...(flip ? n.map((x) => -x) : n))
    }
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
      const a = base + j * nu + i, b = base + j * nu + ((i + 1) % nu), c = base + (j + 1) * nu + ((i + 1) % nu), d = base + (j + 1) * nu + i
      if (flip) idx.push(a, c, b, a, d, c)
      else idx.push(a, b, c, a, c, d)
    }
  }
  return { positions: new Float32Array(pos), normals: new Float32Array(nrm), indices: new Uint32Array(idx) }
}

const options = (method: 'ray' | 'sphere', coneRays: number): ThicknessOptions => ({
  method, coneRays, coneAngle: (30 * Math.PI) / 180, maxNormalDeviation: (60 * Math.PI) / 180, maxThickness: 10, epsilon: 1e-3,
})

describe('thickness slices', () => {
  const { positions, normals, indices } = shell(60, 30)
  const bvh = buildSolidIndex(positions, indices)
  const count = positions.length / 3

  for (const [name, o] of [['ray', options('ray', 0)], ['cone', options('ray', 6)], ['sphere', options('sphere', 0)]] as const) {
    it(`slices of a ${name} measurement put together equal the whole`, () => {
      const whole = computeThickness(bvh, positions, normals, o)
      const cuts = [0, 1, 777, 1000, count - 1, count]
      const pieces = new Float32Array(count)
      for (let k = 0; k + 1 < cuts.length; k++) {
        const slice = computeThickness(bvh, positions, normals, o, undefined, { from: cuts[k], to: cuts[k + 1] })
        expect(slice.length).toBe(cuts[k + 1] - cuts[k])
        pieces.set(slice, cuts[k])
      }
      expect(pieces.length).toBe(whole.length)
      for (let i = 0; i < count; i++) {
        // NaN is a vertex with nothing behind it; the same ones in both.
        if (Number.isNaN(whole[i])) expect(Number.isNaN(pieces[i])).toBe(true)
        else expect(pieces[i]).toBe(whole[i])
      }
    })
  }
})
