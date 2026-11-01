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
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
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

/** Keep the last project, the folders as they were. */
export function saveLastProject(project, dir = configDir()) {
  writeKept(dir, { folders: loadFolders(dir) ?? [], project })
}

const writeKept = (dir, { folders, project }) => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'folders.json'), JSON.stringify({ saved: new Date().toISOString(), folders, ...(project ? { project } : {}) }) + '\n')
}

/** The stored config, with a token made and saved if there was none. */
export function loadConfig(dir = configDir()) {
  const file = join(dir, 'config.json')
  const hasToken = (c) => typeof c?.token === 'string' && c.token.length >= 16
  for (let attempt = 0; ; attempt++) {
    let config = {}
    let raw = null
    try {
      raw = readFileSync(file, 'utf8')
    } catch (e) {
      // On Windows a file another copy is linking in place can refuse to be
      // read for a moment (EBUSY, EPERM). That is no missing file: making a
      // token now would give this copy one that is not on disk, so it waits.
      if (e?.code !== 'ENOENT') {
        if (attempt >= 400) throw e
        sleepMs(25)
        continue
      }
    }
    if (raw !== null) {
      try {
        config = JSON.parse(raw)
      } catch {
        // A file that does not parse may be one another copy is writing
        // this moment; asked again shortly, it reads. One that still does
        // not is kept aside as config.json.bad, not silently replaced.
        if (attempt < 40) {
          sleepMs(25)
          continue
        }
        try {
          renameSync(file, `${file}.bad`)
        } catch {
          // Gone already: another copy dealt with it.
        }
        continue
      }
    }
    if (hasToken(config)) return { ...config, file }
    config = { ...config, token: newToken() }
    mkdirSync(dir, { recursive: true })
    const body = JSON.stringify(config, null, 2) + '\n'
    if (raw !== null) {
      // A config without a token: written whole through a temporary file,
      // so a reader never sees half of it.
      const part = `${file}.${process.pid}.part`
      writeFileSync(part, body, { mode: 0o600 })
      renameSync(part, file)
      return { ...config, file }
    }
    // The first run: the file is made whole and then linked in place,
    // which fails when another copy started at the same moment made it
    // first — then its token is the one read and used, not a second one.
    const part = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.part`
    writeFileSync(part, body, { mode: 0o600 })
    try {
      linkSync(part, file)
      return { ...config, file }
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e
    } finally {
      rmSync(part, { force: true })
    }
  }
}

/** Block this thread for `ms`: loadConfig runs once, at start-up. */
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
