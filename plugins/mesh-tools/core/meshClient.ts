// SPDX-License-Identifier: AGPL-3.0-only
// Mesh Tools' requests of the mesh worker, typed: its part of the worker
// (../worker.ts) answers them through MeshWorkerClient.pluginCall. One per
// worker client, so the version of the edited copy it keeps is one for the
// session.

import type { CreaseSetting } from '../../../src/core/geometry/crease'
import type { Rigid } from '../../../src/core/deviation/rigid'
import type { MeshUnits } from '../../../src/core/meshUnits'
import type { Vec3 } from '../../../src/core/types'
import type { LoadedScan, MeshWorkerClient } from '../../../src/core/workerClient'
import { MESH_TOOLS, type MeshRegion, type MeshToolsOps, type ScanEditRequest, type TrimBody } from './protocol'
import type { ReduceSettings } from './reduce'
import type { TrimSettings } from './trimToScan'

class MeshToolsClient {
  /** Bumped whenever the edited copy is put in place or taken away. A copy
   *  also goes with the scan it was made of, which scanVersion says. */
  editedVersion = 0

  constructor(readonly client: MeshWorkerClient) {}

  /** The worker client's: bumped whenever a scan is put in place. */
  get scanVersion(): number {
    return this.client.scanVersion
  }

  private call<K extends keyof MeshToolsOps>(op: K, payload: MeshToolsOps[K]['payload']): Promise<MeshToolsOps[K]['result']> {
    return this.client.pluginCall<MeshToolsOps[K]['result']>(MESH_TOOLS, op, payload)
  }

  /** The mesh the workspace works on reduced for CAD as it now stands —
   *  every alignment baked in — with its measured deviation from it. */
  reduce(settings: ReduceSettings) {
    return this.call('reduce', { settings })
  }

  /** Its pieces, and the islands among them — those smaller than `minSize`
   *  across. Nothing changes. */
  surveyIslands(minSize: number) {
    return this.call('islands', { minSize })
  }

  /** It without its islands smaller than `minSize` across, to be loaded as
   *  the copy. Nothing changes in the worker. */
  removeIslands(minSize: number) {
    return this.call('remove-islands', { minSize })
  }

  /** Its rims, sorted into holes smaller across than `maxSize` and those left
   *  open. Nothing changes. */
  surveyHoles(maxSize: number) {
    return this.call('holes', { maxSize })
  }

  /** What a cut at the plane through `origin` square to `normal` would close
   *  the part with, and leave open. Nothing changes. */
  cutPreview(origin: Vec3, normal: Vec3) {
    return this.call('cut-preview', { origin, normal })
  }

  /** How far it is from closed — open edges, and edges more than two
   *  triangles share. Nothing changes. */
  closedness() {
    return this.call('closedness', {})
  }

  /** Its size, bounds and closedness, and the volume it encloses when
   *  closed. Nothing changes. */
  describe() {
    return this.call('describe', {})
  }

  /** A copy of its triangles, as it stands — for Wrap's own worker.
   *  Nothing changes. */
  triangles() {
    return this.call('triangles', {})
  }

  /** The vertices of it a region holds — surface named without a mouse.
   *  Nothing changes. */
  select(region: MeshRegion) {
    return this.call('select', { region })
  }

  /** It edited, to be loaded as the copy, like removeIslands'. */
  editScan(edit: ScanEditRequest) {
    return this.call('edit', { edit })
  }

  /** The edited copy's signed distance from the scan in use at each of its
   *  vertices, NaN where an edit made the surface. */
  editedDeviation(fromScan: Int32Array) {
    return this.call('edited-deviation', { fromScan })
  }

  /** Load a file as the edited copy — in the pose `transform` puts it in,
   *  the scan's — beside the scan, which stays the one everything else
   *  measures. Its render geometry comes back. */
  async setEdited(name: string, buffer: ArrayBuffer, crease: CreaseSetting, transform?: Rigid, units: MeshUnits = 'mm'): Promise<LoadedScan> {
    const { id, mesh } = await this.client.prepareScan(name, buffer, crease, transform, units)
    try {
      await this.call('set-edited', { staged: id })
    } catch (e) {
      await this.client.discardImport([id])
      throw e
    }
    this.editedVersion++
    return mesh
  }

  /** The break where `body` reaches into it deeper than `depth`: the
   *  vertices of it, to show as a marking. Nothing changes. */
  findBreak(body: TrimBody, depth: number) {
    return this.call('find-break', { body, depth })
  }

  /** `body` cut to fit its break, as `settings` say — a piece to show beside
   *  it and export. Nothing changes. */
  trimToScan(body: TrimBody, settings: TrimSettings) {
    return this.call('trim-to-scan', { body, settings })
  }

  /** The edited copy's render arrays again, split for sharp edges as
   *  `crease` says — the setting changed under it. Null with no copy. */
  recreaseEdited(crease: CreaseSetting) {
    return this.call('recrease-edited', { crease })
  }

  /** Throw the edited copy away: the workspace works on the scan again. */
  async clearEdited(): Promise<void> {
    await this.call('set-edited', { staged: null })
    this.editedVersion++
  }
}

const clients = new WeakMap<MeshWorkerClient, MeshToolsClient>()

/** The Mesh Tools client of a worker client — the same one every time. */
export function meshToolsOf(client: MeshWorkerClient): MeshToolsClient {
  let tools = clients.get(client)
  if (!tools) {
    tools = new MeshToolsClient(client)
    clients.set(client, tools)
  }
  return tools
}
