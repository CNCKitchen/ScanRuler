// SPDX-License-Identifier: AGPL-3.0-only
// The min / max readouts: what the detail line and the copied summary say
// about where a measured surface reaches, and the diameters that makes.
import { describe, expect, it } from 'vitest'
import { diameterRange } from '../src/core/dimensions'
import { buildSummary, formatDetail, formatDiameterRange } from '../src/core/summary'
import type { CylinderFit, ElementSource, PlaneFit, SphereFit } from '../src/core/types'

const bore: CylinderFit = {
  kind: 'cylinder',
  center: [0, 0, 0],
  axis: [0, 0, 1],
  radius: 4.1585,
  length: 22.042,
  coverage: 358,
  sigma: 0.0288,
  usedPoints: 2075,
  regionSize: 2075,
  formError: 0.1486,
  residualMin: -0.074,
  residualMax: 0.0746,
}

const ball: SphereFit = {
  kind: 'sphere',
  center: [1, 2, 3],
  radius: 12.7,
  sigma: 0.004,
  usedPoints: 9000,
  regionSize: 9200,
  formError: 0.03,
  residualMin: -0.012,
  residualMax: 0.018,
}

const face: PlaneFit = {
  kind: 'plane',
  center: [0, 0, 0],
  normal: [0, 0, 1],
  basisU: [1, 0, 0],
  basisV: [0, 1, 0],
  extentU: 10,
  extentV: 8,
  sigma: 0.0081,
  usedPoints: 4000,
  regionSize: 4100,
  formError: 0.05,
  residualMin: -0.021,
  residualMax: 0.029,
}

const source: ElementSource = {
  type: 'fitted',
  seeds: [1],
  settings: { method: 'gaussian', sigma: 3 },
}

describe('diameter range', () => {
  it('is the Gaussian radius moved to the radial extremes, doubled', () => {
    const [min, max] = diameterRange(bore)!
    expect(min).toBeCloseTo(2 * (4.1585 - 0.074), 9)
    expect(max).toBeCloseTo(2 * (4.1585 + 0.0746), 9)
    expect(formatDiameterRange(bore)).toBe('Ø min 8.169 · max 8.466 mm')
  })

  it('is absent for a plane and for a fit without residuals', () => {
    expect(diameterRange(face)).toBeNull()
    expect(diameterRange({ ...ball, residualMin: undefined, residualMax: undefined })).toBeNull()
    expect(formatDiameterRange({ ...ball, residualMin: undefined, residualMax: undefined })).toBeNull()
  })
})

describe('detail line', () => {
  it('carries the min and max diameter beside the form error', () => {
    const line = formatDetail(bore)
    expect(line).toContain('cylindricity 0.1486 mm')
    expect(line).toContain('Ø min 8.169 · max 8.466 mm')
    // Nothing that was there before has moved: the e2e checks still parse it.
    expect(line).toMatch(/length 22\.042 mm/)
    expect(line).toMatch(/2,075 of 2,075 points/)
    expect(formatDetail(ball)).toContain('Ø min 25.376 · max 25.436 mm')
  })

  it('leaves a plane and a fit without residuals as they were', () => {
    expect(formatDetail(face)).not.toContain('Ø')
    expect(formatDetail({ ...bore, residualMin: undefined, residualMax: undefined })).not.toContain('Ø min')
  })
})

describe('summary', () => {
  it('prints the residual extremes and the diameter range for round features', () => {
    const text = buildSummary(
      'bracket.stl',
      [
        { id: 1, name: 'Cylinder 1', kind: 'cylinder', source, fit: bore },
        { id: 2, name: 'Plane 1', kind: 'plane', source, fit: face },
      ],
      [],
    )
    expect(text).toContain('  residual min / max: −0.0740 / +0.0746 mm')
    expect(text).toContain('  diameter min / max: 8.1690 / 8.4662 mm (radial extremes)')
    expect(text).toContain('  residual min / max: −0.0210 / +0.0290 mm')
    // A plane has no diameter to range.
    expect(text.split('diameter min / max').length).toBe(2)
  })
})
