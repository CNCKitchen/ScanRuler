// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { SCHEMES, schemeById } from '../src/viewer/navSchemes'

/** The navigator resolves a gesture by finding the first binding whose exact
 *  chord and modifier state match, so the scheme table has to hold a few
 *  invariants for that resolution to be well-defined. These tests pin them,
 *  so a mistyped new scheme fails here instead of as a dead mouse button. */
describe('control scheme table', () => {
  it('has unique ids', () => {
    const ids = SCHEMES.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('gives every scheme an orbit and a pan route', () => {
    for (const s of SCHEMES) {
      const actions = new Set(s.bindings.map((b) => b.action))
      expect(actions.has('orbit'), `${s.id} can orbit`).toBe(true)
      expect(actions.has('pan'), `${s.id} can pan`).toBe(true)
    }
  })

  it('uses only real button masks', () => {
    for (const s of SCHEMES) {
      for (const b of s.bindings) {
        expect(b.buttons, `${s.id} binding mask`).toBeGreaterThan(0)
        expect(b.buttons, `${s.id} binding mask`).toBeLessThanOrEqual(7)
      }
    }
  })

  it('never binds the same chord twice within a scheme', () => {
    for (const s of SCHEMES) {
      const seen = new Set<string>()
      for (const b of s.bindings) {
        const key = `${b.buttons}:${!!b.shift}:${!!b.ctrl}:${!!b.alt}`
        expect(seen.has(key), `${s.id} duplicate chord ${key}`).toBe(false)
        seen.add(key)
      }
    }
  })

  it('falls back to the default scheme for unknown ids', () => {
    expect(schemeById('cnckitchen').id).toBe('cnckitchen')
    expect(schemeById('rhino').id).toBe('rhino')
    expect(schemeById('not-a-scheme').id).toBe(SCHEMES[0].id)
    expect(schemeById(null).id).toBe(SCHEMES[0].id)
    expect(schemeById(undefined).id).toBe(SCHEMES[0].id)
  })
})
