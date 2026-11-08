// SPDX-License-Identifier: AGPL-3.0-only
// A wedge whose sides were meant to pass through a revolve's axis, its
// sketch rounded so they miss it by 1e-5 mm, cuts the revolve's cones in
// hyperbolas with semi-axes of that hair, centred on the cones' apexes far
// off the part (issue 97). OCCT reads them back as the straight edges they
// are and the file's check passed; Fusion drew a spike out to the apex.
// The export writes such an edge as the line it runs along, the file's
// check fails on one left in a file, and the body check names them. A
// plane well off the axis makes a hyperbola of a real size, left alone.

import { describe, expect, it, vi } from 'vitest'
import { ReKernel, type Shape } from '../core/kernel'
import type { LoopPiece } from '../core/kernelTypes'
import { smallConics, straightConics } from '../core/kernelStep'
import type { OcctLike } from '../core/occtTypes'

vi.setConfig({ testTimeout: 180_000 })

const kernelPromise = ReKernel.load()

/** The package behind the adapter, for what its writer does unaided. */
const occtOf = (k: ReKernel) => (k as unknown as { occt: OcctLike }).occt

type V = [number, number, number]
const poly = (p: V[]): LoopPiece[] => p.map((a, i) => ({ kind: 'line', a, b: p[(i + 1) % p.length] }))

/** A conical ring about Z — its cones' apexes at z 60 and 120, far above
 *  it — cut by a 60° wedge whose corner lies `off` from the axis, the
 *  sector cut out of a block. */
async function wedgeCut(off: number): Promise<{ k: ReKernel; part: Shape }> {
  const k = await kernelPromise
  const profile = k.face({ outer: poly([[10, 0, 0], [20, 0, 0], [15, 0, 30], [5, 0, 30]]), holes: [] })
  const ring = k.revolve(profile, [0, 0, 0], [0, 0, 1], 2 * Math.PI)
  const a = Math.PI / 3
  const corner: V = [off, -off, 0]
  const plan = k.face({ outer: poly([corner, [40, 1e-5, 0], [40 * Math.cos(a) + 2e-5, 40 * Math.sin(a), 0]]), holes: [] })
  const wedge = k.extrude(plan, [0, 0, 1], -5, 35)
  const sector = k.common(ring, wedge)
  const block = k.box([-30, -30, 2], [30, 30, 28])
  const part = k.cut(block, sector)
  k.release(profile, ring, plan, wedge, sector, block)
  return { k, part }
}

describe('an edge on a hyperbola a hair across', () => {
  it('the writer makes, and the file as written fails the check', async () => {
    const { k, part } = await wedgeCut(1e-5)
    const raw = occtOf(k).exportStep(part)
    const conics = smallConics(raw)
    expect(conics.length).toBeGreaterThan(0)
    for (const c of conics) {
      expect(c.kind).toBe('hyperbola')
      expect(c.size).toBeLessThan(1e-4)
      expect(c.straight).toBe(true)
      // Centred on an apex, far above the part.
      expect(c.centre[2]).toBeGreaterThan(50)
    }
    const check = k.verifyStep(raw, [part])
    expect(check.ok).toBe(false)
    expect(check.problems.join(' ')).toMatch(/on a hyperbola only [\d.e-]+ mm across/)
    expect(k.smallConics(part)).toHaveLength(conics.length)
    k.release(part)
  })

  it('is written as a line, and the file holds', async () => {
    const { k, part } = await wedgeCut(1e-5)
    const text = k.exportStep([part], [{ name: 'Part' }])
    expect(text).not.toMatch(/HYPERBOLA/)
    expect(smallConics(text)).toEqual([])
    const check = k.verifyStep(text, [part])
    expect(check.problems).toEqual([])
    expect(check.bodies[0].closed).toBe(true)
    expect(check.bodies[0].gap.max).toBeLessThan(1e-3)
    // Nothing named by the curves taken out is left behind.
    const ids = new Set([...text.matchAll(/^#(\d+)\s*=/gm)].map((m) => Number(m[1])))
    for (const m of text.matchAll(/#(\d+)(?!\d|\s*=)/g)) expect(ids.has(Number(m[1]))).toBe(true)
    k.release(part)
  })

  it('a plane well off the axis makes a hyperbola of a real size, left as it is', async () => {
    const { k, part } = await wedgeCut(3)
    const raw = occtOf(k).exportStep(part)
    expect(raw).toMatch(/HYPERBOLA/)
    expect(smallConics(raw)).toEqual([])
    expect(straightConics(raw)).toEqual({ text: raw, straightened: 0 })
    expect(k.verifyStep(k.exportStep([part], [{ name: 'Part' }]), [part]).problems).toEqual([])
    expect(k.smallConics(part)).toEqual([])
    k.release(part)
  })
})
