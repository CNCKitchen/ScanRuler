// SPDX-License-Identifier: AGPL-3.0-only
// Why the server stops, said on stderr before it does. An agent's client
// shows a server that went away as just that — gone — so a copy that quits
// over an error nobody heard, a closed pipe or a signal leaves nothing to go
// on unless it says so itself, on the one channel the client keeps a log of.
//
// A rejection nobody handled is logged and the server runs on: it is one
// call's loose end, and ending the process over it would take every tool
// with it. An uncaught exception is logged and ends the process, as Node
// would, since what threw may have left things half done. stdout closing is
// the agent gone; stderr closing leaves nowhere to say anything, and must not
// itself become the uncaught error that ends the process.

/** The signals a client or a terminal stops a server with, and their exit codes. */
const SIGNALS = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }

/** An error as a line or a few: its stack when it has one. */
export const describe = (error) => (error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error))

/**
 * Watch `proc` for every way it may stop, and say why on stderr before it
 * does. Returns `stop(reason, code)`, for the server's own deliberate exits,
 * which says the reason once and exits.
 *
 * @param {{ log: (line: string) => void, proc?: NodeJS.Process, exit?: (code: number) => void }} options
 */
export function guardExits({ log, proc = process, exit = (code) => proc.exit(code) }) {
  let said = false
  let canLog = true
  const say = (line) => {
    if (!canLog) return
    try {
      log(line)
    } catch {
      canLog = false
    }
  }
  const stop = (reason, code = 0) => {
    if (!said) {
      said = true
      say(`Stopping (exit code ${code}): ${reason}`)
    }
    exit(code)
  }

  proc.on('unhandledRejection', (reason) => say(`A rejection nobody handled, running on: ${describe(reason)}`))
  proc.on('uncaughtException', (error, origin) => stop(`${origin === 'unhandledRejection' ? 'an unhandled rejection' : 'an uncaught exception'}: ${describe(error)}`, 1))
  // The agent's end of stdout closed: nothing this says reaches it any more.
  proc.stdout?.on?.('error', (error) => stop(`stdout, the MCP channel, failed — the agent has gone (${error?.code ?? error?.message ?? error}).`, 0))
  // Nowhere left to say anything; heard, so the error does not end the process.
  proc.stderr?.on?.('error', () => {
    canLog = false
  })
  for (const [signal, code] of Object.entries(SIGNALS)) {
    try {
      proc.on(signal, () => stop(`${signal} received.`, code))
    } catch {
      // A signal this platform has no listener for.
    }
  }
  // Whatever else ends the process — a process.exit from a dependency, say —
  // is at least named with its code.
  proc.on('exit', (code) => {
    if (!said) {
      said = true
      say(`Exiting with code ${code}.`)
    }
  })
  return stop
}
