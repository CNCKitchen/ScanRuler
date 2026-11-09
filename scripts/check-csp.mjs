// SPDX-License-Identifier: AGPL-3.0-only
// The built app against its Content-Security-Policy (public/_headers): every
// worker script that can load code building functions from strings — the
// Emscripten bindings of occt-wasm and manifold-3d do, with new Function — is
// sent 'unsafe-eval', and no other worker is. A worker takes its policy from
// its own response, so a worker without it fails only on the hosted app, at
// the first call into the library, with "call to Function() blocked by CSP".
//
// The page itself is not checked: it reaches the kernel only through the
// headless entry (plugins' headless()), never run in a browser.
//
//   npm run build && node scripts/check-csp.mjs [dist]
//
// Exits non-zero, naming each worker, when a policy and the build disagree.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const dist = resolve(process.argv[2] ?? join(root, 'dist'))
const assets = join(dist, 'assets')
if (!existsSync(assets)) {
  console.error(`check-csp: no ${assets} — build the app first (npm run build).`)
  process.exit(2)
}

/** Each path rule of _headers and the policy it leaves, applied in order the
 *  way Cloudflare does: `! Name` drops what an earlier rule set. */
function policyOf(path) {
  let policy = ''
  let rule = null
  for (const line of readFileSync(join(root, 'public/_headers'), 'utf8').split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue
    if (/^\S/.test(line)) {
      const pattern = line.trim().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
      rule = new RegExp(`^${pattern}$`).test(path)
      continue
    }
    if (!rule) continue
    if (/^\s*!\s*Content-Security-Policy\s*$/i.test(line)) policy = ''
    const csp = /^\s*Content-Security-Policy:\s*(.+)$/i.exec(line)?.[1]
    if (csp) policy = policy ? `${policy}, ${csp}` : csp
  }
  return policy
}

const files = readdirSync(assets).filter((f) => f.endsWith('.js'))
const source = new Map(files.map((f) => [f, readFileSync(join(assets, f), 'utf8')]))

/** Code that builds a function from a string: new Function(…), a bare
 *  Function(…) or eval(…), and embind's newFunc(Function, …). */
function evaluates(code) {
  const plain = code.replace(/addFunction\(|WebAssembly\.Function\(/g, '')
  return /new Function\(|[^\w$.]Function\(|\(Function,|[^\w$.]eval\(/.test(plain)
}

/** The chunks a chunk names — static imports, dynamic ones, preload lists. */
const named = (file) =>
  [...source.get(file).matchAll(/["'`](?:\.?\/)?(?:assets\/)?([\w.-]+\.js)["'`]/g)].map((m) => m[1]).filter((f) => f !== file && source.has(f))

/** Every chunk a worker can load, itself included. */
function reach(entry) {
  const seen = new Set([entry])
  const queue = [entry]
  while (queue.length) for (const f of named(queue.shift())) if (!seen.has(f)) (seen.add(f), queue.push(f))
  return seen
}

// The worker scripts: whatever any chunk starts with new Worker(new URL(…)).
const workers = new Set()
for (const code of source.values())
  for (const m of code.matchAll(/new (?:Shared)?Worker\(\s*new URL\(\s*["'`](?:\.?\/)?(?:assets\/)?([\w.-]+\.js)["'`]/g)) if (source.has(m[1])) workers.add(m[1])

const problems = []
for (const worker of [...workers].sort()) {
  const evaluating = [...reach(worker)].filter((f) => evaluates(source.get(f)))
  const policy = policyOf(`/assets/${worker}`)
  const allowed = /'unsafe-eval'/.test(policy)
  const name = worker.replace(/-[\w-]+\.js$/, '')
  if (evaluating.length > 0 && !allowed)
    problems.push(`${name} loads ${evaluating.join(', ')}, which build functions from strings, but its policy has no 'unsafe-eval'`)
  else if (evaluating.length === 0 && allowed) problems.push(`${name} is sent 'unsafe-eval' but loads nothing that needs it — narrow its rule`)
  console.log(`${name.padEnd(18)} ${evaluating.length ? 'evaluates strings' : '-'.padEnd(17)}  ${allowed ? "'unsafe-eval'" : 'strict'}`)
}

if (workers.size === 0) problems.push(`no worker scripts found in ${assets}`)
if (problems.length > 0) {
  console.error(`\ncheck-csp: public/_headers and the build disagree:\n${problems.map((p) => `  - ${p}`).join('\n')}`)
  process.exit(1)
}
console.log(`\ncheck-csp: ${workers.size} workers, each with the policy it needs.`)
