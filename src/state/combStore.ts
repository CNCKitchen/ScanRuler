// SPDX-License-Identifier: AGPL-3.0-only
// The curvature comb: how sharply every edge bends, drawn along it — on the
// 2D sheet over the detected or cut edges, a shadow's outline and the arcs,
// circles and splines fitted there, and on the part over each section. A
// way of looking, like the section view: held for the session, off when the
// app opens, never saved, no step of the history. See core/flat/curvature.

import { create } from 'zustand'
import { COMB_WINDOW_DEFAULT, COMB_WINDOW_MAX, COMB_WINDOW_MIN } from '../core/flat/curvature'

/** The comb's length, as a factor on the length it is drawn at by itself. */
export const COMB_SCALE_MIN = 1 / 8
export const COMB_SCALE_MAX = 8

interface CombState {
  on: boolean
  /** The smoothing window along a chain of points, mm. */
  window: number
  /** How long the teeth are drawn, against the length combReach picks. */
  scale: number
  setOn: (on: boolean) => void
  setWindow: (mm: number) => void
  setScale: (scale: number) => void
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

export const useComb = create<CombState>((set) => ({
  on: false,
  window: COMB_WINDOW_DEFAULT,
  scale: 1,
  setOn: (on) => set({ on }),
  setWindow: (mm) => {
    if (Number.isFinite(mm)) set({ window: clamp(mm, COMB_WINDOW_MIN, COMB_WINDOW_MAX) })
  },
  setScale: (scale) => {
    if (Number.isFinite(scale)) set({ scale: clamp(scale, COMB_SCALE_MIN, COMB_SCALE_MAX) })
  },
}))
