// SPDX-License-Identifier: AGPL-3.0-only
// The server keeps itself current (src/update.js): which copy the launcher
// runs, when the background check asks the registry and fetches, and the
// hand-off itself — the network, npm and the disk stood in for — and the
// launcher run for real, handing off to a copy laid out as npx lays it out.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { cpSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  CHECK_EVERY_MS,
  checkForUpdate,
  fetchLatest,
  HANDED_OFF_ENV,
  installOf,
  launchPlan,
  loadState,
  newer,
  npmFolder,
  npxHash,
  prefetch,
  runHandOff,
  runNpm,
  saveState,
  START_GRACE_MS,
  startUpdates,
  updatePolicy,
} from '../src/update.js'

const MCP_DIR = fileURLToPath(new URL('..', import.meta.url))
const tempDir = () => mkdtemp(join(tmpdir(), 'scanruler-update-'))
const npxCopy = (spec) => join('/cache', '_npx', npxHash(spec), 'node_modules', 'scanruler-mcp')
const noGit = () => false

test('versions compare by number, a release above its prerelease', () => {
  assert.equal(newer('0.4.1', '0.4.0'), true)
  assert.equal(newer('0.10.0', '0.9.9'), true)
  assert.equal(newer('0.4.0', '0.4.0'), false)
  assert.equal(newer('0.3.9', '0.4.0'), false)
  assert.equal(newer('0.4.0', '0.4.0-rc.1'), true)
  assert.equal(newer(undefined, '0.4.0'), false)
  assert.equal(newer('latest', '0.4.0'), false)
})

test('how a copy was installed: npx with its spec, npm, a checkout, a copy', () => {
  // npm's own hash: the folder of `npx scanruler-mcp@0.2.0` seen on a real cache.
  assert.equal(npxHash('scanruler-mcp@0.2.0'), '4250227d2a5c2d2b')
  assert.deepEqual(installOf(npxCopy('scanruler-mcp'), noGit), { kind: 'npx', pinned: false, npmCache: join('/cache') })
  assert.equal(installOf(npxCopy('scanruler-mcp@latest'), noGit).pinned, false)
  assert.equal(installOf(npxCopy('scanruler-mcp@0.4.0'), noGit).pinned, true)
  assert.equal(installOf(npxCopy('scanruler-mcp@^0.4.0'), noGit).pinned, true)
  assert.deepEqual(installOf(join('/usr', 'lib', 'node_modules', 'scanruler-mcp'), noGit), { kind: 'installed', pinned: false })
  // A .git above an npm install (a home folder kept in git) is not a checkout.
  assert.equal(installOf(npxCopy('scanruler-mcp'), () => true).kind, 'npx')
  const repo = join('/src', 'scanruler')
  assert.deepEqual(installOf(join(repo, 'mcp'), (p) => p === join(repo, '.git')), { kind: 'checkout', pinned: false })
  assert.deepEqual(installOf(join('/work', 'scanruler-mcp'), noGit), { kind: 'copy', pinned: false })
})

test('updates are off with --no-update or the variable, in a checkout, for a pinned spec; a copy handed to goes on', () => {
  const npx = { kind: 'npx', pinned: false }
  assert.deepEqual(updatePolicy({ argv: [], env: {}, install: npx }), { updates: 'on' })
  assert.deepEqual(updatePolicy({ argv: ['--no-update'], env: {}, install: npx }), { updates: 'off' })
  assert.deepEqual(updatePolicy({ argv: [], env: { SCANRULER_MCP_NO_UPDATE: '1' }, install: npx }), { updates: 'off' })
  assert.deepEqual(updatePolicy({ argv: [], env: {}, install: { kind: 'checkout' } }), { updates: 'checkout' })
  assert.deepEqual(updatePolicy({ argv: [], env: {}, install: { kind: 'npx', pinned: true } }), { updates: 'pinned', pinned: true })
  // The copy handed to sits in a pinned spec's folder; the launcher decided.
  assert.deepEqual(updatePolicy({ argv: [], env: { [HANDED_OFF_ENV]: '0.4.0' }, install: { kind: 'npx', pinned: true } }), { updates: 'on', handedOffFrom: '0.4.0' })
})

