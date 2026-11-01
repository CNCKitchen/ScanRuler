// SPDX-License-Identifier: AGPL-3.0-only
// The page's commands as MCP tools. A command's name becomes the tool's,
// dots to underscores — element.fit is element_fit — and its JSON Schema
// passes through, but for files: a command that takes a file's bytes takes a
// path on this computer instead, and this server reads the file and streams
// it to the page; a command that hands a file back takes an optional path,
// and this server writes the file there. The agent never sees the bytes —
// but for a picture (a command marked returnsImage), which it is shown as an
// image, and which is written to a file only when it gives a path — or, in
// a batch, where it cannot be shown, always.

import { readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'

export const toolName = (command) => command.name.replace(/\./g, '_')

/** The input property that carries a file's bytes, if the command has one. */
export function bytesProperty(command) {
  const props = command.input?.properties ?? {}
  return Object.keys(props).find((key) => props[key]?.type === 'string' && props[key]?.format === 'binary') ?? null
}

/** Where a relative path is taken from, as every path field says it: the
 *  folder a scan or a project was last opened from or saved into — as
 *  scanruler_write and scanruler_files take it — else the folder the
 *  server started in (mcp.js, pathBase). */
export const relativeFrom = (cwd) =>
  `A relative path is taken from the folder of the scan or project last opened or saved (scanruler_status: server.relativeTo) — before any, from ${cwd ?? 'the folder this server started in'}.`

const inPath = (cwd) => ({
  type: 'string',
  minLength: 1,
  description: `The file to read, on this computer: an absolute path, or a relative one. ${relativeFrom(cwd)}`,
})

const outPath = (outDir, cwd) => ({
  type: 'string',
  minLength: 1,
  description: `Where to write the file: a file path — one there already is replaced — or a folder (one there, or a path ending in /) to write it into under the name ScanRuler gives it, numbered past a file of that name there (-2, -3 …). Without it, it goes into ${outDir} the same way. ${relativeFrom(cwd)}`,
})

const imagePath = (outDir, cwd) => ({
  type: 'string',
  minLength: 1,
  description: `Also write the picture to a file: a file path — one there already is replaced — or a folder (one there, or a path ending in /) to write it into under the name ScanRuler gives it, numbered past a picture of that name there (-2, -3 …). Without it, it is only shown — but in scanruler_batch, which shows no picture, it is written under a new name into the folder of the scan or project last opened or saved (the latest of scanruler_status folders), before any into ${outDir}. ${relativeFrom(cwd)}`,
})

/** The `saveTo` a command that replaces the session takes — one with
 *  `discard`: the session saved as a project file first (mcp.js). */
const saveToIn = (cwd) => ({
  type: 'string',
  minLength: 1,
  description: `Save the session as a .scanruler project file here first — a file path, or a folder to save it into under its own name — then go on as with discard: true. If the save fails nothing is replaced. The answer says where it went (savedTo). ${relativeFrom(cwd)}`,
})

/** Whether a command replaces the session, refusing to over work unless
 *  told `discard` — what `saveTo` is offered on. */
export const replacesSession = (command) => command.input?.properties?.discard?.type === 'boolean'

const inlineIn = {
  type: 'boolean',
  description: 'false, with path: the picture is written to the file and not shown — the answer says where. A picture costs far more context than its text; save the ones you only deliver.',
}

/** How many significant digits a number keeps in an answer, and the finest
 *  step it is given to: six digits is a micrometre on a part under a metre
 *  and a millionth of a unit vector; past them the page's doubles are
 *  noise the agent pays for — 0.9483828176573491 in place of 0.948383. */
const DIGITS = 6
const STEP = 1e6

const tidy = (v) => {
  const r = Number(v.toPrecision(DIGITS))
  return Math.abs(r) < 9e9 ? Math.round(r * STEP) / STEP || 0 : r
}

/** An answer as the agent reads it: JSON, every number that is not whole
 *  kept to DIGITS significant digits and no finer than a millionth — 1e-17,
 *  a zero's rounding error, is 0. Whole numbers — ids, indices, counts —
 *  are as they were. An `exact` answer is one whose numbers are handed
 *  back as inputs — a plane's frame, say — and keeps every digit:
 *  shortened, what is built on them is a hair off what it was meant to
 *  meet. */
export const agentJson = (value, exact = false) =>
  exact ? JSON.stringify(value) : JSON.stringify(value, (_key, v) => (typeof v === 'number' && Number.isFinite(v) && !Number.isInteger(v) ? tidy(v) : v))

/** A command as the MCP tool an agent sees. */
/** The `wait` a tool that changes the session takes, and a long read
 *  (Command.long): the server runs every such call as a job (mcp.js), and
 *  false answers with the job at once. */
export const waitIn = {
  type: 'boolean',
  description: 'false: answer { queued: true, job } at once and run on; scanruler_wait { for: "job", job } gives the answer. true, the default: answer when done — or queued all the same past the server’s answer limit.',
}

/** The `timings` a tool that changes the session takes: the server keeps
 *  what the page's answer carries of the build's steps (mcp.js). */
export const timingsIn = {
  type: 'boolean',
  description: 'true: the answer adds ms and, where the change built, steps.played — each step with its ms.',
}

export function toolFor(command, { outDir, cwd }) {
  const input = structuredClone(command.input ?? { type: 'object' })
  input.properties = { ...(input.properties ?? {}) }
  let required = [...(input.required ?? [])]
  const bytesKey = bytesProperty(command)
  let description = command.description
  if (bytesKey) {
    delete input.properties[bytesKey]
    const pick = FOLDER_PICKS[command.name]
    const read = inPath(cwd)
    input.properties.path = pick ? { ...read, description: `${read.description} A folder opens the one ${pick.what} file in it (${pick.kinds.join(', ')}); with more than one, the answer lists them.` } : read
    required = required.filter((key) => key !== bytesKey && key !== 'name')
    if (!required.includes('path')) required.unshift('path')
    if (input.properties.name) {
      input.properties.name = { ...input.properties.name, description: `${input.properties.name.description ?? ''} Defaults to the file's own name.`.trim() }
    }
    description += ' The file is read from `path` on this computer and streamed to the page.'
  }
  if (command.returnsImage) {
    input.properties.path = imagePath(outDir, cwd)
    input.properties.inline = inlineIn
    description += ' The picture comes back as an image; with `path` it is written to a file too, and with `inline: false` only there.'
  } else if (command.returnsFile) {
    input.properties.path = outPath(outDir, cwd)
    description += ' The file is written to `path`; the result says where and how large it is, not its bytes.'
  }
  if (replacesSession(command)) {
    input.properties.saveTo = saveToIn(cwd)
    description += ' With `saveTo`, the session is saved as a project file there first (as project_save does), then replaced as with discard: true — one call to keep what a page holds and start anew.'
  }
  if (!command.readOnly) {
    input.properties.wait = waitIn
    input.properties.timings = timingsIn
  } else if (command.long) {
    // A long read runs as a job too (mcp.js), so it takes wait.
    input.properties.wait = waitIn
  }
  if (required.length) input.required = required
  else delete input.required
  return {
    name: toolName(command),
    title: command.title,
    description,
    inputSchema: input,
    annotations: { title: command.title, readOnlyHint: Boolean(command.readOnly) && (!command.returnsFile || Boolean(command.returnsImage)), openWorldHint: false },
  }
}

/** A path as the agent gave it, made absolute against `base`. */
export const absolute = (path, base) => (isAbsolute(path) ? path : resolve(base, path))

/** What a folder given in place of a file opens, by command: the one file
 *  of its kind in it. Other commands take a file only. */
const FOLDER_PICKS = {
  'scan.open': { what: 'mesh', kinds: ['.stl', '.ply', '.obj', '.3mf'] },
  'project.load': { what: 'project', kinds: ['.scanruler'] },
}

/** The file a path names: itself, or — for a folder, where the command
 *  takes one (FOLDER_PICKS) — the only file of the command's kind in it.
 *  Refused with the folder's files listed otherwise. */
async function fileAt(command, file) {
  const found = await stat(file).catch(() => null)
  if (!found?.isDirectory()) return file
  const names = (await readdir(file, { withFileTypes: true })).filter((d) => d.isFile()).map((d) => d.name)
  const listed = (list) => (list.length > 20 ? `${list.slice(0, 20).join(', ')} and ${list.length - 20} more` : list.join(', '))
  const pick = FOLDER_PICKS[command.name]
  if (!pick) throw { code: 'invalid_input', message: `path: ${file} is a folder — give a file${names.length ? ` in it: ${listed(names)}` : ''}.` }
  const matches = names.filter((n) => pick.kinds.includes(extname(n).toLowerCase()))
  if (matches.length === 1) return join(file, matches[0])
  if (matches.length === 0) {
    throw { code: 'invalid_input', message: `path: ${file} is a folder with no ${pick.what} file in it (${pick.kinds.join(', ')})${names.length ? ` — it holds ${listed(names)}` : ' — it is empty'}. Give the file’s path.` }
  }
  throw { code: 'invalid_input', message: `path: ${file} is a folder with ${matches.length} ${pick.what} files — give one of them by its path: ${listed(matches)}.` }
}

/** How many near names a missing path's refusal lists at most, and how many
 *  letters off a near name may be. */
const NEAR_LISTED = 5
const NEAR_LETTERS = 2

/** A name as nearNames compares it: case ignored, and "-", "_" and a
 *  space taken alike. */
const nearForm = (name) => name.toLowerCase().replace(/[-_ ]/g, '_')

/** How many letters `a` and `b` are apart — added, taken out or changed —
 *  or `most + 1` once past `most`. */
function lettersApart(a, b, most) {
  if (Math.abs(a.length - b.length) > most) return most + 1
  let row = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const next = [i]
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    if (Math.min(...next) > most) return most + 1
    row = next
  }
  return row[b.length]
}

