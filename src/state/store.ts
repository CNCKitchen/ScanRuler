import { create } from 'zustand'
import type { FitSettings, SigmaPreset } from '../core/types'
import type { FitResult } from '../core/workerClient'

const PALETTE = ['#57b6f2', '#f2a057', '#7ed491', '#ef8080', '#c08ae0', '#e8d76f', '#5fc9bd', '#ef8ab5']

export interface SphereElement {
  id: number
  name: string
  color: string
  seeds: number[]
  status: 'fitting' | 'done'
  center?: [number, number, number]
  diameter?: number
  sigma?: number
  usedPoints?: number
  regionSize?: number
}

interface AppState {
  fileName: string | null
  vertexCount: number
  triangleCount: number
  busy: boolean
  statusText: string
  errorText: string | null
  elements: SphereElement[]
  nextId: number
  nextNumber: number
  settings: FitSettings
  showOverlays: boolean

  setStatus: (text: string) => void
  setError: (text: string | null) => void
  beginLoad: (name: string) => void
  finishLoad: (vertexCount: number, triangleCount: number) => void
  loadFailed: (message: string) => void
  addPending: (seeds: number[]) => number
  markFitting: (id: number, seeds: number[]) => void
  resolveFit: (id: number, r: FitResult) => void
  failFit: (id: number, message: string) => void
  removeElement: (id: number) => void
  clearElements: () => void
  setSigma: (k: SigmaPreset) => void
  setShowOverlays: (v: boolean) => void
}

export const useStore = create<AppState>()((set, get) => ({
  fileName: null,
  vertexCount: 0,
  triangleCount: 0,
  busy: false,
  statusText: '',
  errorText: null,
  elements: [],
  nextId: 1,
  nextNumber: 1,
  settings: { method: 'gaussian', sigma: 3 },
  showOverlays: true,

  setStatus: (statusText) => set({ statusText }),
  setError: (errorText) => set({ errorText }),

  beginLoad: (name) =>
    set({
      busy: true,
      fileName: name,
      statusText: 'Reading file…',
      errorText: null,
      elements: [],
      nextNumber: 1,
      vertexCount: 0,
      triangleCount: 0,
    }),

  finishLoad: (vertexCount, triangleCount) => set({ busy: false, vertexCount, triangleCount }),

  loadFailed: (message) =>
    set({ busy: false, fileName: null, statusText: '', errorText: message }),

  addPending: (seeds) => {
    const id = get().nextId
    const num = get().nextNumber
    set((s) => ({
      nextId: id + 1,
      nextNumber: num + 1,
      elements: [
        ...s.elements,
        { id, name: `Sphere ${num}`, color: PALETTE[(num - 1) % PALETTE.length], seeds, status: 'fitting' as const },
      ],
    }))
    return id
  },

  markFitting: (id, seeds) =>
    set((s) => ({
      elements: s.elements.map((e) => (e.id === id ? { ...e, seeds, status: 'fitting' as const } : e)),
    })),

  resolveFit: (id, r) =>
    set((s) => ({
      elements: s.elements.map((e) =>
        e.id === id
          ? {
              ...e,
              status: 'done' as const,
              center: r.center,
              diameter: 2 * r.radius,
              sigma: r.sigma,
              usedPoints: r.usedPoints,
              regionSize: r.regionSize,
            }
          : e,
      ),
    })),

  // A failed re-fit keeps the element's previous result; a failed first fit
  // removes the placeholder entry.
  failFit: (id, message) =>
    set((s) => ({
      errorText: message,
      elements: s.elements.flatMap((e) => {
        if (e.id !== id) return [e]
        return e.center ? [{ ...e, status: 'done' as const }] : []
      }),
    })),

  removeElement: (id) => set((s) => ({ elements: s.elements.filter((e) => e.id !== id) })),
  clearElements: () => set({ elements: [], nextNumber: 1 }),
  setSigma: (sigma) => set((s) => ({ settings: { ...s.settings, sigma } })),
  setShowOverlays: (showOverlays) => set({ showOverlays }),
}))
