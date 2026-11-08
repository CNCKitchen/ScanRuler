// SPDX-License-Identifier: AGPL-3.0-only
// What the app's own commands share: the guards that keep a command from
// running over work open in the panel, waiting for the stores to settle, and
// files in and out.

import type { BuiltFile } from '../../app/exports'
import { holdsWords, projectUnsaved, sessionHolds, sessionIsDirty } from '../../app/project'
import { dimHolds } from '../../state/historyStore'
import { useShell, type Workspace } from '../../state/shellStore'
import { draftHolds, useStore } from '../../state/store'
import { useFlat, flatDraftHolds } from '../../state/flatStore'
import { bool, str, type JsonSchema } from '../schema'
import { CommandError, type FileOut } from '../types'
import { watchSession } from '../activity'

/**
 * Refuse while something open in the 3D Measure panel holds work the command
 * would throw away: an element being made or edited with picks or a marking
 * on it, a dimension with a slot filled, an alignment or a section being set
 * up. A box merely in hand — the empty one Create leaves for the next — is
 * no work, and the command closes it.
 */
export function requireMeasureFree(): void {
  const s = useStore.getState()
  const open: string[] = []
  if (draftHolds(s.draft)) open.push(s.draft!.editId !== undefined ? 'an element being edited' : `a ${s.draft!.kind} being made`)
  if (dimHolds(s.dimDraft)) open.push('a dimension being set up')
  if (s.alignDraft) open.push('the alignment being set up')
  if (s.scaleDraft) open.push('the Scale part box')
  if (s.sectionDraft) open.push('a section being made')
  if (open.length) {
    throw new CommandError(
      'invalid_state',
      `The 3D Measure panel has ${open.join(' and ')} — finish or cancel it there first, or ask the person at the screen to.`,
    )
  }
}

/** The same for the 2D Measure panel. */
export function requireFlatFree(): void {
  const f = useFlat.getState()
  const open: string[] = []
  if (flatDraftHolds(f.draft)) open.push('an element being made')
  if (dimHolds(f.dimDraft)) open.push('a dimension being set up')
  if (f.tool.kind !== 'none') open.push(`the ${f.tool.kind} tool in hand`)
  if (open.length) {
    throw new CommandError('invalid_state', `The 2D Measure panel has ${open.join(' and ')} — finish or cancel it there first.`)
  }
}

/** Put a workspace on screen, so the person sees what the command does. */
export function showWorkspace(w: Workspace): void {
  if (useShell.getState().workspace !== w) useShell.getState().setWorkspace(w)
}

/** Refuse the input: the message says what is wrong with it. */
export const invalid = (text: string): never => {
  throw new CommandError('invalid_input', text)
}

/** Whatever a refused or failed step left in the error toast, or a fallback. */
export const lastError = (fallback: string): string => useStore.getState().errorText ?? fallback

/** The `discard` switch commands that replace the session take. */
export const discardSchema: JsonSchema = bool(
  'true: replace the session though it holds measurements (lost unless saved as a project first). Refused otherwise when there is work to lose.',
)

/** Refuse to replace a session holding work unless told to — naming the
 *  work, the project it is in and whether it is saved, so whoever is told
 *  can tell their own work from someone else's. */
export function requireDiscardable(discard: boolean | undefined, what: string): void {
  if (discard || !sessionIsDirty()) return
  const held = holdsWords(sessionHolds())
  const list = held.length > 1 ? `${held.slice(0, -1).join(', ')} and ${held.at(-1)}` : (held[0] ?? 'work')
  const name = useStore.getState().projectName
  const unsaved = projectUnsaved()
  const project = name ? ` in the project “${name}”` : ''
  const saved = unsaved === true ? ', with changes not saved,' : unsaved === false ? ', all of it saved,' : ''
  throw new CommandError(
    'invalid_state',
    `The session holds ${list}${project}${saved} that ${what} would replace. Save it with project.save first, or pass discard: true to let it go.`,
  )
}

/** A file's name, which says what it is. */
export const fileNameSchema = (examples: string): JsonSchema =>
  str(`The file's name with its extension — ${examples}.`, { minLength: 1 })

/** Bytes handed in, as the File the panels' inputs give. */
export const fileOf = (bytes: Uint8Array, name: string): File => new File([bytes as BlobPart], name)

/** A built export as a command result. */
export function fileResult(built: BuiltFile): { file: FileOut; status: string } {
  return { file: { name: built.name, mimeType: built.mimeType, bytes: built.bytes }, status: built.status }
}

/**
 * Wait until `read` gives something truthy, checking as the stores change
 * and on a timer besides — for what the app settles on its own after a
 * command's step: a fit landing, a map measured, a cut taken.
 */
export function waitFor<T>(read: () => T | null | undefined | false, what: string, timeoutMs = 120_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    let timer: ReturnType<typeof setTimeout> | undefined
    let done = false
    // Looked at again whenever a store changes — the worker's answers land
    // in them, and a hidden tab's browser does not hold those back — and on
    // a timer besides, for what no store says.
    const unwatch = watchSession(() => check())
    const finish = (then: () => void) => {
      done = true
      clearTimeout(timer)
      unwatch()
      then()
    }
    const check = () => {
      if (done) return
      let value: T | null | undefined | false
      try {
        value = read()
      } catch (e) {
        finish(() => reject(e))
        return
      }
      if (value) {
        const found = value
        finish(() => resolve(found))
        return
      }
      if (Date.now() - started > timeoutMs) {
        finish(() => reject(new CommandError('failed', `Gave up waiting for ${what} after ${Math.round(timeoutMs / 1000)} s.`)))
        return
      }
      clearTimeout(timer)
      timer = setTimeout(check, 20)
    }
    check()
  })
}

/** A task's turn: what is waiting runs first. A MessageChannel's message,
 *  which a hidden tab's browser does not slow down as it does timers. */
export const nextTask = (): Promise<void> =>
  new Promise((resolve) => {
    if (typeof MessageChannel === 'undefined') {
      setTimeout(resolve, 0)
      return
    }
    const channel = new MessageChannel()
    channel.port1.onmessage = () => {
      channel.port1.close()
      resolve()
    }
    channel.port2.postMessage(null)
  })

/** A frame for the stage to follow the stores: the browser's next one — or,
 *  while the tab is hidden and the browser draws none, a task's turn and
 *  then the viewport's frame drawn by hand (SceneManager.pumpFrame), so a
 *  wait on the screen does not stall in a background tab. */
export async function nextFrame(scene?: { pumpFrame(): void } | null): Promise<void> {
  const hidden = typeof document === 'undefined' || document.visibilityState === 'hidden'
  if (!hidden && typeof requestAnimationFrame === 'function') {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    return
  }
  await nextTask()
  scene?.pumpFrame()
}