/** Where a path that is not there may have been meant: the first folder up
 *  from it that is there, the name in the path missing from it, and up to
 *  NEAR_LISTED names in that folder at most NEAR_LETTERS letters off it — a typed
 *  path's slip, "10_scooter_head" for "10_scooterHead". A near folder is
 *  given with the rest of the path when that is in it. */
export async function nearNames(path) {
  let missing = resolve(path)
  let folder = dirname(missing)
  let rest = []
  for (;;) {
    if ((await stat(folder).catch(() => null))?.isDirectory()) break
    if (dirname(folder) === folder) return { folder: null, missing: null, near: [] }
    rest = [basename(missing), ...rest]
    missing = folder
    folder = dirname(folder)
  }
  const want = nearForm(basename(missing))
  const names = await readdir(folder).catch(() => [])
  const near = names
    .map((name) => ({ name, apart: lettersApart(nearForm(name), want, NEAR_LETTERS) }))
    .filter((n) => n.apart <= NEAR_LETTERS)
    .sort((a, b) => a.apart - b.apart || a.name.localeCompare(b.name))
    .slice(0, NEAR_LISTED)
  const paths = []
  for (const { name } of near) {
    const whole = join(folder, name, ...rest)
    paths.push(rest.length && (await stat(whole).catch(() => null)) ? whole : join(folder, name))
  }
  return { folder, missing: basename(missing), near: paths }
}

