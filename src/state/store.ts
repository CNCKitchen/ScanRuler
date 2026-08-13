import { create } from 'zustand'
import type { FitSettings, SigmaPreset } from '../core/types'
import type { FitResult } from '../core/workerClient'

const PALETTE = ['#57b6f2', '#f2a057', '#7ed491', '#ef8080', '#c08ae0', '#e8d76f', '#5fc9bd', '#ef8ab5']

/** Colour of the nth sphere (1-based). Used for the element itself and, while
 *  it is still a draft, for the surfaces picked for it. */
export function elementColor(num: number): string {
  return PALETTE[(num - 1) % PALETTE.length]
}

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

/** A sphere fit in progress: the user's picked surface points plus the
 *  preview fit they produce. Nothing is measured until it is confirmed. */
export interface DraftFit {
  picks: [number, number, number][]
  status: 'empty' | 'fitting' | 'ready' | 'failed'
  center?: [number, number, number]
  diameter?: number
  sigma?: number
  usedPoints?: number
  regionSize?: number
  message?: string
}

interface AppState {
  fileName: string | null
  vertexCount: number
  triangleCount: number
  busy: boolean
  statusText: string
  errorText: string | null
  elements: SphereElement[]
  draft: DraftFit | null
  nextId: number
  nextNumber: number
  settings: FitSettings
  showOverlays: boolean

  setStatus: (text: string) => void
  setError: (text: string | null) => void
  beginLoad: (name: string) => void
  finishLoad: (vertexCount: number, triangleCount: number) => void
  loadFailed: (message: string) => void
  markFitting: (id: number, seeds: number[]) => void
  resolveFit: (id: number, r: FitResult) => void
  failFit: (id: number, message: string) => void
  removeElement: (id: number) => void
  clearElements: () => void
  startDraft: () => void
  setDraftPicks: (picks: [number, number, number][]) => void
  resolveDraft: (r: FitResult) => void
  failDraft: (message: string) => void
  cancelDraft: () => void
  commitDraft: () => number | null
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
  draft: null,
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
      draft: null,
      nextNumber: 1,
      vertexCount: 0,
      triangleCount: 0,
    }),

  finishLoad: (vertexCount, triangleCount) => set({ busy: false, vertexCount, triangleCount }),

  loadFailed: (message) =>
    set({ busy: false, fileName: null, statusText: '', errorText: message }),

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
  clearElements: () => set({ elements: [], draft: null, nextNumber: 1 }),

  startDraft: () => set({ draft: { picks: [], status: 'empty' }, errorText: null }),

  setDraftPicks: (picks) =>
    set((s) =>
      s.draft
        ? { draft: { picks, status: picks.length ? ('fitting' as const) : ('empty' as const) } }
        : {},
    ),

  resolveDraft: (r) =>
    set((s) =>
      s.draft
        ? {
            draft: {
              ...s.draft,
              status: 'ready' as const,
              center: r.center,
              diameter: 2 * r.radius,
              sigma: r.sigma,
              usedPoints: r.usedPoints,
              regionSize: r.regionSize,
              message: undefined,
            },
          }
        : {},
    ),

  // A failed preview keeps the picks so the user can undo the bad one instead
  // of starting over.
  failDraft: (message) =>
    set((s) => (s.draft ? { draft: { ...s.draft, status: 'failed' as const, message } } : {})),

  cancelDraft: () => set({ draft: null }),

  commitDraft: () => {
    const d = get().draft
    if (!d || d.status !== 'ready' || !d.center) return null
    const id = get().nextId
    const num = get().nextNumber
    set((s) => ({
      nextId: id + 1,
      nextNumber: num + 1,
      draft: null,
      elements: [
        ...s.elements,
        {
          id,
          name: `Sphere ${num}`,
          color: elementColor(num),
          seeds: d.picks.flat(),
          status: 'done' as const,
          center: d.center,
          diameter: d.diameter,
          sigma: d.sigma,
          usedPoints: d.usedPoints,
          regionSize: d.regionSize,
        },
      ],
    }))
    return id
  },

  setSigma: (sigma) => set((s) => ({ settings: { ...s.settings, sigma } })),
  setShowOverlays: (showOverlays) => set({ showOverlays }),
}))
