// SPDX-License-Identifier: AGPL-3.0-only
// A move-and-turn handle on an object a layer draws: three's TransformControls
// laid over the viewport, the drag claimed from the camera while the cursor is
// on a handle or a handle is held, so an orbit does not fight it.

import type * as THREE from 'three'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import type { SceneLayerHost } from './sceneLayers'

export interface LayerGizmo {
  /** Put the handle on `obj` (null: take it away). `onChange` runs on every
   *  step of a drag, after the object has moved. */
  attach(obj: THREE.Object3D | null, onChange: () => void, mode?: 'translate' | 'rotate'): void
  /** Follow the view's camera — it changes with the projection. */
  tick(): void
  dispose(): void
}

export function layerGizmo(host: SceneLayerHost): LayerGizmo {
  const controls = new TransformControls(host.camera(), host.canvas)
  const helper = controls.getHelper()
  host.scene.add(helper)
  let onChange: () => void = () => {}
  let held = false
  let over = false
  const claim = () => host.claimDrag(held || over)
  controls.addEventListener('objectChange', () => {
    onChange()
    host.invalidate()
  })
  controls.addEventListener('change', () => host.invalidate())
  controls.addEventListener('dragging-changed', (e) => {
    held = (e as unknown as { value: boolean }).value
    claim()
  })
  controls.addEventListener('axis-changed', (e) => {
    over = (e as unknown as { value: string | null }).value !== null
    claim()
  })
  return {
    attach(obj, cb, mode = 'translate') {
      onChange = cb
      controls.setMode(mode)
      if (obj) controls.attach(obj)
      else controls.detach()
      held = false
      over = false
      claim()
      host.invalidate()
    },
    tick() {
      const camera = host.camera()
      if (controls.camera !== camera) controls.camera = camera
    },
    dispose() {
      controls.detach()
      host.scene.remove(helper)
      host.claimDrag(false)
      controls.dispose()
      host.invalidate()
    },
  }
}
