// SPDX-License-Identifier: AGPL-3.0-only
// The page's end of the agent link (commands/bridge.ts), on a socket of the
// test's own, against the headless session — the server's end is mcp/'s.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { takePairingLink, useAgentLink } from '../src/commands/agentLink'
import { startBridge } from '../src/commands/bridge'
import { decoder, encode, type Message } from '../src/commands/framing'
import { usePrefs } from '../src/state/prefsStore'
import { boxMesh } from './helpers'
import { startHeadless, stlBytes, type Headless } from './commandKit'

/** A WebSocket the test drives: it records what the page sends and plays
 *  the server's frames into it. */
class FakeSocket {
  static made: FakeSocket[] = []
  readyState = 0
  binaryType = 'blob'
  sent: (string | Uint8Array)[] = []
  onopen: ((e: unknown) => void) | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  onclose: ((e: { code: number }) => void) | null = null
  constructor(readonly url: string) {
    FakeSocket.made.push(this)
  }
  send(frame: string | Uint8Array) {
    this.sent.push(frame)
  }
  close(code = 1000) {
    if (this.readyState === 3) return
    this.readyState = 3
    this.onclose?.({ code })
  }
  open() {
    this.readyState = 1
    this.onopen?.({})
  }
  /** The server says something, bytes and all. */
  say(message: Message, binaryPath?: string) {
    for (const frame of encode(message, binaryPath)) {
      this.onmessage?.({ data: typeof frame === 'string' ? frame : frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) })
    }
  }
  /** Everything the page has sent, as messages. */
  messages(): Message[] {
    const out: Message[] = []
    const read = decoder((m) => out.push(m))
    for (const frame of this.sent) read(frame)
    return out
  }
}

/** The page's answer to request `id` — not its progress lines. */
const answerTo = (socket: FakeSocket, id: number) => socket.messages().find((m) => m.id === id && ('result' in m || 'error' in m))

const until = async <T>(read: () => T | undefined | null | false, what: string): Promise<T> => {
  for (let i = 0; i < 400; i++) {
    const v = read()
    if (v) return v
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`timed out waiting for ${what}`)
}

let headless: Headless
let stop: (() => void) | null = null
beforeAll(async () => {
  headless = await startHeadless()
})
afterAll(() => headless.stop())
afterEach(() => {
  stop?.()
  stop = null
  FakeSocket.made = []
})

const connect = async (reach: () => Promise<boolean> = async () => true) => {
  stop = startBridge({ port: 7400, token: 'the-token', socket: (url) => new FakeSocket(url) as unknown as WebSocket, reach })
  const socket = await until(() => FakeSocket.made[0], 'the socket')
  socket.open()
  return socket
}

describe('the agent bridge', () => {
  it('says hello with the token and the commands, and is connected once welcomed', async () => {
    const socket = await connect()
    expect(socket.url).toBe('ws://127.0.0.1:7400/')
    expect(socket.binaryType).toBe('arraybuffer')
    const hello = socket.messages()[0].hello as { app: string; token: string; commands: { name: string }[]; viewport: boolean }
    expect(hello).toMatchObject({ app: 'ScanRuler', token: 'the-token', viewport: false })
    expect(hello.commands.map((c) => c.name)).toContain('element.fit')
    expect(useAgentLink.getState().status).toBe('waiting')
    socket.say({ welcome: { server: 'scanruler-mcp' } })
    expect(useAgentLink.getState().status).toBe('connected')
  })

  it('runs what the server sends — bytes in, bytes out — and answers errors as codes', async () => {
    const socket = await connect()
    socket.say({ welcome: {} })
    socket.say({ id: 1, method: 'run', name: 'scan.open', input: { name: 'box.stl', bytes: stlBytes(boxMesh(40, 40)), discard: true } }, 'input.bytes')
    const opened = await until(() => answerTo(socket, 1), 'scan.open')
    expect((opened.result as { scan: { triangles: number } }).scan.triangles).toBe(19200)
    expect(socket.messages().some((m) => m.event === 'progress' && m.id === 1)).toBe(true)

    socket.say({ id: 2, method: 'run', name: 'element.fit', input: { kind: 'plane', at: { point: [0, 0, 20] } } })
    await until(() => answerTo(socket, 2), 'element.fit')
    socket.say({ id: 3, method: 'run', name: 'export.step', input: {} })
    await until(() => answerTo(socket, 3), 'export.step')
    const head = socket.sent.map((f) => (typeof f === 'string' ? (JSON.parse(f) as Message) : null)).find((m) => m?.id === 3 && 'result' in m)!
    expect(head.binary).toBe('result.file.bytes')
    const step = answerTo(socket, 3)!.result as { file: { name: string; bytes: Uint8Array } }
    expect(step.file.name).toBe('box-elements.step')
    expect(new TextDecoder().decode(step.file.bytes.subarray(0, 13))).toBe('ISO-10303-21;')

    socket.say({ id: 4, method: 'run', name: 'element.fit', input: { kind: 'blob' } })
    const refused = await until(() => answerTo(socket, 4), 'the refusal')
    expect((refused.error as { code: string }).code).toBe('invalid_input')
    socket.say({ id: 5, method: 'run', name: 'no.such', input: {} })
    expect((await until(() => answerTo(socket, 5), 'unknown')).error).toMatchObject({ code: 'unknown_command' })
    socket.say({ id: 6, method: 'list' })
    const list = await until(() => answerTo(socket, 6), 'the list')
    expect((list.result as unknown[]).length).toBeGreaterThan(40)
  })

  it('shows a refusal, and tries again after a lost connection', async () => {
    const socket = await connect()
    socket.say({ refused: 'The pairing token does not match.' })
    socket.close(4001)
    expect(useAgentLink.getState()).toEqual({ status: 'refused', detail: 'The pairing token does not match.' })
    stop!()
    expect(useAgentLink.getState().status).toBe('off')
    stop = null
  })

  it('does not open the socket while the server’s hello does not answer', async () => {
    let asked = 0
    stop = startBridge({ port: 7400, token: 't', socket: (url) => new FakeSocket(url) as unknown as WebSocket, reach: async () => (asked++, false) })
    await until(() => asked > 0, 'the hello')
    expect(FakeSocket.made).toHaveLength(0)
    expect(useAgentLink.getState().status).toBe('waiting')
  })

  it('takes a pairing link out of the address into the settings', () => {
    const replaced: string[] = []
    vi.stubGlobal('location', { hash: '#agent=7400:abcdEFGH_1234-xyz', pathname: '/', search: '?plugins=none' })
    vi.stubGlobal('history', { replaceState: (_s: unknown, _t: string, url: string) => replaced.push(url) })
    // Left stubbed: unstubbing every global would take the worker's `self`
    // away from the other tests in this file.
    expect(takePairingLink()).toBe(true)
    expect(usePrefs.getState()).toMatchObject({ agentLink: true, agentPort: 7400, agentToken: 'abcdEFGH_1234-xyz' })
    expect(replaced).toEqual(['/?plugins=none'])
    vi.stubGlobal('location', { hash: '#view=top', pathname: '/', search: '' })
    expect(takePairingLink()).toBe(false)
  })
})
