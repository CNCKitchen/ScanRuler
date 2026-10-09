// SPDX-License-Identifier: AGPL-3.0-only
// What the server keeps between runs: the pairing token the ScanRuler page
// has to present, made on the first run and kept in the user's config
// folder so it is pasted into ScanRuler's Settings once, not every time —
// and the commands the last page that connected had, so an agent that lists
// the tools once, before a page is back, still sees all of them.

import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Where the config lives: SCANRULER_MCP_CONFIG_DIR, or the platform's
 *  per-user config folder. */
export function configDir(env = process.env, platform = process.platform) {
  if (env.SCANRULER_MCP_CONFIG_DIR) return env.SCANRULER_MCP_CONFIG_DIR
  if (platform === 'win32') return join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'scanruler-mcp')
  if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'scanruler-mcp')
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'scanruler-mcp')
}

/** A new token: 24 random bytes, URL-safe — it travels in a link. */
export const newToken = () => randomBytes(24).toString('base64url')

/** The command list the last connected page sent, or null. */
export function loadRemembered(dir = configDir()) {
  try {
    const kept = JSON.parse(readFileSync(join(dir, 'tools.json'), 'utf8'))
    return Array.isArray(kept.commands) && kept.commands.length > 0 ? kept.commands : null
  } catch {
    return null
  }
}

/** Keep a page's command list for the next run. */
export function saveRemembered(commands, dir = configDir()) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'tools.json'), JSON.stringify({ saved: new Date().toISOString(), commands }) + '\n')
}

/** The stored config, with a token made and saved if there was none. */
export function loadConfig(dir = configDir()) {
  const file = join(dir, 'config.json')
  let config = {}
  if (existsSync(file)) {
    try {
      config = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      config = {}
    }
  }
  if (typeof config.token !== 'string' || config.token.length < 16) {
    config = { ...config, token: newToken() }
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
  }
  return { ...config, file }
}
