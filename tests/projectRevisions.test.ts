// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest'
import { projectRevisionName, revisionBase } from '../src/app/projectRevisions'

it.each([
  [undefined, 'Part-001.scanruler'],
  ['Part.scanruler', 'Part-001.scanruler'],
  ['Part-1.scanruler', 'Part-002.scanruler'],
  ['Part-009.scanruler', 'Part-010.scanruler'],
  ['Part-99.scanruler', 'Part-100.scanruler'],
  ['Part-999.scanruler', 'Part-1000.scanruler'],
  ['PART-010.SCANRULER', 'Part-011.scanruler'],
  ['Other-099.scanruler', 'Part-001.scanruler'],
])('increments filename %s to %s', (previous, next) => {
  expect(projectRevisionName('Part', previous)).toBe(next)
})

it('rejects unsafe revision numbers instead of repeating or corrupting a filename', () => {
  expect(() => projectRevisionName('Part', 'Part-9007199254740991.scanruler')).toThrow('too large')
  expect(() => projectRevisionName('Part', 'Part-999999999999999999999.scanruler')).toThrow('too large')
})

it('uses a manually named opened file until the project title changes', () => {
  expect(revisionBase('Part.scanruler', 'Working copy-007.scanruler', 'Part.scanruler')).toBe('Working copy')
  expect(revisionBase('Other.scanruler', 'Working copy-007.scanruler', 'Part.scanruler')).toBe('Other')
  expect(projectRevisionName('Other', 'Working copy-007.scanruler')).toBe('Other-001.scanruler')
})

it('does not strip digits from a newly typed project title', () => {
  expect(revisionBase('Bracket-2026.scanruler')).toBe('Bracket-2026')
  expect(projectRevisionName(revisionBase('Bracket-2026.scanruler'))).toBe('Bracket-2026-001.scanruler')
  expect(revisionBase('Bracket-2026.scanruler', 'Bracket-2026-001.scanruler', 'Bracket-2026.scanruler')).toBe('Bracket-2026')
})
