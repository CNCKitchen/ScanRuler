// SPDX-License-Identifier: AGPL-3.0-only
// A session for the command tests: the mesh worker running in this process
// under a stubbed `self`, as tests/workerImport.test.ts runs it, behind the
// real MeshWorkerClient; the app's session (app/session) without a viewport,
// watching the stores; and that session installed as the command host with
// the app's commands registered — what App does in the browser, minus the
// screen.

import { vi } from 'vitest'
import { createSession, type AppSession } from '../src/app/session'
import { registerCoreCommands } from '../src/commands/core'
import { installCommandHost, type CommandHost } from '../src/commands/host'
import { runCommand } from '../src/commands/registry'
import { CommandError } from '../src/commands/types'
import { buildBinaryStl } from '../src/core/exportStl'
import { MeshWorkerClient } from '../src/core/workerClient'
import { useDeviation } from '../src/state/deviationStore'
import { useFlat } from '../src/state/flatStore'
import { clearHistory, useHistory } from '../src/state/historyStore'
import { useShell } from '../src/state/shellStore'
import { useStore } from '../src/state/store'
import { useThickness } from '../src/state/thicknessStore'
import { useMark } from '../src/state/markStore'

type Listener = ((event: { data: unknown }) => void) | null

/** The worker's global scope, one per test file: the worker module sets its
 *  onmessage on it when first imported. */
const scope: { onmessage: Listener; postMessage(msg: unknown): void } = {
  onmessage: null,
  postMessage: (msg) => setTimeout(() => current?.onmessage?.({ data: msg }), 0),
}
let current: InProcessWorker | null = null

/** What `new Worker(...)` makes under the tests: messages both ways go
 *  through a timer, as a real worker's do — never synchronously. */
class InProcessWorker {
  onmessage: Listener = null
  onerror: ((e: { message: string; preventDefault(): void }) => void) | null = null
  onmessageerror: (() => void) | null = null
  constructor() {
    current = this
  }
  postMessage(msg: unknown): void {
    setTimeout(() => scope.onmessage?.({ data: msg }), 0)
  }
  terminate(): void {
    if (current === this) current = null
  }
}

let workerLoaded = false

/** Put every store back as the app starts. */
export function resetStores(): void {
  useStore.setState(useStore.getInitialState(), true)
  useFlat.setState(useFlat.getInitialState(), true)
  useDeviation.setState(useDeviation.getInitialState(), true)
  useThickness.setState(useThickness.getInitialState(), true)
  useMark.setState(useMark.getInitialState(), true)
  useShell.getState().setWorkspace('elements')
  clearHistory()
  useHistory.setState({ past: [], future: [] })
}

export interface Headless {
  session: AppSession
  stop(): void
}

/** A fresh session on the in-process worker, installed as the host. */
export async function startHeadless(extra: Omit<CommandHost, 'session'> = {}): Promise<Headless> {
  if (!workerLoaded) {
    vi.stubGlobal('self', scope)
    await import('../src/core/meshWorker')
    workerLoaded = true
  }
  vi.stubGlobal('Worker', InProcessWorker)
  resetStores()
  const clientRef = { current: new MeshWorkerClient() }
  const session = createSession({ clientRef, sceneRef: { current: null } })
  const unwatch = session.watch()
  const uninstall = installCommandHost({ session, ...extra })
  registerCoreCommands()
  return {
    session,
    stop() {
      uninstall()
      unwatch()
    },
  }
}

/** Run a command, and fail the test with its error if it is refused. */
export async function run<T = Record<string, unknown>>(name: string, input: unknown = {}): Promise<T> {
  try {
    return (await runCommand(name, input)) as T
  } catch (e) {
    if (e instanceof CommandError) throw new Error(`${name} → ${e.code}: ${e.message}`)
    throw e
  }
}

/** Run a command expected to be refused, and give the error back. */
export async function refused(name: string, input: unknown = {}): Promise<CommandError> {
  try {
    await runCommand(name, input)
  } catch (e) {
    if (e instanceof CommandError) return e
    throw e
  }
  throw new Error(`${name} was expected to be refused and was not.`)
}

/** A triangle soup as the bytes of a binary STL file. */
export const stlBytes = (soup: Float32Array): Uint8Array => new Uint8Array(buildBinaryStl(soup, null, null, 'command test'))

/** An indexed mesh as a triangle soup, offset by `at`. */
export function soupOf(mesh: { positions: Float32Array; indices: Uint32Array }, at: [number, number, number] = [0, 0, 0]): Float32Array {
  const out = new Float32Array(mesh.indices.length * 3)
  for (let i = 0; i < mesh.indices.length; i++) {
    const v = mesh.indices[i]
    out[i * 3] = mesh.positions[v * 3] + at[0]
    out[i * 3 + 1] = mesh.positions[v * 3 + 1] + at[1]
    out[i * 3 + 2] = mesh.positions[v * 3 + 2] + at[2]
  }
  return out
}

/** The labels on the undo stack, newest last. */
export const undoLabels = (): string[] => useHistory.getState().past.map((e) => e.label)
