// SPDX-License-Identifier: AGPL-3.0-only
// Who a commit to the public repository credits. Contributions are applied to
// the development repository, and each publish is a single commit of the whole
// tree, so their authors would never show here without Co-authored-by lines:
// GitHub counts those as contributions. Credited are the authors of what this
// publish brings, and anyone in the whole development history never credited
// at all, so a contribution from before this script is made good too. Commits
// that touch only what stays private count for nothing.
//
// What a publish brings is the commits since the one the last publish was made
// from, which the publish marks with a tag (--from, `oss-published`): a publish
// that failed leaves the mark where it was, and the next one brings its
// commits. Without the mark — the first publish after it came in — the release
// is the commits since the last version (--since), less the people a public
// commit since that version has credited. That second way is by person, not by
// commit: when a version never reached the public repository, a commit after
// the version before it that credited someone for older work hid their new
// work, as it did in 0.9.6.
//
//   node scripts/oss-credits.mjs --private <repo> --public <repo> --from oss-published --since v1.2.3 --skip a@b.c,d@e.f
//
// Prints a Co-authored-by line each, or nothing. --skip names the emails that are
// never credited, the maintainer's and an assistant's; bots never are.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** One email however GitHub writes it: case aside, and its no-reply address with
 *  or without the account's number. */
export function emailKey(email) {
  return email.trim().toLowerCase().replace(/^\d+\+(.*@users\.noreply\.github\.com)$/, '$1')
}

/** The people in `git log` lines of the form "Name <email>", in order, each
 *  once. Lines of any other form, such as blank ones, say nothing. */
export function people(lines) {
  const found = new Map()
  for (const line of lines) {
    const m = /^\s*(.+?)\s*<([^<>\s]+@[^<>\s]+)>\s*$/.exec(line)
    if (m && !found.has(emailKey(m[2]))) found.set(emailKey(m[2]), { name: m[1], email: m[2] })
  }
  return [...found.values()]
}

const isBot = (p) => /\[bot\]/i.test(`${p.name} ${p.email}`)

/** The lines to credit, given who is in what. `release`: the authors of what
 *  this release brings. `everyone`: of the whole development history.
 *  `creditedRelease`: the public repository's commits since the last version.
 *  `creditedEver`: its whole history. */
export function creditLines({ release, everyone, creditedRelease, creditedEver, skip = [] }) {
  const keys = (list) => new Set(list.map((p) => emailKey(p.email)))
  const skipped = new Set(skip.map(emailKey))
  const inRelease = keys(creditedRelease)
  const ever = keys(creditedEver)
  const owed = [...release.filter((p) => !inRelease.has(emailKey(p.email))), ...everyone.filter((p) => !ever.has(emailKey(p.email)))]
  const seen = new Set()
  return owed
    .filter((p) => {
      const key = emailKey(p.email)
      if (seen.has(key) || skipped.has(key) || isBot(p)) return false
      seen.add(key)
      return true
    })
    .map((p) => `Co-authored-by: ${p.name} <${p.email}>`)
}

/** The authors and co-authors of a range of a repository, or of all of it. */
function logPeople(repo, range, paths = []) {
  const format = '--format=%aN <%aE>%n%(trailers:key=Co-authored-by,valueonly)'
  const args = ['-C', repo, 'log', format, ...(range ? [range] : ['HEAD']), ...(paths.length > 0 ? ['--', '.', ...paths] : [])]
  return people(execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28 }).split('\n'))
}

const hasTag = (repo, tag) => {
  try {
    execFileSync('git', ['-C', repo, 'rev-parse', '-q', '--verify', `refs/tags/${tag}^{commit}`], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** Pathspecs leaving out what the export keeps private. */
function privatePaths(repo) {
  const config = join(repo, 'plugins', 'oss-export.json')
  if (!existsSync(config)) return []
  return JSON.parse(readFileSync(config, 'utf8')).exclude.map((path) => `:(exclude)${path}`)
}

function main() {
  const option = (name) => {
    const at = process.argv.indexOf(`--${name}`)
    return at < 0 ? undefined : process.argv[at + 1]
  }
  const dev = option('private')
  const pub = option('public')
  const since = option('since')
  const from = option('from')
  if (!dev || !pub) throw new Error('Give --private and --public.')
  const paths = privatePaths(dev)
  // The commits since the last publish, none of them credited yet; or, with
  // no mark, those since the last version, as far as the public side says.
  const marked = Boolean(from) && hasTag(dev, from)
  const known = Boolean(since) && hasTag(dev, since)
  const lines = creditLines({
    release: marked ? logPeople(dev, `${from}..HEAD`, paths) : known ? logPeople(dev, `${since}..HEAD`, paths) : [],
    everyone: logPeople(dev, null, paths),
    creditedRelease: !marked && since && hasTag(pub, since) ? logPeople(pub, `${since}..HEAD`) : [],
    creditedEver: logPeople(pub, null),
    skip: (option('skip') ?? '').split(',').filter(Boolean),
  })
  if (lines.length > 0) console.log(lines.join('\n'))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
