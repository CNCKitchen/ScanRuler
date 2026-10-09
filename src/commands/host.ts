// SPDX-License-Identifier: AGPL-3.0-only
// What the commands work through: the session App draws (app/session.ts) —
// the worker, the viewport when there is one, the models' files, the maps
// and the workspaces' verbs — and the few verbs that live in App alone
// because they need the browser: project files and the 2D workspace's image.
// App installs it once; a test installs one it made itself, without a
// viewport. Commands reach it through commandHost().

import type { AppSession } from '../app/session'
import { useDeviation } from '../state/deviationStore'
import { useFlat } from '../state/flatStore'
import { useHistory } from '../state/historyStore'
import { useStore } from '../state/store'
import { useThickness } from '../state/thicknessStore'
import type { BuiltFile } from '../app/exports'
import type { EdgeIndex } from '../core/flat/snap'
import type { SceneManager } from '../viewer/SceneManager'
import { configureCommands, pluginBusy } from './activity'
import { CommandError } from './types'

/** A project packed, or why it could not be. */
export type PackedProject = { name: string; bytes: Uint8Array } | { error: string }

/** The project file verbs, as the top bar's Save and Load run them. */
export interface ProjectHost {
  /** The session as a project file — what Save Project downloads. */
  save(): Promise<PackedProject>
  /** Open a project in place of the session. `discard` stands in for the
   *  question a person is asked before work is thrown away. */
  open(file: File, discard: boolean): Promise<void>
}

/** The 2D workspace's verbs that need the browser's image decoder or the
 *  sheet App holds. */
export interface FlatHost {
  openImage(file: File): Promise<void>
  /** Take the image off the sheet, as a project without one does. */
  closeImage(): void
  /** Find the image's edges again at this sensitivity, 0 to 1. */
  detectEdges(sensitivity: number): Promise<number>
  /** What a pick on the sheet snaps to — the subject's own edges. */
  edgeIndex(): EdgeIndex | null
  /** The sheet as the SVG and DXF buttons write it; null with nothing on
   *  the sheet. */
  buildSvg(): Promise<BuiltFile | null>
  buildDxf(): Promise<BuiltFile | null>
}

export interface CommandHost {
  session: AppSession
  project?: ProjectHost
  flat?: FlatHost
}

let host: CommandHost | null = null

/** What the session is busy with right now, in a few words, or null when a
 *  command may change it. */
export function sessionBusy(): string | null {
  const s = useStore.getState()
  if (host?.session.imports.busy) return 'a file is being read'
  if (s.busy) return s.statusText || 'it is working'
  if (useHistory.getState().restoring) return 'a step of the history is being restored'
  const d = useDeviation.getState()
  if (d.nominalBusy) return 'the reference is being read'
  if (d.alignStatus === 'running') return 'the scan is being aligned to the reference'
  if (d.mapStatus === 'running') return 'the deviation map is being measured'
  if (useThickness.getState().status === 'running') return 'the wall thickness is being measured'
  if (useFlat.getState().imageBusy) return 'the image is being read'
  if (s.draft?.status === 'fitting' || s.elements.some((e) => e.status === 'fitting')) return 'an element is being fitted'
  return pluginBusy()
}

/** Make `next` the host the commands work through, and hold them to the
 *  session's state. The returned function takes it away again. */
export function installCommandHost(next: CommandHost): () => void {
  host = next
  const unguard = configureCommands({ busy: sessionBusy })
  return () => {
    if (host === next) host = null
    unguard()
  }
}

/** The host, or a refusal when none is installed. */
export function commandHost(): CommandHost {
  if (!host) throw new CommandError('unavailable', 'ScanRuler has no session to work on yet.')
  return host
}

/** The viewport, or null in a session without one. */
export const sceneOf = (): SceneManager | null => host?.session.sceneRef.current ?? null

/** The viewport, or a refusal naming what needs it. */
export function requireScene(what: string): SceneManager {
  const scene = sceneOf()
  if (!scene) throw new CommandError('unavailable', `${what} needs the viewport, and this session has none.`)
  return scene
}
