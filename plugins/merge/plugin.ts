// SPDX-License-Identifier: AGPL-3.0-only
// The Merge workspace, as the app finds it: see src/plugins/api.ts for what
// each part of this is to the app. It works on clouds and meshes alike — a
// mesh base asks before it becomes a cloud — so it is never unavailable.

import { registerBusy, registerCommands, type ScanRulerPlugin } from '../../src/plugins/api'
import { registerHistory } from '../../src/state/historyStore'
import { MERGE } from './core/protocol'
import { applyMerge, captureMerge, useMerge, type MergeSnapshot } from './state/mergeStore'
import { MERGE_WORKSPACE, mergeBusy, mergeSession } from './app/mergeSession'
import { mergeCommands } from './app/mergeCommands'
import { useMergePlugin } from './app/useMergePlugin'
import './ui/merge.css'

const plugin: ScanRulerPlugin = {
  id: MERGE,
  name: 'Merge',
  workspace: {
    id: MERGE_WORKSPACE,
    label: 'Merge',
    title: 'Lay extra scan passes on the scan — by moving them, by picked point pairs or by datums, then refined — and merge them into one point cloud to measure',
    icon: 'combine',
    order: 30,
  },
  keyboard: {
    keydown(e, { confirmButton }) {
      const m = useMerge.getState()
      // A merge onto a mesh asks first: Enter says yes, Escape no.
      if (m.confirming) {
        if (e.key === 'Escape') mergeSession()?.answerConfirm(false)
        else if (e.key === 'Enter') confirmButton()?.click()
        return true
      }
      // Escape stops an alignment, else puts the tool in hand away.
      if (e.key === 'Escape' && m.running) {
        mergeSession()?.stop()
        return true
      }
      if (e.key === 'Escape' && m.tool !== null) {
        m.setTool(null)
        return true
      }
      return false
    },
  },
  usePlugin: useMergePlugin,
  install() {
    // What an agent works through: merge.open_layer, merge.align_datums and the rest.
    registerCommands(MERGE, mergeCommands)
    // Stop an alignment, then wait for the panel to be free: a merge runs to its end.
    registerBusy(MERGE, mergeBusy, [useMerge], async () => {
      mergeSession()?.stop()
      while (useMerge.getState().running !== null) await new Promise((r) => setTimeout(r, 20))
    })
    // The layers' poses and whether each is shown, and the count of merges
    // that tells a step across one (see mergeSession's aroundRestore).
    registerHistory({
      sections: [{ key: MERGE, capture: captureMerge, apply: (value) => applyMerge(value as MergeSnapshot) }],
    })
  },
}

export default plugin
