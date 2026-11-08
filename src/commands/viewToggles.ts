// SPDX-License-Identifier: AGPL-3.0-only
// What can be shown or put away in the 3D view for a picture or a look —
// the scan, the reference, the sections, the elements — by key, so that an
// agent can ask for the model on its own (view.set and view.render, their
// `show`). The app's own keys are defined with the view commands; a plugin
// adds its workspace's here, under its id, and may take over an app key
// while its workspace is on screen — the plugin that puts the scan away
// its own way says so with `applies` — and may say why one of its own is
// off (`why`), for a picture that comes out without it.
import { withoutHistory } from '../state/historyStore'


export interface ViewToggle {
  /** The key `show` names it by: `scan`, `sections`, a plugin's own. */
  key: string
  /** A few words on what it shows, for the commands' descriptions. */
  description: string
  /** Whether it is shown now. */
  shown(): boolean
  show(on: boolean): void
  /** The state behind `shown`, as it is kept — where `show(shown())` would
   *  not put it back as it was (shown reads several switches as one) —
   *  for a picture to restore after it; `shown()` when left out. */
  save?(): unknown
  /** What `save` took, put back; `show` when left out. */
  restore?(saved: unknown): void
  /** Whether the toggle stands now — a plugin's while its workspace is on
   *  screen; always, when left out. */
  applies?(): boolean
  /** Why it is not shown, read while it is not — what put it away, or
   *  that there is nothing of it to show — and what shows it, in a few
   *  words, for a picture's answer (`<key>Why`); null, or left out, for
   *  nothing to say. */
  why?(): string | null
  /** What showing it takes past the stage's next frames — a reading a worker
   *  does — awaited by a picture that asks for it, `ms` at most. Never
   *  rejects: the picture goes on without it, and says so. */
  settle?(ms: number): Promise<unknown>
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

/** What a set of toggles was before `show` set them, to put back. */
export interface ShowApplied {
  /** Put every toggle set back as it was, the last set first. */
  putBack(): void
  /** Whether any was set. */
  changed: boolean
  /** The keys asked to be put away that are not on screen now — a
   *  workspace's own, elsewhere: nothing to put away, so nothing done. */
  absent: string[]
}

/**
 * Set the toggles `show` asks for, by key, saving each one's state first
 * (`save`, else `shown`) so that `putBack` restores what was there rather
 * than what `shown` read. A key not standing now is no error when it is
 * put away (false) and a workspace has it: there is nothing of it on
 * screen, and it is answered as absent. Asked to show, or unknown
 * anywhere, it is refused — before anything is set; a toggle that throws
 * puts back what was set before it.
 */
export function applyShow(all: ReadonlyMap<string, ViewToggle>, show: Record<string, boolean> | undefined, refuse: (message: string) => Error): ShowApplied {
  const absent: string[] = []
  const asked: [ViewToggle, boolean][] = []
  for (const [key, on] of Object.entries(show ?? {})) {
    if (typeof on !== 'boolean') throw refuse(`show.${key}: expected true or false`)
    const t = all.get(key)
    if (t) {
      asked.push([t, on])
      continue
    }
    const known = [...all.keys()].join(', ')
    const elsewhere = pluginToggleKeys().find((p) => p.key === key)
    if (elsewhere && !on) absent.push(key)
    else throw refuse(elsewhere ? `show.${key}: not on screen in this workspace — it is ${elsewhere.description}; the keys standing now are ${known}.` : `show.${key}: no such key — there are ${known}.`)
  }
  const done: [ViewToggle, unknown][] = []
  // Each put back whatever another does; the first failure said after.
  // What is shown is no step of the history, set or put back: view.set and
  // view.render are read-only, and a step would clear the redo stack.
  const putBack = () => withoutHistory(() => {
    let failed: unknown = null
    for (const [t, saved] of [...done].reverse()) {
      try {
        if (t.restore) t.restore(saved)
        else t.show(saved as boolean)
      } catch (e) {
        failed ??= e
      }
    }
    if (failed) throw failed
  })
  try {
    withoutHistory(() => {
      for (const [t, on] of asked) {
        done.push([t, t.save ? t.save() : t.shown()])
        t.show(on)
      }
    })
  } catch (e) {
    try {
      putBack()
    } catch {
      // The toggle's own failure is the one to say.
    }
    throw e
  }
  return { putBack, changed: done.length > 0, absent }
}

/** Wait for what `show` asks to be shown and takes its time (`settle`), `ms`
 *  in all. */
export async function settleShown(all: ReadonlyMap<string, ViewToggle>, show: Record<string, boolean> | undefined, ms: number): Promise<void> {
  const until = Date.now() + ms
  for (const [key, on] of Object.entries(show ?? {})) if (on) await all.get(key)?.settle?.(Math.max(0, until - Date.now()))
}

/** Why each toggle that is not shown now is not, as `<key>Why`, for those
 *  that say (`why`) — not a key `show` put away itself, which was asked
 *  for. A picture with none of something in it says why, rather than
 *  looking like one of what is there. */
export function whyNotShown(all: ReadonlyMap<string, ViewToggle>, show: Record<string, boolean> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, t] of all) {
    if (!t.why || show?.[key] === false || t.shown()) continue
    const why = t.why()
    if (why) out[`${key}Why`] = why
  }
  return out
}

/** Every key a plugin has registered, applying or not — for the commands'
 *  descriptions. */
export function pluginToggleKeys(): { key: string; description: string }[] {
  return [...own.values()].flat().map((t) => ({ key: t.key, description: t.description }))
}