test('the launcher runs a newer copy already fetched, and itself otherwise', () => {
  const bin = join(npxCopy('scanruler-mcp@0.4.1'), 'bin', 'scanruler-mcp.js')
  const ready = { checked: '2026-10-23T00:00:00.000Z', latest: '0.4.1', ready: { version: '0.4.1', bin } }
  const base = { argv: [], env: {}, version: '0.4.0', install: { kind: 'npx', pinned: false }, state: ready, exists: (p) => p === bin, readVersion: () => '0.4.1' }
  assert.deepEqual(launchPlan(base), { run: 'handoff', bin, version: '0.4.1' })
  assert.equal(launchPlan({ ...base, version: '0.4.1' }).why, 'current')
  assert.equal(launchPlan({ ...base, version: '0.5.0' }).why, 'current')
  assert.equal(launchPlan({ ...base, state: {} }).why, 'current')
  assert.equal(launchPlan({ ...base, env: { [HANDED_OFF_ENV]: '0.4.0' } }).why, 'handed-off')
  assert.equal(launchPlan({ ...base, argv: ['--no-update'] }).why, 'off')
  assert.equal(launchPlan({ ...base, argv: ['--version'] }).why, 'answer')
  assert.equal(launchPlan({ ...base, argv: ['--pair'] }).why, 'answer')
  assert.equal(launchPlan({ ...base, install: { kind: 'checkout' } }).why, 'checkout')
  assert.equal(launchPlan({ ...base, install: { kind: 'npx', pinned: true } }).why, 'pinned')
  assert.equal(launchPlan({ ...base, state: { ...ready, failed: ['0.4.1'] } }).why, 'failed-before')
  assert.equal(launchPlan({ ...base, exists: () => false }).why, 'missing')
  assert.equal(launchPlan({ ...base, readVersion: () => '0.4.0' }).why, 'missing')
})

test('the check asks the registry once a day, and fetches a newer version for the next start', async () => {
  const dir = await tempDir()
  let now = Date.parse('2026-10-23T08:00:00Z')
  let asked = 0
  const fetched = []
  let latest = '0.4.0'
  const check = () =>
    checkForUpdate({
      version: '0.4.0',
      dir,
      now: () => now,
      latestOf: async () => {
        asked++
        return latest
      },
      fetchCopy: async (v) => {
        fetched.push(v)
        return `/cache/${v}/bin/scanruler-mcp.js`
      },
      exists: (p) => p.startsWith('/cache/'),
    })
  // Current: asked, nothing fetched.
  assert.equal((await check()).latest, '0.4.0')
  assert.deepEqual([asked, fetched], [1, []])
  // Within the day: not asked again, though npm has a newer one by now.
  latest = '0.4.1'
  now += CHECK_EVERY_MS - 60_000
  await check()
  assert.equal(asked, 1)
  // A day on: asked, and the newer one fetched and kept as ready.
  now += 120_000
  const state = await check()
  assert.equal(asked, 2)
  assert.deepEqual(fetched, ['0.4.1'])
  assert.deepEqual(state.ready, { version: '0.4.1', bin: '/cache/0.4.1/bin/scanruler-mcp.js', fetched: new Date(now).toISOString() })
  assert.deepEqual(loadState(dir).ready.version, '0.4.1')
  // Fetched already: not again.
  await check()
  assert.deepEqual(fetched, ['0.4.1'])
})

