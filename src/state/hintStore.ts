// SPDX-License-Identifier: AGPL-3.0-only
// Whether the guided hints are shown, and how far each workspace has got
// towards being outgrown. Both are remembered per browser, in one key: a hint
// that has done its job should not go on being shown for the rest of the
// user's life, and one that was switched off should stay off across a reload.

import { create } from 'zustand'
import type { HintTrack } from '../core/hints'

const HINTS_KEY = 'scanruler.hints'

/** Visits a workspace has to be carried through in before its ring retires.
 *
 *  Not one. Carrying a workflow through once can be an accident — a first look
 *  around that happened to end in a dimension — and a tool that draws a
 *  permanent conclusion from a single visit is one you cannot explore safely.
 *  Two separate visits is the cheapest thing that cannot happen by accident,
 *  and it means a reload always gives a hesitant user their hints back. */
const LEARNED_AFTER = 2

interface Stored {
  on: boolean
  /** Visits each workspace has been carried through to a result in. */
  runs: Partial<Record<HintTrack, number>>
}

/** Falls back to hints on and nothing run when storage is unavailable (private
 *  mode, blocked cookies) or holds something this version cannot read — a new
 *  user is the case the default has to serve. */
const stored = (): Stored => {
  try {
    const raw = localStorage.getItem(HINTS_KEY)
    if (!raw) return { on: true, runs: {} }
    const parsed = JSON.parse(raw) as Partial<Stored> & { learned?: HintTrack[] }
    // The first version of this key recorded a plain list of finished
    // workspaces. Those users are past the threshold, not back at zero.
    const runs = Array.isArray(parsed.learned)
      ? Object.fromEntries(parsed.learned.map((t) => [t, LEARNED_AFTER]))
      : (parsed.runs ?? {})
    return { on: parsed.on !== false, runs }
  } catch {
    return { on: true, runs: {} }
  }
}

const persist = (s: Stored) => {
  try {
    localStorage.setItem(HINTS_KEY, JSON.stringify(s))
  } catch {
    // Not being able to remember the choice is no reason to refuse it — the
    // switch still works for this session.
  }
}

// Which workspaces have already had this visit counted. In memory rather than
// stored, because "a visit" is exactly the life of this page: finishing,
// switching away and coming back is the same visit and must not count twice.
const countedThisVisit = new Set<HintTrack>()

interface HintState {
  on: boolean
  runs: Partial<Record<HintTrack, number>>
  /** Switching the hints back on is the way to ask for them again, so it
   *  forgets what was run — otherwise the switch would come back on and
   *  visibly do nothing for a user who had already finished every workflow. */
  setOn: (on: boolean) => void
  /** This workspace has been carried through to a result on this visit. */
  markRun: (track: HintTrack) => void
}

export const useHintPrefs = create<HintState>()((set, get) => ({
  ...stored(),

  setOn: (on) => {
    const runs = on ? {} : get().runs
    if (on) countedThisVisit.clear()
    persist({ on, runs })
    set({ on, runs })
  },

  markRun: (track) => {
    if (countedThisVisit.has(track)) return
    countedThisVisit.add(track)
    const runs = { ...get().runs, [track]: (get().runs[track] ?? 0) + 1 }
    persist({ on: get().on, runs })
    set({ runs })
  },
}))

/** Whether this workspace has been through enough visits to stop hinting. */
export const hasLearned = (s: Pick<HintState, 'runs'>, track: HintTrack): boolean =>
  (s.runs[track] ?? 0) >= LEARNED_AFTER
