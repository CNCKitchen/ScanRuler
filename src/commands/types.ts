// SPDX-License-Identifier: AGPL-3.0-only
// What a command is: one verb of the session, typed for something other than
// a mouse to call — an agent through the bridge, a script, a test. The verbs
// are the panels' own; a command only names one, checks its input, runs it
// as one step of the undo history and reads back what the stores hold
// afterwards. See registry.ts for how they are found and run.

import type { WorkerRequest } from '../core/workerProtocol'
import type { JsonSchema } from './schema'

/** Why a command did not do what it was asked — the code a caller branches
 *  on, the message a person reads. The codes are part of the contract:
 *
 *  - `unknown_command` — no command by that name
 *  - `invalid_input` — the input does not fit the schema, or names something
 *    that cannot be used where it is named
 *  - `busy` — the session is loading, fitting or measuring something already
 *  - `no_scan` — the command works on a scan and none is open
 *  - `not_found` — an element, dimension or other thing named does not exist
 *  - `invalid_state` — something open in the panel is in the way, or the
 *    step does not apply to the session as it stands
 *  - `failed` — the operation ran and did not succeed (a fit that found no
 *    surface, a file that would not read)
 *  - `unavailable` — needs what this session lacks, such as the viewport
 *  - `not_implemented` — named in the contract, not built yet
 *  - `timeout` — the command did not finish in its time and was given up
 *    on; it may have changed the session in part
 *  - `internal` — a fault of the app's own
 *  - `stale_page` — the page could not load a part of the app it needed:
 *    the app was rebuilt since the page loaded (stalePage.ts)
 */
export type CommandErrorCode =
  | 'unknown_command'
  | 'invalid_input'
  | 'busy'
  | 'no_scan'
  | 'not_found'
  | 'invalid_state'
  | 'failed'
  | 'unavailable'
  | 'not_implemented'
  | 'timeout'
  | 'internal'
  | 'stale_page'

export class CommandError extends Error {
  constructor(
    readonly code: CommandErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'CommandError'
  }

  toJSON(): { code: CommandErrorCode; message: string } {
    return { code: this.code, message: this.message }
  }
}

/** What a caught error says, whatever was thrown. */
export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** A file a command hands back: the bytes and the name the panel's button
 *  would have saved it under. */
export interface FileOut {
  name: string
  mimeType: string
  bytes: Uint8Array
}

/** What a command is handed besides its input. */
export interface CommandContext {
  /** A line on what the command is doing, for whoever is waiting on it. */
  progress(text: string): void
  /** Aborted once the command has run past its time (Command.timeoutMs)
   *  and its caller was answered `timeout`: a long command that looks at it
   *  between its steps stops rather than change the session further. */
  signal?: AbortSignal
  /** The caller runs more changes straight after this one and asked for
   *  work only the last of them needs — a rebuild, say — to be done once,
   *  after it: a command may leave such work undone. What it left is
   *  finished before the next run that is not deferred (registerSettle,
   *  registry.ts). */
  deferred?: boolean
}

export interface Command<I = Record<string, unknown>> {
  /** The verb within its namespace — `fit` in `element.fit`. Lower case,
   *  words joined by underscores. */
  name: string
  /** A few words, as a menu would say it. */
  title: string
  /** What it does, what it needs and what it returns — the tool description
   *  an agent reads. */
  description: string
  /** An object schema — see schema.ts. */
  input: JsonSchema
  /** Changes nothing: runs at once, beside whatever else is running, and is
   *  no step of the history. */
  readOnly?: boolean
  /** The result carries `file: FileOut`. */
  returnsFile?: boolean
  /** The result carries a picture as `file: FileOut` — a PNG, say — for
   *  whoever called to look at rather than to keep: an agent's client shows
   *  it as an image. */
  returnsImage?: boolean
  /** Sets the viewport or pictures what is on it — turns the camera, puts
   *  things away and back, cuts the section view — or draws a picture of
   *  what the stage holds: runs one at a time with every other such
   *  command, never beside one (registry.ts), so two pictures asked for at
   *  once never share the camera. Set on the commands that touch the
   *  stage, not on every one that answers with a picture: one that draws
   *  its own off the screen and runs long would hold the rest up. */
  scene?: boolean
  /** Whether a run is one step of the undo history — the default for every
   *  command that is not read-only. False for those that walk the history
   *  themselves or start it afresh. */
  history?: boolean
  /** The answer's numbers are handed back as inputs — a plane's frame,
   *  say — and must come through to the last digit: a caller that shortens
   *  numbers for reading leaves these alone. */
  exact?: boolean
  /** A read-only command that may take long — a comparison over whole
   *  bodies, say: an agent's server runs it as it runs a change, as a job
   *  it can answer for before its client stops waiting. */
  long?: boolean
  /** Where an input names a new thing whose name may not repeat: `at`
   *  paths into the input (`features[].name` for each item of a list),
   *  `space` the things that share the names ("sketches and features"). An
   *  agent's server refuses a batch whose calls would give one name twice
   *  before it runs any of them. */
  names?: CommandNames
  /** What an answer too long to carry says to ask for next time, by this
   *  command's own fields — "one section at a time (section)". An agent's
   *  server writes such an answer to a file and puts this in its note. */
  askForLess?: string
  /** Runs without the page — no scan, no viewport, no browser — so the
   *  app run headless offers it (src/headless/engine.ts). Off by default:
   *  a command is marked once it has been run so. */
  headless?: boolean
  /** How long a run may take before its caller is answered `timeout` and
   *  the commands after it run — COMMAND_TIMEOUT_MS (registry.ts) unless
   *  set. */
  timeoutMs?: number
  /** Stops what the session is busy with: runs at once — not after the
   *  change running, which may be waiting for the very work it stops — and
   *  is not refused while the session is busy. Its undo step is the change
   *  running's, when one is. */
  interrupts?: boolean
  /** Whether a run, as asked, throws away the work the session holds — a
   *  project or a scan opened with discard: what a plugin is busy with is
   *  stopped first (registerBusy's stop), not waited for, rather than the
   *  command refused over it. */
  discards?(input: I): boolean
  /** The worker requests a run reaches on the scan — for the input given,
   *  when a command reaches one only for some inputs. Whether a cloud may be
   *  run through it follows from what the worker can do with a cloud
   *  (OP_CAPS, core/capabilities.ts): on a point cloud the registry answers
   *  CLOUD_REFUSAL before the command runs, so a command is never left half
   *  done and never answers for an empty mesh. List the ops, not a flag, so
   *  that an op learning to take clouds frees its commands with no edit here. */
  scanOps?: readonly WorkerRequest['type'][] | ((input: I) => readonly WorkerRequest['type'][])
  /** The undo step's name for this input; the title otherwise. */
  label?(input: I): string
  run(input: I, ctx: CommandContext): Promise<unknown>
}

/** A command as a caller sees it in the list: everything but the code. */
export interface CommandInfo {
  name: string
  title: string
  description: string
  input: JsonSchema
  readOnly: boolean
  returnsFile: boolean
  returnsImage: boolean
  /** Only when true — see Command.exact. */
  exact?: boolean
  /** Only when true — see Command.long. */
  long?: boolean
  /** Only when set — see Command.names. */
  names?: CommandNames
  /** Only when set — see Command.askForLess. */
  askForLess?: string
}

/** See Command.names. */
export interface CommandNames {
  space: string
  at: string[]
}