test('offline, a failed fetch, or a version that failed to start leave things as they are', async () => {
  const dir = await tempDir()
  const fetched = []
  // Offline: nothing written, so the next start asks again.
  const offline = await checkForUpdate({ version: '0.4.0', dir, latestOf: async () => null, fetchCopy: async (v) => fetched.push(v) })
  assert.deepEqual(offline, {})
  assert.equal(existsSync(join(dir, 'update.json')), false)
  // The fetch failed: the answer kept, no copy ready.
  const failed = await checkForUpdate({ version: '0.4.0', dir, latestOf: async () => '0.4.1', fetchCopy: async () => null })
  assert.equal(failed.latest, '0.4.1')
  assert.equal(failed.ready, undefined)
  // A version that did not start is not fetched again.
  saveState({ failed: ['0.4.1'] }, dir)
  await checkForUpdate({ version: '0.4.0', dir, latestOf: async () => '0.4.1', fetchCopy: async (v) => fetched.push(v) })
  assert.deepEqual(fetched, [])
})

test('the registry is asked within 2 s, and a failure is no answer', async () => {
  const urls = []
  const ok = async (url, init) => {
    urls.push(url)
    assert.ok(init.signal instanceof AbortSignal)
    return { ok: true, json: async () => ({ name: 'scanruler-mcp', version: '0.4.1' }) }
  }
  assert.equal(await fetchLatest({ env: {}, fetchFn: ok }), '0.4.1')
  assert.equal(await fetchLatest({ env: { npm_config_registry: 'http://127.0.0.1:9/npm' }, fetchFn: ok }), '0.4.1')
  assert.deepEqual(urls, ['https://registry.npmjs.org/scanruler-mcp/latest', 'http://127.0.0.1:9/npm/scanruler-mcp/latest'])
  assert.equal(await fetchLatest({ env: {}, fetchFn: async () => ({ ok: false }) }), null)
  assert.equal(await fetchLatest({ env: {}, fetchFn: async () => ({ ok: true, json: async () => ({ version: 'x' }) }) }), null)
  const slow = (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)))
  // AbortSignal.timeout's timer holds nothing open, and a fetch that never
  // answers holds no socket: on its own the event loop would run dry before
  // the abort, and Node 22's runner cancels the test. A real fetch has its
  // socket.
  const awake = setTimeout(() => {}, 1000)
  const t0 = Date.now()
  try {
    assert.equal(await fetchLatest({ env: {}, fetchFn: slow, within: 50 }), null)
  } finally {
    clearTimeout(awake)
  }
  assert.ok(Date.now() - t0 < 1000)
})

test('the fetch runs the new copy once through npm, and finds it in npx’s folder for its spec', async () => {
  const calls = []
  const cache = '/npm-cache'
  const bin = join(cache, '_npx', npxHash('scanruler-mcp@0.4.1'), 'node_modules', 'scanruler-mcp', 'bin', 'scanruler-mcp.js')
  const npm = async (args) => {
    calls.push(args)
    return { code: 0, stdout: '0.4.1\n' }
  }
  const found = await prefetch('0.4.1', { env: {}, install: { kind: 'npx', npmCache: cache }, npm, readVersion: (p) => (p === bin ? '0.4.1' : null) })
  assert.equal(found, bin)
  assert.deepEqual(calls, [['exec', '--yes', '--package=scanruler-mcp@0.4.1', '--', 'scanruler-mcp', '--version']])
  // Where it is not where expected, npm is asked for its cache.
  calls.length = 0
  const asked = async (args) => {
    calls.push(args)
    return args[0] === 'config' ? { code: 0, stdout: `${cache}\n` } : { code: 0, stdout: '0.4.1\n' }
  }
  assert.equal(await prefetch('0.4.1', { env: {}, npm: asked, readVersion: (p) => (p === bin ? '0.4.1' : null) }), bin)
  assert.deepEqual(calls.at(-1), ['config', 'get', 'cache'])
  // A copy that does not answer its version is not taken.
  assert.equal(await prefetch('0.4.1', { env: {}, npm: async () => ({ code: 1, stdout: '' }) }), null)
  assert.equal(await prefetch('0.4.1; rm -rf /', { env: {}, npm }), null)
})

