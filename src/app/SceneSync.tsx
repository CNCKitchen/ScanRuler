// SPDX-License-Identifier: AGPL-3.0-only
// The scene's follower, as a component of its own. useSceneSync and
// useElementField subscribe to some seventy store fields between them — the
// brush, the overlays' inputs, every map's version — and a hook's subscriptions
// belong to whoever calls it: called from the Workbench, each of those writes
// re-rendered the whole workspace (the panels, the legends, the stage prompts)
// only to repeat itself to the viewport as effects. Here they wake nothing but
// this component, which draws nothing.
//
// It is mounted after the viewport, so on the first commit the scene exists by
// the time these effects first run, exactly as it did when they ran in the
// Workbench. Its effects now run ahead of the Workbench's own in a commit —
// the plugins' among them, which the Workbench calls. One of those the paint
// here does depend on: Mesh Tools swapping its edited copy in and out of the
// scan's place, which has to come first so a map is laid on whichever of the
// two is on screen. That one is a layout effect (useMeshWorkspace), which runs
// ahead of every plain effect wherever it sits. The rest act on the stores,
// the worker, the 2D sheet, or layers and switches of the viewport that
// nothing here writes as well, or writes to agree with them.
import { memo } from 'react'
import { useElementField } from './useElementField'
import { pluginReads, useSceneSync } from './useSceneSync'

export type SceneSyncProps = Parameters<typeof useSceneSync>[0] & Parameters<typeof useElementField>[0]

/** The props as this draws them: every one by identity — refs, the session's
 *  handlers, values held stable by the Workbench — but the plugin's runtime,
 *  which is new on every render, by what is read of it (pluginReads). */
export function sameSceneSyncProps(a: SceneSyncProps, b: SceneSyncProps): boolean {
  for (const key of Object.keys(a) as (keyof SceneSyncProps)[]) {
    if (key !== 'plugin' && !Object.is(a[key], b[key])) return false
  }
  if (Object.keys(a).length !== Object.keys(b).length) return false
  const x = pluginReads(a.plugin)
  const y = pluginReads(b.plugin)
  return x.length === y.length && x.every((v, i) => Object.is(v, y[i]))
}

export const SceneSync = memo(function SceneSync({
  sceneRef,
  clientRef,
  deviation,
  deviationRgb,
  referenceMap,
  referenceRgb,
  elementField,
  elementRgb,
  elementScope,
  fieldDirections,
  thickness,
  thicknessRgb,
  thickScale,
  plugin,
  cancelDraft,
}: SceneSyncProps): null {
  // The element map before the rest of the scene's follower, as the Workbench
  // called them: it measures on a change of target, and the repaint below
  // paints whatever it settles.
  useElementField({ sceneRef, clientRef, elementField, elementRgb, elementScope, fieldDirections })
  useSceneSync({
    sceneRef,
    clientRef,
    deviation,
    deviationRgb,
    referenceMap,
    referenceRgb,
    elementField,
    elementRgb,
    fieldDirections,
    thickness,
    thicknessRgb,
    thickScale,
    plugin,
    cancelDraft,
  })
  return null
}, sameSceneSyncProps)
