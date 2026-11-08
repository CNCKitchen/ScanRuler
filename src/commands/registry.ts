// SPDX-License-Identifier: AGPL-3.0-only
// Where the commands are kept, listed and run. The app registers its own at
// start-up (core.ts); a plugin registers its under its id from its install()
// — the app never names a plugin, so the list a build offers is the app's
// commands plus whatever its plugins added.
//
// Running one: the input is checked against the command's schema; a command
// that changes the session waits for the one before it, is refused while
// the session is busy with something else, and runs as one step of the
// undo history under its label — but one that throws the session's work
// away stops a plugin's work first (Command.discards), and one that stops
// it runs at once, over the guard (Command.interrupts). Read-only commands
// run at once — but those that set or picture the viewport (Command.scene)
// one at a time, each
// after the one before has put the stage back. One that
// runs past its time is given up on — its caller answered `timeout` — and
// the next runs. A run under a job of the caller's own is kept among the
// recent outcomes (session.recent). A run the caller marks deferred may
// leave work only the last of several changes needs — a rebuild — for
// later; it is finished before the next run that is not (registerSettle).

import { historyAsync } from '../state/historyStore'
import { commandGuard, stopPluginWork, useCommandActivity } from './activity'
import { SCHEMA_BUDGET, schemaWeight, validate } from './schema'
import { isStaleImport, staleError } from './stalePage'
import { CommandError, type Command, type CommandContext, type CommandInfo } from './types'

const commands = new Map<string, Command>()

/** Command names: namespace and verb, dotted, lower case. */
const NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/

/**
 * Add commands under a namespace — `registerCommands('element', [fit])`
 * makes `element.fit`. A plugin's namespace is its id. Two commands of one
 * name throw, as two project sections of one key do, and so does a command
 * whose input schema is past SCHEMA_BUDGET — an agent's client would drop
 * it. The returned function takes them out again.
 */
export function registerCommands(namespace: string, list: readonly Command<never>[]): () => void {
  const added: string[] = []
  for (const command of list as readonly Command[]) {
    const name = `${namespace}.${command.name}`
    if (!NAME.test(name)) throw new Error(`"${name}" is not a command name — namespace and verb, dotted, lower case.`)
    if (commands.has(name)) throw new Error(`Two commands share the name "${name}".`)
    if (command.input.type !== 'object') throw new Error(`Command "${name}" must take an object.`)
    const weight = schemaWeight(command.input)
    if (weight.bytes > SCHEMA_BUDGET.bytes || weight.depth > SCHEMA_BUDGET.depth) {
      throw new Error(
        `Command "${name}" has an input schema of ${weight.bytes} bytes nested ${weight.depth} deep — past ${SCHEMA_BUDGET.bytes} bytes and ${SCHEMA_BUDGET.depth} deep an agent's client may drop it. List the shape loosely and check it when the command runs.`,
      )
    }
    commands.set(name, command)
    added.push(name)
  }
  return () => {
    for (const name of added) commands.delete(name)
  }
}

/** Every command, by name, as a caller sees it. */
export function listCommands(): CommandInfo[] {
  return [...commands.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, c]) => ({
      name,
      title: c.title,
      description: c.description,
      input: c.input,
      readOnly: Boolean(c.readOnly),
      returnsFile: Boolean(c.returnsFile),
      returnsImage: Boolean(c.returnsImage),
      ...(c.exact ? { exact: true } : {}),
      ...(c.long ? { long: true } : {}),
      ...(c.names ? { names: c.names } : {}),
      ...(c.askForLess ? { askForLess: c.askForLess } : {}),
    }))
}

/** Whether a command runs without the page — see Command.headless. */
export function runsHeadless(name: string): boolean {
  return commands.get(name)?.headless === true
}

// ---- Running ----------------------------------------------------------------

/** How long a command may run, unless it says otherwise (Command.timeoutMs),
 *  before its caller is answered `timeout` and the queue moves on — longer
 *  than any build or measurement that is going well takes. */
