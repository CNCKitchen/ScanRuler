// SPDX-License-Identifier: AGPL-3.0-only
// The privacy policy in the Imprint says what the app keeps and fetches,
// held against the code that does it. It said scans stay in memory and are
// gone with the tab, and that four preferences are stored; in fact a
// recovery copy of the work goes to IndexedDB, some forty settings to
// localStorage (the agent link's token among them), and a ?open= link
// fetches from whatever server it names (issue 34).

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const imprint = readFileSync('src/ui/Imprint.tsx', 'utf8').replace(/\s+/g, ' ')

/** Every source file under a folder, tests left out. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sources(path)
    return /\.tsx?$/.test(name) && !/\.test\./.test(name) ? [path] : []
  })
}
const code = sources('src').map((f) => readFileSync(f, 'utf8')).join('\n')

describe('the Imprint’s privacy policy', () => {
  it('names the recovery copy in IndexedDB where the app keeps one', () => {
    expect(code.includes('indexedDB.open('), 'the app keeps an IndexedDB store').toBe(true)
    expect(/IndexedDB/.test(imprint), 'names IndexedDB').toBe(true)
    expect(/held in memory for the duration of the session only/.test(imprint), 'says scans stay in memory').toBe(false)
  })

  it('does not count the settings kept in localStorage, and names the agent token', () => {
    const keys = new Set(code.match(/'scanruler\.[a-z0-9.]+'/g) ?? [])
    expect(keys.size).toBeGreaterThan(4)
    expect(/\b(four|five|six) preferences\b/.test(imprint), 'counts the preferences').toBe(false)
    expect(code.includes("'scanruler.agenttoken'"), 'the agent token is a key').toBe(true)
    expect(/token/.test(imprint), 'names the token').toBe(true)
  })

  it('says a link that opens a file fetches it from where it points', () => {
    expect(code.includes("get('open')"), 'the app reads ?open=').toBe(true)
    expect(/\?open=/.test(imprint), 'names ?open=').toBe(true)
  })
})
