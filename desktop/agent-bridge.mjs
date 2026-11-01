// SPDX-License-Identifier: AGPL-3.0-only
// Entry of scanruler-mcp.cmd: joins the ScanRuler app that is open — its port and token are
// kept in agent.json beside its settings — then runs the agent server. Without the app
// open (no file), or with SCANRULER_MCP_TOKEN / _PORT set by hand, nothing changes.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
try {
  const a = JSON.parse(readFileSync(process.env.SCANRULER_AGENT_FILE ?? join(process.env.APPDATA ?? '', 'scanruler-desktop', 'agent.json'), 'utf8'))
  process.env.SCANRULER_MCP_TOKEN ||= a.token
  process.env.SCANRULER_MCP_PORT ||= String(a.port)
} catch {}
await import(pathToFileURL(join(here, 'mcp/bin/scanruler-mcp.js')).href)