export const COMMAND_TIMEOUT_MS = 10 * 60_000

let queue: Promise<unknown> = Promise.resolve()
/** The change last given up on past its time, while the queue waits for it. */
let lingering: Promise<void> | null = null

/** The viewport's own queue: the commands that set it or picture it
 *  (Command.scene), one at a time, whatever else runs beside them. */
let sceneQueue: Promise<unknown> = Promise.resolve()

/** A run of a command that touches the viewport, after every such run
 *  before it has finished — its camera turned, its picture taken and what
 *  it put away put back — so that two pictures asked for at once are two
 *  pictures. Any other command runs as it comes. A run given up on past
 *  its time lets the next one go. */
function inScene<T>(command: Command, run: () => Promise<T>): Promise<T> {
  if (!command.scene) return run()
  const turn = sceneQueue.then(run)
  sceneQueue = turn.catch(() => {})
  return turn
}

/** What a run's fault answers: its own refusal, `stale_page` for a part of
 *  the app the page could not load (stalePage.ts), else `failed`. */
const asCommandError = (e: unknown): CommandError =>
  e instanceof CommandError
    ? e
    : isStaleImport(e)
      ? staleError(e)
      : new CommandError('failed', e instanceof Error ? e.message : String(e))

/** A command's run raced against its time. Past it, the run is told to stop
 *  (ctx.signal) and let go — whatever it does after is nobody's answer —
 *  and the caller is answered `timeout`, so that what waits on it, the
 *  history step and the queue, moves on. */
function limited<T>(name: string, ms: number, abort: AbortController, run: () => Promise<T>, onLate?: (ran: Promise<unknown>) => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let ran: Promise<T>
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onLate?.(ran)
      const e = new CommandError(
        'timeout',
        `${name} did not finish in ${ms / 1000} s and was given up on. It may have changed the session in part — read session.state (history.undo says the last step) before running it again.`,
      )
      abort.abort(e)
      reject(e)
    }, ms)
  })
  try {
    ran = run()
  } catch (e) {
    ran = Promise.reject(e)
  }
  // Let go past its time, it may still fail later: heard here, not as an
  // unhandled rejection.
  ran.catch(() => {})
  return Promise.race([ran, late]).finally(() => clearTimeout(timer))
}

/**
 * Run a command by name. Resolves with its result; rejects with a
 * CommandError — never anything else — saying why it did not run or did not
 * succeed. `onProgress` hears the command's progress lines. `job` is the
 * caller's name for the work this run is part of — an agent's server sends
 * one with each run of a change or a batch — and keeps the run among the
 * recent outcomes under it. `deferred`: more changes follow straight after
 * this one (CommandContext.deferred).
 */
export function runCommand(
  name: string,
  input: unknown = {},
  onProgress?: (text: string) => void,
  job?: string,
  deferred = false,
): Promise<unknown> {
  const run = start(name, input, onProgress, deferred)
  return job ? remember(job, name, run) : run
}

function start(name: string, input: unknown, onProgress: ((text: string) => void) | undefined, deferred: boolean): Promise<unknown> {
  const command = commands.get(name)
  if (!command) return Promise.reject(new CommandError('unknown_command', `There is no command "${name}".`))
  const errors = validate(command.input, input ?? {})
  if (errors.length) return Promise.reject(new CommandError('invalid_input', errors.join('; ')))
  const args = (input ?? {}) as Record<string, unknown>
  if (command.readOnly) {
    const abort = new AbortController()
    const ctx: CommandContext = { progress: (text) => onProgress?.(text), signal: abort.signal, ...(deferred ? { deferred } : {}) }
    // Started at once where nothing is left to finish, as it always was.
    const settling = deferred ? null : settle(name, command)
    return inScene(command, () =>
      limited(name, command.timeoutMs ?? COMMAND_TIMEOUT_MS, abort, () => (settling ? settling.then(() => command.run(args, ctx)) : command.run(args, ctx))),
    ).catch((e) => Promise.reject(asCommandError(e)))
  }
  if (command.interrupts) return interrupt(name, command, args, onProgress)
  const job = queue.then(() => inScene(command, () => execute(name, command, args, onProgress, deferred)))
  // A change given up on past its time may still be changing the session:
  // the next change waits for it to finish, or for one more of its time if
  // it never does, so their changes do not land in each other's steps.
  queue = job.catch(() => {}).then(() => {
    const waiting = lingering
    lingering = null
    return waiting
  })
  return job
}

