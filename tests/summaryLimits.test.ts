// SPDX-License-Identifier: AGPL-3.0-only
// Limits and tolerances in the copied summary: every judged value gets its
// verdict line, and the tally at the end counts them.
import { describe, expect, it } from 'vitest'
import { buildSummary } from '../src/core/summary'
import { evaluateDimensions } from '../src/core/dimensions'
import type { PlaneFit, SphereFit } from '../src/core/types'

const measured = { sigma: 0.002, usedPoints: 1000, regionSize: 1100 }

const base: PlaneFit = {
  kind: 'plane',
  center: [0, 0, 0],
  normal: [0, 0, 1],
  basisU: [1, 0, 0],
  basisV: [0, 1, 0],
  extentU: 10,
  extentV: 10,
  ...measured,
  formError: 0.031,
}
const ball: SphereFit = { kind: 'sphere', center: [0, 0, 20], radius: 6.01, ...measured, formError: 0.004 }

const elements = [
  { id: 1, name: 'Base', kind: 'plane' as const, source: { type: 'fitted' as const, seeds: [] }, fit: base },
  { id: 2, name: 'Ball', kind: 'sphere' as const, source: { type: 'fitted' as const, seeds: [] }, fit: ball },
]

describe('the summary with limits', () => {
  it('judges each limited value and tallies them', () => {
    const rows = evaluateDimensions(
      [
        { id: 1, type: 'form-flatness', name: 'Flatness 1', refs: [1], limit: { kind: 'max', max: 0.05 } },
        { id: 2, type: 'form-sphericity', name: 'Sphericity 1', refs: [2] },
        {
          id: 3,
          type: 'size-diameter',
          name: 'Diameter 1',
          refs: [2],
          limit: { kind: 'band', nominal: 12, plus: 0.01, minus: 0.01 },
        },
        { id: 4, type: 'dist-point-plane', name: 'Distance 1', refs: [2, 1] },
      ],
      elements,
    )
    const text = buildSummary('scan.stl', { method: 'gaussian', sigma: 3 }, elements, rows)
    expect(text).toContain('Flatness 1 (Base) — Flatness: 0.031 mm\n  limit 0.050 mm · Δ -0.019 mm · PASS')
    expect(text).toContain('Sphericity 1 (Ball) — Sphericity: 0.004 mm\n  Peak to peak')
    expect(text).toContain(
      'Diameter 1 (Ball) — Diameter: 12.020 mm\n  nominal 12.000 mm +0.010 mm / −0.010 mm · Δ +0.020 mm · FAIL — 0.010 mm over the upper limit',
    )
    expect(text).toContain('Distance 1 (Ball → Base) — Distance to plane: +20.000 mm')
    expect(text.trimEnd().endsWith('Checked against limits: 2 — 1 pass, 1 fail')).toBe(true)
  })

  it('has no tally when nothing was held to a limit', () => {
    const rows = evaluateDimensions(
      [{ id: 1, type: 'form-flatness', name: 'Flatness 1', refs: [1] }],
      elements,
    )
    const text = buildSummary('scan.stl', { method: 'gaussian', sigma: 3 }, elements, rows)
    expect(text).not.toContain('Checked against limits')
    expect(text).not.toContain('PASS')
  })
})
