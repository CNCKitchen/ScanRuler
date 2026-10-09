// SPDX-License-Identifier: AGPL-3.0-only
// Wall thickness: measured everywhere on the scan at once, no reference.

import type { ThicknessMethod } from '../../core/thickness/thickness'
import { useThickness } from '../../state/thicknessStore'
import { commandHost } from '../host'
import { requireScan } from '../refs'
import { enumOf, int, num, obj, oneOf, type JsonSchema } from '../schema'
import { describeThickness } from '../state'
import { CommandError, type Command } from '../types'
import { lastError, showWorkspace } from './common'

interface Search {
  method?: ThicknessMethod
  maxThickness?: number
  coneRays?: number
  coneAngleDeg?: number
  normalDeviationDeg?: number | null
}

const search: Record<keyof Search, JsonSchema> = {
  method: enumOf(['ray', 'sphere'] as ThicknessMethod[], 'ray: along the inward normal to the far wall (with coneRays, the shortest of a cone of rays). sphere: the largest sphere that fits at the point.'),
  maxThickness: num('The thickest wall searched for, mm.', { exclusiveMinimum: 0 }),
  coneRays: int('ray: rays in the cone about the normal; 0 for the normal alone.', { minimum: 0 }),
  coneAngleDeg: num('ray: the cone’s half-angle, degrees.', { minimum: 0, maximum: 89 }),
  normalDeviationDeg: oneOf([num(undefined, { minimum: 0, maximum: 180 }), { type: 'null', description: 'Not checked.' }], 'How far the far wall may turn from facing back, degrees, or null to accept whatever is hit.'),
}

function applySearch(s: Search) {
  const t = useThickness.getState()
  if (s.method !== undefined) t.setMethod(s.method)
  if (s.maxThickness !== undefined) t.setMaxThickness(s.maxThickness)
  if (s.coneRays !== undefined) t.setConeRays(s.coneRays)
  if (s.coneAngleDeg !== undefined) t.setConeAngle(s.coneAngleDeg)
  if (s.normalDeviationDeg !== undefined) t.setNormalDeviation(s.normalDeviationDeg)
}

const measure: Command<Search> = {
  name: 'measure',
  title: 'Measure the wall thickness',
  description:
    'Measure the wall thickness at every point of the scan, as the Wall Thickness workspace’s Measure button does, with the search settings given or those in hand. Returns the statistics (min, max, mean, sigma, share under the thin-wall limit, points measured) and the settings. One undo step.',
  input: obj(search),
  label: () => 'measure wall thickness',
  run: async (input) => {
    requireScan()
    showWorkspace('thickness')
    applySearch(input)
    await commandHost().session.thickness.runThickness()
    const t = useThickness.getState()
    if (t.status !== 'ready') throw new CommandError('failed', t.message ?? lastError('The wall thickness could not be measured.'))
    return { thickness: describeThickness() }
  },
}

const settings: Command<Search & { low?: number; high?: number; bands?: number | null; limit?: number }> = {
  name: 'settings',
  title: 'Set how the wall thickness is searched and read',
  description:
    'The search settings (method, maxThickness, coneRays, coneAngleDeg, normalDeviationDeg — they take effect at the next thickness.measure) and the reading: low and high, the ends of the colour scale, mm; bands, a stepped scale or null; limit, the thin-wall limit the statistics count under, mm. Returns the thickness state. One undo step.',
  input: obj({
    ...search,
    low: num('Colour scale’s low end, mm.', { minimum: 0 }),
    high: num('Colour scale’s high end, mm.', { exclusiveMinimum: 0 }),
    bands: oneOf([int(undefined, { minimum: 2 }), { type: 'null', description: 'Smooth.' }], 'Stepped colours, or null.'),
    limit: num('Thin-wall limit, mm.', { exclusiveMinimum: 0 }),
  }),
  label: () => 'wall thickness settings',
  run: async (input) => {
    applySearch(input)
    const t = useThickness.getState()
    if (input.low !== undefined) t.setLow(input.low)
    if (input.high !== undefined) t.setHigh(input.high)
    if (input.bands !== undefined) t.setBands(input.bands)
    if (input.limit !== undefined) t.setLimit(input.limit)
    return { thickness: describeThickness() }
  },
}

export const thicknessCommands = [measure, settings]
