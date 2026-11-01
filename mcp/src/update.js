// SPDX-License-Identifier: AGPL-3.0-only
// The server keeps itself current. A config written as `npx -y
// scanruler-mcp` is rarely changed again, and a copy installed or copied by
// hand never updates at all; so the server does it by itself, in two halves
// that never hold up the start:
//
// - In the background, once it serves, it asks npm's registry which version
//   is latest — once a day, 2 s at most, the answer kept in update.json
//   beside tools.json — and when that is newer than itself, has npm fetch it
//   into npm's cache: `npm exec --yes --package=scanruler-mcp@<v> --
//   scanruler-mcp --version`, which runs the fetched copy once, so a copy
//   that does not start is never taken. The session in progress goes on.
// - At the next start the launcher (bin/scanruler-mcp.js) finds that copy in
//   update.json (`ready: { version, bin }` — a contract every later version
//   keeps, since the copy that reads it may be an old one) and runs it in its
//   own place: the same arguments, stdio passed straight through, its exit
//   code passed back. No network before serving.
//
// Every failure leaves the copy that is running: offline, registry down,
// fetch or start failed. Off for a copy run from a git checkout (the dev
// server), with --no-update or SCANRULER_MCP_NO_UPDATE=1, and for a spec
// pinned in the config (`npx -y scanruler-mcp@0.4.0` is taken as meant).
// The hand-off is marked in the environment, so a handed-to copy never hands
// off again in the same start.
//
// npx keeps each spec in its own folder, <npm cache>/_npx/<hash>, the hash
// the first 16 hex digits of the SHA-512 of the spec as written (npm's
// libnpmexec). A copy run by npx tells from that hash whether its spec was
// pinned, and finds npm's cache from its own path.

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { configDir } from './config.js'

export const PACKAGE = 'scanruler-mcp'
/** Set on the copy handed to: the version that handed off. */
export const HANDED_OFF_ENV = 'SCANRULER_MCP_HANDED_OFF'
/** The launcher's process id, for the copy handed to to stop with it. */
export const PARENT_ENV = 'SCANRULER_MCP_PARENT_PID'
export const NO_UPDATE_ENV = 'SCANRULER_MCP_NO_UPDATE'
export const CHECK_EVERY_MS = 24 * 60 * 60 * 1000
export const CHECK_WITHIN_MS = 2000
/** A handed-to copy that fails sooner than this is taken as not starting. */
export const START_GRACE_MS = 3000
/** The exit code of a server that stopped on its arguments or settings — a
 *  bad --port, say — rather than failing to start: a copy handed to that
 *  ends with it is not marked failed. */
export const USAGE_EXIT = 2
const FETCH_WITHIN_MS = 5 * 60 * 1000
const STATE_FILE = 'update.json'
/** Options that answer and exit: never handed off. */
const OWN_ANSWERS = ['--help', '--pair', '--version']

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url))

// ---- versions -------------------------------------------------------------

const parse = (v) => {
  const m = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/.exec(typeof v === 'string' ? v : '')
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ?? null] : null
}

export const isVersion = (v) => parse(v) !== null

/** Whether version `a` is newer than `b`; false when either is no version. */
export function newer(a, b) {
  const x = parse(a)
  const y = parse(b)
  if (!x || !y) return false
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]
  return x[3] === null && y[3] !== null
}

/** npx's folder name for a spec: <npm cache>/_npx/<this>. */
export const npxHash = (spec) => createHash('sha512').update(spec).digest('hex').slice(0, 16)

/** The version of the copy whose bin is `bin`, or null. */
export function versionAt(bin, read = readFileSync) {
  try {
    const v = JSON.parse(read(join(dirname(bin), '..', 'package.json'), 'utf8')).version
    return isVersion(v) ? v : null
  } catch {
    return null
  }
}

// ---- how this copy runs -------------------------------------------------------

/** How the copy in `packageDir` was installed: by npx (`npx`, with npm's
 *  cache, and pinned unless its spec was the bare name or @latest), by npm
 *  (`installed`: global or a project's), from a git checkout (`checkout`),
 *  or copied by hand (`copy`). */
