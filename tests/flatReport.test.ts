// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { datumFrame } from '../src/core/flat/datum'
import { evaluateFlatDimensions } from '../src/core/flat/dimensions'
import type { FlatElement } from '../src/core/flat/elements'
import { fitCirclePoints, fitLinePoints } from '../src/core/flat/fit'
import { buildFlatCsv, buildFlatReport, type FlatReportInput } from '../src/core/flat/report'
import { fitSplinePoints } from '../src/core/flat/spline'

function sampleInput(over: Partial<FlatReportInput> = {}): FlatReportInput {
  const circle = fitCirclePoints([
    [110, 40],
    [100, 50],
    [90, 40],
  ])
  const line = fitLinePoints([
    [0, 0],
    [100, 0],
  ])
  const elements: FlatElement[] = [
    {
      id: 1,
      kind: 'circle',
      name: 'Circle 1',
      color: '#123456',
      source: { type: 'picks', method: 'flat-circle-pick', picks: [] },
      fit: circle,
      error: null,
      visible: true,
    },
    {
      id: 2,
      kind: 'line',
      name: 'Line 1',
      color: '#654321',
      source: { type: 'picks', method: 'flat-line-pick', picks: [] },
      fit: line,
      error: null,
      visible: true,
    },
    {
      id: 3,
      kind: 'point',
      name: 'Point 1',
      color: '#222222',
      source: { type: 'construct', method: 'flat-point-center', refs: [99] },
      fit: null,
      error: 'A referenced element is unavailable.',
      visible: true,
    },
  ]
  return {
    imageName: 'part.png',
    imageWidth: 3000,
    imageHeight: 2000,
    calSource: 'measured',
    pxPerMm: { x: 23.622, y: 23.622 },
    datum: null,
    frame: null,
    unit: 'mm',
    elements,
    dimensions: evaluateFlatDimensions(
      [{ id: 1, type: 'flat-dist-point-line', name: 'Distance 1', refs: [1, 2], visible: true }],
      elements,
    ),
    ...over,
  }
}

describe('buildFlatReport', () => {
  it('says what the numbers rest on and lists everything', () => {
    const text = buildFlatReport(sampleInput())
    expect(text).toContain('part.png')
    expect(text).toContain('CALIBRATED, 23.6220 px/mm')
    expect(text).toContain('image frame')
    expect(text).toContain('Circle 1: Ø 20.000 mm')
    expect(text).toContain('Point 1: no fit')
    expect(text).toContain('Distance to line: 40.000 mm')
  })

  it('shouts about a nominal scale and names the aligned part frame', () => {
    const datum = { originPx: [0, 0] as [number, number], xRefPx: [100, 0] as [number, number] }
    const text = buildFlatReport(
      sampleInput({
        calSource: 'metadata',
        datum,
        frame: datumFrame(datum, { x: 23.622, y: 23.622 }),
      }),
    )
    expect(text).toContain('UNCALIBRATED — nominal 600 dpi')
    expect(text).toContain('aligned part frame')
  })

  it('says when the frame reads +Y up on a sheet shown mirrored', () => {
    // The same alignment on the sheet shown mirrored: +Y is the other way
    // round on the sheet — up the screen as shown — and a point above the
    // axis on the sheet reads below it. The circle's centre is 40 up.
    const datum = { originPx: [0, 0] as [number, number], xRefPx: [100, 0] as [number, number] }
    const plain = buildFlatReport(sampleInput({ datum, frame: datumFrame(datum, null) }))
    expect(plain).toContain('aligned part frame (origin and +X as picked)')
    expect(plain).not.toContain('mirrored')
    const mirrored = buildFlatReport(sampleInput({ datum, frame: datumFrame(datum, null, true) }))
    expect(mirrored).toContain('+Y up on the sheet as shown mirrored')
    const csv = buildFlatCsv(sampleInput({ datum, frame: datumFrame(datum, null, true) }))
    expect(csv.split('\n').find((l) => l.startsWith('Circle 1'))).toContain('100.0000,-40.0000')
  })
})

describe('buildFlatCsv', () => {
  it('carries raw numeric columns with the unit in the header', () => {
    const csv = buildFlatCsv(sampleInput())
    const lines = csv.split('\n')
    expect(lines[1]).toContain('diameter_mm')
    const circleRow = lines.find((l) => l.startsWith('Circle 1'))!
    expect(circleRow).toContain('20.0000')
    expect(circleRow).not.toContain(' mm')
    const orphanRow = lines.find((l) => l.startsWith('Point 1'))!
    expect(orphanRow).toContain('unavailable')
    const dimRow = lines.find((l) => l.startsWith('Circle 1 → Line 1'))!
    expect(dimRow).toContain('40.0000')
  })

  it('quotes fields that would break a naive parser', () => {
    const input = sampleInput()
    input.elements = [{ ...input.elements[0], name: 'Circle "big", outer' }]
    input.dimensions = []
    const csv = buildFlatCsv(input)
    expect(csv).toContain('"Circle ""big"", outer"')
  })
})

describe('a spline in the report and the CSV', () => {
  const spline = fitSplinePoints(
    [
      [0, 0],
      [10, 5],
      [20, 0],
    ],
    [null, [3, 0], null],
    true,
  )
  const element: FlatElement = {
    id: 4,
    kind: 'spline',
    name: 'Spline 1',
    color: '#000000',
    source: { type: 'picks', method: 'flat-spline-pick', picks: [], tangents: [null, [70, 0], null], closed: true },
    fit: spline,
    error: null,
    visible: true,
  }
  const input = sampleInput({ elements: [element], dimensions: [] })

  it('reads as its length, closed, with its points and the tangents set by hand', () => {
    const text = buildFlatReport(input)
    expect(text).toMatch(/Spline 1: L [\d.]+ mm · closed \(3 fit points · 1 tangent set\)/)
  })

  it('carries its start and its length in the numeric columns', () => {
    const row = buildFlatCsv(input)
      .split('\n')
      .find((l) => l.startsWith('Spline 1'))!
    const cols = row.split(',')
    expect(cols[1]).toBe('spline')
    expect(cols[2]).toBe('0.0000')
    expect(cols[3]).toBe('0.0000')
    expect(cols[4]).toBe('')
    expect(Number(cols[5])).toBeCloseTo(spline.length, 3)
    expect(cols[10]).toBe('3')
  })
})
