// SPDX-License-Identifier: AGPL-3.0-only
// Build the open-source tree: this repository without plugins/, checked for
// anything of a plugin that got out of it.
//
//   node scripts/oss-export.mjs <outDir> [--verify] [--link-modules]
//
// The files are the ones git knows — tracked, plus new files not ignored —
// so a build output or a local scan never travels. Left out: plugins/, and
// whatever plugins/oss-export.json lists under "exclude". From package.json
// go the plugins' own dependencies ("stripDependencies") and every script
// that runs something under plugins/; the lockfile is then brought in line
// with it.
//
// The tree is then read for what must not be in it: the plugins' license
// marker, the phrases plugins/oss-export.json lists under "forbidden" (regular
// expressions, any case), the names it lists under "identifiers" (exact, as
// whole words), and any import into plugins/. A hit stops the export with
// every place listed.
//
// --verify installs, type-checks, tests and builds the tree, the proof that
// the open-source edition stands without plugins/. --link-modules skips the
// install and borrows this checkout's node_modules — quicker locally, but it
// cannot notice a dependency the open-source edition no longer declares.
import { execFileSync, execSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const args = process.argv.slice(2)
const outArg = args.find((a) => !a.startsWith('--'))
if (!outArg) {
  console.error('Usage: node scripts/oss-export.mjs <outDir> [--verify] [--link-modules]')
  process.exit(2)
}
const out = resolve(outArg)
const verify = args.includes('--verify')
const linkModules = args.includes('--link-modules')

/** The license every plugin file carries; never in the open-source tree.
 *  Put together here so that this file does not carry it. */
const MARKER = ['LicenseRef', 'ScanRuler', 'Proprietary'].join('-')
const STAMP = '.oss-export'

const configPath = join(root, 'plugins', 'oss-export.json')
const config = existsSync(configPath)
  ? JSON.parse(readFileSync(configPath, 'utf8'))
  : { exclude: [], forbidden: [], stripDependencies: [] }
const exclude = (config.exclude ?? []).map((p) => p.replace(/\\/g, '/'))
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const forbidden = [
  ...(config.forbidden ?? []).map((term) => ({ term, re: new RegExp(term, 'i') })),
  ...(config.identifiers ?? []).map((term) => ({ term, re: new RegExp('(?<![\\w$])' + escapeRe(term) + '(?![\\w$])') })),
]

const excluded = (path) =>
  path === 'plugins' ||
  path.startsWith('plugins/') ||
  exclude.some((e) => (e.endsWith('/') ? path.startsWith(e) : path === e))

// ---- Copy -------------------------------------------------------------------

if (existsSync(out)) {
  const entries = readdirSync(out)
  if (entries.length > 0 && !entries.includes(STAMP)) {
    console.error(`${out} is not empty and not an earlier export — refusing to overwrite it.`)
    process.exit(2)
  }
  rmSync(out, { recursive: true, force: true })
}
mkdirSync(out, { recursive: true })

const listed = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root })
  .toString('utf8')
  .split('\0')
  .filter(Boolean)
let copied = 0
for (const path of new Set(listed)) {
  if (excluded(path)) continue
  const from = join(root, path)
  if (!existsSync(from)) continue // deleted in the working tree
  const to = join(out, path)
  mkdirSync(dirname(to), { recursive: true })
  cpSync(from, to)
  copied++
}
writeFileSync(join(out, STAMP), 'Written by scripts/oss-export.mjs; safe to delete.\n')

// ---- package.json -----------------------------------------------------------

const pkgPath = join(out, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const stripped = []
for (const name of config.stripDependencies ?? []) {
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    if (pkg[field]?.[name] !== undefined) {
      delete pkg[field][name]
      stripped.push(name)
    }
  }
}
for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
  if (/(^|[\s/'"])plugins\//.test(command)) {
    delete pkg.scripts[name]
    stripped.push(`script ${name}`)
  }
}
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')

// ---- Leak checks ------------------------------------------------------------

const isBinary = (buffer) => buffer.subarray(0, 8000).includes(0)

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) yield* walk(path)
    else yield path
  }
}

const leaks = []
for (const file of walk(out)) {
  const rel = relative(out, file).split(sep).join('/')
  if (rel === STAMP || rel === 'package-lock.json') continue
  const buffer = readFileSync(file)
  if (isBinary(buffer)) continue
  const lines = buffer.toString('utf8').split('\n')
  lines.forEach((line, i) => {
    if (line.includes(MARKER)) leaks.push(`${rel}:${i + 1}  plugin license marker`)
    for (const { term, re } of forbidden) if (re.test(line)) leaks.push(`${rel}:${i + 1}  "${term}"`)
  })
}

console.log(`Exported ${copied} files to ${out}`)
if (stripped.length > 0) console.log(`Left out of package.json: ${stripped.join(', ')}`)

if (leaks.length > 0) {
  console.error(`\nThe open-source tree holds plugin material (${leaks.length}):\n`)
  for (const l of leaks.slice(0, 200)) console.error(`  ${l}`)
  if (leaks.length > 200) console.error(`  … and ${leaks.length - 200} more`)
  process.exit(1)
}

// npm is a .cmd on Windows, which Node starts only through a shell — so the
// command is one string there, each argument quoted.
const quote = (a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)
const run = (command, commandArgs) =>
  process.platform === 'win32' && command !== process.execPath
    ? execSync([command, ...commandArgs].map(quote).join(' '), { cwd: out, stdio: 'inherit' })
    : execFileSync(command, commandArgs, { cwd: out, stdio: 'inherit' })

run(process.execPath, [join(root, 'scripts', 'check-plugin-boundary.mjs'), out])

// The lockfile follows package.json: what the stripped dependencies alone
// pulled in goes with them. Resolved from the lockfile that came along, so
// every version that stays is the one this repository pins.
if (stripped.some((s) => !s.startsWith('script '))) {
  run('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'])
}
const lock = readFileSync(join(out, 'package-lock.json'), 'utf8')
for (const name of config.stripDependencies ?? []) {
  if (lock.includes(`"node_modules/${name}"`)) {
    console.error(`package-lock.json still installs ${name}.`)
    process.exit(1)
  }
}
console.log('No plugin material in the open-source tree.')

if (verify) {
  if (linkModules) symlinkSync(join(root, 'node_modules'), join(out, 'node_modules'), 'junction')
  else run('npm', ['ci', '--no-audit', '--no-fund'])
  run('npm', ['test', '--', '--reporter=dot'])
  run('npm', ['run', 'build'])
  console.log('The open-source tree type-checks, passes its tests and builds.')
}
