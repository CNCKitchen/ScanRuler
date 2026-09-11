// SPDX-License-Identifier: AGPL-3.0-only
// The sheet as a DXF: an AutoCAD 2000 file in millimetres, y up, the origin
// on the alignment, every fit as its own entity and the edges as thinned
// polylines on layers of their own.
import { describe, expect, it } from 'vitest'
import { buildFlatDxf, dxfText, type FlatDxfInput } from '../src/core/flat/dxf'
import type { EdgeChains } from '../src/core/flat/edges'
import { fitCirclePoints, fitLinePoints, flatPoint } from '../src/core/flat/fit'
import { fitSplinePoints } from '../src/core/flat/spline'
import type { FlatArcFit } from '../src/core/flat/types'

// Two chains in image pixels on a 1000 × 800 px image at 10 px/mm: an L in
// the lower left and a short vertical run near the top.
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

function input(over: Partial<FlatDxfInput> = {}): FlatDxfInput {
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
      { fit: flatPoint([5, 5]), color: '#778899', name: 'Point 1', value: 'X 5.000 · Y 5.000 mm' },
    ],
    alignDir: null,
    turns: 0,
    unit: 'mm',
    title: 'ScanRuler 2D measurement — part.png (1000 × 800 px)',
    scaleNote: 'Scale: CALIBRATED, 10.0000 px/mm',
    origin: null,
    edgeTolerance: 0,
    ...over,
  }
}

type Group = [number, string]
interface Entity {
  type: string
  g: Group[]
}

/** The file as code/value pairs. */
function groups(dxf: string): Group[] {
  const lines = dxf.split('\n')
  const out: Group[] = []
  for (let i = 0; i + 1 < lines.length; i += 2) out.push([Number(lines[i]), lines[i + 1]])
  return out
}

/** The entities of the ENTITIES section. */
function entities(dxf: string): Entity[] {
  const gs = groups(dxf)
  const start = gs.findIndex(([c, v]) => c === 2 && v === 'ENTITIES')
  const out: Entity[] = []
  for (let i = start + 1; i < gs.length; i++) {
    const [c, v] = gs[i]
    if (c === 0 && v === 'ENDSEC') break
    if (c === 0) out.push({ type: v, g: [] })
    else out[out.length - 1].g.push(gs[i])
  }
  return out
}

const val = (e: Entity, code: number): string | undefined => e.g.find(([c]) => c === code)?.[1]
const vals = (e: Entity, code: number): string[] => e.g.filter(([c]) => c === code).map(([, v]) => v)
const ofType = (dxf: string, type: string): Entity[] => entities(dxf).filter((e) => e.type === type)

/** A header variable's first value. */
function headerVar(dxf: string, name: string): string | undefined {
  const gs = groups(dxf)
  const i = gs.findIndex(([c, v]) => c === 9 && v === name)
  return i >= 0 ? gs[i + 1][1] : undefined
}

