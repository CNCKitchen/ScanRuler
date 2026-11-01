// SPDX-License-Identifier: AGPL-3.0-only
// The background server: one detached copy per user that holds the port, serves the built app and relays to the tab, while agents come and go as stdio copies that relay through it. A state file in the config directory records which process it is, so start, status, open and stop find it again without a window.

import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { configDir, loadConfig } from './config.js'
import { HELLO_PATH } from './serve.js'

/** The port the page connects to unless one is given. */
export const DEFAULT_PORT = 7317

/** The file in the config directory that names the running background server. */
export const STATE_FILE = 'daemon.json'

/** How long one look at the server's address may take: the hello is answered from memory, so a server that takes longer is wedged and the next look asks again. */
export const PROBE_TIMEOUT_MS = 1500

/** How long a started server has to answer: it only binds the port and reads its config, so a few seconds is a wedged start, not a slow one. */
export const START_TIMEOUT_MS = 15_000

/** The pause between looks while a started server comes up: short beside START_TIMEOUT_MS so the caller returns soon after the port answers. */
export const START_POLL_MS = 100

/** The link that opens the served app already paired with the server on `port`. */
export function pairingLink(port, dir = configDir()) {
  return `http://127.0.0.1:${port}/#agent=${port}:${process.env.SCANRULER_MCP_TOKEN || loadConfig(dir).token}`
}

/** The recorded server, or null when none is recorded or the file is not one. */
export function readState(dir = configDir()) {
  let state
  try {
    state = JSON.parse(readFileSync(join(dir, STATE_FILE), 'utf8'))
  } catch {
    return null
  }
  const valid = state !== null && typeof state === 'object' && Number.isInteger(state.pid) && Number.isInteger(state.port) && typeof state.version === 'string'
  return valid ? { pid: state.pid, port: state.port, version: state.version } : null
}

export function writeState(state, dir = configDir()) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, STATE_FILE), JSON.stringify(state))
}

export function clearState(dir = configDir()) {
  rmSync(join(dir, STATE_FILE), { force: true })
}

/** Whether a scanruler-mcp answers its hello on `port`. */
export async function probe(port, fetchImpl = fetch) {
  try {
    const reply = await fetchImpl(`http://127.0.0.1:${port}${HELLO_PATH}`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    const hello = await reply.json()
    return hello !== null && typeof hello === 'object' && hello.server === 'scanruler-mcp'
  } catch {
    return false
  }
}

/**
 * What is running: `{ running, port, pid?, version? }`. A recorded server that no longer answers is not running, and its stale record is cleared.
 * @param {{ port?: number, dir?: string, probeImpl?: (port: number) => Promise<boolean> }} [options]
 */
export async function status({ port, dir = configDir(), probeImpl = probe } = {}) {
  const state = readState(dir)
  if (state !== null && (await probeImpl(state.port))) return { running: true, ...state }
  if (state !== null) clearState(dir)
  return { running: false, port }
}

/**
 * @typedef {Object} StartOptions
 * @property {string} executable The program to run: the bundled executable, or Electron to run as Node.
 * @property {string[]} [leading] Arguments before `--daemon`: a script for a program that runs scripts.
 * @property {string[]} [args] Arguments after `--daemon --port <n>`.
 * @property {NodeJS.ProcessEnv} [env] The environment of the detached process.
 * @property {number} port The port to hold.
 * @property {string} [dir] The config directory.
 * @property {typeof spawn} [spawnImpl] Starts the process; a test stands in for it.
 * @property {(port: number) => Promise<boolean>} [probeImpl] Looks at the port; a test stands in for it.
 * @property {(ms: number) => Promise<void>} [sleep] Pauses between looks; a test stands in for it.
 */
/**
 * Starts the background server as a detached process that outlives the caller, unless one already answers, and resolves once it does. `leading` arguments come before `--daemon` (a script for an executable that runs scripts, such as Electron running as Node with `env` carrying ELECTRON_RUN_AS_NODE). Rejects, saying which, when it does not within START_TIMEOUT_MS.
 * @param {StartOptions} options
 */
export async function start({ executable, leading = [], args = [], env = process.env, port, dir = configDir(), spawnImpl = spawn, probeImpl = probe, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const running = await status({ port, dir, probeImpl })
  if (running.running) return { started: false, ...running }
  const child = spawnImpl(executable, [...leading, '--daemon', '--port', String(port), ...args], { detached: true, stdio: 'ignore', windowsHide: true, env })
  child.unref()
  for (let waited = 0; waited < START_TIMEOUT_MS; waited += START_POLL_MS) {
    if (await probeImpl(port)) return { started: true, ...(await status({ port, dir, probeImpl })) }
    await sleep(START_POLL_MS)
  }
  throw new Error(`The background server did not answer on port ${port} within ${START_TIMEOUT_MS / 1000} seconds.`)
}

/**
 * Stops the recorded server with SIGTERM and resolves once it no longer answers; false when none was running.
 * @param {{ dir?: string, probeImpl?: (port: number) => Promise<boolean>, kill?: (pid: number, signal: string) => unknown, sleep?: (ms: number) => Promise<void> }} [options]
 */
export async function stop({ dir = configDir(), probeImpl = probe, kill = process.kill, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const state = readState(dir)
  if (state === null) return false
  try {
    kill(state.pid, 'SIGTERM')
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error
  }
  for (let waited = 0; waited < START_TIMEOUT_MS; waited += START_POLL_MS) {
    if (!(await probeImpl(state.port))) break
    await sleep(START_POLL_MS)
  }
  if (await probeImpl(state.port)) throw new Error(`The background server (process ${state.pid}) is still answering on port ${state.port}.`)
  clearState(dir)
  return true
}

/** What the background process itself does once it holds the port: record itself, and remove the record when it is told to end. Returns the record. */
export function announce({ port, version, dir = configDir(), pid = process.pid, onSignal = (signal, handler) => process.once(signal, handler), exit = (code) => process.exit(code) }) {
  const state = { pid, port, version }
  writeState(state, dir)
  const end = () => {
    clearState(dir)
    exit(0)
  }
  onSignal('SIGTERM', end)
  onSignal('SIGINT', end)
  return state
}
