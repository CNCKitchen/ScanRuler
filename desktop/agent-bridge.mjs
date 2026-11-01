// SPDX-License-Identifier: AGPL-3.0-only
// Entry of scanruler-mcp.cmd: joins the ScanRuler app that is open — its port and token are
// kept in agent.json beside its settings — then runs the agent server. Without the app
// open (no file), or with SCANRULER_MCP_TOKEN / _PORT set by hand, nothing changes.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const file = process.env.SCANRULER_AGENT_FILE ?? join(process.env.APPDATA ?? '', 'scanruler-desktop', 'agent.json')
try {
  const a = JSON.parse(readFileSync(file, 'utf8'))
  process.env.SCANRULER_MCP_TOKEN ||= a.token
  process.env.SCANRULER_MCP_PORT ||= String(a.port)
  // The app removes the file when it quits. Left running, this server would take the
  // app's port over and the next app could not start; so it leaves with the app.
  setInterval(() => {
    if (!existsSync(file)) process.exit(0)
  }, 2000)
} catch {}
await import(pathToFileURL(join(here, 'mcp/bin/scanruler-mcp.js')).href)
