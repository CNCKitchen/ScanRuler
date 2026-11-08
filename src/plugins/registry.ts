// SPDX-License-Identifier: AGPL-3.0-only
// Where the app finds its plugins: every plugins/<id>/plugin.ts, by a glob
// that matches whichever a build has, so it stands with any of them or none.
// This is the one place outside plugins/ allowed to name the folder (see
// scripts/check-plugin-boundary.mjs).
//
// A plugin found is not yet a plugin in use: installPlugins() asks
// pluginEnabled() of each and installs only those it allows — registering
// their workspaces, their share of the project file, the undo history and
// the rest. Everything else in the app reads the installed list.

import type { ScanRulerPlugin } from './api'

const found = import.meta.glob<{ default: ScanRulerPlugin }>('/plugins/*/plugin.ts', { eager: true })

/** Where the beta workspaces switched on in Settings are remembered: a JSON
 *  list of plugin ids, or `all` — what the browser checks set, so every
 *  workspace in the build is checked whatever it is called. */
const BETA_KEY = 'scanruler.beta'

const storedBeta = (): string[] | 'all' => {
  try {
    const v = localStorage.getItem(BETA_KEY)
    if (v === 'all') return 'all'
    const ids: unknown = v ? JSON.parse(v) : []
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []
  } catch {
    // Storage blocked or unreadable, or no browser at all: none switched on.
    return []
  }
}

/** Whether a beta plugin is switched on in this browser. */
export function betaOn(id: string): boolean {
  const on = storedBeta()
  return on === 'all' || on.includes(id)
}

/** Switch a beta plugin on or off in this browser — from the next start of
 *  the app, since what a plugin installs is installed once. */
export function setBetaOn(id: string, on: boolean): void {
  const stored = storedBeta()
  const ids = (stored === 'all' ? betaPlugins().map((p) => p.id) : stored).filter((x) => x !== id)
  try {
    localStorage.setItem(BETA_KEY, JSON.stringify(on ? [...ids, id] : ids))
  } catch {
    // Not remembered: the choice cannot outlive the reload that applies it.
  }
}

/** The beta plugins in the build, whether switched on or not — what
 *  Settings offers. */
export function betaPlugins(): ScanRulerPlugin[] {
  return Object.values(found)
    .map((m) => m.default)
    .filter((p) => p.beta)
    .sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * Whether a plugin found in the build is to be used. Every one is, but a
 * beta one only once switched on in Settings; this is where a licence or a
 * sign-in will decide it. For a look at the app without any,
 * `?plugins=none` in the address leaves them all out.
 */
export function pluginEnabled(plugin: ScanRulerPlugin): boolean {
  const query = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('plugins')
  if (query === 'none') return false
  return !plugin.beta || betaOn(plugin.id)
}

let installed: readonly ScanRulerPlugin[] | null = null

/** Install every enabled plugin, once, in a fixed order — by id, so what a
 *  plugin registers never depends on the order the bundler found it in. */
export function installPlugins(): readonly ScanRulerPlugin[] {
  if (installed) return installed
  installed = installEnabled(Object.values(found).map((m) => m.default))
  return installed
}

/** Install those of `all` that are enabled, by id, and return the ones that
 *  installed. Only enabled plugins are checked for a shared id, so
 *  `?plugins=none` still opens an app whose build has a clash. A plugin
 *  whose install() throws is left out of the list, so nothing — the
 *  headless engine included — takes it for one in use. */
export function installEnabled(all: readonly ScanRulerPlugin[]): readonly ScanRulerPlugin[] {
  const enabled = all.filter(pluginEnabled).sort((a, b) => a.id.localeCompare(b.id))
  const ids = new Set<string>()
  for (const p of enabled) {
    if (ids.has(p.id)) throw new Error(`Two plugins share the id "${p.id}".`)
    ids.add(p.id)
  }
  const done: ScanRulerPlugin[] = []
  for (const p of enabled) {
    try {
      p.install?.()
      done.push(p)
    } catch (error) {
      console.error(`The plugin "${p.id}" could not be installed.`, error)
    }
  }
  return done
}

/** The plugins in use — none until installPlugins() has run. */
export function plugins(): readonly ScanRulerPlugin[] {
  return installed ?? []
}
