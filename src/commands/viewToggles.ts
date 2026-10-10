// SPDX-License-Identifier: AGPL-3.0-only
// What can be shown or put away in the 3D view for a picture or a look —
// the scan, the reference, the sections, the elements — by key, so that an
// agent can ask for the model on its own (view.set and view.render, their
// `show`). The app's own keys are defined with the view commands; a plugin
// adds its workspace's here, under its id, and may take over an app key
// while its workspace is on screen — the plugin that puts the scan away
// its own way says so with `applies`.

export interface ViewToggle {
  /** The key `show` names it by: `scan`, `sections`, a plugin's own. */
  key: string
  /** A few words on what it shows, for the commands' descriptions. */
  description: string
  /** Whether it is shown now. */
  shown(): boolean
  show(on: boolean): void
  /** Whether the toggle stands now — a plugin's while its workspace is on
   *  screen; always, when left out. */
  applies?(): boolean
}

const own = new Map<string, ViewToggle[]>()

/** A plugin's toggles, under its id. Called from the plugin's install();
 *  the returned function takes them out again. Two sets under one id throw. */
export function registerViewToggles(id: string, toggles: readonly ViewToggle[]): () => void {
  if (own.has(id)) throw new Error(`Two sets of view toggles share the id "${id}".`)
  const kept = [...toggles]
  own.set(id, kept)
  return () => {
    if (own.get(id) === kept) own.delete(id)
  }
}

/** The toggles standing now, by key: a plugin's that applies takes the key
 *  over the app's own, which `base` gives. */
export function viewToggles(base: readonly ViewToggle[]): Map<string, ViewToggle> {
  const out = new Map<string, ViewToggle>()
  for (const t of base) if (t.applies?.() ?? true) out.set(t.key, t)
  for (const list of own.values()) for (const t of list) if (t.applies?.() ?? true) out.set(t.key, t)
  return out
}

/** Every key a plugin has registered, applying or not — for the commands'
 *  descriptions. */
export function pluginToggleKeys(): { key: string; description: string }[] {
  return [...own.values()].flat().map((t) => ({ key: t.key, description: t.description }))
}
