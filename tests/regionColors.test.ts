// SPDX-License-Identifier: AGPL-3.0-only
// The vertex-colour compositor, exercised without a scene: the layers are
// bare scan, element tints, field map, preview, marking — and every mutation
// has to leave the buffer exactly as repainting from scratch would.
import { describe, expect, it } from 'vitest'
import { RegionColors, type Rgb } from '../src/viewer/regionColors'

const BASE: Rgb = [10, 20, 30]
const RED: Rgb = [200, 0, 0]
const GREEN: Rgb = [0, 200, 0]
const BLUE: Rgb = [0, 0, 200]

const N = 8

/** A compositor over a small scan, every vertex on the base colour. */
function setup(): { rc: RegionColors; colors: Uint8Array } {
  const colors = new Uint8Array(N * 3)
  for (let v = 0; v < N; v++) colors.set(BASE, v * 3)
  const rc = new RegionColors(BASE)
  rc.attach(colors)
  return { rc, colors }
}

function colorAt(colors: Uint8Array, v: number): Rgb {
  return [colors[v * 3], colors[v * 3 + 1], colors[v * 3 + 2]]
}

describe('element regions', () => {
  it('applyRegion tints exactly its region and clearElement restores base', () => {
    const { rc, colors } = setup()
    expect(rc.applyRegion(1, RED, Uint32Array.of(1, 2, 3))).toBe(true)
    expect(colorAt(colors, 0)).toEqual(BASE)
    expect(colorAt(colors, 2)).toEqual(RED)
    expect(rc.visibleOwnerAt(2)).toBe(1)
    expect(rc.visibleOwnerAt(0)).toBeNull()

    expect(rc.clearElement(1)).toBe(true)
    expect(colorAt(colors, 2)).toEqual(BASE)
    expect(rc.visibleOwnerAt(2)).toBeNull()
  })

  it('re-applying an element moves its region instead of leaking the old one', () => {
    const { rc, colors } = setup()
    rc.applyRegion(1, RED, Uint32Array.of(0, 1))
    rc.applyRegion(1, GREEN, Uint32Array.of(1, 2))
    expect(colorAt(colors, 0)).toEqual(BASE)
    expect(colorAt(colors, 1)).toEqual(GREEN)
    expect(colorAt(colors, 2)).toEqual(GREEN)
  })

  it('a hidden element keeps its ownership but loses its tint', () => {
    const { rc, colors } = setup()
    rc.applyRegion(1, RED, Uint32Array.of(1, 2))
    expect(rc.setHiddenRegions([1])).toBe(true)
    expect(colorAt(colors, 1)).toEqual(BASE)
    expect(rc.visibleOwnerAt(1)).toBeNull()
    expect(rc.setHiddenRegions([])).toBe(true)
    expect(colorAt(colors, 1)).toEqual(RED)
    expect(rc.visibleOwnerAt(1)).toBe(1)
  })
})

describe('preview region', () => {
  it('lays a tint without ownership and restores the element underneath', () => {
    const { rc, colors } = setup()
    rc.applyRegion(1, RED, Uint32Array.of(1, 2))
    expect(rc.setPreviewRegion(Uint32Array.of(2, 3), BLUE)).toBe(true)
    expect(colorAt(colors, 2)).toEqual(BLUE)
    expect(colorAt(colors, 3)).toEqual(BLUE)
    expect(rc.visibleOwnerAt(2)).toBe(1)

    rc.setPreviewRegion(null)
    expect(colorAt(colors, 2)).toEqual(RED)
    expect(colorAt(colors, 3)).toEqual(BASE)
  })

  it('lifting a preview over a hidden element leaves the tint hidden', () => {
    // The regression this module was split with: baseColorOf has to consult
    // the hidden set, or a lifted preview quietly switches a hidden element's
    // tint back on.
    const { rc, colors } = setup()
    rc.applyRegion(1, RED, Uint32Array.of(1, 2))
    rc.setHiddenRegions([1])
    rc.setPreviewRegion(Uint32Array.of(1, 2), BLUE)
    expect(colorAt(colors, 1)).toEqual(BLUE)
    rc.setPreviewRegion(null)
    expect(colorAt(colors, 1)).toEqual(BASE)
    expect(colorAt(colors, 2)).toEqual(BASE)
  })

  it('is refused while a field map owns the surface', () => {
    const { rc, colors } = setup()
    const field = new Uint8Array(N * 3).fill(99)
    rc.setFieldColors(field)
    expect(rc.setPreviewRegion(Uint32Array.of(0), BLUE)).toBe(false)
    expect(colorAt(colors, 0)).toEqual([99, 99, 99])
  })
})

describe('field maps', () => {
  it('covers everything, keeps bookkeeping live, and restores on the way back', () => {
    const { rc, colors } = setup()
    rc.applyRegion(1, RED, Uint32Array.of(1))
    const field = new Uint8Array(N * 3).fill(77)
    expect(rc.setFieldColors(field)).toBe(true)
    expect(colorAt(colors, 1)).toEqual([77, 77, 77])

    // Ownership recorded under the map: the region lands when the map lifts.
    rc.applyRegion(2, GREEN, Uint32Array.of(3))
    expect(colorAt(colors, 3)).toEqual([77, 77, 77])

    rc.setFieldColors(null)
    expect(colorAt(colors, 1)).toEqual(RED)
    expect(colorAt(colors, 3)).toEqual(GREEN)
    expect(colorAt(colors, 0)).toEqual(BASE)
  })
})

