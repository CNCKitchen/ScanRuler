// SPDX-License-Identifier: AGPL-3.0-only
// scan.scale: the scan scaled to its true size, as the Scale part box of the
// Alignment group does it — from lengths measured on the scan held against
// the same lengths on the real part, or by a factor. See core/scanScale.

import { dimensionTypeInfo, evaluateDimensions } from '../../core/dimensions'
import { roundTo } from '../../core/round'
import { combineReferences, factorProblem, type CombinedScale, type ScaleReference } from '../../core/scanScale'
import type { Vec3 } from '../../core/types'
import { useStore } from '../../state/store'
import { dimensionRefsOf } from '../../state/sectionModel'
import { commandHost } from '../host'
import { elementRefSchema, measuredElement, requireScan, type ElementRef } from '../refs'
import { arr, bool, num, obj, oneOf, vec3 } from '../schema'
import { CommandError, type Command } from '../types'
import { lastError, requireMeasureFree, showWorkspace } from './common'
import { dimensionRefSchema, findDimension } from './dimension'
import { scanSummary } from './scan'

type ReferenceIn = { true: number } & ({ dimension: number | string } | { element: ElementRef } | { points: [Vec3, Vec3] })

/** A reference as given, as the scale reads it: what it is and how long it
 *  is on the scan, mm. */
function referenceOf(r: ReferenceIn): ScaleReference {
  if (!(typeof r.true === 'number' && r.true > 0)) throw new CommandError('invalid_input', 'Each reference needs true: its length on the real part, mm, above 0.')
  if ('points' in r) {
    const [a, b] = r.points
    const measured = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
    if (!(measured > 0)) throw new CommandError('invalid_input', 'The two points of a reference coincide.')
    return { label: 'Two points', measured, true: r.true }
  }
  if ('element' in r) {
    const el = measuredElement(r.element, ['sphere', 'cylinder', 'circle'])
    const fit = el.fit!
    if (fit.kind !== 'sphere' && fit.kind !== 'cylinder' && fit.kind !== 'circle') throw new CommandError('invalid_input', `${el.name} has no diameter.`)
    return { label: `${el.name} Ø`, measured: 2 * fit.radius, true: r.true }
  }
  const dim = findDimension(r.dimension)
  const info = dimensionTypeInfo(dim.type)
  if (info.family !== 'dimension' || info.unit === '°') throw new CommandError('invalid_input', `${dim.name} is not a length — give a distance or a diameter.`)
  const s = useStore.getState()
  const [row] = evaluateDimensions([dim], dimensionRefsOf(s.elements, s.sections))
  const measured = row.value.raw
  if (measured === undefined || !(measured > 0)) throw new CommandError('invalid_state', `${dim.name} has no value to scale from${row.value.invalid ? ` — ${row.value.invalid}` : ''}.`)
  return { label: dim.name, measured, true: r.true }
}

const referenceSchema = oneOf(
  [
    obj({ dimension: dimensionRefSchema('A length dimension already measured — a distance or a diameter.'), true: num('Its length on the real part, mm.') }, ['dimension', 'true']),
    obj({ element: elementRefSchema('A sphere, cylinder or circle; its diameter is the length.'), true: num('Its diameter on the real part, mm.') }, ['element', 'true']),
    obj(
      { points: arr(vec3('A point on the scan, mm.'), 'The two ends of the length.', { minItems: 2, maxItems: 2 }), true: num('The distance between them on the real part, mm.') },
      ['points', 'true'],
    ),
  ],
  'A length known two ways: measured on the scan, and true — from calipers on the real part.',
)

const pct = (share: number) => roundTo(share * 100, 3)

const combinedOut = (c: CombinedScale) => ({
  references: c.references.map((r) => ({ label: r.label, measured: roundTo(r.measured, 4), true: roundTo(r.true, 4), factor: roundTo(r.factor, 6), offPct: pct(r.off) })),
  ...(c.references.length > 1 ? { spreadPct: pct(c.spread) } : {}),
})

export const scale: Command<{ factor?: number; references?: ReferenceIn[]; dryRun?: boolean }> = {
  name: 'scale',
  title: 'Scale the scan',
  description:
    'Scale the scan to its true size — a photogrammetry scan (Meshroom, say) has no size of its own, and session.state says noTrueSize when one looks like it. Give references: lengths measured on the scan with their true lengths from the real part — a length dimension already made (distance or diameter), an element’s diameter (sphere, cylinder, circle), or two points — or a factor outright. Several references are averaged by length; each one’s own factor and how far it is off the average (offPct) come back, so a bad one shows. Best references: long, and between centres (hole to hole, ball to ball) — a centre does not move when the surface sits proud or sunk. The scale is about the frame’s zero point: every coordinate times the factor. Elements, dimensions, sections and the alignment scale with it; the fit to a reference part goes. Refuses while a model, notes or other work is built on the scan at the old size (scale first). dryRun: true returns the factor and the size it would give without scaling. Returns factor, the references, size before and after, and the scan. One undo step.',
  input: obj({
    factor: num('Scale by this factor outright, instead of from references — 25.4 for a file in inches read as mm.', { exclusiveMinimum: 0 }),
    references: arr(referenceSchema, 'Lengths to scale from — one or more.', { minItems: 1 }),
    dryRun: bool('Work out the factor and the size it gives, and scale nothing.'),
  }),
  label: ({ factor }) => (factor ? `scale the scan ×${factor}` : 'scale the scan from references'),
  run: async ({ factor, references, dryRun }) => {
    requireScan()
    requireMeasureFree()
    if ((factor === undefined) === (references === undefined)) throw new CommandError('invalid_input', 'Give either factor or references — one of them.')
    const combined = references ? combineReferences(references.map(referenceOf)) : null
    const k = combined?.factor ?? factor!
    const problem = factorProblem(k)
    if (problem) throw new CommandError('invalid_input', problem)
    const before = 2 * useStore.getState().modelSize
    const out = { factor: roundTo(k, 6), ...(combined ? combinedOut(combined) : {}) }
    if (dryRun) return { ...out, dryRun: true, size: { before: roundTo(before, 3), after: roundTo(before * k, 3) } }
    const { session } = commandHost()
    const refusal = session.scale.refusal()
    if (refusal) throw new CommandError('invalid_state', refusal)
    showWorkspace('elements')
    if (!(await session.scale.applyScale(k, combined?.references.map(({ label, measured, true: t }) => ({ label, measured, true: t })) ?? []))) {
      throw new CommandError('failed', lastError('The scan could not be scaled.'))
    }
    const scan = await scanSummary()
    return { ...out, size: { before: roundTo(before, 3), after: roundTo(scan.size, 3) }, scan }
  },
}
