// SPDX-License-Identifier: AGPL-3.0-only
// The surface marking tools, held once for the whole app.
//
// Two things mark scan surface by hand — an element fitted to exactly the
// triangles the user chose, and the local fine fit's "these surfaces really are
// the part" — and there is only ever one marking live, because the scene holds
// a single mask. So the tools live here rather than once per workspace: the
// same three gestures, the same brush, the same erase switch, and above all the
// same way back to the camera, whichever of the two asked for them.
//
// Which session is open is still the business of the workspace that opened it
// (store.selectMode with a fit draft, deviationStore.marking); this is only the
// tool in the user's hand while one is.

import { create } from 'zustand'
import type { MarkGesture } from '../viewer/SceneManager'

export type { MarkGesture }

interface MarkState {
  /** Which gesture is armed, or null for plain navigation. Null is the state a
   *  session opens in and the one Escape returns to: a marking gesture takes
   *  both plain mouse drags away from the camera, so it is only ever live
   *  because the user just asked for it. */
  gesture: MarkGesture | null
  /** The gesture takes marking away instead of laying it down. The right button
   *  always does, and Alt inverts either way. */
  erase: boolean
  /** Take surface facing away from the camera as well. Survives a session, as a
   *  property of the part being marked rather than of the marking. */
  backfaces: boolean
  /** Brush width on the surface, in mm — a diameter, the way a cutter or a
   *  drill is called out. Sized to the part when one is loaded: a brush is only
   *  usable if it is small against what it marks. */
  diameter: number
  /** Vertices marked right now. The marking itself lives in the scene — this is
   *  the one number the panels need from it. */
  count: number

  setGesture: (g: MarkGesture | null) => void
  setErase: (v: boolean) => void
  setBackfaces: (v: boolean) => void
  setDiameter: (mm: number) => void
  setCount: (n: number) => void
  /** Put the tools back in their opening state — no gesture live, nothing
   *  marked. Called when a session opens and when one workspace hands over to
   *  another, so a gesture can never be live because of something the user did
   *  somewhere else. */
  reset: () => void
  /** Size the brush to the part just loaded: 8% of the scan's radius marks a
   *  feature in a few strokes without swallowing its neighbours, on a
   *  fingertip-sized part as much as on a bumper. */
  sizeToModel: (modelSize: number) => void
}

export const useMark = create<MarkState>((set) => ({
  gesture: null,
  erase: false,
  backfaces: false,
  diameter: 2,
  count: 0,

  setGesture: (gesture) => set({ gesture }),
  setErase: (erase) => set({ erase }),
  setBackfaces: (backfaces) => set({ backfaces }),
  setDiameter: (diameter) => set({ diameter: Math.max(diameter, 2e-4) }),
  setCount: (count) => set({ count }),
  reset: () => set({ gesture: null, erase: false, count: 0 }),
  sizeToModel: (modelSize) => set({ diameter: Math.max(modelSize * 0.08, 2e-3) }),
}))

/** The brush spans a fraction of the part: fine enough for a small boss or to
 *  work along an edge, wide enough to sweep a face in a couple of strokes. */
export function brushRange(modelSize: number): { min: number; max: number } {
  const min = Math.max(modelSize * 0.008, 2e-4)
  return { min, max: Math.max(modelSize * 0.6, min * 2) }
}
