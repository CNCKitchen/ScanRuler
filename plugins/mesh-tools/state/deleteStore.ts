// SPDX-License-Identifier: AGPL-3.0-only
import { create } from 'zustand'

interface DeleteState {
  mode: 'visible' | 'through'
  gesture: 'brush' | 'window' | 'lasso' | null
  remove: boolean
  diameter: number
  selection: Uint8Array | null
  count: number
  stage: 0 | 1 | 2
  setMode(mode: DeleteState['mode']): void
  setGesture(gesture: DeleteState['gesture']): void
  setRemove(remove: boolean): void
  setDiameter(diameter: number): void
  setSelection(selection: Uint8Array | null): void
  setStage(stage: DeleteState['stage']): void
  reset(): void
}

export const useDeleteSelection = create<DeleteState>((set) => ({
  mode: 'visible',
  gesture: null,
  remove: false,
  diameter: 48,
  selection: null,
  count: 0,
  stage: 0,
  setMode: (mode) => set({ mode, gesture: null, selection: null, count: 0, stage: 0 }),
  setGesture: (gesture) => set({ gesture, stage: 0 }),
  setRemove: (remove) => set({ remove, stage: 0 }),
  setDiameter: (diameter) => set({ diameter: Math.max(2, Math.min(200, diameter)), stage: 0 }),
  setSelection: (selection) => set({
    selection,
    count: selection?.reduce((n, selected) => n + selected, 0) ?? 0,
    stage: 0,
  }),
  setStage: (stage) => set({ stage }),
  reset: () => set({ gesture: null, selection: null, count: 0, stage: 0 }),
}))