/** nearNames as a refusal's last sentence. */
async function nearNote(path) {
  const { folder, missing, near } = await nearNames(path)
  if (!folder) return ''
  if (near.length) return ` Near it: ${near.join(', ')}.`
  return ` ${folder} is there, with nothing in it named like ${missing}.`
}

/** The tool call's arguments as the command's input: a path read into the
 *  bytes it names. Returns the input, the input field the bytes go in, and
 *  the file read — a folder's one file, when the path named a folder. */
export async function inputFor(command, args, { cwd }) {
  const input = { ...(args ?? {}) }
  delete input.saveTo
  const bytesKey = bytesProperty(command)
  if (bytesKey) {
    const file = await fileAt(command, absolute(String(input.path ?? ''), cwd))
    delete input.path
    let bytes
    try {
      bytes = new Uint8Array(await readFile(file))
    } catch (e) {
      if (e.code !== 'ENOENT') throw { code: 'invalid_input', message: `Could not read ${file}: ${e.message}.` }
      throw { code: 'invalid_input', message: `Could not read ${file}: there is no such file.${await nearNote(file)}` }
    }
    input[bytesKey] = bytes
    if (command.input?.properties?.name && input.name === undefined) input.name = basename(file)
    return { input, binaryKey: bytesKey, file }
  }
  if (command.returnsFile || command.returnsImage) delete input.path
  if (command.returnsImage) delete input.inline
  return { input, binaryKey: null, file: null }
}

