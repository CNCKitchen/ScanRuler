// SPDX-License-Identifier: AGPL-3.0-only
// Keeping every section's cut in step with its plane: the draft's, as the
// offset is dragged, and the finished ones', which arrive from a project
// with their planes but not their polylines. The store says what plane each
// wants (frameKey) and what plane its cut was taken in (cutKey); this asks
// the worker for whatever is missing, whenever the store changes — with the
// panel open or without it, as a command makes a section too.
//
// Only the latest plane counts for the draft. A grip drag moves it every
// frame, and a cut takes a few milliseconds on a big scan, so at most one
// request is in flight and the draft's plane is read again when it lands —
// a stale answer is kept on screen as the preview until the fresh one
// replaces it, but never makes the draft ready.

import type { RefObject } from 'react'
import { EDGE_MIN_FEATURE_MM } from '../core/flat/edges'
import { frameKey } from '../core/section/frame'
import type { MeshWorkerClient } from '../core/workerClient'
import { useStore } from '../state/store'

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

type State = ReturnType<typeof useStore.getState>

/** The draft's plane, as the key its cut has to match. */
const draftKeyOf = (s: State) => (s.sectionDraft?.frame ? frameKey(s.sectionDraft.frame) : null)

/** Which sections are missing a cut for the plane they now have — one string,
 *  so a change of that set is told from any other change of the store. */
const wantingOf = (s: State) =>
  s.sections
    .filter((sec) => !sec.message && (!sec.cut || sec.cutKey !== frameKey(sec.frame)))
    .map((sec) => sec.id)
    .join(',')

export type SectionCuts = ReturnType<typeof sectionCuts>

export function sectionCuts(clientRef: RefObject<MeshWorkerClient | null>) {
  // ---- the draft -------------------------------------------------------------
  let draftJob: Promise<void> | null = null
  /** Cut the draft's plane until the cut in hand is for the plane it has now.
   *  A second call while one runs waits for the same one. */
  const pumpDraft = (): Promise<void> => {
    if (draftJob) return draftJob
    const job = (async () => {
      for (;;) {
        const d = useStore.getState().sectionDraft
        if (!d?.frame || d.status === 'failed') return
        const key = frameKey(d.frame)
        if (d.cutKey === key) return
        const { origin, normal } = d.frame
        const scanVersion = clientRef.current!.scanVersion
        try {
          const cut = await clientRef.current!.section(origin, normal, EDGE_MIN_FEATURE_MM)
          if (scanVersion !== clientRef.current!.scanVersion || !useStore.getState().sectionDraft) return
          useStore.getState().resolveSectionDraft(key, cut)
        } catch (e) {
          if (scanVersion !== clientRef.current!.scanVersion || !useStore.getState().sectionDraft) return
          useStore.getState().failSectionDraft(message(e))
          return
        }
      }
    })()
    // Settled — however quickly, even before this line — the next call
    // starts afresh.
    draftJob = job
    const done = () => { if (draftJob === job) draftJob = null }
    job.then(done, done)
    return job
  }

  // ---- the sections -------------------------------------------------------
  const inFlight = new Set<number>()
  const pumpSections = () => {
    for (const sec of useStore.getState().sections) {
      if (sec.message || (sec.cut && sec.cutKey === frameKey(sec.frame))) continue
      if (inFlight.has(sec.id)) continue
      inFlight.add(sec.id)
      const key = frameKey(sec.frame)
      const scanVersion = clientRef.current!.scanVersion
      clientRef.current!
        .section(sec.frame.origin, sec.frame.normal, EDGE_MIN_FEATURE_MM)
        .then((cut) => { if (scanVersion === clientRef.current!.scanVersion) useStore.getState().resolveSection(sec.id, key, cut) })
        .catch((e) => { if (scanVersion === clientRef.current!.scanVersion) useStore.getState().failSection(sec.id, message(e)) })
        .finally(() => {
          inFlight.delete(sec.id)
          // The part may have been aligned while the cut was being taken, in
          // which case the answer was for a plane the section no longer has.
          pumpSections()
        })
    }
  }

  /** Cut whatever is missing now, and again whenever the store changes what
   *  is missing. The returned function stops watching. */
  const watch = () => {
    void pumpDraft()
    pumpSections()
    return useStore.subscribe((s, prev) => {
      if (draftKeyOf(s) !== draftKeyOf(prev)) void pumpDraft()
      if (wantingOf(s) !== wantingOf(prev)) pumpSections()
    })
  }

  return { pumpDraft, pumpSections, watch }
}