describe('the marking layer', () => {
  it('markVertex moves mask, count and colour together, both ways', () => {
    const { rc, colors } = setup()
    rc.setPaintColor(BLUE)
    rc.markVertex(4, false)
    rc.markVertex(5, false)
    expect(rc.paintCount).toBe(2)
    expect(colorAt(colors, 4)).toEqual(BLUE)
    // Marking twice is not two marks.
    rc.markVertex(4, false)
    expect(rc.paintCount).toBe(2)
    expect(Array.from(rc.paintedVertices())).toEqual([4, 5])

    rc.markVertex(4, true)
    expect(rc.paintCount).toBe(1)
    expect(colorAt(colors, 4)).toEqual(BASE)
  })

  it('erasing over an element hands the surface back to the element tint', () => {
    const { rc, colors } = setup()
    rc.applyRegion(1, RED, Uint32Array.of(1, 2))
    rc.setPaintColor(BLUE)
    rc.markVertex(1, false)
    expect(colorAt(colors, 1)).toEqual(BLUE)
    rc.markVertex(1, true)
    expect(colorAt(colors, 1)).toEqual(RED)
  })

  it('the marking rides above a repaint — field on, field off, still marked', () => {
    const { rc, colors } = setup()
    rc.setPaintColor(BLUE)
    rc.markVertex(0, false)
    const field = new Uint8Array(N * 3).fill(50)
    rc.setFieldColors(field)
    expect(colorAt(colors, 0)).toEqual(BLUE)
    rc.setFieldColors(null)
    expect(colorAt(colors, 0)).toEqual(BLUE)
  })

  it('the marking wins over a preview laid on the same vertices', () => {
    const { rc, colors } = setup()
    rc.setPaintColor(BLUE)
    rc.markVertex(3, false)
    rc.setPreviewRegion(Uint32Array.of(3), GREEN)
    expect(colorAt(colors, 3)).toEqual(BLUE)
  })

  it('clearPaint restores whatever sits underneath, marking included', () => {
    const { rc, colors } = setup()
    rc.applyRegion(1, RED, Uint32Array.of(1))
    rc.setPaintColor(BLUE)
    rc.setPaintedVertices(Uint32Array.of(0, 1))
    expect(rc.paintCount).toBe(2)
    expect(colorAt(colors, 0)).toEqual(BLUE)
    expect(colorAt(colors, 1)).toEqual(BLUE)

    expect(rc.clearPaint()).toBe(true)
    expect(rc.paintCount).toBe(0)
    expect(colorAt(colors, 0)).toEqual(BASE)
    expect(colorAt(colors, 1)).toEqual(RED)
    // Nothing marked: nothing to change.
    expect(rc.clearPaint()).toBe(false)
  })

  it('setPaintedVertices replaces the old marking and drops out-of-range indices', () => {
    const { rc } = setup()
    rc.setPaintColor(BLUE)
    rc.setPaintedVertices(Uint32Array.of(0, 1, 2))
    rc.setPaintedVertices(Uint32Array.of(5, 5, 99))
    expect(Array.from(rc.paintedVertices())).toEqual([5])
  })
})

describe('the bare-surface colour', () => {
  it('repaints unowned surface and leaves every reading alone', () => {
    const { rc, colors } = setup()
    const SLATE: Rgb = [23, 112, 176]
    rc.applyRegion(1, RED, Uint32Array.of(1))
    rc.setPaintColor(GREEN)
    rc.markVertex(4, false)

    expect(rc.setBaseColor(SLATE)).toBe(true)
    expect(colorAt(colors, 0)).toEqual(SLATE)
    expect(colorAt(colors, 1)).toEqual(RED)
    expect(colorAt(colors, 4)).toEqual(GREEN)
    // And the new colour is what erasing hands back.
    rc.markVertex(4, true)
    expect(colorAt(colors, 4)).toEqual(SLATE)
  })

  it('is recorded but not painted while a field map owns the surface', () => {
    const { rc, colors } = setup()
    const field = new Uint8Array(N * 3)
    for (let v = 0; v < N; v++) field.set(BLUE, v * 3)
    rc.setFieldColors(field)

    const SLATE: Rgb = [23, 112, 176]
    expect(rc.setBaseColor(SLATE)).toBe(false)
    expect(colorAt(colors, 0)).toEqual(BLUE)
    // Taking the map off is what shows it.
    rc.setFieldColors(null)
    expect(colorAt(colors, 0)).toEqual(SLATE)
  })

  it('is a no-op when the colour has not changed', () => {
    const { rc } = setup()
    expect(rc.setBaseColor([10, 20, 30])).toBe(false)
  })
})

describe('lifecycle', () => {
  it('clearAllRegions wipes ownership, tints and the pending preview', () => {
    const { rc, colors } = setup()
    rc.applyRegion(1, RED, Uint32Array.of(0))
    rc.applyRegion(2, GREEN, Uint32Array.of(1))
    rc.setPreviewRegion(Uint32Array.of(2), BLUE)
    expect(rc.clearAllRegions()).toBe(true)
    for (let v = 0; v < N; v++) expect(colorAt(colors, v)).toEqual(BASE)
    expect(rc.visibleOwnerAt(0)).toBeNull()
  })

  it('every mutator is a quiet no-op with no scan attached', () => {
    const rc = new RegionColors(BASE)
    expect(rc.ready).toBe(false)
    expect(rc.applyRegion(1, RED, Uint32Array.of(0))).toBe(false)
    expect(rc.clearElement(1)).toBe(false)
    expect(rc.clearAllRegions()).toBe(false)
    expect(rc.setPreviewRegion(Uint32Array.of(0), BLUE)).toBe(false)
    expect(rc.setFieldColors(new Uint8Array(3))).toBe(false)
    expect(rc.setPaintedVertices(Uint32Array.of(0))).toBe(false)
    expect(rc.paintedVertices().length).toBe(0)
    rc.markVertex(0, false) // nothing to mark on
    expect(rc.paintCount).toBe(0)
  })
})
