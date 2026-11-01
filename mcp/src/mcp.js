// SPDX-License-Identifier: AGPL-3.0-only
// The MCP side: the tools an agent lists and calls. Each of the page's
// commands is a tool (tools.js); seven more are this server's own —
// scanruler_status, to see whether a ScanRuler page is connected and how to
// connect one; scanruler_open, to open one in the user's browser, paired;
// scanruler_wait, to wait for it or for it to be idle; scanruler_batch, to
// run several of the page's tools in one call; scanruler_write, to write a
// text file — a report — next to the scan; scanruler_files, to list what is
// there; and scanruler_read, to read a text file of it, an answer too long
// to carry among them. In compact mode, for a model with a small context
// window, the page's tools are not listed but for those that return a picture,
// which a batch cannot show — it writes the picture to a file and gives its
// text: one more of the server's own, scanruler_tools, lists them a line
// each and gives the definitions of those asked for, and scanruler_batch
// runs them. With a list of namespaces (--tools scan,view or
// -flat,-thickness), only the commands of those namespaces, or all but
// those, are tools, beside the server's own; the others are unknown here.
// Headless (engine.js), the tools are the commands ScanRuler runs in this
// process with no page, listed in any mode.
//
// No call is held past the answer limit (`answerWithinMs`): a client, or a
// bridge between it and this computer, may cut a call at a minute. A change
// or a batch still running then answers with its job, and runs on.

import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, open, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { absolute, agentJson, batchedPicture, fileKind, imageContent, inputFor, relativeFrom, replacesSession, saveFileResult, TEXT_FILES, toolFor, toolName, waitIn, withFiles, wholeUtf8, writeNew } from './tools.js'
import { jsonBytes, replyHead, replyMeasure } from './trace.js'

/** The app's own commands as of this release, so the tools are there before
 *  a page connects — unless a page has connected before whose list was kept
 *  (`remembered`) and is no older; a connected page's own list replaces
 *  either, its plugins' commands included. Kept in step by the app's tests
 *  (tests/mcpCommands.test.ts), with the app's version and when it was
 *  written (SNAPSHOT_OF). */
const SNAPSHOT_FILE = JSON.parse(readFileSync(new URL('./commands.json', import.meta.url), 'utf8'))
export const SNAPSHOT = Array.isArray(SNAPSHOT_FILE) ? SNAPSHOT_FILE : SNAPSHOT_FILE.commands
export const SNAPSHOT_OF = { version: SNAPSHOT_FILE.app ?? null, saved: SNAPSHOT_FILE.saved ?? null }

/** -1, 0 or 1 as version `a` is older than, the same as or newer than `b`,
 *  by their numbers in order — 0.6.10 after 0.6.9. */
export function compareVersions(a, b) {
  const pa = String(a).split(/[^0-9]+/).filter(Boolean).map(Number)
  const pb = String(b).split(/[^0-9]+/).filter(Boolean).map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return Math.sign(d)
  }
  return 0
}

/** The list to give before a page connects, from the one kept from the
 *  last page (`{ commands, version, plugins, saved }`, or a bare list) and
 *  this server's own: the kept one when it is no older — a page's own,
 *  plugins included — else this server's, with the kept page's plugins'
 *  commands, which it lacks. A kept list with no version (a server before
 *  0.4.0 kept it) is the older; the same version goes by when each was
 *  written. `from` says which, for the status. */
export function listBeforePage(kept, snapshot = SNAPSHOT, of = SNAPSHOT_OF) {
  if (!kept) return null
  const record = Array.isArray(kept) ? { commands: kept } : kept
  if (!record.commands?.length) return null
  const order = record.version && of.version ? compareVersions(record.version, of.version) : record.version ? 1 : -1
  const keptNewer = order > 0 || (order === 0 && !(record.saved && of.saved && record.saved < of.saved))
  const page = `ScanRuler ${record.version ?? 'of no version'}`
  if (keptNewer) return { commands: record.commands, from: `the list kept from the last page that connected (${page})` }
  // A plugin's commands are under its id (the app's registry); with no
  // plugins kept, those under a name the app's own list has none of.
  const namespace = (c) => String(c.name).split('.')[0]
  const own = new Set(snapshot.map(namespace))
  const plugin = record.plugins ? (c) => record.plugins.includes(namespace(c)) : (c) => !own.has(namespace(c))
  const added = record.commands.filter(plugin)
  const commands = [...snapshot, ...added].sort((a, b) => a.name.localeCompare(b.name))
  return { commands, from: `this server’s own list (ScanRuler ${of.version ?? 'of no version'}), newer than the one kept from the last page (${page})${added.length ? `, and that page’s plugins’ commands (${added.length})` : ''}` }
}

/** How the page's commands are listed: `full`, each its own tool, or
 *  `compact`, read through scanruler_tools. A third way is a list of
 *  namespaces (parseToolMode). */
export const TOOL_MODES = ['full', 'compact']

/** The namespace of a command's tool: the part of its name before the
 *  first underscore — scan for scan_open, view for view_render. */
const namespaceOf = (command) => toolName(command).split('_')[0]

/** How `--tools` reads. `full` and `compact` as they are; otherwise a
 *  comma-separated list of namespaces, the part of a tool's name before
 *  its first underscore: plain (`scan,view`) lists those namespaces alone,
 *  each with a leading `-` (`-flat,-thickness`) lists every namespace but
 *  those — and the server's own tools either way, each listed command a
 *  tool of its own as in full. A list that mixes the two forms, or is
 *  empty, throws, its message starting with `flag` (`--tools` or
 *  `SCANRULER_MCP_TOOLS`). A namespace no page has is not refused: a page
 *  may add it; the server says at a page's connection which entries match
 *  none of its namespaces. Returns { text, compact, named, lists }: `text`
 *  is the mode as given, what the status and serverInfo report; `named`
 *  the namespaces in the list (null for full and compact); `lists(ns)`
 *  whether a command of that namespace is listed. */
export function parseToolMode(given, flag = '--tools') {
  const text = String(given ?? '').trim()
  if (TOOL_MODES.includes(text)) return { text, compact: text === 'compact', named: null, lists: () => true }
  const forms = `${TOOL_MODES.join(', ')}, namespaces to list (scan,view) or namespaces to leave out (-flat,-thickness)`
  if (text === '') throw new Error(`${flag} is empty: give ${forms}.`)
  const entries = text.split(',').map((s) => s.trim())
  const bad = entries.find((e) => !/^-?[A-Za-z0-9]+$/.test(e))
  if (bad !== undefined) {
    throw new Error(`${flag} ${text}: "${bad}" is no namespace — a namespace is the part of a tool's name before its first underscore (scan, view, element …), with a leading - to leave it out. Give ${forms}.`)
  }
  const out = entries.filter((e) => e.startsWith('-'))
  if (out.length > 0 && out.length < entries.length) {
    throw new Error(`${flag} ${text} mixes namespaces to list (${entries.filter((e) => !e.startsWith('-')).join(', ')}) with namespaces to leave out (${out.join(', ')}): give one form — scan,view lists those alone, -flat,-thickness lists all but those.`)
  }
  const named = new Set(entries.map((e) => e.replace(/^-/, '')))
  const exclude = out.length > 0
  return { text, compact: false, named, lists: (ns) => named.has(ns) !== exclude }
}

/** The most definitions scanruler_tools gives in one answer: twenty are
 *  some ten thousand tokens, a small window's fair share. */
const MAX_DEFINITIONS = 20

const ABOUT = [
  'These tools drive ScanRuler, a measuring app for 3D scans, in the browser tab the user has open: the user watches every step in the viewport and can undo it there.',
  'Start with scanruler_status. If no ScanRuler page is connected, call scanruler_open: it opens ScanRuler in the user’s browser, paired with this server, and waits for it. If that leaves it unconnected, tell the user what howToConnect says, then call scanruler_wait.',
  'Before a task’s first step, read its guide with guide_read — how to measure a scan, model a part or turn a scan into CAD, written for the ScanRuler build connected: guide_read with no topic lists the guides and their sections.',
]
const WORKING = [
  'Read session_state before acting and after: the scan’s bounding box says where the part lies, the elements and dimensions what is measured. Lengths are millimetres, angles degrees; answers give numbers to six significant digits.',
  'A place on the scan is { point: [x, y, z] } (the nearest scan vertex is taken) or { vertex: n }. To fit a feature, aim at its middle, not at an edge.',
  'Every tool that changes the session is one step of the undo history; history_undo takes the last back. report_get gives the report as JSON (format "json") or as the text the panel copies (format "text").',
  'A change, a batch or a long read still running at the server’s answer limit (scanruler_status: server.answerWithin) answers { queued: true, job } and runs on: scanruler_wait { for: "job", job } gives its answer — call it again while it says running.',
]
const INSTRUCTIONS = {
  full: [
    ...ABOUT,
    ...WORKING,
    'view_render shows you the 3D view as a picture; view_set turns it to a standard view or fits it.',
    'scanruler_batch runs several tools in one call, in order — many scan_nearest or element_fit calls, say — and stops at the first that is refused unless told to go on.',
  ].join(' '),
  compact: [
    ...ABOUT,
    'ScanRuler’s own tools are not listed one by one, but for those that return a picture. scanruler_tools lists them all, a name and a line each; scanruler_tools with names gives those tools’ full definitions. Read a tool’s definition before its first use, and give it the arguments its inputSchema asks for.',
    'Run the tools through scanruler_batch — { "calls": [{ "tool": "session_state", "arguments": {} }] }; a single tool is a batch of one, and several run in order. Each result is { tool, ok, result } or { tool, ok: false, error: { code, message } }: the code is the page’s own (invalid_input, no_scan, busy, invalid_state, not_found …) and the message says what was wrong, so retry a refused call with its arguments corrected.',
    ...WORKING,
    'The tools that return a picture — view_render, which pictures the 3D view, among them — are listed as tools of their own: call them directly to see the picture. In a batch a picture is not shown: it is written to a file — the call’s path, or a new file in the server’s output folder — and its result says where (file.path). view_set turns the view.',
  ].join(' '),
}

/** A command in a line, for scanruler_tools' list: its title, or the first
 *  sentence of its description. */
function summary(command) {
  if (command.title) return command.title
  const description = String(command.description ?? '').replace(/\s+/g, ' ').trim()
  return /^.*?[.!?](?= |$)/.exec(description)?.[0] ?? description
}

/** The names a call would give new things, at the fields its command says
 *  name them — `names: { space, at }` in the page's list, `at` paths into
 *  the input ("feature.name", "features[].name", a `[]` stepping into each
 *  item of a list) and `space` the things whose names may not repeat, in
 *  words. Each `{ space, name }`; none for a command that says nothing. */
export function namesGiven(command, args) {
  const declared = command?.names
  if (!declared || !Array.isArray(declared.at)) return []
  const space = String(declared.space ?? 'names')
  const found = []
  const walk = (value, steps) => {
    if (value === null || typeof value !== 'object') {
      if (steps.length === 0 && typeof value === 'string' && value.trim()) found.push({ space, name: value })
      return
    }
    if (steps.length === 0) return
    const [step, ...rest] = steps
    const list = step.endsWith('[]')
    const next = value[list ? step.slice(0, -2) : step]
    if (!list) walk(next, rest)
    else if (Array.isArray(next)) for (const item of next) walk(item, rest)
  }
  for (const path of declared.at) walk(args ?? {}, String(path).split('.'))
  return found
}

/** Why a batch's calls may not run together: two of them — or one twice —
 *  giving new things the same name in one space, trimmed and in any case,
 *  which the page refuses at the second, rolling back every change before
 *  it. Null when none do. `commandOf` finds a call's command by its tool. */
