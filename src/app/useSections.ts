// SPDX-License-Identifier: AGPL-3.0-only
// Keeping every section's cut in step with its plane: the draft's, as the
// offset is dragged, and the finished ones', which arrive from a project
// with their planes but not their polylines. The store says what plane each
// wants (frameKey) and what plane its cut was taken in (cutKey); this hook
// asks the worker for whatever is missing.
//
// Only the latest plane counts for the draft. A grip drag moves it every
// frame, and a cut takes a few milliseconds on a big scan, so at most one
// request is in flight and the draft's plane is read again when it lands —
// a stale answer is kept on screen as the preview until the fresh one
// replaces it, but never makes the draft ready.

import { useEffect, useRef, type RefObject } from 'react'
import { EDGE_MIN_FEATURE_MM } from '../core/flat/edges'
import { frameKey } from '../core/section/frame'
import type { MeshWorkerClient } from '../core/workerClient'
import { useStore } from '../state/store'

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function useSections({ clientRef }: { clientRef: RefObject<MeshWorkerClient | null> }) {
  // ---- the draft -------------------------------------------------------------
  const draftKey = useStore((s) => (s.sectionDraft?.frame ? frameKey(s.sectionDraft.frame) : null))
  const draftBusy = useRef(false)
  const pumpDraft = async () => {
    if (draftBusy.current) return
    draftBusy.current = true
    try {
      for (;;) {
        const d = useStore.getState().sectionDraft
        if (!d?.frame || d.status === 'failed') return
        const key = frameKey(d.frame)
        if (d.cutKey === key) return
        const { origin, normal } = d.frame
        try {
          const cut = await clientRef.current!.section(origin, normal, EDGE_MIN_FEATURE_MM)
          if (!useStore.getState().sectionDraft) return
          useStore.getState().resolveSectionDraft(key, cut)
        } catch (e) {
          if (!useStore.getState().sectionDraft) return
          useStore.getState().failSectionDraft(message(e))
          return
        }
      }
    } finally {
      draftBusy.current = false
    }
  }
  useEffect(() => {
    void pumpDraft()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey])

  // ---- the sections -------------------------------------------------------
  // Which sections are missing a cut for the plane they now have — one string,
  // so the effect below runs when that set changes and not on every store tick.
  const wanting = useStore((s) =>
    s.sections
      .filter((sec) => !sec.message && (!sec.cut || sec.cutKey !== frameKey(sec.frame)))
      .map((sec) => sec.id)
      .join(','),
  )
  const inFlight = useRef(new Set<number>())
  const pumpSections = () => {
    for (const sec of useStore.getState().sections) {
      if (sec.message || (sec.cut && sec.cutKey === frameKey(sec.frame))) continue
      if (inFlight.current.has(sec.id)) continue
      inFlight.current.add(sec.id)
      const key = frameKey(sec.frame)
      clientRef.current!
        .section(sec.frame.origin, sec.frame.normal, EDGE_MIN_FEATURE_MM)
        .then((cut) => useStore.getState().resolveSection(sec.id, key, cut))
        .catch((e) => useStore.getState().failSection(sec.id, message(e)))
        .finally(() => {
          inFlight.current.delete(sec.id)
          // The part may have been aligned while the cut was being taken, in
          // which case the answer was for a plane the section no longer has.
          pumpSections()
        })
    }
  }
  useEffect(() => {
    pumpSections()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanting])
}
