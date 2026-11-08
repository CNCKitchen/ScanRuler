// SPDX-License-Identifier: AGPL-3.0-only
// The element deviation map: kept in step with the element it is measured
// against, so there is no "measure" button to press.
//
// Both maps go to the mesh worker, which is where a pass over the whole scan
// belongs: the reference map because a signed closest point against a whole
// nominal part is a BVH descent per vertex, this one because even a handful of
// flops per vertex is tens of milliseconds over a large scan on a phone — a
// task the next tap waits behind. It is recomputed whenever anything it depends
// on moves, which is what lets the grips resize the measured region and the
// facing limit tighten it with the map following along, instead of a button to
// press. The map in hand stays on screen until the new one lands, and the
// requests coalesce: one is worked out at a time, and of those that arrive
// meanwhile only the newest is asked.

import { useEffect, useMemo, useRef } from 'react'
import type { RefObject } from 'react'
import { applyExtension } from '../core/elements/extend'
import {
  computeElementDeviation,
  isDeviationTarget,
  type ElementTarget,
} from '../core/deviation/elementField'
import { suggestRange } from '../core/deviation/deviation'
import { StaleScan, type MeshWorkerClient } from '../core/workerClient'
import { useDeviation } from '../state/deviationStore'
import { useHistory } from '../state/historyStore'
import { useStore, type Element } from '../state/store'
import type { SceneManager } from '../viewer/SceneManager'

/** The scan's vertices and normals as the viewport holds them — the same buffers
 *  the elements were fitted in, which is why no alignment comes into this.
 *  Its own vertices only: past them the render arrays carry the copies its
 *  sharp edges were split into for shading (core/geometry/crease.ts), and a
 *  map with a reading for each copy is one the scan refuses to paint. */
function scanArrays(
  scene: SceneManager | null,
): { positions: Float32Array; normals: Float32Array } | null {
  const geometry = scene?.scanGeometry()
  const positions = geometry?.getAttribute('position')
  const normals = geometry?.getAttribute('normal')
  if (!scene || !positions || !normals) return null
  const own = scene.scanVertexCount() * 3
  return {
    positions: (positions.array as Float32Array).subarray(0, own),
    normals: (normals.array as Float32Array).subarray(0, own),
  }
}

/** What measuring the map comes to: the readings, the direction each was taken
 *  along, and the colour scale the tool would choose for them. */
export interface ElementMapResult {
  values: Float32Array
  directions: Int8Array
  suggestedRange: number
}

/** Measure the map once and say what became of it: `settle` with the map, or
 *  `fail` — never neither, so the status is never left saying "running" for a
 *  map nobody is working on. Nothing is said at all for a question that has
 *  moved on (`current` no longer true), because whatever moved it has the
 *  status now. `ask` is the worker; where there is none, or it cannot answer,
 *  `here` measures it on this thread as it always could. A scan that moved
 *  while the worker answered is asked about once more, as it now is. */
export async function runElementMap({
  ask,
  here,
  current,
  settle,
  fail,
}: {
  ask: (() => Promise<ElementMapResult>) | null
  here: () => ElementMapResult | null
  current: () => boolean
  settle: (result: ElementMapResult) => void
  fail: () => void
}): Promise<void> {
  if (!current()) return
  let result: ElementMapResult | null = null
  for (let attempt = 0; ask && attempt < 2 && !result; attempt++) {
    try {
      result = await ask()
    } catch (e) {
      if (!current()) return
      if (!(e instanceof StaleScan)) {
        // Measured here instead, which is the cost this moved off the main
        // thread: a worker that keeps failing should not do so unheard.
        console.warn('The worker could not measure the map against the element; measuring it here.', e)
        break
      }
    }
  }
  if (!current()) return
  if (!result) {
    try {
      result = here()
    } catch (e) {
      console.warn('The map against the element could not be measured.', e)
    }
  }
  if (result) settle(result)
  else fail()
}

/** One job at a time, and of those that arrive while one is running only the
 *  newest kept — a facing limit dragged along its slider asks for a map per
 *  step, and the ones in between are answers to questions already out of date.
 *  A job that throws does not stop the next. */
export function latestWins(): (job: () => Promise<void>) => void {
  let busy = false
  let waiting: (() => Promise<void>) | null = null
  const start = (job: () => Promise<void>): void => {
    busy = true
    const next = (): void => {
      busy = false
      const after = waiting
      waiting = null
      if (after) start(after)
    }
    job().then(next, next)
  }
  return (job) => {
    if (busy) waiting = job
    else start(job)
  }
}

/** The element the deviation is measured against, as drawn: the extension is
 *  part of the question, because it is what bounds the measured region. */
export function targetFitOf(elements: Element[], targetId: number | null): ElementTarget | null {
  if (targetId === null) return null
  const el = elements.find((e) => e.id === targetId)
  if (!el?.fit) return null
  const drawn = applyExtension(el.fit, el.extend)
  return isDeviationTarget(drawn) ? drawn : null
}

