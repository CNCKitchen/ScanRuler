// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState } from 'react'
import { draftHolds, useStore } from '../state/store'
import { flatDraftHolds, useFlat } from '../state/flatStore'
import { dimHolds } from '../state/historyStore'
import { useDeviation } from '../state/deviationStore'
import { useThickness } from '../state/thicknessStore'
import { projectSections } from './projectSections'
import { useShell } from '../state/shellStore'
import { ProjectClient } from '../core/project/projectClient'
import { RecoveryStorage, type CheckpointInfo } from './recoveryStorage'
import { ProjectSnapshotCache, type ProjectSnapshot } from './projectSnapshot'

type Snapshot = ProjectSnapshot
export interface RecoveryStatus {
  dirty: boolean
  status: string
  available: CheckpointInfo[]
  working: boolean
  restore: (id: string) => Promise<void>
  discard: (id: string) => Promise<void>
}

/** Unfinished work in an editor — what a leave-page warning is for. A kind
 *  merely in hand, its box empty (what Create leaves behind for the next
 *  one), is not work and does not count. */
function hasDraft() {
  const s = useStore.getState(), f = useFlat.getState()
  return !!(draftHolds(s.draft) || dimHolds(s.dimDraft) || s.alignDraft || s.sectionDraft || flatDraftHolds(f.draft) || dimHolds(f.dimDraft)) ||
    projectSections().some((p) => p.hasDraft?.())
}