export function installOf(packageDir = PACKAGE_DIR, exists = existsSync) {
  const parent = dirname(packageDir)
  if (basename(parent) === 'node_modules') {
    const npxDir = dirname(parent)
    if (basename(dirname(npxDir)) === '_npx') {
      const hash = basename(npxDir)
      const bare = [PACKAGE, `${PACKAGE}@latest`].some((spec) => npxHash(spec) === hash)
      return { kind: 'npx', pinned: !bare, npmCache: dirname(dirname(npxDir)) }
    }
    return { kind: 'installed', pinned: false }
  }
  for (let dir = parent; ; dir = dirname(dir)) {
    if (exists(join(dir, '.git'))) return { kind: 'checkout', pinned: false }
    if (dirname(dir) === dir) return { kind: 'copy', pinned: false }
  }
}

/** Whether this copy keeps itself current: `updates` is `on`, `off`
 *  (--no-update, SCANRULER_MCP_NO_UPDATE), `checkout` or `pinned`. A copy
 *  handed to goes by the launcher's decision, not its own folder — which is
 *  a pinned spec's. */
export function updatePolicy({ argv = [], env = process.env, install }) {
  const handedOffFrom = env[HANDED_OFF_ENV] || null
  const from = handedOffFrom ? { handedOffFrom } : {}
  if (argv.includes('--no-update') || /^(1|true|yes|on)$/i.test(env[NO_UPDATE_ENV] ?? '')) return { updates: 'off', ...from }
  if (handedOffFrom) return { updates: 'on', ...from }
  if (install.kind === 'checkout') return { updates: 'checkout' }
  if (install.pinned) return { updates: 'pinned', pinned: true }
  return { updates: 'on' }
}

// ---- what is kept ---------------------------------------------------------------

/** update.json: `{ checked, latest, ready?: { version, bin }, failed? }`. */
export function loadState(dir = configDir()) {
  try {
    const kept = JSON.parse(readFileSync(join(dir, STATE_FILE), 'utf8'))
    return kept && typeof kept === 'object' ? kept : {}
  } catch {
    return {}
  }
}

/** Merge `patch` into update.json — written whole and renamed into place,
 *  since two copies may start at once. */
export function saveState(patch, dir = configDir()) {
  const next = { ...loadState(dir), ...patch }
  try {
    mkdirSync(dir, { recursive: true })
    const file = join(dir, STATE_FILE)
    const part = `${file}.${process.pid}.part`
    writeFileSync(part, JSON.stringify(next, null, 2) + '\n')
    renameSync(part, file)
  } catch {
    // Not kept: the next start asks again.
  }
  return next
}

// ---- the launcher ---------------------------------------------------------------

/** What the launcher runs: `{ run: 'self', why }` or `{ run: 'handoff',
 *  bin, version }` — read from update.json and the disk alone. */
export function launchPlan({ argv = [], env = process.env, version, install, state = {}, exists = existsSync, readVersion = versionAt }) {
  const self = (why) => ({ run: 'self', why })
  if (env[HANDED_OFF_ENV]) return self('handed-off')
  if (argv.some((a) => OWN_ANSWERS.includes(a))) return self('answer')
  const policy = updatePolicy({ argv, env, install })
  if (policy.updates !== 'on') return self(policy.updates)
  const ready = state.ready
  if (!ready || typeof ready.bin !== 'string' || !newer(ready.version, version)) return self('current')
  if (Array.isArray(state.failed) && state.failed.includes(ready.version)) return self('failed-before')
  if (!exists(ready.bin) || readVersion(ready.bin) !== ready.version) return self('missing')
  return { run: 'handoff', bin: ready.bin, version: ready.version }
}

/** Run the copy at `plan.bin` in this one's place. Resolves `{ code }` with
 *  its exit code, or `{ fallback }` when it did not start — failed to
 *  spawn, or ended with an error within START_GRACE_MS, then marked failed
 *  so the next start does not try it again. */
