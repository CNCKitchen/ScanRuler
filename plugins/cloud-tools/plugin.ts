// SPDX-License-Identifier: AGPL-3.0-only
// The Cloud Tools workspace, as the app finds it: see src/plugins/api.ts for
// what each part of this is to the app. Mesh Tools' counterpart for a point
// cloud — so unavailable on a mesh, where Mesh Tools does the same and more.

import { registerBusy, type ScanRulerPlugin } from '../../src/plugins/api'
import { registerHistory } from '../../src/state/historyStore'
import { useMark } from '../../src/state/markStore'
import { useStore } from '../../src/state/store'
import { CLOUD_TOOLS } from './core/protocol'
import { useCloudTools } from './state/cloudStore'
import { CLOUD_WORKSPACE, cloudBusy } from './app/cloudSession'
import { useCloudPlugin } from './app/useCloudPlugin'
import './ui/cloud-tools.css'

/** Why the workspace is greyed on a mesh. */
export const MESH_REFUSAL = 'Needs a point cloud — this scan is a mesh. Mesh Tools cleans a mesh up.'

const plugin: ScanRulerPlugin = {
  id: CLOUD_TOOLS,
  name: 'Cloud Tools',
  workspace: {
    id: CLOUD_WORKSPACE,
    label: 'Cloud Tools',
    title: 'Clean a point cloud up — clear the pieces floating off the part, cut it at a plane, and delete what you mark by hand',
    icon: 'wsMesh',
    order: 25,
    unavailable: () => {
      const s = useStore.getState()
      return s.fileName && !s.scanIsCloud ? MESH_REFUSAL : null
    },
  },
  keyboard: {
    keydown(e, { confirmButton }) {
      const c = useCloudTools.getState()
      // Delete asks first: Enter says yes, Escape no.
      if (c.confirming) {
        if (e.key === 'Escape') c.setConfirming(false)
        else if (e.key === 'Enter') confirmButton()?.click()
        return true
      }
      // Escape gives the camera back from a marking gesture; what is marked stays.
      if (e.key === 'Escape' && c.tool === 'hand' && useMark.getState().gesture !== null) {
        useMark.getState().setGesture(null)
        return true
      }
      if (e.key === 'Escape' && c.tool !== null && c.running === null) {
        c.setTool(null)
        return true
      }
      return false
    },
  },
  usePlugin: useCloudPlugin,
  install() {
    registerBusy(CLOUD_TOOLS, cloudBusy, [useCloudTools], async () => {
      while (useCloudTools.getState().running !== null) await new Promise((r) => setTimeout(r, 20))
    })
    registerHistory({ blocked: () => useCloudTools.getState().running !== null })
  },
}

export default plugin