/** A child process the test plays. */
function fakeChild() {
  const child = new EventEmitter()
  child.killed = []
  child.kill = (signal) => child.killed.push(signal)
  return child
}

test('the hand-off passes the arguments and the exit code through, marked against a loop', async () => {
  const child = fakeChild()
  let spawned
  const out = runHandOff({
    plan: { bin: '/new/bin/scanruler-mcp.js', version: '0.4.1' },
    argv: ['--port', '7400'],
    version: '0.4.0',
    env: { KEEP: 'me' },
    execPath: 'node',
    now: (() => {
      let t = 0
      return () => (t += 10_000)
    })(),
    spawnFn: (file, args, options) => {
      spawned = { file, args, options }
      return child
    },
  })
  assert.deepEqual([spawned.file, spawned.args], ['node', ['/new/bin/scanruler-mcp.js', '--port', '7400']])
  assert.equal(spawned.options.stdio, 'inherit')
  assert.equal(spawned.options.env.KEEP, 'me')
  assert.equal(spawned.options.env[HANDED_OFF_ENV], '0.4.0')
  child.emit('exit', 3, null)
  assert.deepEqual(await out, { code: 3 })
})

test('a copy that fails to start, or stops at once with an error, falls back and is not tried again', async () => {
  const marked = []
  const spawnErr = fakeChild()
  const a = runHandOff({ plan: { bin: '/x', version: '0.4.1' }, argv: [], version: '0.4.0', env: {}, spawnFn: () => spawnErr, markFailed: (v) => marked.push(v) })
  spawnErr.emit('error', new Error('ENOENT'))
  assert.match((await a).fallback, /could not start/)
  const early = fakeChild()
  const b = runHandOff({ plan: { bin: '/x', version: '0.4.1' }, argv: [], version: '0.4.0', env: {}, now: () => 0, spawnFn: () => early, markFailed: (v) => marked.push(v) })
  early.emit('exit', 1, null)
  assert.match((await b).fallback, /stopped with code 1/)
  assert.deepEqual(marked, ['0.4.1'])
  // A clean exit at once (the client closed it) is the copy's answer.
  const quick = fakeChild()
  const c = runHandOff({ plan: { bin: '/x', version: '0.4.1' }, argv: [], version: '0.4.0', env: {}, now: () => 0, spawnFn: () => quick })
  quick.emit('exit', 0, null)
  assert.deepEqual(await c, { code: 0 })
})

test('a checkout makes no request, and the status says updates are off there', async () => {
  let checked = 0
  const u = startUpdates({ version: '0.4.0', env: {}, packageDir: MCP_DIR, dir: await tempDir(), check: async () => checked++ })
  await u.done
  assert.equal(checked, 0)
  assert.deepEqual(u.info(), { latest: null, updates: 'checkout' })
  const dir = await tempDir()
  saveState({ checked: new Date().toISOString(), latest: '0.4.1' }, dir)
  const on = startUpdates({ version: '0.4.0', env: { [HANDED_OFF_ENV]: '0.3.9' }, packageDir: MCP_DIR, dir, log: () => {}, check: async () => ({ latest: '0.4.2' }) })
  assert.deepEqual(on.info(), { latest: '0.4.1', handedOffFrom: '0.3.9' })
  await on.done
  assert.equal(on.info().latest, '0.4.2')
})

