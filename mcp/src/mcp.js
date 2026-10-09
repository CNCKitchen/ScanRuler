// SPDX-License-Identifier: AGPL-3.0-only
// The MCP side: the tools an agent lists and calls. Each of the page's
// commands is a tool (tools.js); two more are this server's own —
// scanruler_status, to see whether a ScanRuler page is connected and how to
// connect one, and scanruler_wait, to wait for it or for it to be idle.

import { readFileSync } from 'node:fs'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { imageContent, inputFor, saveFileResult, toolFor, toolName } from './tools.js'

/** The app's own commands as of this release, so the tools are there before
 *  a page connects — unless a page has connected before, whose list was
 *  kept (`remembered`); a connected page's own list replaces either, its
 *  plugins' commands included. Kept in step by the app's tests
 *  (tests/mcpCommands.test.ts). */
export const SNAPSHOT = JSON.parse(readFileSync(new URL('./commands.json', import.meta.url), 'utf8'))

export const INSTRUCTIONS = [
  'These tools drive ScanRuler, a measuring app for 3D scans, in the browser tab the user has open: the user watches every step in the viewport and can undo it there.',
  'Start with scanruler_status. If no ScanRuler page is connected, it says how the user connects one; tell them, then call scanruler_wait.',
  'Read session_state before acting and after: the scan’s bounding box says where the part lies, the elements and dimensions what is measured. Lengths are millimetres, angles degrees.',
  'A place on the scan is { point: [x, y, z] } (the nearest scan vertex is taken) or { vertex: n }. To fit a feature, aim at its middle, not at an edge.',
  'Every tool that changes the session is one step of the undo history; history_undo takes the last back. report_get gives the report as JSON (format "json") or as the text the panel copies (format "text").',
  'view_render shows you the 3D view as a picture; view_set turns it to a standard view or fits it.',
].join(' ')

const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 1) }] })
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
 * }} options
 */
export function createMcpServer({ link, version, cwd, outDir, connectHelp, serverInfo, pageTimeoutMs = 15_000, remembered = null }) {
  const server = new Server(
    { name: 'scanruler', title: 'ScanRuler', version },
    { capabilities: { tools: { listChanged: true } }, instructions: INSTRUCTIONS },
  )

  // The last connected page's commands, for listing before a page is back:
  // a client that lists the tools once — at its start, before the tab has
  // reconnected — and does not list them again when told they changed
  // still sees every tool the tab offers.
  let lastPage = remembered?.load() ?? null
  const commands = () => (link.page?.commands?.length ? link.page.commands : lastPage ?? SNAPSHOT)
  const remember = () => {
    const list = link.page?.commands
    if (!list?.length) return
    lastPage = list
    try {
      remembered?.save(list)
    } catch {
      // Not kept: the next run lists the app's own until the page is back.
    }
  }

  const status = () => ({
    connected: link.connected,
    page: link.page
      ? {
          app: link.page.app,
          version: link.page.version,
          origin: link.page.origin,
          plugins: link.page.plugins ?? [],
          viewport: link.page.viewport ?? null,
          commands: link.page.commands.length,
        }
      : null,
    server: serverInfo(),
    ...(link.connected ? {} : { howToConnect: connectHelp() }),
  })

  const own = [
    {
      name: 'scanruler_status',
      title: 'ScanRuler connection status',
      description: 'Whether a ScanRuler page is connected to this agent, which version and plugins it has, and — when none is — how the user connects one.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
      call: async () => text(status()),
    },
    {
      name: 'scanruler_wait',
      title: 'Wait for ScanRuler',
      description: 'Wait until a ScanRuler page is connected (for: "page", the default), or until it is also done with what it is busy with (for: "idle"). Returns the status; connected is false if the time ran out.',
      inputSchema: {
        type: 'object',
        properties: {
          for: { type: 'string', enum: ['page', 'idle'], description: 'page (the default) or idle.' },
          timeoutSeconds: { type: 'number', exclusiveMinimum: 0, maximum: 600, description: 'How long to wait at most, seconds — 120 by default.' },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      call: async (args) => {
        const until = Date.now() + 1000 * (args?.timeoutSeconds ?? 120)
        if (!(await link.waitForPage(Math.max(0, until - Date.now())))) return text(status())
        if (args?.for === 'idle') {
          while (Date.now() < until) {
            const state = await link.run('session.state', {}).catch(() => null)
            if (state && state.busy === null && state.running === null) break
            await new Promise((r) => setTimeout(r, 500))
          }
        }
        return text(status())
      },
    },
  ]

  let listed = ''
  const listNow = () => [...own.map(({ call: _call, ...tool }) => tool), ...commands().map((c) => toolFor(c, { outDir }))]

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = listNow()
    listed = JSON.stringify(tools)
    return { tools }
  })

  // A page with other commands than were listed — plugins, another version,
  // a command whose input or description changed — has the client list them
  // again.
  const relist = () => {
    if (!listed) return
    if (JSON.stringify(listNow()) !== listed) server.sendToolListChanged().catch(() => {})
  }
  for (const event of ['connected', 'commands']) {
    link.on(event, () => {
      remember()
      relist()
    })
  }

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params
    const mine = own.find((t) => t.name === name)
    if (mine) return mine.call(args)
    const command = commands().find((c) => toolName(c) === name)
    if (!command) return failure({ code: 'unknown_command', message: `There is no tool ${name}.` })
    if (!link.connected && !(await link.waitForPage(pageTimeoutMs))) {
      return failure({ code: 'unavailable', message: `No ScanRuler page is connected. ${connectHelp()}` })
    }
    // Progress lines from the page, for a client that asked for them.
    const token = request.params._meta?.progressToken
    let step = 0
    const onProgress =
      token === undefined
        ? undefined
        : (line) => {
            extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: ++step, message: line } }).catch(() => {})
          }
    try {
      const { input, binaryKey } = await inputFor(command, args, { cwd })
      const result = await link.run(command.name, input, binaryKey, onProgress)
      const image = command.returnsImage ? await imageContent(result, args, { cwd, outDir }) : null
      if (image) return { content: image }
      return text(await saveFileResult(result, args, { cwd, outDir }))
    } catch (e) {
      return failure(e)
    }
  })

  return server
}
