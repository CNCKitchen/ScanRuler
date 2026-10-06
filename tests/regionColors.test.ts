// SPDX-License-Identifier: AGPL-3.0-only
// The vertex-colour compositor, exercised without a scene: the layers are
// bare scan, element tints, field map, preview — and every mutation has to
// leave the buffer exactly as repainting from scratch would. The marking is a
// layer apart: a mask the shader tints, never a colour in the buffer. The tint
// mask rides beside the colours and has to say, at every vertex, whether the
// colour there is the bare scan's or a tint of its own.
import { describe, expect, it } from 'vitest'
import { RegionColors, type Rgb } from '../src/viewer/regionColors'

const BASE: Rgb = [10, 20, 30]
const RED: Rgb = [200, 0, 0]
const GREEN: Rgb = [0, 200, 0]
const BLUE: Rgb = [0, 0, 200]

const N = 8

/** A compositor over a small scan, every vertex on the base colour. */
function setup(): { rc: RegionColors; colors: Uint8Array; paint: Uint8Array; tint: Uint8Array } {
  const colors = new Uint8Array(N * 3)
  for (let v = 0; v < N; v++) colors.set(BASE, v * 3)
  const paint = new Uint8Array(N)
  const tint = new Uint8Array(N).fill(7) // stale bytes from a previous scan
  const rc = new RegionColors(BASE)
  rc.attach(colors, paint, tint)
  return { rc, colors, paint, tint }
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

describe('a field map on a scan with shading copies', () => {
  it('is a reading per vertex of the scan, the copies past them left to the scene', () => {
    // Eight vertices of the scan and three copies split off at sharp edges.
    const COPIES = 3
    const colors = new Uint8Array((N + COPIES) * 3)
    for (let v = 0; v < N + COPIES; v++) colors.set(BASE, v * 3)
    const rc = new RegionColors(BASE)
    rc.attach(colors, new Uint8Array(N + COPIES), new Uint8Array(N + COPIES), N)
    expect(rc.setFieldColors(new Uint8Array(N * 3).fill(77))).toBe(true)
    expect(colorAt(colors, 0)).toEqual([77, 77, 77])
    expect(colorAt(colors, N - 1)).toEqual([77, 77, 77])
    // A map the length of the whole buffer is some other layout's.
    rc.setFieldColors(new Uint8Array((N + COPIES) * 3).fill(55))
    expect(colorAt(colors, 0)).toEqual(BASE)
  })
})

describe('the sparse map', () => {
  it('paints its vertices only, over the element tints, and lifts cleanly', () => {
    const { rc, colors, tint } = setup()
    rc.applyRegion(1, RED, Uint32Array.of(1, 2))
    const rgb = new Uint8Array([9, 9, 9, 5, 5, 5])
    expect(rc.setSparseField(Uint32Array.of(2, 5), rgb)).toBe(true)
    expect(colorAt(colors, 2)).toEqual([9, 9, 9])
    expect(colorAt(colors, 5)).toEqual([5, 5, 5])
    expect(colorAt(colors, 1)).toEqual(RED)
    expect(colorAt(colors, 0)).toEqual(BASE)
    expect(tint[5]).toBe(1)
    expect(tint[0]).toBe(0)
    // A new subset gives the vertices it dropped their colour back.
    expect(rc.setSparseField(Uint32Array.of(6), new Uint8Array([1, 2, 3]))).toBe(true)
    expect(colorAt(colors, 2)).toEqual(RED)
    expect(colorAt(colors, 5)).toEqual(BASE)
    expect(tint[5]).toBe(0)
    expect(colorAt(colors, 6)).toEqual([1, 2, 3])
    expect(rc.setSparseField(null, null)).toBe(true)
    expect(colorAt(colors, 6)).toEqual(BASE)
    expect(rc.setSparseField(null, null)).toBe(false)
  })

  it('is put back on top by a repaint underneath it', () => {
    const { rc, colors } = setup()
    rc.setSparseField(Uint32Array.of(3), new Uint8Array([7, 7, 7]))
    rc.applyRegion(1, GREEN, Uint32Array.of(3, 4))
    expect(colorAt(colors, 3)).toEqual([7, 7, 7])
    expect(colorAt(colors, 4)).toEqual(GREEN)
    rc.setHiddenRegions([1])
    expect(colorAt(colors, 3)).toEqual([7, 7, 7])
    expect(colorAt(colors, 4)).toEqual(BASE)
    rc.setBaseColor([1, 1, 1])
    expect(colorAt(colors, 3)).toEqual([7, 7, 7])
  })

  it('waits under a full map and lands when the map lifts', () => {
    const { rc, colors } = setup()
    rc.setFieldColors(new Uint8Array(N * 3).fill(77))
    expect(rc.setSparseField(Uint32Array.of(1), new Uint8Array([8, 8, 8]))).toBe(false)
    expect(colorAt(colors, 1)).toEqual([77, 77, 77])
    rc.setFieldColors(null)
    expect(colorAt(colors, 1)).toEqual([8, 8, 8])
    expect(colorAt(colors, 0)).toEqual(BASE)
  })

  it('ignores a subset whose colours do not match it', () => {
    const { rc, colors } = setup()
    expect(rc.setSparseField(Uint32Array.of(1, 2), new Uint8Array([1, 2, 3]))).toBe(false)
    expect(colorAt(colors, 1)).toEqual(BASE)
  })
})

describe('the marking layer', () => {
  it('markVertex moves mask and count together, both ways, never the colours', () => {
    const { rc, colors, paint } = setup()
    rc.markVertex(4, false)
    rc.markVertex(5, false)
    expect(rc.paintCount).toBe(2)
    expect(paint[4]).toBe(1)
    // The tint is the shader's: the colour buffer stays what lies underneath.
    expect(colorAt(colors, 4)).toEqual(BASE)
    // Marking twice is not two marks.
    rc.markVertex(4, false)
    expect(rc.paintCount).toBe(2)
    expect(Array.from(rc.paintedVertices())).toEqual([4, 5])

    rc.markVertex(4, true)
    expect(rc.paintCount).toBe(1)
    expect(paint[4]).toBe(0)
  })

  it('the marking rides above a repaint — field on, field off, still marked', () => {
    const { rc, colors, paint } = setup()
    rc.markVertex(0, false)
    const field = new Uint8Array(N * 3).fill(50)
    rc.setFieldColors(field)
    expect(paint[0]).toBe(1)
    expect(colorAt(colors, 0)).toEqual([50, 50, 50])
    rc.setFieldColors(null)
    expect(paint[0]).toBe(1)
    expect(rc.paintCount).toBe(1)
  })

  it('a preview under the marking moves the colours, not the mask', () => {
    const { rc, colors, paint } = setup()
    rc.markVertex(3, false)
    rc.setPreviewRegion(Uint32Array.of(3), GREEN)
    expect(colorAt(colors, 3)).toEqual(GREEN)
    expect(paint[3]).toBe(1)
  })

  it('clearPaint wipes the mask and leaves every colour where it was', () => {
    const { rc, colors, paint } = setup()
    rc.applyRegion(1, RED, Uint32Array.of(1))
    rc.setPaintedVertices(Uint32Array.of(0, 1))
    expect(rc.paintCount).toBe(2)
    expect(paint[0]).toBe(1)
    expect(paint[1]).toBe(1)

    expect(rc.clearPaint()).toBe(true)
    expect(rc.paintCount).toBe(0)
    expect(paint[0]).toBe(0)
    expect(colorAt(colors, 0)).toEqual(BASE)
    expect(colorAt(colors, 1)).toEqual(RED)
    // Nothing marked: nothing to upload.
    expect(rc.clearPaint()).toBe(false)
  })

  it('setPaintedVertices replaces the old marking and drops out-of-range indices', () => {
    const { rc } = setup()
    rc.setPaintedVertices(Uint32Array.of(0, 1, 2))
    rc.setPaintedVertices(Uint32Array.of(5, 5, 99))
    expect(Array.from(rc.paintedVertices())).toEqual([5])
  })

  // A strip of six triangles over the eight vertices, top row even, bottom
  // row odd:  0 2 4 6
  //           1 3 5 7
  const STRIP = [0, 1, 2, 2, 1, 3, 2, 3, 4, 4, 3, 5, 4, 5, 6, 6, 5, 7]
  const same = (v: number) => v
  /** The triangles that show as marked — all three corners in the mask. */
  const shown = (paint: Uint8Array, index: number[]) => {
    const out: number[] = []
    for (let f = 0; f < index.length; f += 3) {
      if (paint[index[f]] && paint[index[f + 1]] && paint[index[f + 2]]) out.push(f / 3)
    }
    return out
  }

  it('invertPaint swaps marked and bare, never overlapping what was marked', () => {
    const { rc, paint } = setup()
    rc.setPaintedVertices(Uint32Array.of(0, 1, 2, 3))
    expect(shown(paint, STRIP)).toEqual([0, 1])

    expect(rc.invertPaint(STRIP, same)).toBe(true)
    expect(Array.from(rc.paintedVertices())).toEqual([4, 5, 6, 7])
    expect(rc.paintCount).toBe(4)
    // Triangles 2 and 3 straddle the border and show bare both ways; none of
    // the triangles marked before is marked after.
    expect(shown(paint, STRIP)).toEqual([4, 5])

    // And back: inverting twice is exactly where it started.
    rc.invertPaint(STRIP, same)
    expect(Array.from(rc.paintedVertices())).toEqual([0, 1, 2, 3])
    expect(shown(paint, STRIP)).toEqual([0, 1])
  })

  it('invertPaint leaves a point on no triangle bare', () => {
    const { rc } = setup()
    // The strip's first four triangles, which never reach 6 or 7.
    rc.invertPaint(STRIP.slice(0, 12), same)
    expect(Array.from(rc.paintedVertices())).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('invertPaint keys the marking by the scan vertex behind a render index', () => {
    // Eight scan vertices and one shading copy past them: render vertex 8 is
    // vertex 2 again.
    const colors = new Uint8Array(9 * 3)
    const paint = new Uint8Array(9)
    const rc = new RegionColors(BASE)
    rc.attach(colors, paint, new Uint8Array(9), 8)
    const own = (v: number) => (v === 8 ? 2 : v)
    expect(rc.invertPaint([0, 1, 8, 2, 1, 3], own)).toBe(true)
    // The copy wears what its vertex wears, and is not counted twice.
    expect(paint[8]).toBe(1)
    expect(rc.paintCount).toBe(4)
    expect(Array.from(rc.paintedVertices())).toEqual([0, 1, 2, 3])
    rc.invertPaint([0, 1, 8, 2, 1, 3], own)
    expect(paint[2]).toBe(0)
    expect(paint[8]).toBe(0)
    expect(rc.paintCount).toBe(0)
  })

  it('invertPaint has nothing to turn once the scan is gone', () => {
    const { rc } = setup()
    rc.detach()
    expect(rc.invertPaint(STRIP, same)).toBe(false)
  })
})

describe('the bare-surface colour', () => {
  it('repaints unowned surface and leaves every reading alone', () => {
    const { rc, colors, paint } = setup()
    const SLATE: Rgb = [23, 112, 176]
    rc.applyRegion(1, RED, Uint32Array.of(1))
    rc.markVertex(4, false)

    expect(rc.setBaseColor(SLATE)).toBe(true)
    expect(colorAt(colors, 0)).toEqual(SLATE)
    expect(colorAt(colors, 1)).toEqual(RED)
    // A marked vertex wears the new base underneath — the marking is a mask
    // over it, not a colour of its own.
    expect(colorAt(colors, 4)).toEqual(SLATE)
    expect(paint[4]).toBe(1)
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

describe('the tint mask', () => {
  /** The invariant the shader relies on: a vertex is flagged exactly when its
   *  colour is not the bare scan's. Checked against the colour buffer itself. */
  function expectMaskMatchesColors(colors: Uint8Array, tint: Uint8Array): void {
    for (let v = 0; v < N; v++) {
      const bare = colorAt(colors, v).every((c, i) => c === BASE[i])
      expect(tint[v], `vertex ${v}`).toBe(bare ? 0 : 1)
    }
  }

  it('starts clear on attach, whatever the buffer held', () => {
    const { tint } = setup()
    expect(Array.from(tint)).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  })

  it('flags exactly the region an element tints, and clears with it', () => {
    const { rc, colors, tint } = setup()
    rc.applyRegion(1, RED, Uint32Array.of(1, 2, 3))
    expect(Array.from(tint)).toEqual([0, 1, 1, 1, 0, 0, 0, 0])
    expectMaskMatchesColors(colors, tint)
    rc.applyRegion(1, GREEN, Uint32Array.of(3, 4))
    expect(Array.from(tint)).toEqual([0, 0, 0, 1, 1, 0, 0, 0])
    rc.clearElement(1)
    expect(Array.from(tint)).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
    expectMaskMatchesColors(colors, tint)
  })

  it('follows a hidden element off the surface and back on', () => {
    const { rc, colors, tint } = setup()
    rc.applyRegion(1, RED, Uint32Array.of(1, 2))
    rc.applyRegion(2, GREEN, Uint32Array.of(5))
    rc.setHiddenRegions([1])
    expect(Array.from(tint)).toEqual([0, 0, 0, 0, 0, 1, 0, 0])
    expectMaskMatchesColors(colors, tint)
    rc.setHiddenRegions([])
    expect(Array.from(tint)).toEqual([0, 1, 1, 0, 0, 1, 0, 0])
  })

  it('flags a preview, and lifting it hands each vertex back to what lies under', () => {
    const { rc, colors, tint } = setup()
    rc.applyRegion(1, RED, Uint32Array.of(1, 2))
    rc.setPreviewRegion(Uint32Array.of(2, 3), BLUE)
    expect(Array.from(tint)).toEqual([0, 1, 1, 1, 0, 0, 0, 0])
    rc.setPreviewRegion(null)
    expect(Array.from(tint)).toEqual([0, 1, 1, 0, 0, 0, 0, 0])
    expectMaskMatchesColors(colors, tint)

    // Over a hidden element the lifted preview leaves bare scan behind.
    rc.setHiddenRegions([1])
    rc.setPreviewRegion(Uint32Array.of(1, 2), BLUE)
    expect(Array.from(tint)).toEqual([0, 1, 1, 0, 0, 0, 0, 0])
    rc.setPreviewRegion(null)
    expect(Array.from(tint)).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
    expectMaskMatchesColors(colors, tint)
  })

  it('a measured map flags every vertex, so the map stays smooth; lifting it rebuilds from the elements', () => {
    const { rc, colors, tint } = setup()
    rc.applyRegion(1, RED, Uint32Array.of(1))
    rc.setFieldColors(new Uint8Array(N * 3).fill(77))
    expect(Array.from(tint)).toEqual([1, 1, 1, 1, 1, 1, 1, 1])
    // Recorded under the map, flagged when it lifts.
    rc.applyRegion(2, GREEN, Uint32Array.of(6))
    expect(Array.from(tint)).toEqual([1, 1, 1, 1, 1, 1, 1, 1])
    rc.setFieldColors(null)
    expect(Array.from(tint)).toEqual([0, 1, 0, 0, 0, 0, 1, 0])
    expectMaskMatchesColors(colors, tint)
  })

  it('clearAllRegions wipes it with the tints', () => {
    const { rc, tint } = setup()
    rc.applyRegion(1, RED, Uint32Array.of(0, 1))
    rc.setPreviewRegion(Uint32Array.of(2), BLUE)
    rc.clearAllRegions()
    expect(Array.from(tint)).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  })

  it('is untouched by the marking and by a new bare colour', () => {
    const { rc, colors, tint } = setup()
    rc.applyRegion(1, RED, Uint32Array.of(1))
    rc.markVertex(1, false)
    rc.markVertex(4, false)
    expect(Array.from(tint)).toEqual([0, 1, 0, 0, 0, 0, 0, 0])
    rc.clearPaint()
    expect(Array.from(tint)).toEqual([0, 1, 0, 0, 0, 0, 0, 0])
    rc.setBaseColor([23, 112, 176])
    expect(Array.from(tint)).toEqual([0, 1, 0, 0, 0, 0, 0, 0])
    // Still one flag per tinted vertex, against the new bare colour.
    for (let v = 0; v < N; v++) {
      const bare = colorAt(colors, v).every((c, i) => c === [23, 112, 176][i])
      expect(tint[v]).toBe(bare ? 0 : 1)
    }
  })
})

describe('trading states', () => {
  it('swaps everything with another compositor, and back', () => {
    const scan = setup()
    scan.rc.applyRegion(1, RED, Uint32Array.from([0, 1, 2]))
    scan.rc.markVertex(5, false)
    // The copy: a mesh of its own, bare, with a marking of its own.
    const copyColors = new Uint8Array(4 * 3)
    for (let v = 0; v < 4; v++) copyColors.set(BASE, v * 3)
    const copyPaint = new Uint8Array(4)
    const copyTint = new Uint8Array(4)
    const copy = new RegionColors(BASE)
    copy.attach(copyColors, copyPaint, copyTint)
    copy.markVertex(3, false)
    copy.markVertex(2, false)

    scan.rc.exchange(copy)
    // The compositor the marking holds now speaks for the copy…
    expect(scan.rc.paintCount).toBe(2)
    expect(Array.from(scan.rc.paintedVertices())).toEqual([2, 3])
    expect(scan.rc.visibleOwnerAt(0)).toBeNull()
    // …and the other one keeps the scan's, painting into the scan's buffers.
    expect(copy.visibleOwnerAt(0)).toBe(1)
    copy.applyRegion(2, GREEN, Uint32Array.from([6]))
    expect(colorAt(scan.colors, 6)).toEqual(GREEN)
    expect(Array.from(copyColors.subarray(0, 3))).toEqual([...BASE])

    scan.rc.exchange(copy)
    expect(scan.rc.visibleOwnerAt(6)).toBe(2)
    expect(scan.rc.paintCount).toBe(1)
    expect(colorAt(scan.colors, 0)).toEqual(RED)
  })
})