/** The change running now, while one runs: its name, and whether it was
 *  run deferred. */
let current: { name: string; deferred: boolean } | null = null

/** The change running now, or null — for code a change calls into, which
 *  is handed no context: whether it may leave work for later. */
export const runningChange = (): { name: string; deferred: boolean } | null => current

type Settle = (next: { name: string; readOnly: boolean }) => Promise<void> | void

const settlers = new Set<Settle>()

/** Finish what runs marked deferred left for later — a plugin's rebuild —
 *  before a run that is not: `settle` is called with the command about to
 *  run, and may leave it to that command when the command finishes the work
 *  itself (one of the plugin's own). The returned function takes it out. */
export function registerSettle(settle: Settle): () => void {
  settlers.add(settle)
  return () => void settlers.delete(settle)
}

/** Every settle's work for the command about to run, waited for — null
 *  when none had any. */
function settle(name: string, command: Command): Promise<void> | null {
  const waits: Promise<void>[] = []
  for (const s of settlers) {
    try {
      const w = s({ name, readOnly: Boolean(command.readOnly) })
      if (w) waits.push(w)
    } catch {
      // What a settle could not finish is the next command's to meet.
    }
  }
  // Each one's failure, too, is the next command's to meet.
  return waits.length > 0 ? Promise.all(waits.map((w) => w.catch(() => {}))).then(() => {}) : null
}

/** A command that stops what the session is busy with (Command.interrupts):
 *  run at once, beside the change running — which may be waiting for what
 *  it stops — and over the busy guard; its undo step the running change's,
 *  when one is, else its own. */
async function interrupt(name: string, command: Command, input: Record<string, unknown>, onProgress: ((text: string) => void) | undefined): Promise<unknown> {
  const abort = new AbortController()
  const ctx: CommandContext = { progress: (text) => onProgress?.(text), signal: abort.signal }
  const run = () => limited(name, command.timeoutMs ?? COMMAND_TIMEOUT_MS, abort, () => command.run(input, ctx))
  try {
    if (command.history === false) return await run()
    let result: unknown
    await historyAsync(`Agent: ${command.label?.(input) ?? command.title.toLowerCase()}`, async () => {
      result = await run()
    })
    return result
  } catch (e) {
    throw asCommandError(e)
  }
}

async function execute(
  name: string,
  command: Command,
  input: Record<string, unknown>,
  onProgress: ((text: string) => void) | undefined,
  deferred: boolean,
): Promise<unknown> {
  // A change that throws the session's work away stops what the plugins
  // are busy with rather than wait for it: that goes with the rest. What
  // they start again meanwhile waits for the change to have run.
  const stops = command.discards?.(input) === true && commandGuard().busy() !== null
  let ran!: () => void
  const done = new Promise<void>((resolve) => (ran = resolve))
  try {
    if (stops) await stopPluginWork(done)
    else if (!deferred) await settle(name, command)
    return await guarded(name, command, input, onProgress, deferred)
  } finally {
    ran()
  }
}

/** The change itself, once nothing is left for it to wait for: refused
 *  while the session is busy, else run as one step of the history, the
 *  activity strip naming it. */