export function nameClash(calls, commandOf) {
  const seen = new Map()
  for (let i = 0; i < calls.length; i++) {
    const tool = String(calls[i]?.tool ?? '')
    for (const { space, name } of namesGiven(commandOf(tool), calls[i]?.arguments)) {
      const key = `${space}\u0000${name.trim().toLowerCase()}`
      const first = seen.get(key)
      if (first) {
        const which = first.index === i ? `calls[${i}] (${tool}) gives the name “${name.trim()}” twice` : `calls[${first.index}] (${first.tool}) and calls[${i}] (${tool}) both give the name “${name.trim()}”${first.name.trim() !== name.trim() ? ` (“${first.name.trim()}”)` : ''}`
        return `${which} — names are unique across ${space}, so the page would refuse the second and the batch roll back what came before it. Nothing was run: give each its own name.`
      }
      seen.set(key, { index: i, tool, name })
    }
  }
  return null
}

/** A batch's calls as the client sent them — `{ calls }`, or `{ error }`
 *  when they cannot be read. Some clients send a large nested value as a
 *  string of its JSON: the list of calls, a call, or a call's arguments
 *  given so is read as that JSON. Anything else that is not a list is no
 *  calls, as before. */
export function callsGiven(given) {
  const parse = (text) => {
    if (!text.trim()) return { value: undefined }
    try {
      return { value: JSON.parse(text) }
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  }
  const SHAPE = '[{ "tool": "…", "arguments": { … } }]'
  let list = given
  if (typeof given === 'string') {
    const read = parse(given)
    if (read.error) return { error: `calls came as a string that is not JSON (${read.error}) — give calls as a list: ${SHAPE}.` }
    list = Array.isArray(read.value?.calls) ? read.value.calls : read.value
    if (!Array.isArray(list)) return { error: `calls came as a string whose JSON is not a list of calls — give calls as a list: ${SHAPE}.` }
  }
  if (!Array.isArray(list)) return { calls: [] }
  const calls = []
  for (let i = 0; i < list.length; i++) {
    let c = list[i]
    if (typeof c === 'string') {
      const read = parse(c)
      if (read.error || !read.value || typeof read.value !== 'object' || Array.isArray(read.value)) return { error: `calls[${i}] came as a string that is not a call's JSON${read.error ? ` (${read.error})` : ''} — each call is { "tool": "…", "arguments": { … } }. Nothing was run.` }
      c = read.value
    }
    if (c && typeof c === 'object' && typeof c.arguments === 'string') {
      const read = parse(c.arguments)
      const tool = typeof c.tool === 'string' ? ` (${c.tool})` : ''
      if (read.error) return { error: `calls[${i}].arguments${tool} came as a string that is not JSON (${read.error}) — give them as an object, {} for none. Nothing was run.` }
      if (read.value !== undefined && (read.value === null || typeof read.value !== 'object' || Array.isArray(read.value))) return { error: `calls[${i}].arguments${tool} came as a string whose JSON is not an object — give them as an object, {} for none. Nothing was run.` }
      c = { ...c, arguments: read.value ?? {} }
    }
    calls.push(c)
  }
  return { calls }
}

/** What the server says it is when it runs ScanRuler itself, headless. */
const HEADLESS_ABOUT = [
  'These tools drive ScanRuler headless: the app runs inside this server, with no browser, no scan and no viewport — nobody watches it, and nothing is drawn. scanruler_status says so (backend: "headless").',
  'Before a task’s first step, read its guide with guide_read — written for this build: guide_read with no topic lists the guides and their sections.',
]
const HEADLESS_WORKING = [
  'Lengths are millimetres, angles degrees; answers give numbers to six significant digits. Every tool that changes the session is one step of the undo history; history_undo takes the last back. Read session_state before acting and after.',
  'A change or a batch still running at the server’s answer limit (scanruler_status: server.answerWithin) answers { queued: true, job } and runs on: scanruler_wait { for: "job", job } gives its answer.',
]
const HEADLESS_INSTRUCTIONS = {
  full: [
    ...HEADLESS_ABOUT,
    'The tools listed are those that run so: modelling solids feature by feature with parameters, describing and checking the bodies, notes, and STEP and STL files read and written on this computer. A tool that needs the page — a scan, a picture, the browser — is not listed, and answers unavailable if called; it needs this server started in page mode, paired with a ScanRuler tab.',
    ...HEADLESS_WORKING,
    'scanruler_batch runs several tools in one call, in order, and stops at the first that is refused unless told to go on.',
  ].join(' '),
  compact: [
    ...HEADLESS_ABOUT,
    'ScanRuler’s tools are those that run so — modelling solids feature by feature with parameters, describing and checking the bodies, notes, and STEP and STL files read and written on this computer — and are not listed one by one. scanruler_tools lists them, a name and a line each; scanruler_tools with names gives those tools’ full definitions. Read a tool’s definition before its first use, and give it the arguments its inputSchema asks for. A tool that needs the page — a scan, a picture, the browser — is not among them, and answers unavailable if called; it needs this server started in page mode, paired with a ScanRuler tab.',
    'Run the tools through scanruler_batch — { "calls": [{ "tool": "session_state", "arguments": {} }] }; a single tool is a batch of one, and several run in order. Each result is { tool, ok, result } or { tool, ok: false, error: { code, message } }: the message says what was wrong, so retry a refused call with its arguments corrected.',
    ...HEADLESS_WORKING,
  ].join(' '),
}

/** How many jobs the server keeps answers of, the oldest finished let go
 *  first. */
const JOBS_KEPT = 50

/** How long the status waits for the page to say what its session holds,
 *  ms; past it the status goes without. */
const SESSION_WITHIN_MS = 3_000

/** The kinds of file scanruler_write writes: text, for a report. */
const TEXT_KINDS = ['.md', '.txt', '.csv', '.json']

/** Names scanruler_write does not write, in any folder: files other tools
 *  read as their instructions or settings, which a report never needs. */
const PROTECTED_NAMES = ['claude.md', 'agents.md', 'gemini.md', 'package.json', 'package-lock.json', 'tsconfig.json', 'jsconfig.json']

/** A change answered directly that took longer than this has likely
 *  outlived its client's wait (Claude Desktop's is a minute): its answer
 *  counts as not yet seen, for scanruler_wait { for: "idle" } to give. */
const SEEN_WITHIN_MS = 55_000

/** How long a call is held before it answers with its job, by default: under
 *  the minute a client or a bridge may cut it at. */
export const ANSWER_WITHIN_MS = 45_000

/** How long a batch waits for the page to be idle — before it retries a
 *  call refused busy, and before it rolls back. */
const IDLE_WAIT_MS = 60_000

/** How long a listing of the tools waits for a page that connected before
 *  and is not back yet, ms. */
const LIST_WAIT_MS = 3_000

/** The most characters an answer carries — some ten thousand tokens. A
 *  longer one is written to a file in the output folder, and the answer
 *  says where, how large and what it holds. */
export const ANSWER_CAP = 40_000

/** Commands whose answer may run past ANSWER_CAP before it is written to a
 *  file, and how far. A guide is read whole, before a task's first step,
 *  and is worth its room: several asked for together are answered while
 *  they fit some 80 k characters, the rest named to read next (the page's
 *  guide.read), so a read does not reach this. 90 k stays under Claude Code's
 *  default limit on a tool's answer, 25 000 tokens (MAX_MCP_OUTPUT_TOKENS)
 *  — some 100 k characters at four a token, less for text with many
 *  escapes and marks. */
export const ANSWER_CAPS = { 'guide.read': 90_000 }

/** What a spilled answer of a command says to ask for next time: less of
 *  it, by the command's own fields — the command's own word (askForLess,
 *  which a page sends with its commands) first, else this, for a page from
 *  before it did. */
const ASK_FOR_LESS = {
  'guide.read': 'one section at a time (section, by its heading — a ### part of a long one too; guide_read with no topic lists them with what each costs)',
}

/** What a command's spilled answer says to ask for next time. */
const lessOf = (command) => (typeof command?.askForLess === 'string' && command.askForLess ? command.askForLess : ASK_FOR_LESS[command?.name])

/** How many jobs the status lists besides those running, the newest. */
const JOBS_LISTED = 5

/** How many folders are kept, the latest first. */
const FOLDERS_KEPT = 10

/** How many entries scanruler_files lists at most. */
const FILES_LISTED = 300

/** The folder in the scan's folder that the server's own files go into
 *  when no path was given — answers too long to carry, a batch's pictures
 *  — kept apart from the person's files beside the scan. */
const WORK_FOLDER = 'scanruler-work'

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)))

/** The notes an answer carries for the agent (`notes`), when it is an
 *  object that has them. */
const notesIn = (v) => (v !== null && typeof v === 'object' && !Array.isArray(v) && v.notes !== undefined && v.notes !== null ? v.notes : undefined)

/** `d` as local time with its offset from UTC, to the second —
 *  2026-10-23T18:04:05+02:00 — for an agent whose host gives it no clock. */
