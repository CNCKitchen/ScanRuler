// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import type { SceneManager } from '../../../src/viewer/SceneManager'
import { useShell } from '../../../src/state/shellStore'
import { useStore } from '../../../src/state/store'
import { useMark } from '../../../src/state/markStore'
import { onScan } from '../../../src/app/scanEvents'
import { useMeshTools } from '../state/meshStore'
import { useDeleteSelection } from '../state/deleteStore'
import { selectedTriangles } from '../core/triangleSelection'
import { markedTriangles } from '../core/edit'
import { DeleteSelectionScene } from '../viewer/deleteSelection'
import type { MeshToolsSession } from './meshToolsSession'

export function useDeleteTool(session: MeshToolsSession, sceneRef: RefObject<SceneManager | null>) {
  const onMesh = useShell((s) => s.workspace === 'mesh')
  const deleting = useMeshTools((s) => s.tool === 'delete')
  const active = onMesh && deleting
  const copyVersion = useMeshTools((s) => s.copyVersion)
  const alignment = useStore((s) => s.appliedAlignment)
  const state = useDeleteSelection()
  const marked = useMark((s) => s.count)
  const diameter = useMark((s) => s.diameter)
  const view = useRef<DeleteSelectionScene | null>(null)
  const selectedMesh = useRef<Uint32Array | null>(null)
  const clear = () => {
    view.current?.clear()
    useDeleteSelection.getState().reset()
    selectedMesh.current = null
    sceneRef.current?.clearPaint()
    useMark.getState().setCount(0)
    useMeshTools.getState().setConfirming(false)
  }
  useEffect(() => {
    if (!active || !sceneRef.current) return
    const layer = new DeleteSelectionScene(
      sceneRef.current,
      (mask) => {
        selectedMesh.current = sceneRef.current?.scanMesh()?.indices ?? null
        useDeleteSelection.getState().setSelection(mask)
        useStore.getState().setStatus('Selection only. Orange triangles would be deleted; yellow lines mark selection edges. Release each stroke to update.')
      },
      (message) => useStore.getState().setError(message),
      () => useStore.getState().busy || useMeshTools.getState().editing || useDeleteSelection.getState().stage !== 0 || useDeleteSelection.getState().selecting,
    )
    view.current = layer
    return () => {
      layer.dispose()
      view.current = null
    }
  }, [active, sceneRef])
  useEffect(() => { clear() }, [active, copyVersion, alignment, state.mode])
  useEffect(() => onScan({ loaded: clear, swapped: clear }), [])
  useEffect(() => {
    const layer = view.current
    if (!layer) return
    layer.enabled = active && state.mode === 'visible'
    void layer.show(state.selection)
  }, [active, state.mode, state.selection, copyVersion])
  useEffect(() => {
    // Legacy vertex marking is also invalidated by any change after preview.
    if (state.mode === 'through') useDeleteSelection.getState().setStage(0)
  }, [marked, state.mode])
  const mesh = sceneRef.current?.scanMesh()
  const legacyCount = active && state.mode === 'through' && marked > 0 && mesh
    ? markedTriangles(mesh.indices, sceneRef.current!.paintedVertices(), mesh.positions.length / 3).count
    : 0
  const count = state.mode === 'visible' ? state.count : legacyCount
  const total = mesh ? mesh.indices.length / 3 : 0
  const applyDelete = async () => {
    const current = useDeleteSelection.getState()
    if (current.stage !== 2 || !active || current.selecting) return
    if (current.mode === 'visible') {
      const mesh = sceneRef.current?.scanMesh()
      if (!current.selection || !mesh || selectedMesh.current !== mesh.indices || current.selection.length * 3 !== mesh.indices.length) {
        useStore.getState().setError('The mesh changed after preview. Select the surface again.')
        clear()
        return
      }
      const result = await session.deleteTriangles(selectedTriangles(current.selection))
      if (result) clear()
    } else {
      const result = await session.deleteMarked()
      if (result) clear()
    }
    useDeleteSelection.getState().setStage(0)
  }
  return {
    ...state,
    diameter,
    setDiameter: (mm: number) => {
      useMark.getState().setDiameter(mm)
      useDeleteSelection.getState().setStage(0)
    },
    count,
    total,
    clear,
    selectView: () => { void view.current?.selectView() },
    cancelSelection: () => view.current?.cancelWork(),
    invert: () => {
      const n = sceneRef.current?.scanMesh()?.indices.length
      if (!n) {
        useStore.getState().setError('Load a triangle mesh before inverting selection.')
        return
      }
      const mask = state.selection?.slice() ?? new Uint8Array(n / 3)
      const indices = sceneRef.current?.scanMesh()?.indices ?? null
      if (state.selection && selectedMesh.current !== indices) {
        useStore.getState().setError('The mesh changed since selection. Clear and select again.')
        clear()
        return
      }
      for (let t = 0; t < mask.length; t++) mask[t] = mask[t] ? 0 : 1
      void view.current?.invertSelection(mask)
    },
    applyDelete,
  }
}

export type DeleteToolState = ReturnType<typeof useDeleteTool>
