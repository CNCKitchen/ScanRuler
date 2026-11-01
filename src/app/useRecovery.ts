// SPDX-License-Identifier: AGPL-3.0-only
// Whether there is unsaved work, and a checkpoint of it kept in this browser
// (recoveryStorage.ts) for a page closed or crashed before Save Project.
// Only the fields a project saves are watched: picking, progress and
// pointer motion must not serialise a large measurement set. A draft with
// work in it is not in a project, but it still earns the leave-page
// warning. A checkpoint comes back packed into a project file and opened
// the way any project is.

import { useEffect, useRef, useState } from 'react'
import { draftHolds, useStore } from '../state/store'
import { flatDraftHolds, useFlat } from '../state/flatStore'
import { dimHolds } from '../state/historyStore'
import { useDeviation } from '../state/deviationStore'
import { useThickness } from '../state/thicknessStore'
import { projectSections } from './projectSections'
import { watchUnsaved } from './project'
import { useShell } from '../state/shellStore'
import { ProjectClient } from '../core/project/projectClient'
import { RecoveryStorage, staleCheckpoints, type CheckpointInfo } from './recoveryStorage'
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
  const forgetCheckpoint = useRef(() => {})
  const storage = useRef<RecoveryStorage | null>(null)
  const [state, setState] = useState({ dirty: false, status: '', available: [] as CheckpointInfo[], working: false })
  const update = (patch: Partial<typeof state>) => setState((s) =>
    (Object.keys(patch) as (keyof typeof state)[]).every((key) => s[key] === patch[key]) ? s : { ...s, ...patch })

  useEffect(() => {
    const db = new RecoveryStorage()
    storage.current = db
    const release = db.hold()
    let disposed = false, writing = false, pending = true
    let checkpointKey = '', timer: ReturnType<typeof setTimeout> | undefined
    cache.invalidate()
    saved.current ??= cache.inspect().signature
    const reportError = (error: unknown) => {
      if (!disposed) update({ status: `Local recovery unavailable: ${error instanceof Error ? error.message : String(error)}. Use Save Project.` })
    }
    // What closed pages left behind, less what is too old or too many to keep.
    void db.left().then(async (rows) => {
      const stale = new Set(staleCheckpoints(rows, Date.now()))
      for (const id of stale) await db.remove(id)
      if (!disposed) update({ available: rows.filter((row) => !stale.has(row.id)) })
    }).catch(reportError)

    // What was last found, for a question asked while the session is busy.
    let dirty = false
    const inspect = () => {
      if (disposed || callbacks.current.blocked()) return null
      const current = cache.inspect()
      const { signature } = current
      hadContent.current ||= current.hasContent
      dirty = (hadContent.current && signature !== saved.current) || hasDraft()
      update({ dirty })
      return current
    }
    // The same flag for the session's readout (session.state's
    // project.unsaved), found as it is asked for rather than when the
    // throttled look next comes round.
    const unwatchUnsaved = watchUnsaved(() => {
      try {
        inspect()
      } catch (error) {
        reportError(error)
      }
      return dirty
    })
    const checkpoint = async () => {
      if (!pending || writing || disposed) return
      try {
        const current = inspect()
        if (!current) return
        pending = false
        const snapshot = cache.forWrite()
        if (current.signature === checkpointKey) { cache.release(snapshot); return }
        // Deleting the last piece of work is a change worth saving too.
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
    forgetCheckpoint.current = () => { checkpointKey = '' }
    // Zustand stores use immutable updates; watch only project fields. Picking,
    // progress and pointer motion must not serialize a large measurement set.
    const watch = <T extends object>(store: { subscribe: (fn: (s: T, prev: T) => void) => () => void }, keys: (keyof T)[], notify = changed) =>
      store.subscribe((s, prev) => { if (keys.some((k) => s[k] !== prev[k])) notify() })
    const unsub = [
      watch(useStore, ['projectName', 'fileName', 'busy', 'appliedAlignment', 'elements', 'dimensions', 'nextId', 'nextNumber', 'nextOfKind', 'nextDimensionId', 'nextOfDimGroup', 'settings', 'selectMode', 'showLabels', 'showBackfaces', 'sections', 'nextSectionNumber']),
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
      unwatchUnsaved()
      clearTimeout(timer)
      clearInterval(interval)
      unsub.forEach((fn) => fn())
      document.removeEventListener('visibilitychange', visibility)
      window.removeEventListener('beforeunload', beforeUnload)
      refresh.current = () => {}
      forgetCheckpoint.current = () => {}
      storage.current = null
      release()
      db.close()
    }
  }, [cache])

  const markSaved = (snapshot: Snapshot) => {
    saved.current = cache.key(snapshot)
    refresh.current()
    // Saved work needs no checkpoint: a later change writes a new one, even
    // back to a state checkpointed before, since the slot is gone.
    forgetCheckpoint.current()
    const db = storage.current
    void db?.remove(db.id).catch(() => {})
  }
  const restored = () => { saved.current = null; update({ available: [] }); refresh.current() }
  const restore = async (id: string) => {
    const db = storage.current
    if (!db || callbacks.current.blocked()) return
    update({ working: true })
    let worker: ProjectClient | null = null
    try {
      const { manifest, members } = await db.read(id)
      worker = new ProjectClient()
      const bytes = await worker.pack(manifest, members)
      await callbacks.current.open(new File([bytes as BlobPart], 'recovered.scanruler'))
      // The work is this page's now, checkpointed in this page's own slot.
      await db.remove(id).catch(() => {})
    } catch (error) {
      update({ status: `Recovery failed: ${error instanceof Error ? error.message : String(error)}` })
    } finally { worker?.dispose(); update({ working: false }) }
  }
  const discard = async (id: string) => {
    if (!storage.current) return
    update({ working: true })
    try {
      await storage.current.remove(id)
      update({ available: await storage.current.left() })
    } catch (error) { update({ status: `Could not discard checkpoint: ${String(error)}` }) }
    finally { update({ working: false }) }
  }
  return { ...state, restore, discard, markSaved, restored }
}
