// SPDX-License-Identifier: AGPL-3.0-only
// The call trace: one JSON line per tool call into a file of the session's
// own, for measuring a run afterwards — how long each call took, how much
// went each way, what was refused, and whether the tab was hidden. Off
// unless asked for (--trace <dir>, SCANRULER_MCP_TRACE); local only; an
// argument's contents, and the head of each answer, are written only with
// --trace-args, their sizes always.
// scripts/trace-summary.mjs reads the files.

import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/** Bytes of a value as JSON, UTF-8. */
export const jsonBytes = (value) => (value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value), 'utf8'))

/** What an MCP reply weighs: its text in UTF-8 bytes, a picture by its
 *  base64 — what the client is handed — and the error code of a refusal. */
export function replyMeasure(reply) {
  let out = 0
  let images = 0
  for (const c of reply?.content ?? []) {
    if (c.type === 'text') out += Buffer.byteLength(c.text ?? '', 'utf8')
    else if (c.type === 'image') {
      out += (c.data ?? '').length
      images++
    }
  }
  const text = reply?.content?.find((c) => c.type === 'text')?.text ?? ''
  const error = reply?.isError ? (/^([a-z_]+): /.exec(text)?.[1] ?? 'failed') : null
  return { out, error, ...(images ? { images } : {}) }
}

/** How much of an answer the trace keeps, characters. */
const HEAD_CHARS = 500

/** The start of a reply's text — a refusal's message, most often whole — for
 *  reading a run afterwards. */
export function replyHead(reply) {
  const text = reply?.content?.find((c) => c.type === 'text')?.text
  return typeof text === 'string' && text.length > 0 ? text.slice(0, HEAD_CHARS) : undefined
}

/** A trace into a new file in `dir`, or null when `dir` is empty. Each
 *  line is a JSON object with `ev`: "start" (the server), "list" (the tool
 *  list handed out), "call" (a tool call answered), "entry" (one call of a
 *  batch), "job" (a change started with wait: false, finished) and
 *  "visibility" (the tab hidden or shown). Times are ms since the epoch
 *  (`t`, the start) and durations ms. `secrets` are written as
 *  "[redacted]" wherever they appear — the pairing token, which the help on
 *  connecting gives in full: a trace is made to be shared. */
export function createTrace(dir, { args = false, now = () => Date.now(), pid = process.pid, secrets = [] } = {}) {
  if (!dir) return null
  mkdirSync(dir, { recursive: true })
  const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-').replace(/Z$/, '')
  const file = join(dir, `scanruler-mcp-${stamp}-${pid}.jsonl`)
  let broken = false
  const write = (line) => {
    if (broken) return
    try {
      let json = JSON.stringify(line)
      for (const secret of secrets) if (secret) json = json.split(secret).join('[redacted]')
      appendFileSync(file, `${json}\n`)
    } catch (e) {
      // A trace that cannot be written is not a reason to fail the call.
      broken = true
      process.stderr.write(`[scanruler-mcp] The trace stopped: ${e?.message ?? e}\n`)
    }
  }
  return { file, args, now, write }
}
