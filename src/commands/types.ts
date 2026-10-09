// SPDX-License-Identifier: AGPL-3.0-only
// What a command is: one verb of the session, typed for something other than
// a mouse to call — an agent through the bridge, a script, a test. The verbs
// are the panels' own; a command only names one, checks its input, runs it
// as one step of the undo history and reads back what the stores hold
// afterwards. See registry.ts for how they are found and run.

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
 *  - `internal` — a fault of the app's own
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
  | 'internal'

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
  /** Whether a run is one step of the undo history — the default for every
   *  command that is not read-only. False for those that walk the history
   *  themselves or start it afresh. */
  history?: boolean
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
}