export function useRecovery(capture: () => Snapshot, blocked: () => boolean, open: (file: File) => Promise<void>) {
  const callbacks = useRef({ capture, blocked, open })
  callbacks.current = { capture, blocked, open }
  const [cache] = useState(() => new ProjectSnapshotCache(() => callbacks.current.capture()))
  const saved = useRef<string | null>(null)
  const hadContent = useRef(false)
  const refresh = useRef(() => {})
  const storage = useRef<RecoveryStorage | null>(null)
  const [state, setState] = useState({ dirty: false, status: '', available: [] as CheckpointInfo[], working: false })
  const update = (patch: Partial<typeof state>) => setState((s) =>
    (Object.keys(patch) as (keyof typeof state)[]).every((key) => s[key] === patch[key]) ? s : { ...s, ...patch })

  useEffect(() => {
    const db = new RecoveryStorage()
    storage.current = db
    let disposed = false, writing = false, pending = true
    let checkpointKey = '', timer: ReturnType<typeof setTimeout> | undefined
    cache.invalidate()
    saved.current ??= cache.inspect().signature
    const reportError = (error: unknown) => {
      if (!disposed) update({ status: `Local recovery unavailable: ${error instanceof Error ? error.message : String(error)}. Use Save Project.` })
    }
    void db.list().then((available) => { if (!disposed) update({ available }) }, reportError)

    const inspect = () => {
      if (disposed || callbacks.current.blocked()) return null
      const current = cache.inspect()
      const { signature } = current
      hadContent.current ||= current.hasContent
      update({ dirty: (hadContent.current && signature !== saved.current) || hasDraft() })
      return current
    }
    const checkpoint = async () => {
      if (!pending || writing || disposed) return
      try {
        const current = inspect()
        if (!current) return
        pending = false
        const snapshot = cache.forWrite()
        if (current.signature === checkpointKey) { cache.release(snapshot); return }
        // Deleting the last CAD feature is a change worth saving too.
        if (!hadContent.current) { cache.release(snapshot); return }
        writing = true
        update({ status: 'Saving local checkpoint…' })
        try { await db.write(snapshot.manifest, snapshot.members) }
        finally { cache.release(snapshot) }
        checkpointKey = current.signature
        if (!disposed) update({ status: 'Local checkpoint saved' })
      } catch (error) { reportError(error) }
      finally { writing = false }
    }
    const scheduleInspect = () => {
      // Throttle rather than debounce: continuous edits still get checkpoints.
      if (timer === undefined) timer = setTimeout(() => {
        timer = undefined
        try { inspect() } catch (error) { reportError(error) }
      }, 300)
    }
    const changed = () => {
      cache.invalidate()
      pending = true
      scheduleInspect()
    }
    refresh.current = scheduleInspect
    // Zustand stores use immutable updates; watch only project fields. Picking,
    // progress and pointer motion must not serialize a large measurement set.
    const watch = <T extends object>(store: { subscribe: (fn: (s: T, prev: T) => void) => () => void }, keys: (keyof T)[], notify = changed) =>
      store.subscribe((s, prev) => { if (keys.some((k) => s[k] !== prev[k])) notify() })
    const unsub = [
      watch(useStore, ['fileName', 'busy', 'appliedAlignment', 'elements', 'dimensions', 'nextId', 'nextNumber', 'nextOfKind', 'nextDimensionId', 'nextOfDimGroup', 'settings', 'selectMode', 'showLabels', 'showBackfaces', 'sections', 'nextSectionNumber']),
      watch(useFlat, ['imageName', 'imageVersion', 'pxPerMm', 'calSource', 'splitAxes', 'edgeSensitivity', 'showEdges', 'snapToEdge', 'showGrid', 'elements', 'nextId', 'nameCounts', 'dimensions', 'nextDimId', 'dimCounts', 'datum', 'counts', 'nextCountId', 'notes', 'nextNoteId', 'turns', 'mirror', 'subject', 'sheets']),
      watch(useDeviation, ['source', 'nominalName', 'align', 'globalAlign', 'pairs', 'localMaxDistance', 'targetId', 'targetSide', 'targetFacingDeg', 'mapFacingDeg', 'targetScope', 'scopeVersion', 'showElement', 'range', 'rangeAuto', 'maxDistance', 'maxDistanceAuto', 'bands', 'tolerance', 'showHistogram', 'showNominal', 'showScan', 'showMap', 'split', 'probes', 'nextProbeId']),
      watch(useThickness, ['status', 'method', 'maxThickness', 'maxThicknessAuto', 'coneRays', 'coneAngleDeg', 'normalDeviationDeg', 'low', 'high', 'scaleAuto', 'bands', 'limit', 'showHistogram', 'probes', 'nextProbeId']),
      watch(useShell, ['workspace']),
      // Drafts need a leave-page warning, but aren't in the project format.
      watch(useStore, ['draft', 'dimDraft', 'alignDraft', 'sectionDraft'], scheduleInspect),
      watch(useFlat, ['draft', 'dimDraft'], scheduleInspect),
      // What the sections save, and their drafts.
      ...projectSections().flatMap((p) => (p.watch ? [p.watch(changed, scheduleInspect)] : [])),
    ]
    const interval = setInterval(() => { void checkpoint() }, 2000)
    const visibility = () => { if (document.visibilityState === 'hidden') void checkpoint() }
    const beforeUnload = (event: BeforeUnloadEvent) => {
      // Inspect synchronously so a change immediately before closing is covered.
      const current = cache.inspect()
      hadContent.current ||= current.hasContent
      if (hasDraft() || (hadContent.current && current.signature !== saved.current)) {
        event.preventDefault()
        event.returnValue = ''
      }
    }
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('beforeunload', beforeUnload)
    return () => {
      disposed = true
      clearTimeout(timer)
      clearInterval(interval)
      unsub.forEach((fn) => fn())
      document.removeEventListener('visibilitychange', visibility)
      window.removeEventListener('beforeunload', beforeUnload)
      refresh.current = () => {}
      storage.current = null
      db.close()
    }
  }, [cache])

  const markSaved = (snapshot: Snapshot) => { saved.current = cache.key(snapshot); refresh.current() }
  const restored = () => { saved.current = null; update({ available: [] }); refresh.current() }
  const restore = async (id: string) => {
    if (!storage.current || callbacks.current.blocked()) return
    update({ working: true })
    let worker: ProjectClient | null = null
    try {
      const { manifest, members } = await storage.current.read(id)
      worker = new ProjectClient()
      const bytes = await worker.pack(manifest, members)
      await callbacks.current.open(new File([bytes as BlobPart], 'recovered.scanruler'))
    } catch (error) {
      update({ status: `Recovery failed: ${error instanceof Error ? error.message : String(error)}` })
    } finally { worker?.dispose(); update({ working: false }) }
  }
  const discard = async (id: string) => {
    if (!storage.current) return
    update({ working: true })
    try {
      await storage.current.remove(id)
      update({ available: (await storage.current.list()).filter((item) => item.id !== storage.current?.id) })
    } catch (error) { update({ status: `Could not discard checkpoint: ${String(error)}` }) }
    finally { update({ working: false }) }
  }
  return { ...state, restore, discard, markSaved, restored }
}
