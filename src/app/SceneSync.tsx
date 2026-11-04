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
// Workbench; its effects now run ahead of the Workbench's own in a commit,
// which nothing there depends on (they act on the stores, the worker and the
// 2D sheet, not on what the viewport was last told).
import { memo } from 'react'
import { useElementField } from './useElementField'
import { useSceneSync } from './useSceneSync'

export type SceneSyncProps = Parameters<typeof useSceneSync>[0] & Parameters<typeof useElementField>[0]

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
})