/** Arguments with every `{ "$file": path }` in them — an object of that one
 *  key, at any depth — replaced by the JSON the file holds: a long list of
 *  stations a script wrote need not pass through the conversation. A
 *  relative path is taken from `cwd` — the folder the server takes
 *  relative paths from (mcp.js, pathBase). What a file holds is not looked
 *  into again. */
export async function withFiles(value, cwd) {
  if (Array.isArray(value)) return Promise.all(value.map((v) => withFiles(v, cwd)))
  if (!value || typeof value !== 'object' || value instanceof Uint8Array) return value
  const keys = Object.keys(value)
  if (keys.length === 1 && keys[0] === '$file') {
    if (typeof value.$file !== 'string' || !value.$file) throw { code: 'invalid_input', message: '$file: give the path of a JSON file.' }
    const path = absolute(value.$file, cwd)
    try {
      return JSON.parse(await readFile(path, 'utf8'))
    } catch (e) {
      throw { code: 'invalid_input', message: `$file: ${path} could not be read as JSON (${e?.code === 'ENOENT' ? 'there is no such file' : e instanceof Error ? e.message : String(e)}).` }
    }
  }
  const out = {}
  for (const key of keys) out[key] = await withFiles(value[key], cwd)
  return out
}

/** A file's kind by its extension, as scanruler_files lists it. */
const KINDS = {
  mesh: ['.stl', '.ply', '.obj', '.3mf', '.off'],
  project: ['.scanruler'],
  step: ['.step', '.stp'],
  picture: ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'],
  drawing: ['.dxf', '.svg', '.pdf'],
  text: ['.md', '.txt', '.csv', '.json', '.jsonl'],
}
/** The extensions of the files scanruler_read reads. */
export const TEXT_FILES = KINDS.text
export const fileKind = (name) => {
  const ext = extname(name).toLowerCase()
  return Object.keys(KINDS).find((kind) => KINDS[kind].includes(ext)) ?? 'other'
}

/** How many bytes the UTF-8 character that starts with `byte` takes. */
const utf8Length = (byte) => (byte < 0x80 ? 1 : byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : 2)

/** The start of UTF-8 `bytes` up to `most` of them, ending on a character's
 *  end — the first character at least, when they hold it whole. */
export function wholeUtf8(bytes, most = bytes.length) {
  const cut = bytes.subarray(0, Math.max(most, utf8Length(bytes[0])))
  for (let back = 1; back <= Math.min(4, cut.length); back++) {
    const byte = cut[cut.length - back]
    if ((byte & 0xc0) === 0x80) continue
    return utf8Length(byte) > back ? cut.subarray(0, cut.length - back) : cut
  }
  return cut
}

/** A picture a command handed back, as MCP content: the image, and the rest
 *  of the result as text — where the picture was written, if the call gave
 *  a path, in place of its bytes; written and not shown with `inline:
 *  false`. Null for a result with no picture in it. */
