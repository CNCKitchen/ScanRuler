// SPDX-License-Identifier: AGPL-3.0-only
// The panel's text in inches: the list of edits and the cut's plane read in
// the units shown, while what is kept stays in millimetres — and with no
// units asked, as a command asks, everything reads mm as before.
import { describe, expect, it } from 'vitest'
import { scanEditFigure, scanEditText } from '../state/meshStore'
import { cutPlaneOf } from '../core/cutPlane'
import { typedLen } from '../ui/meshFormat'

describe('Mesh Tools text in inches', () => {
  it('writes a typed setting as its field shows it', () => {
    expect(typedLen(5.08, 'in')).toBe('0.2 in')
    expect(typedLen(2, 'in')).toBe('0.07874 in')
    expect(typedLen(5)).toBe('5 mm')
  })

  it('writes a reduction as the tolerance it held, or the figure it reached, rounded', () => {
    const held = { kind: 'reduce', tolerance: 0.05, held: true, p999: 0.0412345, triangles: 2000 } as const
    expect(scanEditText(held)).toBe('Reduced to within 0.05 mm')
    expect(scanEditText({ ...held, held: false, p999: 0.154908642414225 })).toBe('Reduced to within 0.155 mm')
    expect(scanEditText({ ...held, tolerance: 2.54 }, 'in')).toBe('Reduced to within 0.1 in')
    expect(scanEditFigure(held)).toBe('−2,000 △')
  })

  it('writes the list of edits in inches', () => {
    expect(scanEditText({ kind: 'pieces', minSize: 2.54, pieces: 3, triangles: 90 }, 'in')).toBe('Removed 3 islands under 0.1 in')
    expect(scanEditText({ kind: 'fill', maxSize: 5.08, mode: 'flat', holes: 1, triangles: 40 }, 'in')).toBe(
      'Filled 1 hole under 0.2 in, flat',
    )
    const smooth = { kind: 'smooth' as const, size: 2.54, limit: 0.254, maxMove: 0.0254 }
    expect(scanEditText(smooth, 'in')).toBe('Smoothed bumps under 0.1 in, within 0.01 in')
    expect(scanEditFigure(smooth, 'in')).toBe('≤ 0.0010 in')
    const shrink = { kind: 'offset' as const, distance: -0.254, maxMove: 0.3 }
    expect(scanEditText(shrink, 'in')).toBe('Shrank by 0.01 in')
    expect(scanEditFigure(shrink, 'in')).toBe('−0.0100 in')
    const bore = { kind: 'boolean' as const, op: 'subtract' as const, solid: 'Solid 2', removed: 40, added: 260, volume: -16387.064 }
    expect(scanEditFigure(bore, 'in')).toBe('−1.000 in³')
    const hollow = { kind: 'shell' as const, mode: 'hollow' as const, thickness: 2.54, triangles: 1800, cavities: 1, volume: 16387.064 }
    expect(scanEditText(hollow, 'in')).toBe('Hollowed with a 0.1 in wall')
    expect(scanEditFigure(hollow, 'in')).toBe('−1.000 in³')
    expect(scanEditText({ kind: 'shell', mode: 'thicken', thickness: 1.27, side: 'out', triangles: 4000 }, 'in')).toBe(
      'Thickened 0.05 in outward',
    )
  })

  it('names a cut kept in mm again in inches, and leaves one with no figure', () => {
    expect(scanEditText({ kind: 'cut', plane: 'XY plane, Z 12.7 mm', removed: 10, capped: 1, open: 0 }, 'in')).toBe(
      'Cut at XY plane, Z 0.5 in, closed flat',
    )
    expect(scanEditText({ kind: 'cut', plane: 'Plane 1 −25.4 mm', removed: 10, capped: 0, open: 0 }, 'in')).toBe('Cut at Plane 1 −1 in')
    expect(scanEditText({ kind: 'cut', plane: 'Plane 1', removed: 10, capped: 0, open: 0 }, 'in')).toBe('Cut at Plane 1')
    expect(scanEditText({ kind: 'cut', plane: 'XY plane, Z 12.7 mm', removed: 10, capped: 0, open: 0 })).toBe(
      'Cut at XY plane, Z 12.7 mm',
    )
  })

  it('names the cut plane in the units asked, and in mm without', () => {
    const plane = { id: 3, name: 'Plane 1', fit: { kind: 'plane', center: [0, 0, 2], normal: [0, 0, 1], basisU: [1, 0, 0] } as never }
    expect(cutPlaneOf('x', 12.7, false, 'minus', [], [0, 0, 0], 'in')!.label).toBe('YZ plane, X 0.5 in')
    expect(cutPlaneOf('x', 12.7, false, 'minus', [], [0, 0, 0])!.label).toBe('YZ plane, X 12.7 mm')
    expect(cutPlaneOf(3, -25.4, false, 'plus', [plane], [0, 0, 0], 'in')!.label).toBe('Plane 1 −1 in')
  })
})
