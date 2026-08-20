// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { datumFrame } from '../src/core/flat/datum'
import { evaluateFlatDimensions } from '../src/core/flat/dimensions'
import type { FlatElement } from '../src/core/flat/elements'
import { fitCirclePoints, fitLinePoints, flatPoint } from '../src/core/flat/fit'
import { buildFlatCsv, buildFlatReport, type FlatReportInput } from '../src/core/flat/report'

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
      [{ id: 1, type: 'flat-dist-point-line', refs: [1, 2] }],
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

  it('shouts about a nominal scale and names the datum frame', () => {
    const datum = { originPx: [0, 0] as [number, number], xRefPx: [100, 0] as [number, number] }
    const text = buildFlatReport(
      sampleInput({
        calSource: 'metadata',
        datum,
        frame: datumFrame(datum, { x: 23.622, y: 23.622 }),
      }),
    )
    expect(text).toContain('UNCALIBRATED — nominal 600 dpi')
    expect(text).toContain('part datum frame')
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
