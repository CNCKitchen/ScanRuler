// SPDX-License-Identifier: AGPL-3.0-only
// What a plugin is to the mesh worker: plugins/<id>/worker.ts, whose default
// export answers requests of the plugin's own beside the worker's, on the
// scan the worker holds — found by workerPlugins.ts, asked for by
// MeshWorkerClient.pluginCall.

import type { NominalSurface } from './deviation/surface'
import type { Rigid } from './deviation/rigid'
import type { MeshGraph } from './types'

/** What the worker lends a plugin's request. */
export interface WorkerContext {
  /** The scan the session holds, as the worker has it — every alignment
   *  baked into its vertices — or null with none. */
  scan(): MeshGraph | null
  /** A mesh loaded as a staged import (MeshWorkerClient.prepareScan), taken:
   *  it is the plugin's from here on. Undefined when there is none by that
   *  number. */
  takeStaged(id: number): MeshGraph | undefined
  /** A line for the status strip while the request runs. */
  progress(text: string): void
  /** A mesh prepared for closest-point queries, built on first use and kept
   *  until its vertices move. `why` is what the status says meanwhile. */
  surfaceOf(mesh: MeshGraph, why: string): NominalSurface
}

/** A request's answer, with the buffers to hand over rather than copy. */
export interface WorkerReply {
  result: unknown
  transfer?: Transferable[]
}

export interface WorkerPlugin {
  /** The plugin's id, as its plugin.ts gives it. */
  id: string
  /** Answer a request. An answer that is a promise holds every other request
   *  back until it settles: nothing may run inside the wait that would
   *  change what it is working on. Throw to answer with an error. */
  handle(op: string, payload: unknown, ctx: WorkerContext): WorkerReply | Promise<WorkerReply>
  /** The scan was replaced, or taken away: what was made of the one before
   *  goes. */
  scanReplaced?(): void
  /** The scan was moved — an alignment baked into its vertices. What stands
   *  in its frame moves with it. */
  transformed?(transform: Rigid): void
}
