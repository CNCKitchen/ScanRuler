// SPDX-License-Identifier: AGPL-3.0-only
// The session outside React: the mesh worker, the viewport (when there is
// one), the files the models came from, the per-vertex maps, and the
// workspaces' verbs wired to them. App makes one and draws it; the commands
// (src/commands) are handed the same one, so a panel button and a command
// run the same code. Under a test, or a headless run, it stands without a
// viewport — every scene call in it is optional.

import type { RefObject } from 'react'
import type { MeshWorkerClient } from '../core/workerClient'
import type { ScanMaps } from '../plugins/api'
import type { SceneManager } from '../viewer/SceneManager'
import { deviationWorkspace } from './deviationWorkspace'
import { ImportQueue } from './importQueue'
import { measureWorkspace } from './measureWorkspace'
import { partAlignment } from './partAlignment'
import { emptySources, type SourceFiles } from './project'
import { scanImport } from './scanImport'
import { sectionCuts } from './sectionCuts'
import { thicknessWorkspace } from './thicknessWorkspace'

export type AppSession = ReturnType<typeof createSession>

const ref = <T,>(value: T): { current: T } => ({ current: value })

export function createSession({
  clientRef,
  sceneRef,
}: {
  clientRef: RefObject<MeshWorkerClient | null>
  sceneRef: RefObject<SceneManager | null>
}) {
  // One queue for every load and replace of a model.
  const imports = new ImportQueue()
  // The bytes of every model as it came in, for saving the session as a
  // project — see app/project. The worker takes its copy by transfer, so this
  // is the only one left.
  const sources: RefObject<SourceFiles> = ref(emptySources())
  const maps: ScanMaps = {
    // The deviation field: one float per scan vertex, so hundreds of
    // thousands of them. It stays out of the store, and stays on the main
    // thread so that moving the scale or the search distance re-colours the
    // part immediately instead of going back to the worker.
    deviation: ref<Float32Array | null>(null),
    deviationRgb: ref<Uint8Array | null>(null),
    // The deviation from a fitted element, held beside the one from the
    // reference part rather than sharing it: a few megabytes buys switching
    // between what the scan is measured against without either map losing
    // what it had.
    elementField: ref<Float32Array | null>(null),
    elementRgb: ref<Uint8Array | null>(null),
    // The hand-marked scan region an element map can be restricted to. A
    // snapshot rather than the live paint mask, so the region survives the
    // paint layer being cleared by other workflows — the map keeps showing
    // what was chosen.
    elementScope: ref<Uint32Array | null>(null),
    // The wall thickness field, kept the same way and for the same reasons:
    // one float per scan vertex, and the two ends of its scale move it
    // immediately rather than going back to the worker.
    thickness: ref<Float32Array | null>(null),
    thicknessRgb: ref<Uint8Array | null>(null),
  }
  // The direction each reading of a deviation map was taken along, for
  // playing the map as motion (core/deviation/deflection.ts) — keyed by the
  // map's own array, so a direction can never be read against a map it was
  // not measured with, and goes when the map does.
  const fieldDirections = new WeakMap<Float32Array, Int8Array>()

  const measure = measureWorkspace({ clientRef, sceneRef })
  const scan = scanImport({ clientRef, sceneRef, sources, imports, maps, clearPreview: measure.clearPreview })
  const alignment = partAlignment({ clientRef, sceneRef, imports, maps, clearPreview: measure.clearPreview })
  const deviation = deviationWorkspace({
    clientRef,
    sceneRef,
    deviation: maps.deviation,
    deviationRgb: maps.deviationRgb,
    fieldDirections,
    sources,
    imports,
  })
  const thickness = thicknessWorkspace({ clientRef, thickness: maps.thickness, thicknessRgb: maps.thicknessRgb })
  const sections = sectionCuts(clientRef)

  /** Start what keeps itself in step with the stores — a centroid measuring
   *  itself, the sections' cuts. The returned function stops it. */
  const watch = () => {
    const stops = [measure.watch(), sections.watch()]
    return () => stops.forEach((stop) => stop())
  }

  return { clientRef, sceneRef, imports, sources, maps, fieldDirections, measure, scan, alignment, deviation, thickness, sections, watch }
}
