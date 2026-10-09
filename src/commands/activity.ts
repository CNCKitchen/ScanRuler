// SPDX-License-Identifier: AGPL-3.0-only
// What the page needs to know of the commands without carrying them: which
// one is running — the status strip names it, the hint ring and the
// viewport's clicks stand back while one does — and what a command that
// changes the session is held to, which the command host sets. The registry
// (registry.ts) runs them; it is loaded with the agent connection.

import { create } from 'zustand'

interface ActivityState {
  /** The command changing the session right now, for the status strip. */
  running: { name: string; title: string } | null
  /** Its latest progress line. */
  progress: string | null
}

/** Which command is running — read by the status strip, the hint ring and
 *  the viewport's click handlers, which stand back while one does. */
export const useCommandActivity = create<ActivityState>(() => ({ running: null, progress: null }))

export const commandRunning = (): boolean => useCommandActivity.getState().running !== null

export interface CommandGuard {
  /** What the session is busy with, in a sentence, or null when it is free. */
  busy(): string | null
}

const FREE: CommandGuard = { busy: () => null }
let guard: CommandGuard = FREE

/** What a command that changes the session is held to — set by the command
 *  host (host.ts). The returned function puts the default back. */
export function configureCommands(next: CommandGuard): () => void {
  guard = next
  return () => {
    guard = FREE
  }
}

/** The guard in force. */
export const commandGuard = (): CommandGuard => guard

// ---- What a plugin is busy with ----------------------------------------------------

const busyChecks = new Map<string, () => string | null>()

/** A plugin's part of what the session is busy with, under its id: what its
 *  own machinery is doing that a command must not run over — in a few
 *  words, or null when it is idle. Read wherever the session's own are:
 *  the guard on every command that changes the session, and the readout's
 *  `busy`. Called from the plugin's install(); the returned function takes
 *  it out again. Two under one id throw. */
export function registerBusy(id: string, check: () => string | null): () => void {
  if (busyChecks.has(id)) throw new Error(`Two busy checks share the id "${id}".`)
  busyChecks.set(id, check)
  return () => {
    if (busyChecks.get(id) === check) busyChecks.delete(id)
  }
}

/** What a plugin is busy with, the first that is, or null. */
export function pluginBusy(): string | null {
  for (const check of busyChecks.values()) {
    try {
      const busy = check()
      if (busy) return busy
    } catch {
      // A check that fails says nothing.
    }
  }
  return null
}
