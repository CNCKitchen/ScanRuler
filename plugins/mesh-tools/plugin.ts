// SPDX-License-Identifier: AGPL-3.0-only
// The Mesh Tools workspace, as the app finds it: see src/plugins/api.ts for
// what each part of this is to the app.

import type { HintStep } from '../../src/core/hints'
import { registerBusy, registerCommands, registerStateSection, type ScanRulerPlugin } from '../../src/plugins/api'
import { pick, registerHistory } from '../../src/state/historyStore'
import { registerProjectSection } from '../../src/app/projectSections'
import { meshSection } from './app/projectSection'
import { MESH_SETTINGS, useMeshTools } from './state/meshStore'
import { useMark } from '../../src/state/markStore'
import { useDeleteSelection } from './state/deleteStore'
import { useMeshPlugin } from './app/useMeshPlugin'
import { MeshNotices } from './ui/MeshNotices'
import { meshBusy, meshCommands } from './app/meshCommands'
import { describeMesh } from './app/meshReadout'
import './ui/mesh-tools.css'

const REDUCE_STEP: HintStep = { target: 'reduce-mesh', text: 'Part loaded — reduce the mesh' }

const plugin: ScanRulerPlugin = {
  id: 'mesh-tools',
  name: 'Mesh Tools',
  workspace: {
    // The id the workspace has always had: project files saved in it say so.
    id: 'mesh',
    label: 'Mesh Tools',
    title: 'Clean the scan up — islands, holes, scatter — expand, shrink or hollow it, and reduce it to a light mesh for CAD held within a tolerance you set',
    icon: 'wsMesh',
    order: 20,
    // Two steps deep: the app's own, the scan, then a reduction — walked
    // only while Reduce mesh is the tool in hand.
    useHintStep() {
      const reduced = useMeshTools((s) => s.report !== null || s.tool !== 'reduce')
      const busy = useMeshTools((s) => s.status === 'running' || s.editing)
      return { step: reduced ? 'done' : REDUCE_STEP, busy }
    },
  },
  keyboard: {
    keydown(e, { confirmButton }) {
      const m = useMeshTools.getState()
      const deletion = useDeleteSelection.getState()
      if (m.tool === 'delete' && deletion.stage !== 0) {
        if (e.key === 'Escape') deletion.setStage(0)
        else if (e.key === 'Enter' && !e.repeat && !m.editing) confirmButton()?.click()
        return true
      }
      if (m.tool === 'delete' && deletion.mode === 'visible' && e.key === 'Escape' && deletion.gesture !== null) {
        deletion.setGesture(null)
        return true
      }
      // Remove islands and Delete marked ask before they delete: Enter says
      // yes, Escape no.
      if (m.confirming) {
        if (e.key === 'Escape') m.setConfirming(false)
        else if (e.key === 'Enter') confirmButton()?.click()
        return true
      }
      // Delete marked's and Flip normals' marking, and a region marked to
      // smooth or to move, give the camera back on Escape, as every marking
      // does; what is marked stays.
      const marking =
        m.tool === 'delete' ||
        m.tool === 'flip' ||
        m.tool === 'trim' ||
        (m.tool === 'smooth' && m.smoothScope === 'marked') ||
        (m.tool === 'offset' && m.offsetScope === 'marked')
      if (e.key === 'Escape' && marking && useMark.getState().gesture !== null) {
        useMark.getState().setGesture(null)
        return true
      }
      // Escape puts the tool in hand away — not while it is at work.
      if (e.key === 'Escape' && m.tool !== null && m.status !== 'running' && m.trimStatus !== 'running' && !m.editing) {
        m.setTool(null)
        return true
      }
      return false
    },
  },
  notices: MeshNotices,
  usePlugin: useMeshPlugin,
  install() {
    registerProjectSection(meshSection)
    // What an agent works through: the commands under the workspace's id —
    // the plugin's has a hyphen, which a command's name does not take — its
    // part of the readout, and what it is busy with.
    registerCommands('mesh', meshCommands)
    registerStateSection('mesh', describeMesh)
    registerBusy('mesh', meshBusy, [useMeshTools])
    registerHistory({
      // The settings and the list of edits: a reduction on hand stays what
      // it was made with, and the panel says so when the two part ways.
      sections: [
        {
          key: 'mesh',
          capture: () =>
            pick(useMeshTools.getState(), [...MESH_SETTINGS, 'edits', 'pending']),
          apply: (value) => useMeshTools.setState(value as Partial<ReturnType<typeof useMeshTools.getState>>),
        },
      ],
      actions: [
        {
          store: useMeshTools,
          label: 'Mesh Tools',
          names: ['setTolerance', 'setMaxTriangles', 'setPieceSize', 'setCutRef', 'setCutOffset', 'setCutKeep', 'setCutCap',
            'setHoleSize', 'setFillMode', 'setSmoothScope', 'setSmoothSize', 'setSmoothLimit', 'setSmoothEdges', 'setOffsetScope',
            'setOffsetDirection', 'setOffsetDistance', 'setBoolOp', 'toggleBoolSolid', 'setBoolSolids', 'setTrimSolid', 'toggleTrimSolid',
            'setTrimOffset', 'setTrimDepth', 'setTrimFlip', 'setShellThickness', 'setShellSide'],
        },
      ],
      blocked: () => {
        const m = useMeshTools.getState()
        return m.status === 'running' || m.trimStatus === 'running' || m.editing
      },
    })
  },
}

export default plugin