export async function imageContent(result, args, { cwd, outDir }) {
  const file = result?.file
  if (!file || !(file.bytes instanceof Uint8Array) || !String(file.mimeType ?? '').startsWith('image/')) return null
  const saved = args?.path ? await saveFileResult(result, args, { cwd, outDir }) : { ...result, file: { name: file.name, mimeType: file.mimeType, size: file.bytes.byteLength } }
  if (args?.path && args?.inline === false) return [{ type: 'text', text: agentJson(saved) }]
  return [
    { type: 'text', text: agentJson(saved) },
    { type: 'image', data: Buffer.from(file.bytes.buffer, file.bytes.byteOffset, file.bytes.byteLength).toString('base64'), mimeType: file.mimeType },
  ]
}

/** How many numbered names writeNew tries before it gives up. */
const NUMBERED_MOST = 10_000

/** `data` written to a new file in `folder` under `name` — or, a file of
 *  that name being there, as `stem-2.ext`, `stem-3.ext` …: each is made
 *  with `wx`, which refuses one that is there, so two written at once —
 *  pictures rendered side by side, answers spilled together — never take
 *  the same name, and nothing earlier is written over. Returns its path. */
export async function writeNew(folder, name, data) {
  await mkdir(folder, { recursive: true })
  const dot = name.lastIndexOf('.')
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
  for (let n = 1; n <= NUMBERED_MOST; n++) {
    const target = join(folder, n === 1 ? name : `${stem}-${n}${ext}`)
    try {
      await writeFile(target, data, { flag: 'wx' })
      return target
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e
    }
  }
  throw { code: 'failed', message: `${folder} already holds ${NUMBERED_MOST} files named like ${name}: give a path to write it to.` }
}

/** A picture a batched call handed back, which a batch cannot show:
 *  written where the call asked, or into `folder` — the server's work
 *  folder in the one the scan came from, which a sandboxed agent can open,
 *  made when it is not there — else, or when that folder takes no file,
 *  into `outDir`; as saveFileResult writes any file, numbered past one
 *  already there, so a batch of renders, or a render from an earlier
 *  batch, is not written over. The result says where, in place of the
 *  bytes — written into `folder`, that folder too (file.folder). */
export async function batchedPicture(result, args, { cwd, outDir, folder }) {
  if (args?.path || !folder) return saveFileResult(result, args, { cwd, outDir })
  try {
    const saved = await saveFileResult(result, args, { cwd, outDir: folder })
    return saved?.file?.path ? { ...saved, file: { ...saved.file, folder } } : saved
  } catch {
    return saveFileResult(result, args, { cwd, outDir })
  }
}

/** A name the page gave a file, made one this computer's file system takes
 *  as a plain file name. A colon on Windows would write the bytes to a
 *  hidden stream and leave an empty file, and a device name such as CON
 *  is no file at all, so reserved characters become `_` and a device name
 *  is prefixed with one. */
export const safeFileName = (name) => {
  const plain = String(name).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '') || 'file'
  return /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(plain) ? `_${plain}` : plain
}

/** Write a returned file where the call asked, or into `outDir`; the result
 *  then says where, in place of the bytes. A file path given is written,
 *  over one there; a folder — one there, or a path ending in a separator —
 *  or `outDir` takes the name ScanRuler gave the file, numbered past one
 *  already there (writeNew). */
export async function saveFileResult(result, args, { cwd, outDir }) {
  const file = result?.file
  if (!file || !(file.bytes instanceof Uint8Array)) return result
  const name = safeFileName(String(file.name ?? 'file').split(/[\\/]/).pop())
  const given = args?.path ? absolute(String(args.path), cwd) : null
  const folder = given === null ? outDir : /[\\/]$/.test(String(args.path)) || (await stat(given).catch(() => null))?.isDirectory() ? given : null
  let target
  if (folder !== null) target = await writeNew(folder, name, file.bytes)
  else {
    target = given
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, file.bytes)
  }
  return { ...result, file: { name: file.name, mimeType: file.mimeType, size: file.bytes.byteLength, path: target } }
}
