// SPDX-License-Identifier: AGPL-3.0-only
// A stand-in for the ScanRuler page, for the tests: it connects as the page's
// bridge does, says hello with a command list, and answers runs from a table.
import WebSocket from 'ws'
import { decoder, encode } from '../src/framing.js'
import { SNAPSHOT } from '../src/mcp.js'

/** Connect to `port`; resolves once the server has answered the hello —
 *  with `{ page, welcome }` or `{ page, refused, code }`. `answer(name,
 *  input, progress)` makes each result, `progress(text)` sending a progress
 *  line before it; a thrown `{ code, message }` is the error. */
export function fakePage(port, { token, origin = 'https://scanruler.com', commands = SNAPSHOT, answer = () => ({}) } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { origin })
    const page = { ws, runs: [], close: () => ws.close() }
    let greeted = false
    const read = decoder(async (message) => {
      if (!greeted) {
        greeted = true
        if (message.welcome) resolve({ page, welcome: message.welcome })
        else ws.once('close', (code) => resolve({ page, refused: message.refused, code }))
        return
      }
      if (message.method !== 'run') return
      page.runs.push(message)
      try {
        const progress = (text) => ws.send(JSON.stringify({ event: 'progress', id: message.id, text }))
        const result = await answer(message.name, message.input, progress)
        const binary = result?.file?.bytes instanceof Uint8Array ? 'result.file.bytes' : undefined
        for (const frame of encode({ id: message.id, result }, binary)) ws.send(frame)
      } catch (e) {
        ws.send(JSON.stringify({ id: message.id, error: { code: e.code ?? 'failed', message: e.message ?? String(e) } }))
      }
    })
    ws.on('message', (data, isBinary) => read(isBinary ? new Uint8Array(data) : data.toString('utf8')))
    ws.on('open', () => ws.send(JSON.stringify({ hello: { app: 'ScanRuler', version: '0.0.0-test', token, commands, plugins: [], viewport: true } })))
    ws.on('unexpected-response', (_req, res) => resolve({ page, refused: `HTTP ${res.statusCode}`, code: res.statusCode }))
    ws.on('error', (e) => {
      if (!greeted) reject(e)
    })
  })
}
