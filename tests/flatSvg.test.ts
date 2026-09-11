// SPDX-License-Identifier: AGPL-3.0-only
// The sheet as an SVG drawing: true scale, y down, edges as polylines and
// fits as their native shapes, turned as the sheet is shown.
import { describe, expect, it } from 'vitest'
import type { EdgeChains } from '../src/core/flat/edges'
import { fitCirclePoints, fitLinePoints, flatPoint } from '../src/core/flat/fit'
import { fitSplinePoints } from '../src/core/flat/spline'
import { buildFlatSvg, type FlatSvgInput } from '../src/core/flat/svg'
import type { FlatArcFit } from '../src/core/flat/types'

// Two chains in image pixels on a 1000 × 800 px image at 10 px/mm: an L in
// the lower left (image y up, as the detector reports it) and a short
// vertical run near the top.
const chains: EdgeChains = {
  points: new Float32Array([100, 100, 200, 100, 200, 200, 500, 700, 500, 600]),
  offsets: new Uint32Array([0, 3, 5]),
}

const arc = (start: number, sweep: number): FlatArcFit => ({
  kind: 'arc',
  center: [50, 40],
  radius: 10,
  start,
  sweep,
  sigma: 0,
  usedPoints: 0,
})

function input(over: Partial<FlatSvgInput> = {}): FlatSvgInput {
  return {
    bounds: { min: [0, 0], max: [100, 80] },
    chains,
    chainUnit: { x: 0.1, y: 0.1 },
    elements: [
      {
        fit: fitCirclePoints([
          [30, 40],
          [20, 50],
          [10, 40],
        ]),
        color: '#112233',
        name: 'Circle 1',
        value: 'Ø 20.000 mm',
      },
      {
        fit: fitLinePoints([
          [10, 10],
          [60, 10],
        ]),
        color: '#445566',
        name: 'Line 1',
        value: 'L 50.000 mm · 0.00°',
      },
      { fit: flatPoint([5, 5]), color: '#778899', name: 'Point <A> & "B"', value: 'X 5.000 · Y 5.000 mm' },
    ],
    alignDir: null,
    turns: 0,
    unit: 'mm',
    title: 'ScanRuler 2D measurement — part.png (1000 × 800 px)',
    scaleNote: 'Scale: CALIBRATED, 10.0000 px/mm',
    ...over,
  }
}

