// SPDX-License-Identifier: AGPL-3.0-only
// What the server keeps between runs: the pairing token the ScanRuler page
// has to present, made on the first run and kept in the user's config
// folder so it is pasted into ScanRuler's Settings once, not every time —
// and the commands the last page that connected had, so an agent that lists
// the tools once, before a page is back, still sees all of them — and the
// folders the scans were opened from, where its files go. The command list
// carries the page's version: a server shipped with a newer list of its own
// lists that one (mcp.js).

import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
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
const newToken = () => randomBytes(24).toString('base64url')

/** The command list the last connected page sent, with the page's version
 *  and plugins and when it was kept — `{ commands, version, plugins, saved }`
 *  — or null. A list kept by a server before 0.4.0 has no version. */
export function loadRemembered(dir = configDir()) {
  try {
    const kept = JSON.parse(readFileSync(join(dir, 'tools.json'), 'utf8'))
    if (!Array.isArray(kept.commands) || kept.commands.length === 0) return null
    return {
      commands: kept.commands,
      version: typeof kept.version === 'string' ? kept.version : null,
      plugins: Array.isArray(kept.plugins) ? kept.plugins.map(String) : null,
      saved: typeof kept.saved === 'string' ? kept.saved : null,
    }
  } catch {
    return null
  }
}

/** Keep a page's command list for the next run: `{ commands, version,
 *  plugins }` — the page's version, for the next run to tell whether the
 *  list it was shipped with is newer — or the list alone. */
export function saveRemembered(kept, dir = configDir()) {
  const { commands, version = null, plugins = null } = Array.isArray(kept) ? { commands: kept } : kept
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'tools.json'), JSON.stringify({ saved: new Date().toISOString(), version, plugins, commands }) + '\n')
}

/** The folders scans and projects were opened from or saved into, the
 *  latest first, or null — kept beside the command list, so a copy started
 *  afresh still writes and lists where the last one did. */
export function loadFolders(dir = configDir()) {
  try {
    const kept = JSON.parse(readFileSync(join(dir, 'folders.json'), 'utf8'))
    return Array.isArray(kept.folders) && kept.folders.every((f) => typeof f === 'string') ? kept.folders : null
  } catch {
    return null
  }
}

/** Keep the folders for the next run, and for the other copies — the
 *  last project kept beside them as it was. */
export function saveFolders(folders, dir = configDir()) {
  writeKept(dir, { folders, project: loadLastProject(dir) })
}

/** The project file last opened or saved through a copy of this server,
 *  or null — kept with the folders: what a page that came back empty is
 *  pointed to. */
export function loadLastProject(dir = configDir()) {
  try {
    const kept = JSON.parse(readFileSync(join(dir, 'folders.json'), 'utf8'))
    return typeof kept.project === 'string' && kept.project ? kept.project : null
  } catch {
    return null
  }
}

/** Keep the last project, the folders as they were. A file there that
 *  cannot be read is left as it is, the project not kept: written over, the
 *  folders it held would be lost. */
export function saveLastProject(project, dir = configDir()) {
  const folders = loadFolders(dir)
  if (!folders && existsSync(join(dir, 'folders.json'))) return
  writeKept(dir, { folders: folders ?? [], project })
}

/** Written whole and renamed into place, as update.json is: another copy
 *  reading it meanwhile reads the old file or the new, never half of one. */
const writeKept = (dir, { folders, project }) => {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'folders.json')
  const part = `${file}.${process.pid}.part`
  writeFileSync(part, JSON.stringify({ saved: new Date().toISOString(), folders, ...(project ? { project } : {}) }) + '\n')
  renameSync(part, file)
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
