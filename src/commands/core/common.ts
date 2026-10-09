// SPDX-License-Identifier: AGPL-3.0-only
// What the app's own commands share: the guards that keep a command from
// running over work open in the panel, waiting for the stores to settle, and
// files in and out.

import type { BuiltFile } from '../../app/exports'
import { sessionIsDirty } from '../../app/project'
import { dimHolds } from '../../state/historyStore'
import { useShell, type Workspace } from '../../state/shellStore'
import { draftHolds, useStore } from '../../state/store'
import { useFlat, flatDraftHolds } from '../../state/flatStore'
import { bool, str, type JsonSchema } from '../schema'
import { CommandError, type FileOut } from '../types'

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

/** Whatever a refused or failed step left in the error toast, or a fallback. */
export const lastError = (fallback: string): string => useStore.getState().errorText ?? fallback

/** The `discard` switch commands that replace the session take. */
export const discardSchema: JsonSchema = bool(
  'Replace the session even though it holds measurements — they are lost (a project file saved before keeps them). Without it the command refuses when there is work to lose.',
)

/** Refuse to replace a session holding work unless told to. */
export function requireDiscardable(discard: boolean | undefined, what: string): void {
  if (!discard && sessionIsDirty()) {
    throw new CommandError(
      'invalid_state',
      `The session holds measurements that ${what} would replace. Save them with project.save, or pass discard: true.`,
    )
  }
}

/** A file's name, which says what it is. */
export const fileNameSchema = (examples: string): JsonSchema =>
  str(`The file's name with its extension — ${examples}. It is what the session calls the model.`, { minLength: 1 })

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
    const check = () => {
      let value: T | null | undefined | false
      try {
        value = read()
      } catch (e) {
        reject(e)
        return
      }
      if (value) {
        resolve(value)
        return
      }
      if (Date.now() - started > timeoutMs) {
        reject(new CommandError('failed', `Gave up waiting for ${what} after ${Math.round(timeoutMs / 1000)} s.`))
        return
      }
      setTimeout(check, 20)
    }
    check()
  })
}
