// SPDX-License-Identifier: AGPL-3.0-only
// Where the app finds its plugins: every plugins/<id>/plugin.ts, by a glob
// that matches nothing when the folder is absent. That is how the
// open-source tree builds — it has no plugins/ at all — and it is the one
// place outside plugins/ allowed to name the folder (see
// scripts/check-plugin-boundary.mjs).
//
// A plugin found is not yet a plugin in use: installPlugins() asks
// pluginEnabled() of each and installs only those it allows — registering
// their workspaces, their share of the project file, the undo history and
// the rest. Everything else in the app reads the installed list.

import type { ScanRulerPlugin } from './api'

const found = import.meta.glob<{ default: ScanRulerPlugin }>('/plugins/*/plugin.ts', { eager: true })

/**
 * Whether a plugin found in the build is to be used. Every one is, for now;
 * this is where a licence or a sign-in will decide it. For a look at the
 * app as the open-source build has it, `?plugins=none` in the address
 * leaves them all out.
 */
export function pluginEnabled(plugin: ScanRulerPlugin): boolean {
  void plugin
  const query = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('plugins')
  return query !== 'none'
}

let installed: readonly ScanRulerPlugin[] | null = null

/** Install every enabled plugin, once, in a fixed order — by id, so what a
 *  plugin registers never depends on the order the bundler found it in. */
export function installPlugins(): readonly ScanRulerPlugin[] {
  if (installed) return installed
  const all = Object.values(found)
    .map((m) => m.default)
    .sort((a, b) => a.id.localeCompare(b.id))
  const ids = new Set<string>()
  for (const p of all) {
    if (ids.has(p.id)) throw new Error(`Two plugins share the id "${p.id}".`)
    ids.add(p.id)
  }
  installed = all.filter(pluginEnabled)
  for (const p of installed) p.install?.()
  return installed
}

/** The plugins in use — none until installPlugins() has run. */
export function plugins(): readonly ScanRulerPlugin[] {
  return installed ?? []
}
