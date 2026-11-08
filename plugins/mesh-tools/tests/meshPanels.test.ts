// SPDX-License-Identifier: AGPL-3.0-only
// The tool panels read the Mesh Tools store through a selector: one that
// takes the whole store renders again on every write to it.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const TOOLS = join(__dirname, '../ui/tools')

describe('the Mesh Tools panels', () => {
  it('subscribe to the fields they read, not the whole store', () => {
    const whole = readdirSync(TOOLS)
      .filter((f) => f.endsWith('.tsx'))
      .filter((f) => /useMeshTools\(\s*\)/.test(readFileSync(join(TOOLS, f), 'utf8')))
    expect(whole).toEqual([])
  })
})