describe('buildFlatSvg', () => {
  it('is a true-scale drawing of the sheet, in millimetres, that says what it rests on', () => {
    const svg = buildFlatSvg(input())
    expect(svg.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
    expect(svg).toContain('width="100mm" height="80mm" viewBox="0 0 100 80"')
    expect(svg).toContain('<title>ScanRuler 2D measurement — part.png (1000 × 800 px)</title>')
    expect(svg).toContain('Scale: CALIBRATED, 10.0000 px/mm. One unit is one millimetre; y runs down')
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true)
  })

  it('draws every edge chain as a polyline in millimetres, y down', () => {
    const svg = buildFlatSvg(input())
    expect(svg).toContain('<g id="edges" fill="none" stroke="#11b5a5"')
    expect(svg).toContain('<polyline points="10,70 20,70 20,60"/>')
    expect(svg).toContain('<polyline points="50,10 50,20"/>')
    expect((svg.match(/<polyline /g) ?? []).length).toBe(2)
  })

  it('leaves the edge layer empty, not missing, when there are no chains', () => {
    const svg = buildFlatSvg(input({ chains: null, elements: [] }))
    expect(svg).toMatch(/<g id="edges"[^>]*>\n {2}<\/g>/)
    expect(svg).not.toContain('<polyline')
  })

  it('draws a circle, a line and a point as their native shapes', () => {
    const svg = buildFlatSvg(input())
    expect(svg).toContain('<circle cx="20" cy="40" r="10"/>')
    expect(svg).toContain('<line x1="10" y1="70" x2="60" y2="70"/>')
    // The point is a cross sized off the sheet's diagonal (128.06 × 0.006).
    expect(svg).toContain('<line x1="4.232" y1="75" x2="5.768" y2="75"/>')
    expect(svg).toContain('<line x1="5" y1="75.768" x2="5" y2="74.232"/>')
  })

  it('groups each element under its name and colour, escaped for XML', () => {
    const svg = buildFlatSvg(input())
    expect(svg).toContain('<g id="element-1" data-name="Circle 1" stroke="#112233">')
    expect(svg).toContain('<title>Circle 1 — Ø 20.000 mm</title>')
    expect(svg).toContain('data-name="Point &lt;A&gt; &amp; &quot;B&quot;"')
    expect(svg).not.toContain('<A>')
    // Labels ride in their own layer: the name above the reading.
    expect(svg).toMatch(
      /<g id="labels"[^>]*>[\s\S]*<tspan x="[\d.]+" dy="-1\.2em">Circle 1<\/tspan><tspan x="[\d.]+" dy="1\.2em">Ø 20\.000 mm<\/tspan>/,
    )
    // Nothing is filled: a closed polyline or a circle must not become a blob.
    expect(svg).toContain('<g id="elements" fill="none"')
  })

  it('draws an arc counter-clockwise from its start, the long way round past a half turn', () => {
    const el = (fit: FlatArcFit) => [{ fit, color: '#000', name: 'Arc 1', value: '' }]
    const quarter = buildFlatSvg(input({ elements: el(arc(0, Math.PI / 2)) }))
    // From (60, 40) on the sheet to (50, 50): on the page that is (60, 40) → (50, 30).
    expect(quarter).toContain('<path d="M 60 40 A 10 10 0 0 0 50 30"/>')
    const long = buildFlatSvg(input({ elements: el(arc(0, 1.5 * Math.PI)) }))
    expect(long).toContain('<path d="M 60 40 A 10 10 0 1 0 50 50"/>')
    const full = buildFlatSvg(input({ elements: el(arc(0.3, 2 * Math.PI)) }))
    expect(full).toContain('<circle cx="50" cy="40" r="10"/>')
    expect(full).not.toContain('<path')
  })

  it('draws a spline as its own cubic Béziers, closed with a Z', () => {
    const pts: [number, number][] = [
      [10, 10],
      [30, 20],
      [50, 10],
    ]
    const el = (closed: boolean) => [
      { fit: fitSplinePoints(pts, [null, null, null], closed), color: '#000', name: 'Spline 1', value: '' },
    ]
    const open = buildFlatSvg(input({ elements: el(false) })).match(/<path d="([^"]+)"/)![1]
    // From the first point, y down: (10, 10) on the sheet is (10, 70) on the page.
    expect(open.startsWith('M 10 70 C ')).toBe(true)
    expect((open.match(/ C /g) ?? []).length).toBe(2)
    expect(open.endsWith(' 50 70')).toBe(true)
    expect(open).not.toContain('Z')
    // Every number is a plain coordinate: no exponents, no transform.
    expect(open).toMatch(/^M( -?[\d.]+){2}( C( -?[\d.]+){6}){2}$/)
    const closed = buildFlatSvg(input({ elements: el(true) })).match(/<path d="([^"]+)"/)![1]
    expect((closed.match(/ C /g) ?? []).length).toBe(3)
    expect(closed.endsWith(' 10 70 Z')).toBe(true)
  })

  it('turns the drawing with the sheet', () => {
    // A quarter turn counter-clockwise stands the landscape sheet on end:
    // document +X runs up the page, and the sheet's origin lands bottom-right.
    const svg = buildFlatSvg(input({ turns: 1 }))
    expect(svg).toContain('width="80mm" height="100mm" viewBox="0 0 80 100"')
    expect(svg).toContain('<polyline points="70,90 70,80 60,80"/>')
    expect(svg).toContain('turned a quarter turn counter-clockwise')
    // Round the other way: the same corner lands top-left.
    const cw = buildFlatSvg(input({ turns: -1 }))
    expect(cw).toContain('<polyline points="10,10 10,20 20,20"/>')
    // Upside down keeps the format and flips both axes.
    const flipped = buildFlatSvg(input({ turns: 2 }))
    expect(flipped).toContain('width="100mm" height="80mm"')
    expect(flipped).toContain('<polyline points="90,10 80,10 80,20"/>')
    // A circle's shape is turn-invariant; only where it sits moves.
    expect(svg).toContain('<circle cx="40" cy="80" r="10"/>')
  })

  it('aligns the drawing to the part as the stage shows it', () => {
    // +X picked pointing straight up the scan: the sheet is shown a quarter
    // turn clockwise, and the drawing comes out exactly as a clockwise turn
    // would — the alignment snaps square, not nearly square.
    const aligned = buildFlatSvg(input({ alignDir: [0, 1] }))
    expect(aligned).toContain('width="80mm" height="100mm" viewBox="0 0 80 100"')
    expect(aligned).toContain('<polyline points="10,10 10,20 20,20"/>')
    expect(aligned).toContain('aligned to the part with its +X along the page')
    // Aligned along the diagonal, the drawing is the sheet's bounding box as
    // rolled, and the line that ran along the sheet's +X now runs along the
    // page's x — square to the part, not to the scanner.
    const d = Math.SQRT1_2
    const diagonal = buildFlatSvg(
      input({
        alignDir: [d, d],
        elements: [
          {
            fit: fitLinePoints([
              [10, 10],
              [20, 20],
            ]),
            color: '#445566',
            name: 'Line 1',
            value: 'L 14.142 mm · 0.00°',
          },
        ],
      }),
    )
    const w = Number(diagonal.match(/width="([\d.]+)mm"/)![1])
    expect(w).toBeCloseTo((100 + 80) * d, 2)
    const line = diagonal.match(/<line x1="([\d.-]+)" y1="([\d.-]+)" x2="([\d.-]+)" y2="([\d.-]+)"/)!
    expect(Number(line[2])).toBeCloseTo(Number(line[4]), 2)
    expect(Math.abs(Number(line[3]) - Number(line[1]))).toBeCloseTo(Math.hypot(10, 10), 2)
    // The turns still go on top of the alignment.
    const both = buildFlatSvg(input({ alignDir: [0, 1], turns: 1 }))
    expect(both).toContain('width="100mm" height="80mm" viewBox="0 0 100 80"')
    expect(both).toContain('<polyline points="10,70 20,70 20,60"/>')
    expect(both).toContain('aligned to the part with its +X along the page, turned a quarter turn counter-clockwise')
  })

  it('is in pixels, with no unit on the size, while nothing sets a scale', () => {
    const svg = buildFlatSvg(
      input({
        bounds: { min: [0, 0], max: [1000, 800] },
        chainUnit: { x: 1, y: 1 },
        unit: 'px',
        elements: [],
        scaleNote: 'Scale: UNCALIBRATED — no scale, all values in PIXELS',
      }),
    )
    expect(svg).toContain(
      '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="800" viewBox="0 0 1000 800">',
    )
    expect(svg).toContain('<polyline points="100,700 200,700 200,600"/>')
    expect(svg).toContain('One unit is one image pixel')
  })

  it('never prints a negative zero', () => {
    // A point on the sheet's top edge lands at y = 0 exactly; a hair below
    // zero after rounding must not read "-0".
    const svg = buildFlatSvg(
      input({
        chains: null,
        elements: [{ fit: flatPoint([0, 80.0000001]), color: '#000', name: 'P', value: '' }],
      }),
    )
    expect(svg).not.toContain('"-0"')
    expect(svg).toContain('y1="0"')
  })

  it('lays a section sheet out from its own bounds', () => {
    // A section's chains are millimetres already, on a sheet padded round the cut.
    const svg = buildFlatSvg(
      input({
        bounds: { min: [-30, -20], max: [30, 20] },
        chains: { points: new Float32Array([-10, -10, 10, -10, 10, 10]), offsets: new Uint32Array([0, 3]) },
        chainUnit: { x: 1, y: 1 },
        elements: [],
      }),
    )
    expect(svg).toContain('width="60mm" height="40mm"')
    expect(svg).toContain('<polyline points="20,30 40,30 40,10"/>')
  })
})
