// SPDX-License-Identifier: AGPL-3.0-only
// A slice of the scan measured alone reads what the whole map reads there, directions included,
// which is what lets the map be cut up for several workers.
import { describe, expect, it } from 'vitest'
import { computeDeviation, scanNormalsSign } from '../src/core/deviation/deviation'
import { computeDeviationAuto } from '../src/core/deviation/parallel'
import { identityRigid } from '../src/core/deviation/rigid'
import { NominalSurface } from '../src/core/deviation/surface'

/** A sphere of radius R: positions, outward normals and indices. */
function sphere(R: number, nu: number, nv: number, inward = false) {
  const pos: number[] = []
  const nrm: number[] = []
  const idx: number[] = []
  for (let j = 0; j <= nv; j++) for (let i = 0; i < nu; i++) {
    const th = (Math.PI * j) / nv, ph = (2 * Math.PI * i) / nu
    const n = [Math.sin(th) * Math.cos(ph), Math.sin(th) * Math.sin(ph), Math.cos(th)]
    pos.push(R * n[0], R * n[1], R * n[2])
    nrm.push(...(inward ? n.map((x) => -x) : n))
  }
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const a = j * nu + i, b = j * nu + ((i + 1) % nu), c = (j + 1) * nu + ((i + 1) % nu), d = (j + 1) * nu + i
    if (inward) idx.push(a, c, b, a, d, c)
    else idx.push(a, b, c, a, c, d)
  }
  return { positions: new Float32Array(pos), normals: new Float32Array(nrm), indices: new Uint32Array(idx) }
}

describe('deviation slices', () => {
  const reference = sphere(50, 48, 24)
  const surface = new NominalSurface(reference.positions, reference.indices)
  // A scan of a thin shell: its outer skin faces the way the reference does, its inner skin faces away from it,
  // which sends those points into the facing search.
  const outer = sphere(50.1, 30, 15)
  const inner = sphere(48, 30, 15, true)
  const positions = new Float32Array([...outer.positions, ...inner.positions])
  const normals = new Float32Array([...outer.normals, ...inner.normals])
  const count = positions.length / 3
  const facing = (60 * Math.PI) / 180

  for (const [name, limit] of [['no facing limit', null], ['a facing limit', facing]] as const) {
    it(`slices put together equal the whole map, with ${name}`, () => {
      const wholeDirs = new Int8Array(count * 3)
      const whole = computeDeviation(surface, positions, identityRigid(), { directions: wholeDirs, normals, maxNormalDeviation: limit })
      // Settled once for the whole scan, as the caller of the slices does.
      const outward = limit === null ? 1 : scanNormalsSign(surface, positions, normals, identityRigid())
      const cuts = [0, 1, 123, 400, count - 1, count]
      const values = new Float32Array(count)
      const dirs = new Int8Array(count * 3)
      for (let k = 0; k + 1 < cuts.length; k++) {
        const len = cuts[k + 1] - cuts[k]
        const sliceDirs = new Int8Array(len * 3)
        const slice = computeDeviation(surface, positions, identityRigid(), {
          range: { from: cuts[k], to: cuts[k + 1] }, directions: sliceDirs, normals, maxNormalDeviation: limit, outward,
        })
        expect(slice.length).toBe(len)
        values.set(slice, cuts[k])
        dirs.set(sliceDirs, cuts[k] * 3)
      }
      for (let i = 0; i < count; i++) {
        if (Number.isNaN(whole[i])) expect(Number.isNaN(values[i])).toBe(true)
        else expect(values[i]).toBe(whole[i])
      }
      expect(dirs).toEqual(wholeDirs)
    })

    it(`the adaptive map, where there are no helpers, equals the whole map, with ${name}`, async () => {
      const wholeDirs = new Int8Array(count * 3)
      const whole = computeDeviation(surface, positions, identityRigid(), { directions: wholeDirs, normals, maxNormalDeviation: limit })
      const dirs = new Int8Array(count * 3)
      const got = await computeDeviationAuto(surface, positions, identityRigid(), { directions: dirs, normals, maxNormalDeviation: limit })
      expect(got.length).toBe(whole.length)
      for (let i = 0; i < count; i++) {
        if (Number.isNaN(whole[i])) expect(Number.isNaN(got[i])).toBe(true)
        else expect(got[i]).toBe(whole[i])
      }
      expect(dirs).toEqual(wholeDirs)
    })
  }

  it('the adaptive map of a scan large enough to be probed first covers every point, in the spans between probes too', async () => {
    const big = [sphere(50.1, 100, 50), sphere(48, 100, 50, true)]
    const bigPositions = new Float32Array([...big[0].positions, ...big[1].positions])
    const bigNormals = new Float32Array([...big[0].normals, ...big[1].normals])
    const bigCount = bigPositions.length / 3
    expect(bigCount).toBeGreaterThan(8 * 500 * 2)
    const wholeDirs = new Int8Array(bigCount * 3)
    const whole = computeDeviation(surface, bigPositions, identityRigid(), { directions: wholeDirs, normals: bigNormals, maxNormalDeviation: facing })
    const dirs = new Int8Array(bigCount * 3)
    const progress: number[] = []
    const got = await computeDeviationAuto(surface, bigPositions, identityRigid(), { directions: dirs, normals: bigNormals, maxNormalDeviation: facing, onProgress: (f) => progress.push(f) })
    for (let i = 0; i < bigCount; i++) {
      if (Number.isNaN(whole[i])) expect(Number.isNaN(got[i])).toBe(true)
      else expect(got[i]).toBe(whole[i])
    }
    expect(dirs).toEqual(wholeDirs)
    expect(progress.at(-1)).toBe(1)
    expect(Math.min(...progress)).toBeGreaterThanOrEqual(0)
  })

  it('a helper, which rebuilds the reference from its positions and reordered index, reads the same map', () => {
    const rebuilt = new NominalSurface(surface.positions, surface.index)
    for (const limit of [null, facing]) {
      const a = computeDeviation(surface, positions, identityRigid(), { normals, maxNormalDeviation: limit })
      const b = computeDeviation(rebuilt, positions, identityRigid(), { normals, maxNormalDeviation: limit })
      for (let i = 0; i < count; i++) {
        if (Number.isNaN(a[i])) expect(Number.isNaN(b[i])).toBe(true)
        else expect(b[i]).toBe(a[i])
      }
    }
  })

  it('actually exercises the facing search: some points are re-read against a surface that faces them', () => {
    const plain = computeDeviation(surface, positions, identityRigid(), { normals, maxNormalDeviation: null })
    const faced = computeDeviation(surface, positions, identityRigid(), { normals, maxNormalDeviation: facing })
    let differ = 0
    for (let i = 0; i < count; i++) if (!(plain[i] === faced[i]) && !(Number.isNaN(plain[i]) && Number.isNaN(faced[i]))) differ++
    expect(differ).toBeGreaterThan(0)
  })
})