export function runHandOff({ plan, argv, version, env = process.env, spawnFn = spawn, now = Date.now, markFailed = () => {}, execPath = process.execPath }) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawnFn(execPath, [plan.bin, ...argv], {
        stdio: 'inherit',
        env: { ...env, [HANDED_OFF_ENV]: version, [PARENT_ENV]: String(process.pid) },
        windowsHide: true,
      })
    } catch (e) {
      resolve({ fallback: `could not start it: ${e?.message ?? e}` })
      return
    }
    const started = now()
    const forward = (signal) => () => child.kill(signal)
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'].map((s) => [s, forward(s)])
    for (const [s, f] of signals) process.on(s, f)
    const done = (out) => {
      for (const [s, f] of signals) process.off(s, f)
      resolve(out)
    }
    child.once('error', (e) => done({ fallback: `could not start it: ${e?.message ?? e}` }))
    child.once('exit', (code, signal) => {
      // A copy that refused its arguments started well: this copy would
      // refuse them too, and by now the child may have read the client's
      // first message, so its code is passed on and the version kept.
      if (code === USAGE_EXIT) done({ code })
      else if (code !== 0 && signal === null && now() - started < START_GRACE_MS) {
        markFailed(plan.version)
        done({ fallback: `it stopped with code ${code} as it started` })
      } else done({ code: code ?? 1 })
    })
  })
}

/** The launcher's part: run a newer copy fetched earlier in this one's
 *  place. Resolves its exit code, or null for this copy to run — always
 *  null on any failure. */
export async function launch(argv, { env = process.env, packageDir = PACKAGE_DIR, dir, log = stderrLog } = {}) {
  try {
    const version = versionAt(join(packageDir, 'bin', 'scanruler-mcp.js'))
    const where = dir ?? configDir(env)
    const plan = launchPlan({ argv, env, version, install: installOf(packageDir), state: loadState(where) })
    if (plan.run !== 'handoff') return null
    log(`Starting scanruler-mcp ${plan.version}, fetched earlier, in place of ${version}.`)
    const out = await runHandOff({
      plan,
      argv,
      version,
      env,
      markFailed: (v) => {
        const failed = loadState(where).failed
        saveState({ failed: [...(Array.isArray(failed) ? failed : []), v].slice(-5) }, where)
      },
    })
    if ('code' in out) return out.code
    log(`scanruler-mcp ${plan.version} did not start (${out.fallback}); running ${version}.`)
    return null
  } catch {
    return null
  }
}

/** In a copy handed to: stop when the launcher is gone — killed by the
 *  client, which on Windows does not take its children with it. */
export function watchParent(env = process.env, { every = 2000, alive = processAlive, exit = () => process.exit(0) } = {}) {
  const pid = Number(env[PARENT_ENV])
  if (!env[HANDED_OFF_ENV] || !Number.isInteger(pid) || pid <= 0) return null
  const timer = setInterval(() => {
    if (!alive(pid)) exit()
  }, every)
  timer.unref?.()
  return timer
}

function processAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e?.code === 'EPERM'
  }
}

const stderrLog = (line) => process.stderr.write(`[scanruler-mcp] ${line}\n`)

// ---- the background check ---------------------------------------------------------

/** The latest version on the registry npm uses, or null — 2 s at most. */
export async function fetchLatest({ env = process.env, fetchFn = fetch, within = CHECK_WITHIN_MS } = {}) {
  try {
    const registry = (env.npm_config_registry || 'https://registry.npmjs.org/').replace(/\/?$/, '/')
    const r = await fetchFn(`${registry}${PACKAGE}/latest`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(within) })
    if (!r.ok) return null
    const { version } = await r.json()
    return isVersion(version) ? version : null
  } catch {
    return null
  }
}

/** How to run npm without a shell: the npm that ran npx, or the one beside
 *  this Node; `npm` through the shell as the last resort. */
export function npmCommand(env = process.env, execPath = process.execPath, exists = existsSync) {
  const given = env.npm_execpath ?? ''
  const candidates = [
    /npm-cli\.js$/.test(given) ? given : null,
    /npx-cli\.js$/.test(given) ? join(dirname(given), 'npm-cli.js') : null,
    join(dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]
  const cli = candidates.find((c) => c && exists(c))
  return cli ? { file: execPath, args: [cli], shell: false } : { file: 'npm', args: [], shell: process.platform === 'win32' }
}

/** Run npm with `args` (fixed words and a checked version only — they may
 *  pass a shell), quietly, from the temp folder: `{ code, stdout }`. */
export function runNpm(args, { env = process.env, within = FETCH_WITHIN_MS, spawnFn = spawn } = {}) {
  return new Promise((resolve) => {
    const npm = npmCommand(env)
    let child
    try {
      child = spawnFn(npm.file, [...npm.args, ...args], {
        cwd: tmpdir(),
        env: { ...env, [NO_UPDATE_ENV]: '1', [HANDED_OFF_ENV]: '' },
        stdio: ['ignore', 'pipe', 'ignore'],
        shell: npm.shell,
        windowsHide: true,
      })
    } catch {
      resolve({ code: -1, stdout: '' })
      return
    }
    let stdout = ''
    child.stdout?.on('data', (d) => {
      if (stdout.length < 4096) stdout += d
    })
    const timer = setTimeout(() => child.kill(), within)
    timer.unref?.()
    child.once('error', () => {
      clearTimeout(timer)
      resolve({ code: -1, stdout })
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout })
    })
  })
}

