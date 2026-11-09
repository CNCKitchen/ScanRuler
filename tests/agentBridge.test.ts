// SPDX-License-Identifier: AGPL-3.0-only
// The page's end of the agent link (commands/bridge.ts), on a socket of the
// test's own, against the headless session — the server's end is mcp/'s.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { serverTooOld, takePairingLink, useAgentLink, WANTS_SERVER } from '../src/commands/agentLink'
import { registerGuide } from '../src/commands/guides'
import { registerCommands, runCommand } from '../src/commands/registry'
import { isStaleImport, resetPageStale } from '../src/commands/stalePage'
import { CommandError } from '../src/commands/types'
import { BROWSER_ASKING, nothingAnswers, startBridge } from '../src/commands/bridge'
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

it('refuses binary paths that can change object prototypes', () => {
  const read = decoder(() => {})
  expect(() => read(JSON.stringify({ binary: '__proto__.polluted' }))).toThrow(/unsafe binary path/i)
  expect(() => read(JSON.stringify({ binary: 'constructor.prototype.polluted' }))).toThrow(/unsafe binary path/i)
  expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined()
})

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
    // The page's own name, kept while it lives, and when it loaded.
    const { pageId, since } = hello as unknown as { pageId: string; since: string }
    expect(pageId).toMatch(/\S{8,}/)
    expect(Number.isFinite(Date.parse(since))).toBe(true)
    expect(useAgentLink.getState().status).toBe('waiting')
    socket.say({ welcome: { server: 'scanruler-mcp', version: '0.4.0' } })
    expect(useAgentLink.getState().status).toBe('connected')
    expect(useAgentLink.getState().server).toEqual({ version: '0.4.0' })
  })

  it('tells an out of date server by its welcome: older than wanted, or a scanruler-mcp that gives no version', async () => {
    const welcomed = async (welcome: Record<string, unknown>) => {
      const socket = await connect()
      socket.say({ welcome })
      const server = useAgentLink.getState().server
      const tooOld = serverTooOld()
      const state = (await runCommand('session.state', {})) as { serverTooOld?: string }
      stop!()
      stop = null
      FakeSocket.made = []
      return { server, tooOld, inState: state.serverTooOld }
    }
    // Before 0.4.0 the welcome said what it was, but no version.
    const old = await welcomed({ server: 'scanruler-mcp' })
    expect(old.server).toEqual({ version: null })
    expect(old.tooOld).toMatch(/^Your ScanRuler connector is out of date: .*older than 0\.4\.0/)
    expect(old.tooOld).toContain('npx -y scanruler-mcp@latest')
    expect(old.tooOld).toContain('ask the agent to')
    expect(old.tooOld).toContain('quit the app completely and open it again')
    expect(old.inState).toBe(old.tooOld)
    const older = await welcomed({ server: 'scanruler-mcp', version: '0.3.9' })
    expect(older.tooOld).toMatch(/version 0\.3\.9, and this ScanRuler needs 0\.4\.0 or newer/)
    // Current and newer servers, and a welcome from something else, are not.
    for (const welcome of [{ server: 'scanruler-mcp', version: WANTS_SERVER }, { server: 'scanruler-mcp', version: '1.0.0' }, {}]) {
      const ok = await welcomed(welcome)
      expect(ok.tooOld).toBeNull()
      expect(ok.inState).toBeUndefined()
    }
    // Switched off, it is forgotten.
    expect(useAgentLink.getState().server).toBeNull()
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

  it('answers stale_page for a part of the app it can no longer load, and says so in the session from then on', async () => {
    // As the dev server answers a page that loaded before the guide was
    // edited: the import is turned down.
    const off = registerGuide({ id: 'edited-since', title: 'Edited since', when: 'testing a stale page', text: () => Promise.reject(new TypeError('Failed to fetch dynamically imported module: http://localhost:5173/guides/edited-since.md?raw&t=1761318480000')) })
    try {
      const socket = await connect()
      socket.say({ welcome: {} })
      expect(((await runCommand('session.state', {})) as { stale?: unknown }).stale).toBeUndefined()
      socket.say({ id: 1, method: 'run', name: 'guide.read', input: { topic: 'edited-since' } })
      const { error } = (await until(() => answerTo(socket, 1), 'guide.read')) as { error: { code: string; message: string } }
      expect(error.code).toBe('stale_page')
      expect(error.message).toMatch(/^This tab is older than the app it came from \(rebuilt since\) — save the project \(project_save\), then ask the person to reload/)
      expect(error.message).toContain('Failed to fetch dynamically imported module')
      const { stale } = (await runCommand('session.state', {})) as { stale?: { since: string; note: string } }
      expect(stale?.note).toMatch(/^this tab is older than the app/)
      expect(Number.isFinite(Date.parse(stale!.since))).toBe(true)
      // A refusal of the command's own is not one.
      expect(isStaleImport(new CommandError('failed', 'Failed to fetch dynamically imported module'))).toBe(false)
    } finally {
      off()
      resetPageStale()
    }
  })

  it('keeps a run sent under a job among the recent outcomes, which session.recent reads', async () => {
    const socket = await connect()
    socket.say({ welcome: {} })
    socket.say({ id: 1, method: 'run', name: 'session.state', input: {}, job: 'j1-bridge' })
    socket.say({ id: 2, method: 'run', name: 'element.fit', input: { kind: 'blob' }, job: 'j1-bridge' })
    socket.say({ id: 3, method: 'run', name: 'session.state', input: {} })
    await until(() => answerTo(socket, 3), 'the reads')
    await until(() => answerTo(socket, 2), 'the refusal')
    socket.say({ id: 4, method: 'run', name: 'session.recent', input: { job: 'j1-bridge' } })
    const { outcomes } = (await until(() => answerTo(socket, 4), 'session.recent')).result as { outcomes: { job: string; name: string; state: string; error?: { code: string } }[] }
    expect(outcomes.map((o) => [o.name, o.state])).toEqual([
      ['element.fit', 'failed'],
      ['session.state', 'done'],
    ])
    expect(outcomes[0].error?.code).toBe('invalid_input')
  })

  it('shows a refusal, and tries again after a lost connection', async () => {
    const socket = await connect()
    socket.say({ refused: 'The pairing token does not match.' })
    socket.close(4001)
    expect(useAgentLink.getState()).toEqual({ status: 'refused', detail: 'The pairing token does not match.', server: null })
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

  it('says nothing answers on the port while the hello fails, and how to start it', async () => {
    stop = startBridge({ port: 7400, token: 't', socket: (url) => new FakeSocket(url) as unknown as WebSocket, reach: async () => false })
    await until(() => useAgentLink.getState().detail, 'the reason')
    expect(useAgentLink.getState()).toMatchObject({ status: 'waiting', detail: nothingAnswers(7400) })
    expect(nothingAnswers(7400)).toContain('port 7400')
    expect(nothingAnswers(7400)).toContain('--pair')
    expect(nothingAnswers(7400)).toContain('--serve')
  })

  it('says it waits for the browser while the hello hangs, and stops saying so once it answers (issue 100)', async () => {
    let answer: ((ok: boolean) => void) | undefined
    stop = startBridge({
      port: 7400,
      token: 't',
      socket: (url) => new FakeSocket(url) as unknown as WebSocket,
      reach: () => new Promise((resolve) => (answer = resolve)),
      slowMs: 20,
    })
    await until(() => useAgentLink.getState().detail === BROWSER_ASKING, 'the browser question')
    expect(useAgentLink.getState().status).toBe('waiting')
    answer!(true)
    const socket = await until(() => FakeSocket.made[0], 'the socket')
    expect(useAgentLink.getState().detail).toBeNull()
    socket.open()
    socket.say({ welcome: { server: 'scanruler-mcp', version: '1.0.0' } })
    expect(useAgentLink.getState()).toMatchObject({ status: 'connected', detail: null })
  })

  it('takes a pairing link out of the address into the settings', () => {
    const replaced: string[] = []
    vi.stubGlobal('location', { hash: '#agent=7400:abcdEFGH_1234-xyz', pathname: '/', search: '?plugins=none' })
    vi.stubGlobal('history', { replaceState: (_s: unknown, _t: string, url: string) => replaced.push(url) })
    // Left stubbed: unstubbing every global would take the worker's `self`
    // away from the other tests in this file.
    expect(takePairingLink()).toBe(true)
    expect(usePrefs.getState()).toMatchObject({ agentPort: 7400, agentToken: 'abcdEFGH_1234-xyz' })
    expect(replaced).toEqual(['/?plugins=none'])
    vi.stubGlobal('location', { hash: '#view=top', pathname: '/', search: '' })
    expect(takePairingLink()).toBe(false)
  })

  it('stays off until the warning about the data is accepted, by a pairing link or by hand', () => {
    const fresh = { agentLink: false, agentDataOk: false, agentDataAsking: false }
    usePrefs.setState(fresh)

    vi.stubGlobal('location', { hash: '#agent=7400:abcdEFGH_1234-xyz', pathname: '/', search: '' })
    takePairingLink()
    expect(usePrefs.getState()).toMatchObject({ agentLink: false, agentDataAsking: true })
    usePrefs.getState().answerAgentData(false)
    expect(usePrefs.getState()).toMatchObject(fresh)

    // A "no" is not remembered: switching it on asks again.
    usePrefs.getState().setAgentLink(true)
    expect(usePrefs.getState()).toMatchObject({ agentLink: false, agentDataAsking: true })
    usePrefs.getState().answerAgentData(true)
    expect(usePrefs.getState()).toMatchObject({ agentLink: true, agentDataOk: true, agentDataAsking: false })

    // A "yes" is: off and on again does not ask.
    usePrefs.getState().setAgentLink(false)
    expect(usePrefs.getState()).toMatchObject({ agentLink: false, agentDataOk: true })
    usePrefs.getState().setAgentLink(true)
    expect(usePrefs.getState()).toMatchObject({ agentLink: true, agentDataAsking: false })
  })
  it('answers a command on the connection it came on, not on the one after', async () => {
    let finish!: () => void
    registerCommands('test', [{
      name: 'wait', title: 'Wait', description: 'Waits to be let go.', input: { type: 'object', properties: {} }, readOnly: true,
      run: () => new Promise((resolve) => (finish = () => resolve({ done: true }))),
    } as never])
    const first = await connect()
    first.say({ welcome: { server: 'scanruler-mcp', version: '0.5.0' } })
    first.say({ id: 3, method: 'run', name: 'test.wait', input: {} })
    await until(() => finish, 'the command to start')
    // The server stops; a new one — counting its ids from 1 again — takes the port.
    first.close(1006)
    const second = await until(() => FakeSocket.made[1], 'the page to reconnect')
    second.open()
    second.say({ welcome: { server: 'scanruler-mcp', version: '0.5.0' } })
    finish()
    await new Promise((r) => setTimeout(r, 20))
    expect(answerTo(second, 3)).toBeUndefined()
  })
})