async function guarded(
  name: string,
  command: Command,
  input: Record<string, unknown>,
  onProgress: ((text: string) => void) | undefined,
  deferred: boolean,
): Promise<unknown> {
  const busy = commandGuard().busy()
  if (busy) throw new CommandError('busy', `The session is busy — ${busy}. Try again once it has finished.`)
  const abort = new AbortController()
  const ctx: CommandContext = {
    progress: (text) => {
      // A run let go past its time says nothing more to the strip.
      if (!abort.signal.aborted) useCommandActivity.setState({ progress: text })
      onProgress?.(text)
    },
    signal: abort.signal,
    ...(deferred ? { deferred } : {}),
  }
  // Raced inside the history step, so that the step ends — and the history
  // takes changes again — when the command is given up on.
  const ms = command.timeoutMs ?? COMMAND_TIMEOUT_MS
  const linger = (ran: Promise<unknown>) => {
    lingering = Promise.race([ran.then(() => {}, () => {}), new Promise<void>((resolve) => setTimeout(resolve, ms))])
  }
  const run = () => limited(name, ms, abort, () => command.run(input, ctx), linger)
  useCommandActivity.setState({ running: { name, title: command.title, since: Date.now() }, progress: null })
  current = { name, deferred }
  try {
    if (command.history === false) return await run()
    let result: unknown
    await historyAsync(`Agent: ${command.label?.(input) ?? command.title.toLowerCase()}`, async () => {
      result = await run()
    })
    return result
  } catch (e) {
    throw asCommandError(e)
  } finally {
    current = null
    useCommandActivity.setState({ running: null, progress: null })
  }
}

// ---- Recent outcomes ---------------------------------------------------------
// What became of the runs made under a job: kept on the page, which outlives
// the agent's server — a server copy started after the one that asked, or
// one that lost track of its job, still reads what the job did here
// (session.recent).

/** How many runs are kept, the oldest let go first. */
export const RECENT_KEPT = 100

/** The most of a result kept, in JSON characters; past it, only its size. */
export const RECENT_RESULT_CHARS = 16_000

export interface RecentOutcome {
  /** The job the run was part of, as the caller named it. */
  job: string
  name: string
  state: 'running' | 'done' | 'failed'
  /** When it started, ISO. */
  started: string
  /** How long it took; null while it runs. */
  ms: number | null
  result?: unknown
  /** Why the result is not kept: its size. */
  resultOmitted?: string
  error?: { code: string; message: string }
}

const recent: RecentOutcome[] = []

/** A result as it is kept: a copy, a file's bytes as their count, or only
 *  its size when it is large. */
function keptResult(result: unknown): Pick<RecentOutcome, 'result' | 'resultOmitted'> {
  if (result === undefined) return {}
  let json: string
  try {
    json = JSON.stringify(result, (_key, v: unknown) => (v instanceof Uint8Array ? `${v.byteLength} bytes` : v)) ?? 'null'
  } catch {
    return { resultOmitted: 'not kept: it is not JSON' }
  }
  if (json.length > RECENT_RESULT_CHARS) return { resultOmitted: `${json.length} characters, past the ${RECENT_RESULT_CHARS} kept` }
  return { result: JSON.parse(json) as unknown }
}

function remember(job: string, name: string, run: Promise<unknown>): Promise<unknown> {
  const since = Date.now()
  const outcome: RecentOutcome = { job, name, state: 'running', started: new Date(since).toISOString(), ms: null }
  recent.push(outcome)
  if (recent.length > RECENT_KEPT) recent.splice(0, recent.length - RECENT_KEPT)
  run.then(
    (result) => Object.assign(outcome, { state: 'done', ms: Date.now() - since }, keptResult(result)),
    (e: unknown) => Object.assign(outcome, { state: 'failed', ms: Date.now() - since, error: asCommandError(e).toJSON() }),
  )
  return run
}

/** The runs kept, newest first — only those of `job` when given. */
export function recentOutcomes(job?: string): RecentOutcome[] {
  return recent
    .filter((o) => job === undefined || o.job === job)
    .reverse()
    .map((o) => ({ ...o }))
}