export function localTime(d = new Date()) {
  const pad = (n) => String(Math.trunc(Math.abs(n))).padStart(2, '0')
  const off = -d.getTimezoneOffset()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${off < 0 ? '-' : '+'}${pad(off / 60)}:${pad(off % 60)}`
}

const text = (value, exact = false) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : agentJson(value, exact) }] })
const failure = (e) => {
  const code = e?.code ?? 'failed'
  const message = e?.message ?? String(e)
  return { ...text(`${code}: ${message}`), isError: true }
}

/**
 * @param {{
 *   link: import('./relay.js').SharedLink | import('./link.js').PageLink,
 *   version: string,
 *   cwd: string,
 *   outDir: string,
 *   connectHelp: () => string,
 *   serverInfo: () => Record<string, unknown>,
 *   pageTimeoutMs?: number,
 *   remembered?: { load(): unknown[] | null, save(commands: unknown[]): void } | null,
 *   openPage?: () => Promise<boolean>,
 *   openGraceMs?: number,
 *   openWaitMs?: number,
 *   tools?: string,
 *   log?: (line: string) => void,
 *   trace?: ReturnType<typeof import('./trace.js').createTrace>,
 *   answerWithinMs?: number,
 *   folderStore?: { load(): string[] | null, save(folders: string[]): void } | null,
 *   listWaitMs?: number,
 *   answerCap?: number,
 * }} options — `tools` is how the page's commands are listed: full,
 *   compact, or a list of namespaces (parseToolMode). `log` takes the
 *   server's lines for the user — a namespace listed that no page has.
 *   `listWaitMs`: how long a listing waits for a page that connected before
 *   and is not back yet. `answerCap`: the most characters an answer
 *   carries; a longer one goes to a file in the folder the scan open now
 *   came from, else in `outDir` (ANSWER_CAP).
 *   `trace`, when given, gets a line per call (trace.js).
 *   `answerWithinMs` is how long a job's call is held before it answers
 *   with the job, and the most scanruler_wait waits; 0 holds it to the end.
 *   `folderStore` keeps the folders scans came from between runs
 *   (config.js).
 *   `openPage` opens the pairing link in the user's browser
 *   (browser.js), true when it could; scanruler_open first gives a tab that
 *   is already paired `openGraceMs` to connect by itself — the page tries
 *   again at most ten seconds apart — and then waits `openWaitMs` for the
 *   one it opened, the user's answer to the browser's question included.
 *   Both together stay under the minute some clients give a tool call.
 */
export function createMcpServer({
  link,
  version,
  cwd,
  outDir,
  connectHelp,
  serverInfo,
  pageTimeoutMs = 15_000,
  remembered = null,
  openPage = async () => false,
  openGraceMs = 11_000,
  openWaitMs = 40_000,
  tools: toolMode = 'full',
  log = (line) => process.stderr.write(`[scanruler-mcp] ${line}\n`),
  trace = null,
  answerWithinMs = ANSWER_WITHIN_MS,
  folderStore = null,
  listWaitMs = LIST_WAIT_MS,
  answerCap = ANSWER_CAP,
}) {
  // The most any call is held, ms — Infinity with no limit.
  const holdMs = answerWithinMs > 0 ? answerWithinMs : Infinity
  const holdS = answerWithinMs > 0 ? answerWithinMs / 1000 : null
  const headless = link.backend === 'headless'
  // Full, compact, or the namespaces to list: a command of a namespace
  // left out is not listed, and not run either.
  const selection = parseToolMode(toolMode)
  const compact = selection.compact
  const leftOut = (c) => !compact && !selection.lists(namespaceOf(c))
  const server = new Server(
    { name: 'scanruler', title: 'ScanRuler', version },
    {
      capabilities: { tools: { listChanged: true } },
      instructions:
        (headless ? HEADLESS_INSTRUCTIONS : INSTRUCTIONS)[compact ? 'compact' : 'full'] +
        (selection.named ? ` This server lists ScanRuler’s tools by namespace, as it was started (--tools ${selection.text}); a tool of a namespace left out is unknown here.` : ''),
    },
  )

  // The last connected page's commands, for listing before a page is back:
  // a client that lists the tools once — at its start, before the tab has
  // reconnected — and does not list them again when told they changed
  // still sees every tool the tab offers.
  // A server shipped with a newer list than the one kept lists its own: the
  // kept one may be days old (listBeforePage).
  let lastPage = listBeforePage(remembered?.load() ?? null)
  const commands = () => (link.page?.commands?.length ? link.page.commands : lastPage?.commands ?? SNAPSHOT)
  const remember = () => {
    const list = link.page?.commands
    if (!list?.length) return
    lastPage = { commands: list, from: 'the list kept from the last page that connected' }
    try {
      remembered?.save({ commands: list, version: link.page.version ?? null, plugins: link.page.plugins ?? null })
    } catch {
      // Not kept: the next run lists the app's own until the page is back.
    }
  }

  // ---- jobs ---------------------------------------------------------------
  // Every call that changes the session is a job, its answer kept: one
  // started with wait: false answers at once with the job, and one the
  // client gave up waiting for keeps running and keeps its reply — the
  // status lists both, and scanruler_wait { for: "job" } gives the answer.
  // The page keeps what each run under a job did (session.recent), so a
  // copy of this server started later can still say: a job's name carries
  // this copy's own mark, and is not taken again by the next.
  const jobs = new Map()
  let nextJob = 1
  const copyMark = randomBytes(3).toString('hex').slice(0, 4)
  // `ctx` is the call's own, for the trace: the job is named on the call's
  // line, and one answered before it was done (queued) gets a line when it
  // is. `run` is handed the job's name, for the page.
  const startJob = (tool, run, ctx = null, queued = false) => {
    const job = { job: `j${nextJob++}-${copyMark}`, tool, state: 'running', started: Date.now(), ms: null, reply: null, queued, progress: null }
    if (ctx) Object.assign(ctx.fields, { job: job.job, ...(queued ? { queued: true } : {}) })
    const finished = (reply) => {
      job.state = reply.isError ? 'failed' : 'done'
      job.ms = Date.now() - job.started
      job.reply = reply
      // Answered to the client: seen, unless queued or likely timed out.
      job.told = !job.queued && job.ms < SEEN_WITHIN_MS
      if (job.queued && trace) trace.write({ ev: 'job', job: job.job, call: ctx?.call ?? null, tool, t: job.started, ms: job.ms, ...replyMeasure(reply), ...(trace.args ? { head: replyHead(reply) } : {}) })
      return reply
    }
    job.done = Promise.resolve()
      .then(() => run(job.job))
      .then(finished, (e) => finished(failure(e)))
    jobs.set(job.job, job)
    // The newest kept, but never one still running.
    for (const [id, j] of jobs) {
      if (jobs.size <= JOBS_KEPT) break
      if (j.state !== 'running') jobs.delete(id)
    }
    return job
  }
  const jobBrief = (j) => ({
    job: j.job,
    tool: j.tool,
    state: j.state,
    ...(j.ms !== null ? { ms: j.ms } : { runningMs: Date.now() - j.started, ...(j.progress ? { progress: j.progress } : {}) }),
  })
  /** A job's last progress line from the page kept — what its status line
   *  says, "Measuring deviation — 42%…" — as `{ phase, percent }`, percent
   *  null when the line gives none; `call`, in a batch, the index of the
   *  call it came from. The status and scanruler_wait answer it while the
   *  job runs, whether or not the client asked for progress. */
  const noteProgress = (job, line, call) => {
    if (!job) return
    const text = String(line ?? '').trim()
    if (!text) return
    const m = /(\d+(?:\.\d+)?)\s*%/.exec(text)
    const phase = m ? text.replace(/\s*[—–-]?\s*\d+(?:\.\d+)?\s*%\s*/, ' ').replace(/\s+(?=[…:.,]|$)/g, '').trim() : text
    job.progress = { phase: phase || text, percent: m ? Number(m[1]) : null, ...(call !== undefined ? { call } : {}) }
  }
  /** A job's answer as scanruler_wait gives it: the tool's own answer
   *  under result, or its refusal under error. */
  const jobAnswer = (j) => {
    if (!j.reply) return jobBrief(j)
    const body = j.reply.content.find((x) => x.type === 'text')?.text ?? ''
    if (j.reply.isError) {
      const m = /^([a-z_]+): ([\s\S]*)$/.exec(body)
      return { ...jobBrief(j), error: m ? { code: m[1], message: m[2] } : { code: 'failed', message: body } }
    }
    let result
    try {
      result = JSON.parse(body)
    } catch {
      result = body
    }
    return { ...jobBrief(j), result }
  }

  /** A job answered at once with its name: wait: false. */
  const queuedReply = (job) => text({ queued: true, job: job.job, tool: job.tool })

  /** A job's call answered: its reply once done, or — still running at
   *  the answer limit — its name, as with wait: false. */
  const answerFor = async (job, ctx) => {
    if (holdMs === Infinity) return job.done
    let timer
    const reply = await Promise.race([job.done, new Promise((r) => (timer = setTimeout(() => r(null), holdMs)))])
    clearTimeout(timer)
    if (reply) return reply
    job.queued = true
    if (ctx) ctx.fields.queued = true
    return text({
      queued: true,
      job: job.job,
      tool: job.tool,
      after: holdS,
      note: `Still running after ${holdS} s, and running on${hiddenNow() ? '; the ScanRuler tab is hidden' : ''}. scanruler_wait { for: "job", job: "${job.job}" } gives its answer — call it again while it says running.`,
    })
  }

  /** Whether the page is done with what it is busy with — polled until
   *  `until` (ms since the epoch). A page that does not say is taken as
   *  idle. */
  /** What the page was busy with when pageIdle last looked — its busy
   *  sentence (a build's step in play and how long it has run, say), and
   *  the change running and for how long — or null. */
  let pageBusy = null
  const pageIdle = async (until) => {
    for (;;) {
      const state = await link.run('session.state', {}).catch(() => null)
      pageBusy = state && typeof state === 'object' ? { busy: state.busy ?? null, running: state.running ?? null, runningMs: state.runningMs ?? null } : null
      if (!state || typeof state !== 'object' || (state.busy == null && state.running == null)) return true
      if (Date.now() >= until) return false
      await sleep(Math.min(500, until - Date.now()))
    }
  }

  /** What the page says was run under a job this copy does not know — one
   *  of a copy before it — waiting while a run under it goes on, until
   *  `until`. Null when the page has nothing under it, or cannot say. */
  const jobFromPage = async (job, until) => {
    if (headless || !link.connected) return null
    for (;;) {
      let outcomes
      try {
        outcomes = (await link.run('session.recent', { job, limit: 100 }))?.outcomes
      } catch {
        return null
      }
      if (!Array.isArray(outcomes) || outcomes.length === 0) return null
      const running = outcomes.some((o) => o.state === 'running')
      if (!running || Date.now() >= until) return pageJobAnswer(job, outcomes.slice().reverse(), running)
      await sleep(Math.min(1000, until - Date.now()))
    }
  }
  /** The page's record of a job, in run order, as scanruler_wait gives it:
   *  a single run as a job's answer, several — a batch — as calls. */
  const pageJobAnswer = (job, runs, running) => {
    const calls = runs.map((o) => ({
      tool: toolName({ name: String(o.name) }),
      state: o.state,
      ms: o.ms,
      ...(o.result !== undefined ? { result: o.result } : {}),
      ...(o.resultOmitted ? { resultOmitted: o.resultOmitted } : {}),
      ...(o.error ? { error: o.error } : {}),
    }))
    const from = `the page (session.recent): this server copy, started at ${startedAt}, did not start ${job}; the page kept what was run under it, but no picture or file it gave.`
    if (calls.length === 1) return { job, ...calls[0], from }
    return {
      job,
      state: running ? 'running' : 'ended',
      calls,
      from,
      note: 'A batch’s own answer — its results in full, what it undid — belonged to the server copy that ran it. These are the page’s commands under the job, in order; a batch stopped part way shows only those it ran. Read session_state for where the session stands.',
    }
  }

  /** Whether the tab is hidden now — null with no page, or headless. */
  const hiddenNow = () => (link.connected && link.page && !headless ? (link.page.hidden ?? false) : null)
  const runningJobs = () => [...jobs.values()].filter((j) => j.state === 'running').length
  /** The page's reads being answered now, which no job stands for: an export
   *  writing its file, a check — what a wait for idle has to count too. */
  const callsInFlight = new Set()

  /** A finished job as scanruler_wait { for: "idle" } lists it: a failed
   *  one with its error, a batch with the call it stopped at. */
  const finishedOut = (j) => {
    const answer = jobAnswer(j)
    if (j.state === 'failed') return { ...jobBrief(j), error: answer.error }
    const failed = j.tool === 'scanruler_batch' ? answer.result?.failed : undefined
    return { ...jobBrief(j), ...(failed ? { failed } : {}) }
  }

  // Since when this copy of the server keeps jobs: one asked of a copy
  // before it — another process, or this one restarted — is not known here.
  const startedAt = new Date().toISOString()
  const noJobs = `None asked of this server copy, which started at ${startedAt}. A change asked of an earlier copy is not known here: session_state says what the page holds.`

  /** The page's session.state, or null when there is no page or it does
   *  not answer soon. */
  const sessionRead = async () => {
    if (!link.connected) return null
    let timer
    const state = await Promise.race([
      link.run('session.state', {}).catch(() => null),
      new Promise((r) => (timer = setTimeout(() => r(null), SESSION_WITHIN_MS))),
    ])
    clearTimeout(timer)
    return state && typeof state === 'object' ? state : null
  }
  /** Whether a session holds work: a scan, or anything counted. */
  const holdsWork = (state) => Boolean(state?.scan) || Object.values(state?.project?.holds ?? {}).some((n) => typeof n === 'number' && n > 0)

  // ---- the scan open now ----------------------------------------------------
  // The folder the scan open in the page came from, when this server opened
  // it — or the project holding it — from a file: the part's own folder,
  // where an answer too long to carry and a batch's picture are written.
  // Not the latest of the folders: a scan_open that saves the session it
  // replaces (saveTo) puts the previous part's folder there, and a scan
  // opened by hand puts nothing. Forgotten when a session is replaced
  // without a file or the page reloads; and the page holding a scan of
  // another name now (opened by hand) holds another part.
  let openScan = null
  /** What a session-replacing call leaves open: its file's folder and the
   *  scan's name as the page answered it, or nothing known. */
  const openedFrom = (file, result) => {
    openScan = file ? { folder: dirname(file), scan: typeof result?.scan?.fileName === 'string' ? result.scan.fileName : null } : null
  }
  /** The folder of the scan open now, or null when it was not opened from
   *  one here. A page that does not answer soon is taken to hold it still. */
  const scanFolderNow = async () => {
    if (!openScan) return null
    const kept = openScan
    const state = await sessionRead()
    if (state && kept.scan !== null && (state.scan?.fileName ?? null) !== kept.scan) return null
    return kept.folder
  }
  /** The folder in the scan's folder the server's own files go into — an
   *  answer too long to carry, a batch's picture — so they do not lie
   *  among the person's: WORK_FOLDER, or null as scanFolderNow. Still in
   *  the scan's folder, which a sandboxed agent can open. */
  const workFolderNow = async () => {
    const folder = await scanFolderNow()
    return folder ? join(folder, WORK_FOLDER) : null
  }

  // ---- the page that came back ----------------------------------------------
  // A page names itself — pageId, new each time it loads — and says when it
  // loaded (since). Another name where the last page held work is a reload
  // (Vite's after an edit, the person's, a tab the browser unloaded), and
  // what that page held is gone: the next answer says so, with the project
  // last opened or saved here, before a no_scan is read as a session never
  // had. A page from before pageId is not told apart. `stale`: what the
  // page said when it could not load a part of the app (stale_page).
  let pageSeen = null
  let reloaded = null
  const seePage = (connected) => {
    if (!link.page) return
    const id = typeof link.page.pageId === 'string' && link.page.pageId ? link.page.pageId : null
    if (pageSeen && (id === null ? !connected : pageSeen.id === id)) return
    if (id !== null && pageSeen?.id && pageSeen.held) {
      const r = { since: typeof link.page.since === 'string' ? link.page.since : null, empty: null }
      reloaded = r
      // Whether the new page holds anything, read once while it is new.
      sessionRead().then((state) => {
        if (state) r.empty = !holdsWork(state)
      })
    }
    // Another page holds nothing this server opened.
    if (pageSeen) openScan = null
    pageSeen = { id, held: false, stale: null }
  }
  /** The note a reload is told by, once. */
  const reloadNote = ({ since, empty }) => {
    const at = since && Number.isFinite(Date.parse(since)) ? ` at ${localTime(new Date(since)).slice(11, 16)}` : ''
    const now = empty === true ? ' and holds nothing now' : empty === false ? ' — a new page, holding work of its own' : ''
    const project = knownProject()
    return (
      `The ScanRuler page reloaded${at}${now}: what the page held before is gone, unless it was saved. ` +
      (project ? `The last project opened or saved here was ${project} (project_load opens it).` : 'No project was opened or saved through this server.')
    )
  }
  /** A reply with the reload said in it, when one is to be said: in an
   *  object answer as pageReloaded, first; after a refusal's message. */
  const withReload = (reply) => {
    if (!reloaded || !link.connected) return reply
    const block = reply?.content?.find((x) => x.type === 'text')
    if (!block) return reply
    const note = reloadNote(reloaded)
    reloaded = null
    const body = block.text.trimStart()
    const said = reply.isError || !body.startsWith('{') ? `${block.text} — ${note}` : `{"pageReloaded":${JSON.stringify(note)}${/^\{\s*\}$/.test(body) ? '}' : `,${body.slice(1)}`}`
    // A copy: a job keeps its reply as it was, for scanruler_wait.
    return { ...reply, content: reply.content.map((x) => (x === block ? { ...x, text: said } : x)) }
  }

  /** What the page's session holds, in brief, for the status: the scan,
   *  the project's name, whether it has unsaved changes, and its work
   *  counted — read off session.state, and left out when the page does not
   *  answer soon. */
  const sessionBrief = async () => {
    const state = await sessionRead()
    if (!state) return {}
    const project = state.project ?? {}
    if (pageSeen && holdsWork(state)) pageSeen.held = true
    if (pageSeen && typeof state.stale?.note === 'string') pageSeen.stale = state.stale.note
    return {
      session: {
        scan: state.scan?.fileName ?? null,
        ...(project.name ? { project: project.name } : {}),
        unsaved: project.unsaved ?? null,
        ...(project.holds ?? {}),
      },
      // The page's word that the server it is connected to is older than its
      // commands assume — while relaying, that is the holding copy.
      ...(typeof state.serverTooOld === 'string' ? { serverTooOld: tooOldHere(state.serverTooOld) } : {}),
    }
  }

  /** The page judges the copy it is connected to. A relaying copy is not
   *  that one: say which is out of date, and that quitting its app is the
   *  fix — updating this one changes nothing. */
  const tooOldHere = (said) => {
    const info = serverInfo()
    if (info.role !== 'relay') return said
    const holder = info.holder?.version ? `version ${info.holder.version}` : 'from before 0.4.1'
    return (
      `This server (${info.version}) is current; it sends its calls through another copy of scanruler-mcp, ${holder}, which holds the tab’s connection and is the one out of date. ` +
      'Another AI app or chat started it — quit that app completely (Claude Desktop, Claude Code, Codex or another), and this copy takes the connection over within about ten seconds; or update that app’s setting as the page says: ' +
      said
    )
  }

  // ---- answers that fit -----------------------------------------------------
  // An answer past answerCap — a read with every point in it, a batch of
  // many — would crowd out the agent's context: it is written whole to a
  // file, and the answer says where, how large and what it holds. The file
  // goes into WORK_FOLDER in the folder the scan open now came from
  // (workFolderNow) — a sandboxed agent can open that one, not the server's
  // outDir — else, or when that folder takes no file, into outDir.
  /** The answers this copy wrote to a file: scanruler_read reads them
   *  wherever they lie, outDir being no folder of a scan's. */
  const spilled = new Set()
  /** The most characters a command's answer carries (ANSWER_CAPS), never
   *  under answerCap. */
  const capOf = (command) => Math.max(answerCap, ANSWER_CAPS[command?.name] ?? 0)
  /** `value` as an answer gives it: itself, or — its JSON past `cap` —
   *  `{ truncated, file, bytes, keys, brief }`, brief its short fields,
   *  those named in `keep` and its notes. `tool` names the file, numbered
   *  past one there (writeNew), so answers spilled at once never share it;
   *  `less` says what to ask for next time. A file that cannot be written
   *  leaves the answer whole. */
  const fitted = async (value, tool, exact = false, keep = [], { cap = answerCap, less = 'fields, limit' } = {}) => {
    const body = agentJson(value, exact)
    if (body.length <= cap) return value
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const name = `${tool}-${stamp}.json`
    const workFolder = await workFolderNow()
    let file
    let where
    try {
      file = workFolder ? await writeNew(workFolder, name, body).catch(() => null) : null
      where = file ? `It is in ${workFolder}, ${WORK_FOLDER} in the folder the scan open now was opened from.` : `It is in ${outDir}, the server's output folder${workFolder ? ` — ${workFolder}, in the scan's folder, took no file` : ': the scan open now was not opened from a folder through this server'}.`
      file ??= await writeNew(outDir, name, body)
    } catch {
      return value
    }
    spilled.add(resolve(file))
    const object = value !== null && typeof value === 'object' && !Array.isArray(value)
    const short = (k, v) => keep.includes(k) || k === 'notes' || v === null || typeof v === 'number' || typeof v === 'boolean' || (typeof v === 'string' && v.length <= 200)
    const brief = object ? Object.fromEntries(Object.entries(value).filter(([k, v]) => short(k, v))) : {}
    // The notes the person left for the agent ride in every brief, where
    // the answer gave them or one level down (a job's result, a
    // workspace's part of the session): a note read late is a step done
    // over.
    if (object) for (const [k, v] of Object.entries(value)) if (!(k in brief) && notesIn(v) !== undefined) brief[k] = { notes: notesIn(v) }
    return {
      truncated: true,
      file,
      bytes: Buffer.byteLength(body, 'utf8'),
      ...(object ? { keys: Object.keys(value) } : Array.isArray(value) ? { items: value.length } : {}),
      ...(Object.keys(brief).length ? { brief } : {}),
      note: `The answer is ${Math.round(body.length / 1000)} k characters, past the ${Math.round(cap / 1000)} k an answer carries, so it was written whole to file as JSON: read what you need from there${headless ? '' : ' — scanruler_read { path: file } gives it in parts, where you cannot open the folder —'} or ask for less next time (${less}). ${where}`,
    }
  }

  // ---- folders -------------------------------------------------------------
  // The folders this server opened a scan or a project from, or saved one
  // into, the latest first: where scanruler_write may write, and what
  // scanruler_files lists and scanruler_read reads. Kept beside the command
  // list (folderStore), so a copy started afresh — or the other copy beside
  // this one — has them too.
  let folders = []
  const knownFolders = () => {
    try {
      const kept = folderStore?.load()
      if (kept) folders = kept
    } catch {
      // Not read: this copy's own list stands.
    }
    return folders
  }
  const rememberFolder = (file) => {
    const folder = dirname(file)
    folders = [folder, ...knownFolders().filter((f) => f !== folder)].slice(0, FOLDERS_KEPT)
    try {
      folderStore?.save(folders)
    } catch {
      // Not kept: this copy still has it.
    }
  }
  /** The folder every relative path is taken from — a batch's file, a
   *  $file, a file read, a file written: the latest of those folders, as
   *  scanruler_write and scanruler_files take it, else the folder this
   *  server started in. A client may start the server anywhere (Claude
   *  Desktop in its own install folder); the scan's folder is where the
   *  agent's files are. */
  const pathBase = () => knownFolders()[0] ?? cwd

  // The project file last opened or saved here, kept with the folders: what
  // a page that came back empty is pointed to.
  let lastProject = null
  const knownProject = () => {
    try {
      const kept = folderStore?.loadProject?.()
      if (kept) lastProject = kept
    } catch {
      // Not read: this copy's own stands.
    }
    return lastProject
  }
  const rememberProject = (file) => {
    if (extname(String(file)).toLowerCase() !== '.scanruler') return
    lastProject = file
    try {
      folderStore?.saveProject?.(file)
    } catch {
      // Not kept: this copy still has it.
    }
  }

  /** The jobs as the status lists them, newest first: every one running
   *  and the newest JOBS_LISTED others; jobsMore counts the rest kept. */
  const jobsListed = () => {
    const newest = [...jobs.values()].reverse()
    let others = 0
    const listed = newest.filter((j) => j.state === 'running' || others++ < JOBS_LISTED)
    const more = newest.length - listed.length
    return { jobs: listed.map(jobBrief), ...(more > 0 ? { jobsMore: more } : {}) }
  }

  const status = () => ({
    backend: headless ? 'headless' : 'page',
    connected: link.connected,
    page: link.page
      ? {
          app: link.page.app,
          version: link.page.version,
          origin: link.page.origin,
          plugins: link.page.plugins ?? [],
          viewport: link.page.viewport ?? null,
          hidden: link.page.hidden ?? null,
          commands: link.page.commands.length,
          ...(typeof link.page.since === 'string' ? { since: link.page.since } : {}),
          ...(pageSeen?.stale ? { stale: true, staleNote: pageSeen.stale } : {}),
        }
      : null,
    server: { ...serverInfo(), now: localTime(), cwd, relativeTo: pathBase(), answerWithin: holdS },
    ...(link.connected || headless ? {} : { howToConnect: connectHelp() }),
    ...(link.page?.hidden ? { hiddenNote: 'The ScanRuler tab is hidden — in the background, its window covered or minimised, or the screen locked. Changes still run; pictures and anything that waits on the screen are slower, and a browser that unloads background tabs (Chrome’s Memory Saver) may close it: add the site to "Always keep these sites active".' } : {}),
    ...(jobs.size > 0 ? jobsListed() : { jobsNote: noJobs }),
    ...(!headless && knownFolders().length ? { folders: knownFolders() } : {}),
    ...(!headless && knownProject() ? { lastProject: knownProject() } : {}),
    ...staleTools(),
  })

  const own = [
    {
      name: 'scanruler_status',
      title: 'ScanRuler connection status',
      description: 'Whether a ScanRuler page is connected to this agent, which version and plugins it has, whether its tab is hidden (page.hidden), and — when none is — how the user connects one. session, with a page, says what it holds: the scan, the project’s name, whether it has changes not saved (unsaved), and its work counted — elements, features, notes … — so a session someone else left is seen before it is replaced (scan_open with saveTo keeps it). page.since: when the page loaded. page.stale, when there: the page could not load a part of the app (an answer said stale_page) — it is older than the app it came from, rebuilt since: save the project, then ask the person to reload, as page.staleNote says. lastProject: the project file last opened or saved through this server — what to open again when the page reloaded (an answer then says pageReloaded). backend says whether ScanRuler runs in a tab (page) or in this server (headless). jobs lists the calls that change the session still running and the latest five others, newest first, each running, done or failed, a running one with progress: { phase, percent } when the page has said how far it is — a call whose answer you did not get is among them; scanruler_wait { for: "job", job } gives its answer, also for a job of an earlier copy of this server, which the page remembers; jobsMore counts the older ones kept. folders: where a scan or a project was opened from or saved into, the latest first — what scanruler_write writes into, scanruler_files lists and scanruler_read reads; kept when the server restarts. server.answerWithin: the seconds a call is held at most before it answers with its job. server.now: the time on this computer, local, with its offset from UTC (2026-10-23T18:04:05+02:00) — the clock to date a report or time a step by. server.cwd: the folder this server started in; server.relativeTo: the folder every relative path is taken from — the latest of folders, else cwd; server.outDir: where a file goes that no path was given for — but an answer too long to carry (truncated: true, file), and a picture in a batch without a path, go into scanruler-work in the folder the scan open now was opened from, when it was opened here by a path — the server’s own files, kept apart from the person’s (scanruler_files { path: "scanruler-work" } lists them, scanruler_read reads them). server.version is this server’s, server.latest the newest on npm when known, server.handedOffFrom the older copy that started this one in its place. server.role: holder — this copy holds the port and the tab’s connection; relay — another copy (another chat or AI app) holds them and this one sends its calls through it, the work still running in the tab, server.holder.version saying which (null: from before 0.4.1); none — neither yet, server.error saying why. serverTooOld, when there, says the server the page is connected to is older than the page needs — while relaying, the holding copy, not this one: tell the person once, in its words, and change nothing yourself unless they ask you to update it. tools, when there, says the tools you were given are not the ones the page offers now (stale): which were added, removed or changed — named the first time, counted after — and which page they were listed from.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
      call: async () => {
        // The session read first: it may find the page stale.
        const brief = await sessionBrief()
        return text({ ...status(), ...brief })
      },
    },
    {
      name: 'scanruler_open',
      title: 'Open ScanRuler',
      description: 'Open ScanRuler in the user’s default browser, paired with this server, and wait for the page to connect — for when scanruler_status says none is. The first time, ScanRuler warns the user that what you read goes to you and your model, and connects only once they accept; then the browser asks whether the site may reach apps on this computer, and they must allow it. Returns the status, with opened: whether the browser was asked to open it. If connected is still false, tell the user what howToConnect says.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: false, openWorldHint: false },
      call: async () => {
        if (headless) return text({ ...status(), opened: false, note: 'This server runs ScanRuler headless, in this process: there is no page to open.' })
        // A tab that was paired before is likely open and on its way back.
        if (link.connected || (await link.waitForPage(openGraceMs))) return text({ ...status(), opened: false })
        const opened = await openPage().catch(() => false)
        // Within the answer limit, with a little to spare for the answer.
        if (opened) await link.waitForPage(Math.max(1_000, Math.min(openWaitMs, holdMs - openGraceMs - 2_000)))
        return text({ ...status(), opened })
      },
    },
    {
      name: 'scanruler_wait',
      title: 'Wait for ScanRuler',
      description: `Wait until a ScanRuler page is connected (for: "page", the default), or until it is also done with what it is busy with and every change still running has finished (for: "idle" — then finished lists the changes done or failed since the last such answer, a failed one with its error, and state says idle or running; running, with busy — what the page is at, in its words: a model's build names the step in play and how long it has run — and running, the change still running, with runningS), or until a job is done (for: "job" with job — a call started with wait: false, one answered queued, or one whose answer did not come; scanruler_status lists them). Returns the status — for idle only connected, state and finished, and busy and running while running — or for a job its answer: { job, tool, state, ms, result } or { …, error: { code, message } } — state running if the time ran out first, with runningMs and, once the page has said how far it is, progress: { phase, percent } (its status line: "Measuring deviation", 42): call it again. A picture the job's tool gave comes with that answer, as an image. A job of an earlier copy of this server is read from the page's record of it (session.recent), from says so; that keeps no picture.${holdS ? ` It waits ${holdS} s at most, this server's answer limit, whatever timeoutSeconds says.` : ''} connected is false if the time ran out waiting for a page.`,
      inputSchema: {
        type: 'object',
        properties: {
          for: { type: 'string', enum: ['page', 'idle', 'job'], description: 'page (the default), idle, or job.' },
          job: { type: 'string', minLength: 1, description: 'The job to wait for, with for: "job" — as a call with wait: false, a queued answer or scanruler_status gave it.' },
          timeoutSeconds: { type: 'number', exclusiveMinimum: 0, maximum: 600, description: `How long to wait at most, seconds — 120 by default${holdS ? `, and never past ${holdS}` : ''}.` },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      call: async (args, ctx) => {
        if (ctx) ctx.fields.wait = args?.for ?? (args?.job !== undefined ? 'job' : 'page')
        // Never held past the answer limit: a cut call says nothing.
        const until = Date.now() + Math.min(1000 * (args?.timeoutSeconds ?? 120), holdMs)
        if (args?.for === 'job' || args?.job !== undefined) {
          const id = String(args?.job ?? '')
          const j = jobs.get(id)
          if (!j) {
            const kept = id ? await jobFromPage(id, until) : null
            if (kept) return text(await fitted(kept, 'scanruler_wait'))
            return failure({ code: 'not_found', message: `There is no job "${id}" — scanruler_status lists the latest. This server copy started at ${startedAt}; a job of an earlier one is not known here, nor did the page keep it (session_recent), so session_state says whether its change was made.` })
          }
          let timer
          await Promise.race([j.done, new Promise((r) => (timer = setTimeout(r, Math.max(0, until - Date.now()))))])
          clearTimeout(timer)
          if (j.state !== 'running') j.told = true
          // The picture the job's tool gave, as the call itself would show it.
          const answer = text(await fitted(jobAnswer(j), 'scanruler_wait'))
          return { ...answer, content: [...answer.content, ...(j.reply?.content ?? []).filter((x) => x.type === 'image')] }
        }
        if (!(await link.waitForPage(Math.max(0, until - Date.now())))) return text(status())
        if (args?.for === 'idle') {
          // The changes still running first — their answers are what idle
          // waits for — then the page's own work.
          for (const done of [...[...jobs.values()].filter((x) => x.state === 'running').map((x) => x.done), ...callsInFlight]) {
            let timer
            await Promise.race([done, new Promise((r) => (timer = setTimeout(r, Math.max(0, until - Date.now()))))])
            clearTimeout(timer)
          }
          const idle = (await pageIdle(until)) && runningJobs() === 0 && callsInFlight.size === 0
          // What finished since it was last said: each job once, a failed
          // one with its error.
          const finished = [...jobs.values()].filter((j) => j.state !== 'running' && !j.told)
          for (const j of finished) j.told = true
          // The state and what finished, not the whole status: an agent
          // waits for idle many times in a run.
          // Not idle: what the page is at, as it says it — a build's step
          // in play and how long it has run.
          const at = idle || !pageBusy ? {} : { ...(pageBusy.busy ? { busy: pageBusy.busy } : {}), ...(pageBusy.running ? { running: pageBusy.running, ...(pageBusy.runningMs != null ? { runningS: Math.round(pageBusy.runningMs / 1000) } : {}) } : {}) }
          return text({ connected: link.connected, state: idle ? 'idle' : 'running', ...at, finished: finished.map(finishedOut), ...(hiddenNow() ? { hidden: true } : {}), ...staleTools() })
        }
        return text(status())
      },
    },
  ]

  // A report beside the scan, written by this server: no grant of the
  // browser's to save a file, and nowhere but the scan's folder.
  if (!headless) {
    own.push({
      name: 'scanruler_write',
      title: 'Write a text file beside the scan',
      description: `Write a text file — a report, notes, a table of readings — next to the scan, as UTF-8: ${TEXT_KINDS.join(', ')} only, and only inside the folder this server last opened a scan or a project from (scan_open, project_load) or saved one into (saveTo), or a folder under it. A relative path is taken in that folder; an absolute one must lie in one of those folders, and a path may not climb out with "..". Hidden files and folders (a name starting with ".") and files other tools read as instructions or settings (CLAUDE.md, AGENTS.md, package.json …) are refused. A file already there is replaced. Returns its path and size in bytes. Refused while this server has opened no scan or project from a folder — then open the scan with scan_open first, or write the file yourself.`,
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', minLength: 1, description: `The file: a name in the scan’s folder ("report.md"), a path under it ("report/sigma.md"), or an absolute path in it — ${TEXT_KINDS.join(', ')}.` },
          text: { type: 'string', description: 'What the file holds, as text.' },
        },
        required: ['path', 'text'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
      call: async (args) => {
        try {
          return text(await writeText(args?.path, args?.text))
        } catch (e) {
          return failure(e)
        }
      },
    })
    own.push({
      name: 'scanruler_files',
      title: 'List the files beside the scan',
      description: `The files in the folder this server last opened a scan or a project from, or saved one into — kept when the server restarts — or in a folder under it (path): each file's name, size in bytes and kind (mesh, project, step, picture, drawing, text or other), newest first, and the folders in it. Where scanruler_write's reports and the files saved beside the scan are; up to ${FILES_LISTED} entries. Refused while no scan or project has been opened from a folder.`,
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', minLength: 1, description: 'A folder under the scan’s folder, relative to it or absolute; or one of the folders scanruler_status lists. Leave out for the scan’s folder.' },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      call: async (args) => {
        try {
          return text(await listFiles(args?.path))
        } catch (e) {
          return failure(e)
        }
      },
    })
    own.push({
      name: 'scanruler_read',
      title: 'Read a text file beside the scan',
      description: `A text file read part by part: ${TEXT_FILES.join(', ')}, in the folder this server last opened a scan or a project from, or saved one into, in a folder under it, or in one of the folders scanruler_status lists — or an answer too long to carry (truncated: true, file), wherever it was written. A relative path is taken in the first of those folders, and a path may not climb out with "..". Returns { text, offset, nextOffset, size }, in bytes of the file: nextOffset, when there, is where to read on from; without it the text reaches the file's end. An answer holds at most ${Math.round(answerCap / 1000)} k characters. Refused for any other kind of file, and, but for such an answer, while no scan or project has been opened from a folder.`,
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', minLength: 1, description: 'The file: a name in the scan’s folder, a path under it ("scanruler-work/report.json"), or an absolute path.' },
          offset: { type: 'integer', minimum: 0, description: 'Where to start, in bytes: the last answer’s nextOffset. The file’s start by default.' },
          limit: { type: 'integer', minimum: 1, description: 'The most bytes to read, a whole character at least; as many as an answer holds by default, and never more.' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      call: async (args) => {
        try {
          return text(await readText(args?.path, args?.offset, args?.limit))
        } catch (e) {
          return failure(e)
        }
      },
    })
  }

  /** scanruler_files' list — see its description. */
  const listFiles = async (path) => {
    const folders = knownFolders()
    if (folders.length === 0) {
      throw { code: 'invalid_state', message: 'This server has opened no scan or project from a folder, so it has none to list. Open the scan with scan_open (or a project with project_load) by its path first.' }
    }
    if (typeof path === 'string' && path.split(/[\\/]/).includes('..')) throw { code: 'invalid_input', message: 'path: ".." is not taken — give a folder in the scan’s folder or under it.' }
    const folder = typeof path === 'string' && path ? (isAbsolute(path) ? resolve(path) : resolve(folders[0], path)) : folders[0]
    const within = (f) => {
      const r = relative(f, folder)
      return r === '' || (!r.startsWith('..') && !isAbsolute(r))
    }
    if (!folders.some(within)) throw { code: 'invalid_input', message: `path: ${folder} is outside the folders a scan or a project was opened from — ${folders.join(', ')}.` }
    let entries
    try {
      entries = await readdir(folder, { withFileTypes: true })
    } catch (e) {
      throw { code: 'not_found', message: `${folder} could not be read: ${e?.code === 'ENOENT' ? 'there is no such folder' : (e?.message ?? String(e))}.` }
    }
    const files = []
    const subfolders = []
    for (const entry of entries) {
      if (entry.isDirectory()) subfolders.push(entry.name)
      else if (entry.isFile()) {
        const info = await stat(join(folder, entry.name)).catch(() => null)
        if (info) files.push({ name: entry.name, size: info.size, kind: fileKind(entry.name), modified: info.mtime.toISOString() })
      }
    }
    files.sort((a, b) => b.modified.localeCompare(a.modified))
    const listed = files.slice(0, FILES_LISTED)
    return {
      folder,
      files: listed,
      folders: subfolders.slice(0, FILES_LISTED),
      ...(files.length > listed.length ? { more: files.length - listed.length } : {}),
    }
  }

  /** scanruler_read's part of a text file, kept to the folders a scan or a
   *  project came from and the answers this copy wrote to a file — see its
   *  description. Cut on a character, and short enough that its answer, its
   *  JSON's escapes counted, stays within answerCap. */
  const readText = async (path, offset = 0, limit = answerCap) => {
    if (typeof path !== 'string' || path.length === 0) throw { code: 'invalid_input', message: 'path: give the file to read.' }
    if (!Number.isInteger(offset) || offset < 0) throw { code: 'invalid_input', message: 'offset: give a whole number of bytes, 0 or more — the last answer’s nextOffset.' }
    if (!Number.isInteger(limit) || limit < 1) throw { code: 'invalid_input', message: 'limit: give a whole number of bytes, 1 or more.' }
    if (fileKind(path) !== 'text') throw { code: 'invalid_input', message: `path: only ${TEXT_FILES.join(', ')} files are read, as text — not "${extname(path).toLowerCase() || 'no extension'}".` }
    if (path.split(/[\\/]/).includes('..')) throw { code: 'invalid_input', message: 'path: ".." is not taken — give a path in the scan’s folder or under it.' }
    const folders = knownFolders()
    const target = resolve(folders[0] ?? outDir, path)
    const inside = (folder) => {
      const r = relative(folder, target)
      return r !== '' && !r.startsWith('..') && !isAbsolute(r)
    }
    if (!spilled.has(target)) {
      if (folders.length === 0) throw { code: 'invalid_state', message: 'This server has opened no scan or project from a folder, so it has none to read from. Open the scan with scan_open (or a project with project_load) by its path first.' }
      if (!folders.some(inside)) throw { code: 'invalid_input', message: `path: ${target} is outside the folders a scan or a project was opened from — ${folders.join(', ')}.` }
    }
    const most = Math.min(limit, answerCap)
    let size
    let start
    let bytes
    let handle
    try {
      handle = await open(target, 'r')
      ;({ size } = await handle.stat())
      start = Math.min(offset, size)
      // Room to pass a character cut at the offset, and for a whole one after.
      const buffer = Buffer.alloc(Math.min(Math.max(4, most) + 3, size - start))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start)
      bytes = buffer.subarray(0, bytesRead)
    } catch (e) {
      throw { code: 'not_found', message: `${target} could not be read: ${e?.code === 'ENOENT' ? 'there is no such file' : (e?.message ?? String(e))}.` }
    } finally {
      await handle?.close()
    }
    // An offset in the middle of a character starts at the next one.
    for (let i = 0; i < 3 && start > 0 && (bytes[0] & 0xc0) === 0x80; i++) {
      bytes = bytes.subarray(1)
      start++
    }
    let chars
    try {
      // Nothing whole is a character the file itself ends inside: refused.
      const whole = wholeUtf8(bytes, most)
      chars = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(whole.length > 0 ? whole : bytes)
    } catch {
      throw { code: 'invalid_input', message: `path: ${target} does not read as UTF-8 text, so it may not be a text file.` }
    }
    // The most characters whose answer fits, a surrogate pair kept whole.
    const fits = (n) => agentJson({ text: chars.slice(0, n), offset: start, nextOffset: size, size }).length <= answerCap
    let count = chars.length
    if (!fits(count)) {
      let low = 0
      let high = count
      while (high - low > 1) {
        const mid = (low + high) >> 1
        if (fits(mid)) low = mid
        else high = mid
      }
      const last = chars.charCodeAt(low - 1)
      count = last >= 0xd800 && last < 0xdc00 ? low - 1 : low
    }
    const part = chars.slice(0, count)
    const next = start + Buffer.byteLength(part, 'utf8')
    return { text: part, offset: start, ...(next < size ? { nextOffset: next } : {}), size }
  }

  /** scanruler_write's file, kept to the folders a scan or a project came
   *  from — see its description. */
  const writeText = async (path, body) => {
    if (typeof path !== 'string' || path.length === 0) throw { code: 'invalid_input', message: 'path: give the file to write.' }
    if (typeof body !== 'string') throw { code: 'invalid_input', message: 'text: give what the file holds, as a string.' }
    const kind = extname(path).toLowerCase()
    if (!TEXT_KINDS.includes(kind)) throw { code: 'invalid_input', message: `path: only ${TEXT_KINDS.join(', ')} files are written — not "${kind || 'no extension'}".` }
    if (path.split(/[\\/]/).includes('..')) throw { code: 'invalid_input', message: 'path: ".." is not taken — give a path in the scan’s folder or under it.' }
    const folders = knownFolders()
    if (folders.length === 0) {
      throw { code: 'invalid_state', message: 'This server has opened no scan or project from a folder, so it has none to write into. Open the scan with scan_open (or a project with project_load) by its path first — its folder is where the file goes — or write the file yourself.' }
    }
    const target = isAbsolute(path) ? resolve(path) : resolve(folders[0], path)
    const inside = (folder) => {
      const r = relative(folder, target)
      return r !== '' && !r.startsWith('..') && !isAbsolute(r)
    }
    if (!folders.some(inside)) {
      throw { code: 'invalid_input', message: `path: ${target} is outside the folders a scan or a project was opened from — ${folders.join(', ')}. Give a path in one of them.` }
    }
    // A scan folder may sit inside a code project, where a hidden folder
    // (.claude, .github, .vscode) or an agent's instruction file is read as
    // settings or instructions by other tools later run there; those are
    // not written.
    if (folders.filter(inside).some((folder) => relative(folder, target).split(/[\\/]/).some((part) => part.startsWith('.')))) {
      throw { code: 'invalid_input', message: 'path: a hidden file or folder (a name starting with ".") is not written — give a plain name.' }
    }
    if (PROTECTED_NAMES.includes(basename(target).toLowerCase())) {
      throw { code: 'invalid_input', message: `path: ${basename(target)} is read by other tools as settings or instructions, so it is not written — give another name.` }
    }
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, body, 'utf8')
    return { path: target, size: Buffer.byteLength(body, 'utf8') }
  }

  // What the client was given at its last list: each tool's definition by
  // name, and the page the list came from.
  let listed = null
  let listedFrom = null
  const definition = ({ call: _call, ...tool }) => tool
  // Compact, the list is the server's own tools and the page's that return
  // a picture — a batch gives a picture as its text and a file, so those are called
  // directly; scanruler_tools reads commands() when it is called. With
  // namespaces, the server's own and the page's of the namespaces listed.
  const shown = (c) => (compact ? Boolean(c.returnsImage) : !leftOut(c))
  const listNow = () => [...own.map(definition), ...commands().filter(shown).map((c) => toolFor(c, { outDir, cwd }))]
  const listSource = () =>
    link.page?.commands?.length ? `the page, ScanRuler ${link.page.version ?? 'of no version'}` : lastPage ? lastPage.from : `this server’s own list (scanruler-mcp ${version})`

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // A tab that was paired before is likely open and on its way back: a
    // client that lists once, at its start, gets its list if it comes soon.
    if (!headless && !link.connected && lastPage && listWaitMs > 0) await link.waitForPage(listWaitMs)
    const tools = listNow()
    listed = new Map(tools.map((t) => [t.name, JSON.stringify(t)]))
    listedFrom = listSource()
    staleNamed = null
    trace?.write({ ev: 'list', t: trace.now(), tools: tools.length, bytes: Buffer.byteLength(JSON.stringify(tools), 'utf8') })
    return { tools }
  })

  /** How the tools now differ from those listed: added, removed, and
   *  changed — the same name, another input or description. Null when
   *  nothing was listed yet. */
  const listDiff = () => {
    if (!listed) return null
    const now = new Map(listNow().map((t) => [t.name, JSON.stringify(t)]))
    const added = [...now.keys()].filter((n) => !listed.has(n))
    const removed = [...listed.keys()].filter((n) => !now.has(n))
    const changed = [...now.keys()].filter((n) => listed.has(n) && listed.get(n) !== now.get(n))
    return { now: now.size, added, removed, changed, any: added.length + removed.length + changed.length > 0 }
  }

  // A page with other commands than were listed — plugins, another version,
  // a command whose input or description changed — has the client list them
  // again.
  const relist = () => {
    if (listDiff()?.any) server.sendToolListChanged().catch(() => {})
  }
  // A client told the list changed may not list it again — Claude Desktop
  // runs two copies of the server, and the chat's may keep the list it got
  // at its start: the status says so, with what was added, taken away and
  // changed, and which page the list came from — the names once for each
  // difference, counted in every answer after it.
  let staleNamed = null
  function staleTools() {
    const diff = listDiff()
    if (!diff?.any) return {}
    const key = JSON.stringify([diff.added, diff.removed, diff.changed])
    const named = staleNamed !== key
    staleNamed = key
    const names = (list) => (named ? list : list.length)
    return {
      tools: {
        stale: true,
        listed: listed.size,
        now: diff.now,
        ...(diff.added.length ? { added: names(diff.added) } : {}),
        ...(diff.removed.length ? { removed: names(diff.removed) } : {}),
        ...(diff.changed.length ? { changed: names(diff.changed) } : {}),
        listedFrom,
        note: named
          ? 'The tools this chat was given are not the ones the ScanRuler page offers now — it changed since they were listed, and the client did not list them again. A tool or field missing from them may be there now: start a new chat to get the current tools; meanwhile scanruler_batch runs any of the page’s tools by name, and a changed tool takes what the page’s command takes now.'
          : 'Still stale, as an earlier answer named them: scanruler_batch runs any of the page’s tools by name.',
      },
    }
  }
  // A namespace in --tools that none of the page's commands is in — a
  // typo, or a plugin the page lacks — said once per page, and again when
  // the page's commands change it.
  let unmatchedSaid = null
  const noteNamespaces = () => {
    if (!selection.named || !link.page?.commands?.length) return
    const have = new Set(link.page.commands.map(namespaceOf))
    const unmatched = [...selection.named].filter((ns) => !have.has(ns))
    const key = unmatched.join(',')
    if (key === unmatchedSaid) return
    unmatchedSaid = key
    if (unmatched.length === 0) return
    log(`--tools ${selection.text}: no tool of the ${headless ? 'engine' : 'page'} (ScanRuler ${link.page.version ?? 'of no version'}) is in ${unmatched.join(', ')}; its namespaces are ${[...have].sort().join(', ')}.`)
  }
  for (const event of ['connected', 'commands']) {
    link.on(event, () => {
      seePage(event === 'connected')
      remember()
      relist()
      noteNamespaces()
    })
  }
  seePage(true)
  noteNamespaces()

  /** One of the page's tools run on the page: the result as MCP content,
   *  or a failure. `batched`: a picture is written to a file — the call's
   *  path, or a new one in WORK_FOLDER in the scan's folder (workFolderNow),
   *  else in outDir — and
   *  given as its text, not shown. `job`:
   *  the job the call is part of, which the page keeps its outcome under.
   *  `deferred`: more changes follow straight after it (a batch with
   *  build: "end"), and the page may leave their rebuild to the last.
   *  A `{ "$file": path }` anywhere in the arguments is that file's JSON. */
  const runPageTool = async (name, given, onProgress, { timings = false, ms = false, batched = false, job, deferred = false } = {}) => {
    const command = commands().find((c) => toolName(c) === name)
    const needsPage = !command && headless ? link.pageCommand(name) : null
    if (needsPage) return failure({ code: 'unavailable', message: `${name} needs the ScanRuler page — a scan, the viewport or the browser — and this server runs ScanRuler headless, with none. Start scanruler-mcp in page mode (without --engine or --headless) and pair it with a ScanRuler tab for it.` })
    if (!command) return failure({ code: 'unknown_command', message: `There is no tool ${name}.` })
    if (leftOut(command)) {
      return failure({ code: 'unknown_command', message: `There is no tool ${name} here: this server was started with --tools ${selection.text}, which leaves the ${namespaceOf(command)}_ tools out. A server started with --tools full, or with a list that has ${namespaceOf(command)}, offers it.` })
    }
    if (!link.connected && !(await link.waitForPage(pageTimeoutMs))) {
      return failure({ code: 'unavailable', message: `No ScanRuler page is connected; scanruler_open opens one. ${connectHelp()}` })
    }
    try {
      // Every relative path in the call from one folder, taken before a
      // scan opened by it moves it.
      const base = pathBase()
      const args = await withFiles(given ?? {}, base)
      const { input, binaryKey, file } = await inputFor(command, args, { cwd: base })
      // A session kept before it is replaced: saved, then let go.
      const savedTo = replacesSession(command) && args?.saveTo !== undefined ? await saveSession(String(args.saveTo), job, base) : undefined
      if (savedTo !== undefined) input.discard = true
      const started = Date.now()
      let result = await link.run(command.name, input, binaryKey, onProgress, job, deferred)
      // The folder a scan or a project was opened from, for scanruler_write.
      if (binaryKey && replacesSession(command) && file) {
        rememberFolder(file)
        rememberProject(file)
      }
      // And the scan open now: this one's, or — replaced without a file —
      // none known.
      if (replacesSession(command)) openedFrom(binaryKey ? file : null, result)
      if (!command.readOnly && pageSeen) pageSeen.held = true
      if (savedTo !== undefined && result && typeof result === 'object' && !Array.isArray(result)) result = { ...result, savedTo }
      if (ms && result && typeof result === 'object' && !Array.isArray(result)) result = { ...result, ms: Date.now() - started }
      const image = command.returnsImage && !batched ? await imageContent(result, args, { cwd: base, outDir }) : null
      if (image) return { content: image }
      // Which steps a change's build played, and how long each took, only
      // for a batch asked for its timings.
      if (!timings && result?.steps?.played) {
        const { played: _played, ...steps } = result.steps
        result = { ...result, steps }
      }
      const saved = command.returnsImage && batched ? await batchedPicture(result, args, { cwd: base, outDir, folder: args?.path ? null : await workFolderNow() }) : await saveFileResult(result, args, { cwd: base, outDir })
      // A project saved to a file: the one a reloaded page is pointed to.
      if (saved?.file?.path) rememberProject(saved.file.path)
      if (saved?.holds && saved?.file?.path) {
        const lost = lostSinceLastSave(saved)
        if (lost) saved.warning = saved.warning ? `${saved.warning} ${lost}` : lost
      }
      return text(await fitted(saved, name, Boolean(command.exact), [], { cap: capOf(command), ...(lessOf(command) ? { less: lessOf(command) } : {}) }), Boolean(command.exact))
    } catch (e) {
      // A page older than its app, said once so: the status keeps it.
      if (e?.code === 'stale_page' && pageSeen) pageSeen.stale ??= typeof e.message === 'string' ? e.message : 'stale_page'
      return failure(e)
    }
  }

  /** What the last save from this server held and this one does not — the
   *  page was reset or reloaded between them, as its own memory cannot tell —
   *  in a sentence; null when nothing fell away. */
  let lastSave = null
  const lostSinceLastSave = ({ holds, aligned, file }) => {
    const was = lastSave
    lastSave = { holds, aligned, path: file.path }
    if (!was) return null
    const gone = Object.entries(was.holds).filter(([what, n]) => n > 0 && !(holds[what] > 0)).map(([what, n]) => `${n} ${what}`)
    const frame = was.aligned && !aligned
    if (gone.length === 0 && !frame) return null
    return `This file holds less than the last save (${was.path}): ${[...gone, ...(frame ? ['the alignment'] : [])].join(', ')} gone — the page was reset or reloaded between them, so it is no copy of that work${frame ? ', and coordinates from before no longer hold on the scan' : ''}.`
  }

  /** The session saved as a project file at `path` (a file, or a folder
   *  for its own name): where it went, or null when the session held
   *  nothing to save. Throws, saving nothing, when the save fails. */
  const saveSession = async (path, job, base = pathBase()) => {
    let result
    try {
      result = await link.run('project.save', {}, undefined, undefined, job)
    } catch (e) {
      if (/nothing to save/i.test(e?.message ?? '')) return null
      throw { code: e?.code ?? 'failed', message: `Nothing was replaced: the session could not be saved first — ${e?.message ?? String(e)}` }
    }
    const written = await saveFileResult(result, { path }, { cwd: base, outDir })
    if (!written?.file?.path) throw { code: 'failed', message: 'Nothing was replaced: project.save gave no file to save.' }
    rememberFolder(written.file.path)
    rememberProject(written.file.path)
    return written.file.path
  }

  // Several of the page's tools in one call — what cuts a run of twenty
  // scan_nearest calls to one round trip. Each answer is the tool's own; a
  // picture comes back as the text beside it, not as an image, and is
  // written to a file — the call's path, or a new one in WORK_FOLDER in the
  // folder the scan open now came from (workFolderNow), else in outDir —
  // which the text names.
  own.push({
    name: 'scanruler_batch',
    title: 'Run several ScanRuler tools',
    description:
      `Run several of the ScanRuler tools in one call, in order, each with its own arguments — a run of scan_nearest, element_fit or section_get calls, say. Returns results, one per call in order: { tool, ok, result } or { tool, ok: false, error: { code, message } }. The first refused stops the rest (stopped says which index, failed: { index, tool, error } which call) unless stopOnError is false. notes, when a call answered with the notes left for you, is the last call’s, repeated at the top. When the refused call is a change, then with rollback (the default) every change the batch made before it is undone, so the batch stands or falls whole: undone names the steps taken back, newest first, callsUndone counts the calls, and each of those answers ok: false and undone: true, its result kept as it was. Before anything runs, the names the calls would give new things (a command that says which of its fields name them, in one name space) are checked against each other: two alike — case and spaces at the ends aside — refuse the batch with nothing run, naming both calls; a name the session already has is the page’s to refuse. A refused read — section_get, scan_query, any tool that changes nothing — undoes nothing: what came before it stands (kept says so). A call refused busy is run again once the page is idle (retried: "busy" on its result). Each call that changes the session is still its own undo step. build: "end" builds a modelled part once for a run of changes to it — sketches edited one after another, say — rather than after each: every call but the last is sent deferred, and a change so sent answers before its rebuild (build: "held", its result and bodies the part as last built; a pick by index names a face of that part); the last call builds them all, and so does a read of the part, or any other kind of tool, met on the way. timings: true gives each call its ms and the batch total_ms, and a change\'s build the steps it played with their ms (result.steps.played). wait: false answers at once with { queued, job }, and so does a batch still running at the server’s answer limit (with after, its seconds); scanruler_wait { for: "job", job } gives the batch\'s answer. A { "$file": path } anywhere in a call’s arguments is that JSON file’s contents. ${relativeFrom(cwd)} A tool that returns a picture is not shown here: the picture is written to a file — its call’s path, or a new file in ${WORK_FOLDER} in the folder the scan open now was opened from (by scan_open or project_load with a path), else in ${outDir} — and its result gives that file.path (and file.folder, the ${WORK_FOLDER} folder); call the tool directly to see the picture. The server’s own tools (scanruler_status, _open, _wait, _batch, _write, _files, _read, _tools) cannot be batched.`,
    inputSchema: {
      type: 'object',
      properties: {
        calls: {
          type: 'array',
          minItems: 1,
          maxItems: 200,
          description: 'The calls, in order — or give file instead.',
          items: {
            type: 'object',
            properties: {
              tool: { type: 'string', minLength: 1, description: 'A tool’s name, as listed — scan_nearest, element_fit.' },
              arguments: { type: 'object', description: 'Its arguments, as the tool takes them; {} for none.' },
            },
            required: ['tool'],
            additionalProperties: false,
          },
        },
        file: { type: 'string', minLength: 1, description: `A JSON file of the calls, read here in place of calls: [{ tool, arguments }], or [{ name, input }] by the command's own name (scan.open), or either under "calls" or "steps". For a long run a script wrote, which then need not pass through the conversation. ${relativeFrom(cwd)}` },
        stopOnError: { type: 'boolean', description: 'Stop at the first refused call (the default), or run every call and report each.' },
        rollback: { type: 'boolean', description: 'When the batch stops at a refused change, undo what it changed before it (the default) — or leave those changes standing (false). A refused read undoes nothing either way.' },
        build: { type: 'string', enum: ['each', 'end'], description: 'each (the default): a change rebuilds the part before it answers. end: the changes build once, at the last call.' },
        timings: { type: 'boolean', description: 'Each call’s ms, the batch’s total_ms, and the steps a change’s build played with their ms.' },
        wait: waitIn,
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, openWorldHint: false },
    call: async (args, ctx) => {
      const given = callsGiven(args?.calls)
      if (given.error) return failure({ code: 'invalid_input', message: given.error })
      let calls = given.calls
      if (args?.file !== undefined) {
        if (calls.length > 0) return failure({ code: 'invalid_input', message: 'Give calls or file, not both.' })
        const read = await callsFromFile(String(args.file))
        if (read.error) return failure({ code: 'invalid_input', message: read.error })
        calls = read.calls
      }
      if (calls.length === 0) return failure({ code: 'invalid_input', message: 'calls: give at least one call (or a file of them).' })
      if (ctx) ctx.fields.calls = calls.length
      // Two calls naming new things alike would roll the batch back at the
      // second, over every good change before it: refused before any runs.
      const clash = nameClash(calls, (tool) => commands().find((c) => toolName(c) === tool))
      if (clash) return failure({ code: 'invalid_input', message: clash })
      const job = startJob('scanruler_batch', (id) => runBatch(calls, args, ctx, id), ctx, args?.wait === false)
      return args?.wait === false ? queuedReply(job) : answerFor(job, ctx)
    },
  })

  /** A batch's calls read from a JSON file — { tool, arguments } as the
   *  batch takes them, or { name, input } by the command's own name, a
   *  list or one under "calls" or "steps". */
  const callsFromFile = async (file) => {
    const path = absolute(file, pathBase())
    let data
    try {
      data = JSON.parse(await readFile(path, 'utf8'))
    } catch (e) {
      return { error: `file: ${path} could not be read as JSON (${e instanceof Error ? e.message : String(e)}).` }
    }
    const list = Array.isArray(data) ? data : Array.isArray(data?.calls) ? data.calls : Array.isArray(data?.steps) ? data.steps : null
    if (!list) return { error: `file: ${path} holds no list of calls — a list, or one under "calls" or "steps".` }
    const given = callsGiven(list.map((c) => (c && typeof c === 'object' && typeof c.name === 'string' && c.tool === undefined ? { tool: toolName({ name: c.name }), arguments: c.input ?? {} } : c)))
    if (given.error) return { error: `file: ${path}: ${given.error}` }
    const { calls } = given
    if (calls.some((c) => !c || typeof c !== 'object' || typeof c.tool !== 'string')) return { error: `file: every call in ${path} needs a tool (or a name).` }
    return { calls }
  }

  /** The batch's calls run in order — see scanruler_batch. `job` is the
   *  batch's, sent with each of its calls for the page to keep. */
  const runBatch = async (calls, args, ctx = null, job = undefined) => {
    const stopOnError = args?.stopOnError !== false
    const timings = args?.timings === true
    // Built at the end: every call but the last sent deferred.
    const atEnd = args?.build === 'end'
    let lastDeferred = false
    const commandOf = (tool) => commands().find((x) => toolName(x) === tool)
    const changes = (tool) => Boolean(commandOf(tool)) && !commandOf(tool).readOnly
    // Where the history stood, to go back to when a change is refused —
    // only when a call may change something, and a page that cannot mark
    // its history simply has its batch left as it went.
    let checkpoint = null
    if (args?.rollback !== false && stopOnError && calls.some((c) => changes(String(c?.tool ?? '')))) {
      checkpoint = await link
        .run('history.checkpoint', {}, undefined, undefined, job)
        .then((r) => r?.checkpoint ?? null)
        .catch(() => null)
    }
    const results = []
    let stopped
    let failed
    // A batch holding an exact answer (a plane's frame, say) keeps
    // every answer exact: the rounding is one pass over the whole.
    let exact = false
    const started = Date.now()
    const errorOf = (reply) => {
      const body = reply.content.find((x) => x.type === 'text')?.text ?? ''
      const m = /^([a-z_]+): ([\s\S]*)$/.exec(body)
      return m ? { code: m[1], message: m[2] } : { code: 'failed', message: body }
    }
    for (let i = 0; i < calls.length; i++) {
      const c = calls[i] ?? {}
      const tool = String(c.tool ?? '')
      const at = Date.now()
      const { wait: _wait, timings: _timings, ...callArgs } = c.arguments ?? {}
      const hiddenAt = hiddenNow()
      const deferred = atEnd && i < calls.length - 1
      lastDeferred = deferred
      const run = () => runPageTool(tool, callArgs, (line) => noteProgress(jobs.get(job), line, i), { timings, batched: true, job, deferred })
      let one = own.some((t) => t.name === tool) ? failure({ code: 'invalid_input', message: `${tool} is the server’s own and is not batched — call it on its own.` }) : await run()
      // Busy with something of the page's own — a map being worked out,
      // say: once it is idle, the call is run again, once.
      let retried
      if (one.isError && errorOf(one).code === 'busy' && commandOf(tool)) {
        await pageIdle(Date.now() + IDLE_WAIT_MS)
        one = await run()
        retried = 'busy'
      }
      if (ctx && trace) {
        trace.write({ ev: 'entry', call: ctx.call, index: i, t: at, tool, ms: Date.now() - at, in: jsonBytes(callArgs), ...replyMeasure(one), hidden: [hiddenAt, hiddenNow()], ...(retried ? { retried } : {}), ...(trace.args ? { args: callArgs, head: replyHead(one) } : {}) })
      }
      const ms = timings ? { ms: Date.now() - at } : {}
      const again = retried ? { retried } : {}
      if (!one.isError && commandOf(tool)?.exact) exact = true
      if (one.isError) {
        const error = errorOf(one)
        results.push({ tool, ok: false, error, ...again, ...ms })
        if (stopOnError) {
          stopped = i
          failed = { index: i, tool, error }
          break
        }
      } else {
        const body = one.content.find((x) => x.type === 'text')?.text ?? ''
        let parsed
        try {
          parsed = JSON.parse(body)
        } catch {
          parsed = body
        }
        results.push({ tool, ok: true, result: parsed, ...again, ...ms })
      }
    }
    // A refused change: what the batch did before it taken back, newest
    // first, once the page is idle — a rebuild still landing would refuse
    // the undo. A refused read leaves it standing.
    const rollback = Boolean(failed && checkpoint && changes(failed.tool))
    let undone
    let rollbackError
    if (rollback) {
      await pageIdle(Date.now() + IDLE_WAIT_MS)
      try {
        undone = (await link.run('history.restore', { checkpoint }, undefined, undefined, job))?.undone ?? []
      } catch (e) {
        rollbackError = `${e?.code ?? 'failed'}: ${e?.message ?? String(e)}`
      }
    }
    // Each change taken back says so: its result is what it did before the
    // rollback, which no longer stands.
    let callsUndone = 0
    if (rollback && undone !== undefined) {
      for (let i = 0; i < results.length - 1; i++) {
        const { tool, ok, ...rest } = results[i]
        if (!ok || !changes(tool)) continue
        results[i] = { tool, ok: false, undone: true, ...rest }
        callsUndone++
      }
    }
    // Stopped before its last call, a batch built at the end leaves no
    // rebuild held: the page, read for idle, builds what is.
    if (atEnd && lastDeferred && !rollback) await pageIdle(Date.now() + IDLE_WAIT_MS)
    const kept = failed && checkpoint && !rollback ? { kept: `${failed.tool} changes nothing, so its refusal undid nothing: what the batch changed before it stands.` } : {}
    // The notes for the agent as the last call that gave them said — its
    // result spilled to a file, from its brief — at the top: not left in
    // the middle of a long batch, and kept in the batch's own brief.
    const notes = results.reduce((last, r) => notesIn(r.result) ?? notesIn(r.result?.brief) ?? last, undefined)
    const answer = {
      results,
      ran: results.length,
      of: calls.length,
      ...(stopped !== undefined ? { stopped } : {}),
      ...(failed ? { failed, ...(rollback ? { undone: undone ?? [], callsUndone } : {}), ...kept, ...(rollbackError ? { rollbackError } : {}) } : {}),
      ...(notes !== undefined ? { notes } : {}),
      ...(timings ? { total_ms: Date.now() - started } : {}),
    }
    // Each call's result is capped already; many together may still be
    // past it — then the whole goes to a file, and the answer keeps how
    // the batch ended. A call that may answer longer (a guide) lets the
    // batch it is in answer as long.
    const cap = Math.max(...calls.map((c) => capOf(commandOf(String(c?.tool ?? '')))))
    return text(await fitted(answer, 'scanruler_batch', exact, ['failed', 'undone'], { cap }), exact)
  }

  // The page's tools for a client that does not list them: a line each,
  // or the definitions of some — each as the full list would give it.
  if (compact) {
    own.push({
      name: 'scanruler_tools',
      title: 'List the ScanRuler tools',
      description: `The ScanRuler tools, which this server lists one by one only when they return a picture. With no arguments: every tool’s name and what it does, a line each. With names: those tools’ full definitions — description and inputSchema — up to ${MAX_DEFINITIONS} at a time; read a tool’s before its first use. Run them with scanruler_batch, a single tool as a batch of one. Names it does not know come back in unknown. The list is the connected page’s, so it can change when a page connects.`,
      inputSchema: {
        type: 'object',
        properties: {
          names: {
            type: 'array',
            items: { type: 'string', minLength: 1 },
            maxItems: MAX_DEFINITIONS,
            description: 'Tool names, as the list gives them — element_fit, scan_nearest. Leave out for the list.',
          },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      call: async (args) => {
        const asked = typeof args?.names === 'string' ? args.names.split(/[\s,]+/) : Array.isArray(args?.names) ? args.names.map(String) : []
        const names = [...new Set(asked.filter(Boolean))]
        const list = commands()
        if (names.length === 0) {
          return text({
            count: list.length,
            tools: Object.fromEntries(list.map((c) => [toolName(c), summary(c)])),
            next: 'scanruler_tools with names gives a tool’s definition; scanruler_batch runs it.',
          })
        }
        if (names.length > MAX_DEFINITIONS) {
          return failure({ code: 'invalid_input', message: `names: at most ${MAX_DEFINITIONS} at a time — ask for the rest in another call.` })
        }
        const found = []
        const unknown = []
        for (const name of names) {
          const command = list.find((c) => toolName(c) === name)
          const mine = own.find((t) => t.name === name)
          if (command) found.push(toolFor(command, { outDir, cwd }))
          else if (mine) found.push(definition(mine))
          else unknown.push(name)
        }
        // Exact: a schema's numbers are limits and defaults, not readings.
        return text({ tools: found, unknown }, true)
      },
    })
  }

  // Each call traced as one line when it is answered — what the client
  // waited for — with the tab's hidden state at its start and end and the
  // jobs running when it came; a batch's entries and a queued job's end get
  // lines of their own.
  let callNo = 0
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    if (!trace) return withReload(await dispatch(request, extra, null))
    const { name, arguments: args } = request.params
    const ctx = { call: ++callNo, fields: {} }
    const t = trace.now()
    const hiddenAt = hiddenNow()
    const running = runningJobs()
    const reply = withReload(await dispatch(request, extra, ctx))
    trace.write({
      ev: 'call',
      call: ctx.call,
      t,
      tool: name,
      ms: trace.now() - t,
      in: jsonBytes(args ?? {}),
      ...replyMeasure(reply),
      hidden: [hiddenAt, hiddenNow()],
      ...(running ? { running } : {}),
      ...ctx.fields,
      ...(trace.args ? { args: args ?? {}, head: replyHead(reply) } : {}),
    })
    return reply
  })

  /** A tool call answered — see the handler above. */
  const dispatch = async (request, extra, ctx) => {
    const { name, arguments: args } = request.params
    const mine = own.find((t) => t.name === name)
    if (mine) return mine.call(args, ctx)
    // Progress lines from the page: kept on the call's job, for the status
    // and scanruler_wait to answer, and sent on to a client that asked for
    // them.
    const token = request.params._meta?.progressToken
    let step = 0
    let job = null
    const onProgress = (line) => {
      noteProgress(job, line)
      if (token !== undefined) extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: ++step, message: line } }).catch(() => {})
    }
    // A change runs as a job, and so does a long read: answered when done —
    // or with the job, at once for wait: false and at the answer limit
    // otherwise — and kept either way, for a client that stops waiting
    // before it is done.
    const command = commands().find((c) => toolName(c) === name)
    if (!command || (command.readOnly && !command.long)) {
      const answer = runPageTool(name, args, onProgress)
      callsInFlight.add(answer)
      return answer.finally(() => callsInFlight.delete(answer))
    }
    const { wait, timings, ...rest } = args ?? {}
    const timed = timings === true && !command.readOnly
    // Busy with something of the page's own, as a batch's calls are: once it
    // is idle, the call is run again, once.
    const runOnce = (id) => runPageTool(name, rest, onProgress, { timings: timed, ms: timed, job: id })
    job = startJob(
      name,
      async (id) => {
        const first = await runOnce(id)
        if (replyMeasure(first).error !== 'busy') return first
        await pageIdle(Date.now() + IDLE_WAIT_MS)
        return runOnce(id)
      },
      ctx,
      wait === false,
    )
    return wait === false ? queuedReply(job) : answerFor(job, ctx)
  }

  trace?.write({ ev: 'start', t: trace.now(), version, backend: headless ? 'headless' : 'page', tools: toolMode, pid: process.pid, args: trace.args })
  link.on?.('visibility', (hidden) => trace?.write({ ev: 'visibility', t: trace.now(), hidden }))

  return server
}