describe('buildFlatDxf', () => {
  it('is an AutoCAD 2000 file in millimetres that says what it rests on', () => {
    const dxf = buildFlatDxf(input())
    expect(headerVar(dxf, '$ACADVER')).toBe('AC1015')
    expect(headerVar(dxf, '$INSUNITS')).toBe('4')
    expect(headerVar(dxf, '$EXTMIN')).toBe('0')
    expect(headerVar(dxf, '$EXTMAX')).toBe('100')
    // The traceability line rides in comments at the top, in plain ASCII.
    expect(dxf.startsWith('999\nScanRuler 2D measurement - part.png (1000 x 800 px)\n999\nScale: CALIBRATED, 10.0000 px/mm\n')).toBe(true)
    expect(dxf).toContain("One unit is one millimetre; y up; the origin is the sheet's own origin")
    expect(dxf.trimEnd().endsWith('  0\nEOF')).toBe(true)
    // Every table a strict reader looks for, and the two block records.
    for (const t of ['VPORT', 'LTYPE', 'LAYER', 'STYLE', 'VIEW', 'UCS', 'APPID', 'DIMSTYLE', 'BLOCK_RECORD']) {
      expect(dxf).toContain(`  0\nTABLE\n  2\n${t}\n`)
    }
    expect(dxf).toContain('*MODEL_SPACE')
    expect(dxf).toContain('*PAPER_SPACE')
  })

  it('gives everything a handle of its own, below the seed', () => {
    const dxf = buildFlatDxf(input())
    const handles = groups(dxf)
      .filter(([c]) => c === 5)
      .map(([, v]) => v)
    const seed = parseInt(headerVar(dxf, '$HANDSEED')!, 16)
    const own = handles.slice(1) // the first group 5 is $HANDSEED itself
    expect(new Set(own).size).toBe(own.length)
    expect(Math.max(...own.map((h) => parseInt(h, 16)))).toBeLessThan(seed)
  })

  it('lays every edge chain out as a lightweight polyline in millimetres, y up', () => {
    const dxf = buildFlatDxf(input())
    const polys = ofType(dxf, 'LWPOLYLINE')
    expect(polys.length).toBe(2)
    expect(val(polys[0], 8)).toBe('edges')
    expect(val(polys[0], 90)).toBe('3')
    expect(val(polys[0], 70)).toBe('0')
    expect(vals(polys[0], 10)).toEqual(['10', '20', '20'])
    expect(vals(polys[0], 20)).toEqual(['10', '10', '20'])
    expect(vals(polys[1], 10)).toEqual(['50', '50'])
    expect(vals(polys[1], 20)).toEqual(['70', '60'])
  })

  it('leaves the edge layer empty while the edges are not shown', () => {
    const dxf = buildFlatDxf(input({ chains: null }))
    expect(ofType(dxf, 'LWPOLYLINE')).toEqual([])
    expect(dxf).toContain('  2\nedges\n')
  })

  it('thins a chain to the tolerance, and closes one that returns to its start', () => {
    const wobbly: EdgeChains = {
      // A straight run wobbling by 0.02 px, and a square that ends on its
      // first point.
      points: new Float32Array([
        100, 100, 200, 100.02, 300, 99.98, 400, 100.01, 500, 100,
        600, 600, 700, 600, 700, 700, 600, 700, 600, 600,
      ]),
      offsets: new Uint32Array([0, 5, 10]),
    }
    // 0.01 mm is a tenth of a pixel at this scale — over the wobble.
    const dxf = buildFlatDxf(input({ chains: wobbly, edgeTolerance: 0.01 }))
    const [run, square] = ofType(dxf, 'LWPOLYLINE')
    expect(val(run, 90)).toBe('2')
    expect(vals(run, 10)).toEqual(['10', '50'])
    expect(val(square, 70)).toBe('1')
    expect(val(square, 90)).toBe('4')
    expect(vals(square, 10)).toEqual(['60', '70', '70', '60'])
    // With no tolerance the wobble stays.
    const raw = ofType(buildFlatDxf(input({ chains: wobbly })), 'LWPOLYLINE')
    expect(val(raw[0], 90)).toBe('5')
    expect(dxf).toContain('thinned to 0.01 mm')
  })

  it('writes the fits as the entities CAD has for them, in colour, on the elements layer', () => {
    const dxf = buildFlatDxf(input())
    const [circle] = ofType(dxf, 'CIRCLE')
    expect(val(circle, 8)).toBe('elements')
    expect(val(circle, 420)).toBe(String(0x112233))
    expect([val(circle, 10), val(circle, 20), val(circle, 40)]).toEqual(['20', '40', '10'])
    const [line] = ofType(dxf, 'LINE')
    expect([val(line, 10), val(line, 20), val(line, 11), val(line, 21)]).toEqual(['10', '10', '60', '10'])
    const [point] = ofType(dxf, 'POINT')
    expect([val(point, 10), val(point, 20)]).toEqual(['5', '5'])
    expect(headerVar(dxf, '$PDMODE')).toBe('3')
  })

  it('labels each element with two lines of TEXT, escaped the AutoCAD way', () => {
    const dxf = buildFlatDxf(input())
    const texts = ofType(dxf, 'TEXT')
    expect(texts.length).toBe(6)
    expect(texts.every((t) => val(t, 8) === 'labels')).toBe(true)
    const words = texts.map((t) => val(t, 1))
    expect(words).toContain('Circle 1')
    expect(words).toContain('%%c 20.000 mm')
    expect(words).toContain('L 50.000 mm, 0.00%%d')
    expect(words).toContain('X 5.000, Y 5.000 mm')
    // The name sits a line above the reading.
    const [name, reading] = texts
    expect(Number(val(name, 20))).toBeGreaterThan(Number(val(reading, 20)))
    expect(val(name, 10)).toBe(val(reading, 10))
    expect(dxfText('plain')).toBe('plain')
    expect(dxfText('σ ±1 —')).toBe('\\U+03C3 %%p1 \\U+2014')
  })

  it('draws an arc counter-clockwise from its start angle, and a full one as a circle', () => {
    const el = (fit: FlatArcFit) => [{ fit, color: '#000000', name: 'Arc 1', value: '' }]
    const [quarter] = ofType(buildFlatDxf(input({ elements: el(arc(0, Math.PI / 2)) })), 'ARC')
    expect([val(quarter, 10), val(quarter, 20), val(quarter, 40)]).toEqual(['50', '40', '10'])
    expect([val(quarter, 50), val(quarter, 51)]).toEqual(['0', '90'])
    const [long] = ofType(buildFlatDxf(input({ elements: el(arc(0, 1.5 * Math.PI)) })), 'ARC')
    expect([val(long, 50), val(long, 51)]).toEqual(['0', '270'])
    const full = buildFlatDxf(input({ elements: el(arc(0.3, 2 * Math.PI)) }))
    expect(ofType(full, 'ARC')).toEqual([])
    expect(ofType(full, 'CIRCLE').length).toBe(1)
    // Rolled with the sheet: +X picked straight up turns the drawing a
    // quarter clockwise, and the angles go round with it.
    const [rolled] = ofType(buildFlatDxf(input({ alignDir: [0, 1], elements: el(arc(0, Math.PI / 2)) })), 'ARC')
    expect([val(rolled, 50), val(rolled, 51)]).toEqual(['270', '0'])
  })

  it('writes a spline as one cubic B-spline through its own Bézier poles', () => {
    const pts: [number, number][] = [
      [10, 10],
      [30, 20],
      [50, 10],
    ]
    const el = (closed: boolean) => [
      { fit: fitSplinePoints(pts, [null, null, null], closed), color: '#000000', name: 'Spline 1', value: '' },
    ]
    const [open] = ofType(buildFlatDxf(input({ elements: el(false) })), 'SPLINE')
    expect(val(open, 71)).toBe('3')
    expect(val(open, 73)).toBe('7')
    expect(val(open, 72)).toBe('11')
    expect(val(open, 74)).toBe('0')
    const knots = vals(open, 40).map(Number)
    expect(knots.length).toBe(11)
    expect(knots.slice(0, 4)).toEqual([0, 0, 0, 0])
    expect(new Set(knots.slice(4, 7)).size).toBe(1)
    expect(new Set(knots.slice(7)).size).toBe(1)
    expect(vals(open, 10).length).toBe(7)
    expect([vals(open, 10)[0], vals(open, 20)[0]]).toEqual(['10', '10'])
    expect([vals(open, 10)[6], vals(open, 20)[6]]).toEqual(['50', '10'])
    // A closed curve's last pole is its first.
    const [closed] = ofType(buildFlatDxf(input({ elements: el(true) })), 'SPLINE')
    expect(val(closed, 73)).toBe('10')
    expect(val(closed, 72)).toBe('14')
    expect(vals(closed, 10)[9]).toBe(vals(closed, 10)[0])
    expect(vals(closed, 20)[9]).toBe(vals(closed, 20)[0])
  })

  it('puts the origin on the alignment and rolls the drawing as the stage shows it', () => {
    // The origin on the circle's centre: the circle sits at (0, 0).
    const moved = buildFlatDxf(input({ origin: [20, 40] }))
    const [circle] = ofType(moved, 'CIRCLE')
    expect([val(circle, 10), val(circle, 20)]).toEqual(['0', '0'])
    expect(vals(ofType(moved, 'LWPOLYLINE')[0], 10)).toEqual(['-10', '0', '0'])
    expect(moved).toContain("the origin is the alignment's origin")
    // +X picked straight up: a quarter turn clockwise, y still up, no flip.
    const rolled = buildFlatDxf(input({ alignDir: [0, 1] }))
    const [poly] = ofType(rolled, 'LWPOLYLINE')
    expect(vals(poly, 10)).toEqual(['10', '10', '20'])
    expect(vals(poly, 20)).toEqual(['-10', '-20', '-20'])
    expect(headerVar(rolled, '$EXTMIN')).toBe('0')
    expect(groups(rolled).find(([c, v]) => c === 20 && v === '-100')).toBeTruthy()
    expect(rolled).toContain('aligned to the part with its +X along the page')
    // The turns go on top.
    const both = buildFlatDxf(input({ alignDir: [0, 1], turns: 1 }))
    expect(vals(ofType(both, 'LWPOLYLINE')[0], 10)).toEqual(['10', '20', '20'])
    expect(vals(ofType(both, 'LWPOLYLINE')[0], 20)).toEqual(['10', '10', '20'])
  })

  it('is unitless pixels while nothing sets a scale', () => {
    const dxf = buildFlatDxf(
      input({
        bounds: { min: [0, 0], max: [1000, 800] },
        chainUnit: { x: 1, y: 1 },
        unit: 'px',
        elements: [],
        scaleNote: 'Scale: UNCALIBRATED — no scale, all values in PIXELS',
      }),
    )
    expect(headerVar(dxf, '$INSUNITS')).toBe('0')
    expect(vals(ofType(dxf, 'LWPOLYLINE')[0], 10)).toEqual(['100', '200', '200'])
    expect(dxf).toContain('One unit is one image pixel')
  })
})