test('the launcher, run for real, hands off to the fetched copy with the same arguments and passes its exit code back', { timeout: 30_000 }, async () => {
  const root = await tempDir()
  // This version, installed by npm — not a checkout — with its launcher.
  const pkg = join(root, 'lib', 'node_modules', 'scanruler-mcp')
  mkdirSync(join(pkg, 'src'), { recursive: true })
  cpSync(join(MCP_DIR, 'bin'), join(pkg, 'bin'), { recursive: true })
  for (const f of ['update.js', 'config.js']) cpSync(join(MCP_DIR, 'src', f), join(pkg, 'src', f))
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'scanruler-mcp', version: '0.4.0', type: 'module' }))
  // A newer copy where npx puts `scanruler-mcp@0.4.1`, which says what it got.
  const newer = join(root, 'cache', '_npx', npxHash('scanruler-mcp@0.4.1'), 'node_modules', 'scanruler-mcp')
  mkdirSync(join(newer, 'bin'), { recursive: true })
  writeFileSync(join(newer, 'package.json'), JSON.stringify({ name: 'scanruler-mcp', version: '0.4.1', type: 'module' }))
  const fake = (body) => writeFileSync(join(newer, 'bin', 'scanruler-mcp.js'), body)
  // Past the start-up grace, so its exit code is its answer.
  fake(
    `process.stdout.write(JSON.stringify({ args: process.argv.slice(2), from: process.env.${HANDED_OFF_ENV} }))\n` +
      `setTimeout(() => process.exit(7), ${START_GRACE_MS + 300})\n`,
  )
  const config = join(root, 'config')
  saveState({ checked: new Date().toISOString(), latest: '0.4.1', ready: { version: '0.4.1', bin: join(newer, 'bin', 'scanruler-mcp.js') } }, config)
  const run = (args, env = {}) =>
    spawnSync(process.execPath, [join(pkg, 'bin', 'scanruler-mcp.js'), ...args], {
      env: { ...process.env, SCANRULER_MCP_CONFIG_DIR: config, [HANDED_OFF_ENV]: '', SCANRULER_MCP_NO_UPDATE: '', ...env },
      encoding: 'utf8',
    })
  const handed = run(['--port', '7401', '--out', 'x y'])
  assert.equal(handed.status, 7, handed.stderr)
  assert.deepEqual(JSON.parse(handed.stdout), { args: ['--port', '7401', '--out', 'x y'], from: '0.4.0' })
  assert.match(handed.stderr, /Starting scanruler-mcp 0\.4\.1, fetched earlier, in place of 0\.4\.0/)
  // Off: this copy runs (and, with no main.js beside it here, fails so).
  const off = run(['--port', '7401'], { SCANRULER_MCP_NO_UPDATE: '1' })
  assert.doesNotMatch(off.stderr, /Starting scanruler-mcp/)
  assert.match(off.stderr, /src[\/]main\.js/)
  // A copy that stops at once with an error: this one runs, and that one is
  // not tried again.
  fake('process.exit(5)\n')
  const failed = run([])
  assert.match(failed.stderr, /scanruler-mcp 0\.4\.1 did not start \(it stopped with code 5 as it started\); running 0\.4\.0/)
  assert.match(failed.stderr, /src[\/]main\.js/)
  assert.deepEqual(loadState(config).failed, ['0.4.1'])
  assert.doesNotMatch(run([]).stderr, /Starting scanruler-mcp/)
})

test('npm runs in a folder of this user’s own, never the shared temp folder', async () => {
  const config = await tempDir()
  const env = { SCANRULER_MCP_CONFIG_DIR: config }
  let cwd = null
  const fake = new EventEmitter()
  const ran = runNpm(['--version'], {
    env,
    spawnFn: (_file, _args, options) => {
      cwd = options.cwd
      queueMicrotask(() => fake.emit('close', 0))
      return fake
    },
  })
  assert.deepEqual(await ran, { code: 0, stdout: '' })
  // npm exec takes a package from node_modules in the folder it runs in, so
  // a planted /tmp/node_modules/scanruler-mcp would run as this user.
  assert.equal(cwd, join(config, 'npm-run'))
  assert.notEqual(cwd, tmpdir())
  if (process.platform !== 'win32') assert.equal(statSync(cwd).mode & 0o077, 0, 'nobody else may write into it')
  // Where the folder cannot be made, the home folder rather than the temp one.
  assert.equal(npmFolder(env, () => { throw new Error('read-only') }), homedir())
})
