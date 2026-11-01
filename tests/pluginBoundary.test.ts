// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const CHECK = fileURLToPath(new URL('../scripts/check-plugin-boundary.mjs', import.meta.url))

describe('the plugin boundary check', () => {
  let root: string
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  /** The check run over a tree of the given files. */
  const check = (files: Record<string, string>) => {
    root = mkdtempSync(join(tmpdir(), 'boundary-'))
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), text)
    }
    return spawnSync(process.execPath, [CHECK, root], { encoding: 'utf8' })
  }

  it('reads src/plugins/ too, where a reach into plugins/ is likeliest', () => {
    const run = check({
      'plugins/x/plugin.ts': 'export const x = 1\n',
      'src/plugins/api.ts': "import { x } from '../../plugins/x/plugin'\n",
    })
    expect(run.status).toBe(1)
    expect(run.stdout + run.stderr).toContain('src/plugins/api.ts:1')
  })

  it('lets a plugin import from itself', () => {
    const run = check({
      'plugins/x/plugin.ts': "import { y } from './y'\n",
      'plugins/x/y.ts': 'export const y = 1\n',
    })
    expect(run.status).toBe(0)
  })
})
