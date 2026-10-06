// SPDX-License-Identifier: AGPL-3.0-only
// The element deviation map: kept in step with the element it is measured
// against, so there is no "measure" button to press.
//
// The reference map goes to the worker because a signed closest point against a
// whole nominal part is a BVH descent per vertex. An element is a plane, a
// cylinder or a sphere — a handful of flops per vertex, a few milliseconds over
// a large scan — so it is computed here on the main thread and simply recomputed
// whenever anything it depends on moves. That is what lets the grips resize the
// measured region and the facing limit tighten it with the map following along,
// instead of a round trip and a progress bar for each.

import { useEffect, useMemo, useRef } from 'react'
import type { RefObject } from 'react'
import { applyExtension } from '../core/elements/extend'
import {
  computeElementDeviation,
  isDeviationTarget,
  type ElementTarget,
} from '../core/deviation/elementField'
import { suggestRange } from '../core/deviation/deviation'
import { useDeviation } from '../state/deviationStore'
import { useHistory } from '../state/historyStore'
import { useStore, type Element } from '../state/store'
import type { SceneManager } from '../viewer/SceneManager'

/** The scan's vertices and normals as the viewport holds them — the same buffers
 *  the elements were fitted in, which is why no alignment comes into this. */
function scanArrays(
  scene: SceneManager | null,
): { positions: Float32Array; normals: Float32Array } | null {
  const geometry = scene?.scanGeometry()
  const positions = geometry?.getAttribute('position')
  const normals = geometry?.getAttribute('normal')
  if (!positions || !normals) return null
  return {
    positions: positions.array as Float32Array,
    normals: normals.array as Float32Array,
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
  elementField,
  elementRgb,
  elementScope,
  fieldDirections,
}: {
  sceneRef: RefObject<SceneManager | null>
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
    if (!scan) return

    const directions = new Int8Array(scan.positions.length)
    const values = computeElementDeviation(target, scan.positions, scan.normals, {
      side: targetSide,
      maxNormalDeviation: targetFacingDeg === null ? null : (targetFacingDeg * Math.PI) / 180,
      // A marked scope with nothing marked yet is an empty map, not the whole
      // scan: the hint in the panel says to mark, and the map follows the brush.
      subset: targetScope === 'marked' ? (elementScope.current ?? new Uint32Array(0)) : null,
      directions,
    })
    elementField.current = values
    fieldDirections.set(values, directions)
    elementRgb.current = null
    useDeviation.getState().resolveElementMap(
      suggestRange(values, useDeviation.getState().maxDistance),
      restoring,
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, targetId, targetSide, targetFacingDeg, targetScope, scopeVersion, revision])
}
