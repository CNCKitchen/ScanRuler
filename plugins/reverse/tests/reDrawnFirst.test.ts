// SPDX-License-Identifier: AGPL-3.0-only
// A build's measuring done once: a face's area and centre kept by its hash
// and read again only where a step changed the face, a shape's volume kept
// by its handle, a loose box for a size — and the bodies handed over to be
// drawn before the faces of a body the build did not read are read.

import { describe, expect, it } from 'vitest'
import { Builder } from '../core/build'
import { ReKernel } from '../core/kernel'
import { readFace } from '../core/kernelOps'
import type { Shape } from '../core/kernelTypes'
import type { OcctLike } from '../core/occtTypes'
import { resolveFeatures } from '../core/resolve'
import { findRegions } from '../core/regions'
import type { Sketch } from '../core/sketch'
import { build, ctx, extrudeAll, rectangleSketch } from './reKit'

const kernelPromise = ReKernel.load()
const occtOf = (k: ReKernel) => (k as unknown as { occt: OcctLike }).occt
const shapeOf = (b: Builder, id: number) => (b as unknown as { bodies: ReadonlyMap<number, { shape: Shape }> }).bodies.get(id)!.shape

const a = rectangleSketch(1, 20, 10)
const box = [a, extrudeAll(2, a, 0, 10)]

/** The kernel's calls to measure a face's area, counted while `fn` runs. */
async function areasRead<T>(k: ReKernel, fn: () => Promise<T>): Promise<{ result: T; areas: number }> {
  const occt = occtOf(k)
  const was = occt.getSurfaceArea
  let areas = 0
  occt.getSurfaceArea = (s) => {
    areas++
    return was.call(occt, s)
  }
  try {
    return { result: await fn(), areas }
  } finally {
    occt.getSurfaceArea = was
  }
}

describe('a build measured once', () => {
  it('reads a face’s area and centre again only where a step changed it, and reads them right', async () => {
    const k = await kernelPromise
    const block = k.box([0, 0, 0], [20, 10, 10])
    const notch = k.box([5, 2, 8], [15, 8, 12])
    const first = await areasRead(k, async () => k.faces(block))
    expect(first.areas).toBe(6)
    expect((await areasRead(k, async () => k.faces(block))).areas).toBe(0)
    // A pocket in the top: the top made again and the pocket's five faces
    // new; the bottom and the four sides stand as they were.
    const cut = k.cut(block, notch)
    const { result: faces, areas } = await areasRead(k, async () => k.faces(cut))
    expect(faces).toHaveLength(11)
    expect(areas).toBe(6)
    const occt = occtOf(k)
    const handles = occt.getSubShapes(cut, 'face')
    try {
      const fresh = new Map(handles.map((h) => readFace(occt, h)).map((f) => [f.hash, f]))
      for (const f of faces) {
        expect(f.area).toBeCloseTo(fresh.get(f.hash)!.area, 9)
        f.centroid.forEach((c, i) => expect(c).toBeCloseTo(fresh.get(f.hash)!.centroid[i], 9))
      }
    } finally {
      for (const h of handles) occt.release(h)
    }
    k.release(block, notch, cut)
  })

  it('keeps a shape’s volume by its handle, and sizes a body by a box round its true one', async () => {
    const k = await kernelPromise
    const builder = new Builder(k)
    await build(builder, box)
    const shape = shapeOf(builder, 2)
    const occt = occtOf(k)
    const was = occt.getVolume
    let volumes = 0
    occt.getVolume = (s) => {
      volumes++
      return was.call(occt, s)
    }
    try {
      const copy = occt.copy(shape) as Shape
      expect(k.volume(copy)).toBeCloseTo(2000, 6)
      expect(k.isClosedSolid(copy)).toBe(true)
      expect(k.measuredVolume(copy)).toBeCloseTo(2000, 6)
      expect(volumes).toBe(1)
      k.release(copy)
    } finally {
      occt.getVolume = was
    }
    const loose = k.extent(shape)
    const tight = k.bounds(shape)
    for (let i = 0; i < 3; i++) {
      expect(loose.min[i]).toBeLessThanOrEqual(tight.min[i] + 1e-9)
      expect(loose.max[i]).toBeGreaterThanOrEqual(tight.max[i] - 1e-9)
    }
    builder.dispose()
  })

  it('hands a body over to be drawn before its faces are read, and reads them after', async () => {
    const builder = new Builder(await kernelPromise)
    const steps = resolveFeatures(box, ctx, (f) => findRegions(f.sketch))
    const sketches = new Map<number, Sketch>([[1, a.sketch]])
    const drawn = builder.buildDrawn(steps, (id) => sketches.get(id))
    expect(drawn.results.map((r) => r.status)).toEqual(['ok'])
    const [body] = drawn.bodies
    expect(body.mesh.indices.length).toBeGreaterThan(0)
    expect(body.volume).toBeCloseTo(2000, 6)
    expect(body.closed).toBe(true)
    expect(body.topology).toBeUndefined()
    const [read] = builder.topologiesOf([body.id])
    expect(read.key).toBe(body.key)
    expect(read.topology.faces).toHaveLength(6)
    expect(read.topology.edges).toHaveLength(12)
    // Read once, kept with the body: the build after hands it over with it,
    // at the same key.
    const again = builder.buildDrawn(steps, (id) => sketches.get(id))
    expect(again.bodies[0].key).toBe(body.key)
    expect(again.bodies[0].topology?.faces).toHaveLength(6)
    builder.dispose()
  })
})
