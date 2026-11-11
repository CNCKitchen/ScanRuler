// SPDX-License-Identifier: AGPL-3.0-only
// `.note-label` is the 2D sheet's text note (FlatScene). The Reverse
// engineer's note pins once used the same class, so their offset beside the
// badge moved every 2D note 34 px right and 17 px up from where it was
// placed. The pins have their own class; this stylesheet may touch the 2D
// one only through the sketch glyphs it draws as such notes.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../ui/reverse.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

/** Every selector in the stylesheet, one per comma-separated part. */
const selectors = [...css.matchAll(/([^{}]+)\{/g)].flatMap((m) => m[1].split(',').map((s) => s.trim())).filter(Boolean)

describe('reverse.css and the 2D note', () => {
  it('styles the 2D sheet note only as a sketch glyph', () => {
    const touching = selectors.filter((s) => /\.note-label\b/.test(s))
    expect(touching.length).toBeGreaterThan(0)
    for (const s of touching) expect(s).toMatch(/^\.viewport-label\.note-label\.glyph\b/)
  })

  it('gives the note pins their own class', () => {
    expect(selectors).toContain('.re-note-label')
  })
})