/** npm's cache folder when nobody says otherwise. */
const defaultNpmCache = (env, platform = process.platform) =>
  platform === 'win32' ? join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'npm-cache') : join(homedir(), '.npm')

/** Have npm fetch `version` into its cache and run it once; the bin of the
 *  copy fetched, or null. */
export async function prefetch(version, { env = process.env, install = { kind: 'copy' }, npm = runNpm, readVersion = versionAt } = {}) {
  if (!isVersion(version)) return null
  const spec = `${PACKAGE}@${version}`
  const ran = await npm(['exec', '--yes', `--package=${spec}`, '--', PACKAGE, '--version'], { env })
  if (ran.code !== 0 || ran.stdout.trim() !== version) return null
  const binIn = (cache) => join(cache, '_npx', npxHash(spec), 'node_modules', PACKAGE, 'bin', 'scanruler-mcp.js')
  const caches = [install.npmCache, env.npm_config_cache, defaultNpmCache(env)].filter(Boolean)
  for (const cache of caches) if (readVersion(binIn(cache)) === version) return binIn(cache)
  const asked = await npm(['config', 'get', 'cache'], { env, within: 30_000 })
  const cache = asked.code === 0 ? asked.stdout.trim() : ''
  return cache && readVersion(binIn(cache)) === version ? binIn(cache) : null
}

/** The background check: ask the registry (once a day), and fetch a newer
 *  version for the next start. Resolves the state kept. */
export async function checkForUpdate({ version, dir = configDir(), env = process.env, install = { kind: 'copy' }, now = Date.now, latestOf = () => fetchLatest({ env }), fetchCopy = (v) => prefetch(v, { env, install }), exists = existsSync }) {
  let state = loadState(dir)
  const checked = Date.parse(state.checked ?? '')
  if (!Number.isFinite(checked) || now() - checked > CHECK_EVERY_MS || now() < checked) {
    const latest = await latestOf()
    if (!latest) return state
    state = saveState({ checked: new Date(now()).toISOString(), latest }, dir)
  }
  const latest = state.latest
  if (!newer(latest, version)) return state
  if (Array.isArray(state.failed) && state.failed.includes(latest)) return state
  if (state.ready?.version === latest && exists(state.ready.bin)) return state
  const bin = await fetchCopy(latest)
  return bin ? saveState({ ready: { version: latest, bin, fetched: new Date(now()).toISOString() } }, dir) : state
}

/** The server's part, once it serves: the check in the background, and
 *  what the status says of it — `{ latest, handedOffFrom?, pinned?,
 *  updates? }` (updates only when off: `off` or `checkout`). */
export function startUpdates({ version, argv = [], env = process.env, packageDir = PACKAGE_DIR, dir = configDir(env), log = stderrLog, check = checkForUpdate } = {}) {
  const install = installOf(packageDir)
  const policy = updatePolicy({ argv, env, install })
  let state = policy.updates === 'on' ? loadState(dir) : {}
  const done =
    policy.updates === 'on'
      ? new Promise((resolve) => setImmediate(resolve))
          .then(() => check({ version, dir, env, install }))
          .then((s) => {
            state = s
            if (newer(s.ready?.version, version)) log(`scanruler-mcp ${s.ready.version} is fetched; it starts in place of ${version} next time.`)
          })
          .catch(() => {})
      : Promise.resolve()
  const info = () => ({
    latest: isVersion(state.latest) ? state.latest : null,
    ...(policy.handedOffFrom ? { handedOffFrom: policy.handedOffFrom } : {}),
    ...(policy.pinned ? { pinned: true } : {}),
    ...(policy.updates === 'off' || policy.updates === 'checkout' ? { updates: policy.updates } : {}),
  })
  return { info, done }
}
