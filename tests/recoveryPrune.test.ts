// SPDX-License-Identifier: AGPL-3.0-only
// Which checkpoints left by closed pages are let go of. The storage itself is
// IndexedDB, which the tests do not have; the choice is checked on its own.
import { describe, expect, it } from 'vitest'
import { RECOVERY_KEEP, RECOVERY_MAX_AGE_MS, staleCheckpoints } from '../src/app/recoveryStorage'

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000
const row = (id: string, ageMs: number) => ({ id, name: id, savedAt: NOW - ageMs })

describe('staleCheckpoints', () => {
  it('lets go of checkpoints older than the age limit', () => {
    const rows = [row('fresh', DAY), row('old', RECOVERY_MAX_AGE_MS + DAY)]
    expect(staleCheckpoints(rows, NOW)).toEqual(['old'])
  })

  it('keeps only the newest few, however recent the rest', () => {
    const rows = Array.from({ length: RECOVERY_KEEP + 3 }, (_, i) => row(`p${i}`, i * 1000))
    expect(staleCheckpoints(rows, NOW).sort()).toEqual(rows.slice(RECOVERY_KEEP).map((r) => r.id).sort())
  })

  it('keeps everything recent and few', () => {
    expect(staleCheckpoints([row('a', 0), row('b', DAY)], NOW)).toEqual([])
  })
})
