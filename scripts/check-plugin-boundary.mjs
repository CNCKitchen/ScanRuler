// SPDX-License-Identifier: AGPL-3.0-only
// The one rule the plugin split rests on: nothing outside plugins/ reaches
// into it. The app finds its plugins by a glob that matches nothing when the
// folder is absent — which is how the open-source tree builds — so any other
// path into plugins/ is a file the open-source build would fail to find, or,
// worse, code of a plugin that would have to be published to make it build.
//
// Every import-like reference is checked: static and dynamic imports,
// re-exports, `new URL(…, import.meta.url)` (workers, wasm, assets), CSS
// @import and url(), and import.meta.glob patterns — the last allowed only
// in the registries that discover plugins.
//
//   node scripts/check-plugin-boundary.mjs [root]
//
// Exits non-zero, listing each reference, when the rule is broken.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(process.argv[2] ?? fileURLToPath(new URL('../', import.meta.url)))
const pluginsDir = join(root, 'plugins')

/** The files that discover plugins, and so may name plugins/ in a glob. */
const REGISTRIES = new Set(['src/plugins/registry.ts', 'src/core/workerPlugins.ts'])

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.wrangler', 'e2e-out', 'plugins'])
const EXTENSIONS = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|css|html)$/

const PATTERNS = [
  // import x from '…', export { x } from '…', import type … from '…'
  /\b(?:import|export)\s[^;'"`]*?\bfrom\s*(['"])([^'"]+)\1/g,
  // import '…' (side effect)
  /\bimport\s*(['"])([^'"]+)\1/g,
  // import('…'), vi.mock('…'), require('…')
  /\b(?:import|require|mock|doMock|importActual)\s*\(\s*(['"`])([^'"`]+)\1/g,
  // new URL('…', import.meta.url)
  /\bnew\s+URL\s*\(\s*(['"`])([^'"`]+)\1\s*,\s*import\.meta\.url/g,
  // CSS
  /@import\s+(?:url\()?\s*(['"])([^'"]+)\1/g,
  /\burl\(\s*(['"]?)([^'")]+)\1\s*\)/g,
]
const GLOB = /\bimport\.meta\.glob(?:<[^>]*>)?\s*\(\s*([\s\S]*?)\)/g

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    const stat = statSync(path)
    if (stat.isDirectory()) {
      if (!SKIP_DIRS.has(name)) yield* walk(path)
    } else if (EXTENSIONS.test(name)) yield path
  }
}

/** Where a specifier points, if it is a path at all: relative to the file,
 *  or absolute from the project root the way Vite reads `/…`. */
function target(file, spec) {
  if (spec.startsWith('./') || spec.startsWith('../')) return resolve(dirname(file), spec)
  if (spec.startsWith('/')) return join(root, spec)
  return null
}

const insidePlugins = (path) => path === pluginsDir || path.startsWith(pluginsDir + sep)

const lineOf = (text, index) => text.slice(0, index).split('\n').length

// A set: one CSS line can match both @import and url().
const violations = new Set()
for (const file of walk(root)) {
  const rel = relative(root, file).split(sep).join('/')
  const text = readFileSync(file, 'utf8')
  for (const pattern of PATTERNS) {
    for (const m of text.matchAll(pattern)) {
      const to = target(file, m[2])
      if (to && insidePlugins(to)) violations.add(`${rel}:${lineOf(text, m.index)}  ${m[2]}`)
    }
  }
  for (const m of text.matchAll(GLOB)) {
    const specs = [...m[1].matchAll(/(['"`])([^'"`]+)\1/g)].map((s) => s[2])
    for (const spec of specs) {
      const to = target(file, spec.replace(/^!/, ''))
      if (to && insidePlugins(to) && !REGISTRIES.has(rel)) {
        violations.add(`${rel}:${lineOf(text, m.index)}  import.meta.glob ${spec} (only the plugin registries may glob plugins/)`)
      }
    }
  }
}

if (violations.size > 0) {
  console.error(`Code outside plugins/ reaches into it (${violations.size}):\n`)
  for (const v of violations) console.error(`  ${v}`)
  console.error('\nThe open-source tree has no plugins/ folder. Go through the plugin registry instead — see plugins/README.md.')
  process.exit(1)
}
console.log('Plugin boundary holds: nothing outside plugins/ imports from it.')
