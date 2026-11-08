// SPDX-License-Identifier: AGPL-3.0-only
// Who a publish to the public repository credits: real repositories, as the
// publish step runs it.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error A script, without types.
import { creditLines, emailKey, people } from '../scripts/oss-credits.mjs'

const SCRIPT = fileURLToPath(new URL('../scripts/oss-credits.mjs', import.meta.url))
const OWNER = 'owner@example.com'
const ASSISTANT = 'noreply@anthropic.com'
const ANA = 'Ana <1234+ana@users.noreply.github.com>'
const BO = 'Bo <bo@example.com>'

describe('the credit lines', () => {
  const who = (...lines: string[]) => people(lines)

  it('read people out of git log, each once', () => {
    expect(who('Ana <ana@example.com>', '', 'not a person', 'ANA again <ANA@example.com>', '  Bo B. <bo@example.com> ')).toEqual([
      { name: 'Ana', email: 'ana@example.com' },
      { name: 'Bo B.', email: 'bo@example.com' },
    ])
  })

  it('take a no-reply address with or without its number as one', () => {
    expect(emailKey('1234+Ana@users.noreply.github.com')).toBe(emailKey('ana@users.noreply.github.com'))
    expect(emailKey('1234+ana@example.com')).toBe('1234+ana@example.com')
  })

  it('leave out the maintainer, the assistant and bots', () => {
    const everyone = who(`Owner <${OWNER}>`, `Claude <${ASSISTANT}>`, 'github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>', BO)
    expect(creditLines({ release: everyone, everyone, creditedRelease: [], creditedEver: [], skip: [OWNER, ASSISTANT] })).toEqual([`Co-authored-by: ${BO}`])
  })
})

describe('a publish', () => {
  let root = ''
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const git = (repo: string, ...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: 'pipe' })
  /** A commit by `author`, of a file. */
  const commit = (repo: string, author: string, file: string, message = 'work') => {
    mkdirSync(dirname(join(repo, file)), { recursive: true })
    writeFileSync(join(repo, file), `${Math.random()}`)
    git(repo, 'add', '-A')
    git(repo, '-c', `user.name=Owner`, '-c', `user.email=${OWNER}`, 'commit', '-q', `--author=${author}`, '-m', message)
  }
  const start = () => {
    root = mkdtempSync(join(tmpdir(), 'oss-credits-'))
    const dev = join(root, 'dev')
    const pub = join(root, 'pub')
    for (const repo of [dev, pub]) {
      mkdirSync(repo)
      git(repo, 'init', '-q')
    }
    mkdirSync(join(dev, 'plugins'))
    writeFileSync(join(dev, 'plugins', 'oss-export.json'), JSON.stringify({ exclude: ['plugins/closed/'] }))
    return { dev, pub }
  }
  const credits = (dev: string, pub: string, since: string, from?: string) =>
    execFileSync(process.execPath, [SCRIPT, '--private', dev, '--public', pub, '--since', since, ...(from ? ['--from', from] : []), '--skip', `${OWNER},${ASSISTANT}`], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)

  it('credits someone from before it existed, then only for new work', () => {
    const { dev, pub } = start()
    commit(dev, `Owner <${OWNER}>`, 'a.txt', `first\n\nCo-authored-by: Claude <${ASSISTANT}>`)
    commit(dev, ANA, 'b.txt')
    commit(dev, BO, 'c.txt')
    git(dev, 'tag', 'v1.0.0')
    commit(pub, `Bot <41898282+github-actions[bot]@users.noreply.github.com>`, 'a.txt', 'ScanRuler 1.0.0')
    git(pub, 'tag', 'v1.0.0')

    // Never credited, though from before the last version: made good.
    expect(credits(dev, pub, 'v1.0.0').sort()).toEqual([`Co-authored-by: ${ANA}`, `Co-authored-by: ${BO}`])
    commit(pub, 'Bot <1+x[bot]@users.noreply.github.com>', 'b.txt', `Update\n\nCo-authored-by: ${ANA}\nCo-authored-by: ${BO}`)
    expect(credits(dev, pub, 'v1.0.0'), 'said once').toEqual([])

    // Ana's next work is credited in the next release, and once.
    commit(dev, ANA, 'd.txt')
    git(dev, 'tag', 'v1.1.0')
    commit(dev, ANA, 'e.txt')
    git(pub, 'tag', 'v1.1.0')
    expect(credits(dev, pub, 'v1.1.0')).toEqual([`Co-authored-by: ${ANA}`])
    commit(pub, 'Bot <1+x[bot]@users.noreply.github.com>', 'c.txt', `ScanRuler 1.2.0\n\nCo-authored-by: ${ANA}`)
    expect(credits(dev, pub, 'v1.1.0')).toEqual([])
  })

  it('credits what was brought since the last publish, though a version in between never reached the public side', () => {
    const { dev, pub } = start()
    commit(dev, ANA, 'a.txt')
    git(dev, 'tag', 'v1.0.0')
    commit(pub, 'Bot <1+x[bot]@users.noreply.github.com>', 'a.txt', 'ScanRuler 1.0.0')
    git(pub, 'tag', 'v1.0.0')
    // Ana's older work, published between versions and credited there.
    commit(dev, ANA, 'b.txt')
    git(dev, 'tag', 'oss-published')
    commit(pub, 'Bot <1+x[bot]@users.noreply.github.com>', 'b.txt', `Update\n\nCo-authored-by: ${ANA}`)
    // 1.1.0 never reaches the public side; 1.2.0 brings it and Ana's new work.
    git(dev, 'tag', 'v1.1.0')
    commit(dev, ANA, 'c.txt')
    // Counted by person since the last public version, Ana's new work is hid by
    // the Update that credited her older work.
    expect(credits(dev, pub, 'v1.0.0')).toEqual([])
    // Counted by commit since the last publish, it is credited.
    expect(credits(dev, pub, 'v1.0.0', 'oss-published')).toEqual([`Co-authored-by: ${ANA}`])
    // Once published and marked, nothing is owed.
    commit(pub, 'Bot <1+x[bot]@users.noreply.github.com>', 'c.txt', `ScanRuler 1.2.0\n\nCo-authored-by: ${ANA}`)
    git(dev, 'tag', '-f', 'oss-published')
    expect(credits(dev, pub, 'v1.0.0', 'oss-published')).toEqual([])
  })

  it('takes a co-author on a contribution, and nothing that stays private', () => {
    const { dev, pub } = start()
    commit(dev, `Owner <${OWNER}>`, 'a.txt')
    commit(dev, 'Closed <closed@example.com>', 'plugins/closed/x.ts')
    commit(dev, ANA, 'b.txt', `pair\n\nCo-authored-by: ${BO}`)
    commit(pub, 'Bot <1+x[bot]@users.noreply.github.com>', 'a.txt', 'ScanRuler 1.0.0')
    // A version with no tag yet says nothing of a release, and no harm comes.
    expect(credits(dev, pub, 'v9.9.9')).toEqual([`Co-authored-by: ${ANA}`, `Co-authored-by: ${BO}`])
  })
})
