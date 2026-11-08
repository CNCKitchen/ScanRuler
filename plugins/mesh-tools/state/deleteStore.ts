// SPDX-License-Identifier: AGPL-3.0-only
import { create } from 'zustand'

interface DeleteState {
  mode: 'visible' | 'through'
  gesture: 'brush' | 'window' | 'lasso' | null
  remove: boolean
  selection: Uint8Array | null
  count: number
  stage: 0 | 1 | 2
  selecting: boolean
  progress: string | null
  setProgress(progress: string | null, percent?: number): void
  setMode(mode: DeleteState['mode']): void
  setGesture(gesture: DeleteState['gesture']): void
  setRemove(remove: boolean): void
  setSelection(selection: Uint8Array | null): void
  setStage(stage: DeleteState['stage']): void
  reset(): void
}

export const useDeleteSelection = create<DeleteState>((set) => ({
  mode: 'visible',
  gesture: null,
  remove: false,
  selection: null,
  count: 0,
  stage: 0,
  selecting: false,
  progress: null,
  setProgress: (progress) => set({ selecting: progress !== null, progress }),
  setMode: (mode) => set({ mode, gesture: null, selection: null, count: 0, stage: 0 }),
  setGesture: (gesture) => set({ gesture, stage: 0 }),
  setRemove: (remove) => set({ remove, stage: 0 }),
  setSelection: (selection) => set({
    selection,
    count: selection?.reduce((n, selected) => n + selected, 0) ?? 0,
    stage: 0,
  }),
  setStage: (stage) => set({ stage }),
  reset: () => {
    set({ gesture: null, selection: null, count: 0, stage: 0, selecting: false, progress: null })
  },
}))