export function useElementField({
  sceneRef,
  clientRef,
  elementField,
  elementRgb,
  elementScope,
  fieldDirections,
}: {
  sceneRef: RefObject<SceneManager | null>
  /** The mesh worker, where the map is measured. */
  clientRef: RefObject<MeshWorkerClient | null>
  elementField: RefObject<Float32Array | null>
  elementRgb: RefObject<Uint8Array | null>
  /** The hand-marked scan region the map is restricted to, when the scope says
   *  so — held in a ref like the field itself, because it is one large typed
   *  array only this computation reads. */
  elementScope: RefObject<Uint32Array | null>
  /** The direction each map's readings were taken along, keyed by the map. */
  fieldDirections: WeakMap<Float32Array, Int8Array>
}) {
  const targetId = useDeviation((s) => s.targetId)
  const targetSide = useDeviation((s) => s.targetSide)
  const targetFacingDeg = useDeviation((s) => s.targetFacingDeg)
  const targetScope = useDeviation((s) => s.targetScope)
  const scopeVersion = useDeviation((s) => s.scopeVersion)
  const fit = useStore((s) => s.elements.find((el) => el.id === targetId)?.fit)
  const extend = useStore((s) => s.elements.find((el) => el.id === targetId)?.extend)
  const revision = useHistory((s) => s.revision)
  const seenRevision = useRef(revision)
  const previousInputs = useRef<unknown[] | null>(null)
  const queue = useRef<ReturnType<typeof latestWins> | null>(null)
  if (!queue.current) queue.current = latestWins()

  // A map still being measured when this goes away must not be settled by
  // it: whoever mounts next measures its own, and it owns the status.
  useEffect(
    () => () => {
      previousInputs.current = null
    },
    [],
  )

  // Held stable across renders: applyExtension builds a fresh object every call,
  // so depending on it directly would recompute the field on every render.
  const target = useMemo(() => {
    if (!fit) return null
    const drawn = applyExtension(fit, extend)
    return isDeviationTarget(drawn) ? drawn : null
  }, [fit, extend])

  // Deliberately not gated on the source being the element: an element can be
  // re-fitted, extended or deleted from the other workspace while a reference
  // map is the one on screen, and the map against it has to be right — or gone —
  // by the time anybody looks. Nothing is measured until an element is chosen,
  // and choosing one is only possible from the element side, so this costs a
  // session that never uses it nothing at all.
  useEffect(() => {
    const restoring = seenRevision.current !== revision || useHistory.getState().restoring
    seenRevision.current = revision
    const inputs = [target, targetId, targetSide, targetFacingDeg, targetScope, scopeVersion]
    // History in another workspace must not recompute a scan-sized field.
    if (previousInputs.current?.every((value, index) => value === inputs[index])) return
    previousInputs.current = inputs
    if (!target) {
      // The element the map was measured against is gone — deleted, or re-made
      // into something with no surface to measure against. The field goes with
      // it, and so does the scale that would otherwise be left standing over a
      // map that no longer exists.
      elementField.current = null
      elementRgb.current = null
      if (useDeviation.getState().elementStatus !== 'idle') {
        useDeviation.getState().clearElementMap()
      }
      return
    }
    const scan = scanArrays(sceneRef.current)
    if (!scan) {
      // Whatever was being measured is not wanted any more and nothing is
      // taking its place: it must not leave the status waiting for it.
      if (useDeviation.getState().elementStatus === 'running') useDeviation.getState().failElementMap()
      return
    }

    // Everything the map is a function of is taken now, at the change: the
    // answer is painted only if `inputs` is still what is wanted when it lands,
    // and `restoring` is the history's word about this change, not a later one.
    const side = targetSide
    const maxNormalDeviation = targetFacingDeg === null ? null : (targetFacingDeg * Math.PI) / 180
    // A marked scope with nothing marked yet is an empty map, not the whole
    // scan: the hint in the panel says to mark, and the map follows the brush.
    const subset = targetScope === 'marked' ? (elementScope.current ?? new Uint32Array(0)) : null
    const maxDistance = useDeviation.getState().maxDistance
    useDeviation.getState().beginElementMap()
    queue.current!(() =>
      runElementMap({
        ask: clientRef.current
          ? () => clientRef.current!.elementDeviation(target, { side, maxNormalDeviation, subset, maxDistance }, () => scanArrays(sceneRef.current))
          : null,
        here: () => {
          const now = scanArrays(sceneRef.current)
          if (!now) return null
          const directions = new Int8Array(now.positions.length)
          const values = computeElementDeviation(target, now.positions, now.normals, { side, maxNormalDeviation, subset, directions })
          return { values, directions, suggestedRange: suggestRange(values, useDeviation.getState().maxDistance) }
        },
        current: () => previousInputs.current === inputs,
        settle: ({ values, directions, suggestedRange }) => {
          elementField.current = values
          fieldDirections.set(values, directions)
          elementRgb.current = null
          // The scale is suggested within the search distance, which may have
          // been dragged while the worker measured.
          const held = useDeviation.getState()
          held.resolveElementMap(held.maxDistance === maxDistance ? suggestedRange : suggestRange(values, held.maxDistance), restoring)
        },
        fail: () => useDeviation.getState().failElementMap(),
      }),
    )
    // Runs on the listed dependencies only, not on everything it reads.
  }, [target, targetId, targetSide, targetFacingDeg, targetScope, scopeVersion, revision])
}
