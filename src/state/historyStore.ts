// SPDX-License-Identifier: AGPL-3.0-only
import { create } from 'zustand'
import { draftHolds, useStore } from './store'
import { flatDraftHolds, useFlat } from './flatStore'
import { useDeviation } from './deviationStore'
import { useThickness } from './thicknessStore'
import { useShell, type Workspace } from './shellStore'

/** The fields of a store's state named in `keys`, as a snapshot. */
export const pick = <T, K extends keyof T>(state: T, keys: readonly K[]): Pick<T, K> =>
  Object.fromEntries(keys.map((key) => [key, state[key]])) as Pick<T, K>

function captureCore() {
  return {
    measure: pick(useStore.getState(), ['elements', 'dimensions', 'sections', 'nextId', 'nextNumber', 'nextOfKind', 'nextDimensionId', 'nextOfDimGroup', 'nextSectionNumber', 'appliedAlignment', 'modelCenter']),
    flat: pick(useFlat.getState(), ['subject', 'sheets', 'pxPerMm', 'calSource', 'elements', 'nextId', 'nameCounts', 'dimensions', 'nextDimId', 'dimCounts', 'datum', 'counts', 'nextCountId', 'notes', 'nextNoteId', 'turns', 'mirror', 'splitAxes', 'edgeSensitivity', 'showEdges', 'snapToEdge', 'showGrid']),
    deviation: pick(useDeviation.getState(), ['source', 'align', 'globalAlign', 'pairs', 'localMaxDistance', 'targetId', 'targetSide', 'targetFacingDeg', 'targetScope', 'scopeCount', 'showElement', 'range', 'rangeAuto', 'maxDistance', 'maxDistanceAuto', 'bands', 'tolerance', 'showHistogram', 'showNominal', 'showScan', 'showMap', 'split', 'probes', 'nextProbeId']),
    thickness: pick(useThickness.getState(), ['method', 'maxThickness', 'maxThicknessAuto', 'coneRays', 'coneAngleDeg', 'normalDeviationDeg', 'low', 'high', 'scaleAuto', 'bands', 'limit', 'showHistogram', 'probes', 'nextProbeId']),
    scope: hooks.getScope(),
    // The scan's file as the session holds it, by identity: an edit taken
    // into use puts another in its place, and a step back puts the one
    // before back — see beforeRestore.
    scan: hooks.getScan(),
  }
}

/** The app's own part of a snapshot; a plugin's sections sit beside it
 *  under their keys. */
export type CoreHistorySnapshot = ReturnType<typeof captureCore>
export type HistorySnapshot = CoreHistorySnapshot & { [key: string]: unknown }
export type HistoryPatch = Partial<CoreHistorySnapshot> & { [key: string]: unknown }

// ---- What plugins add ----------------------------------------------------------

/** One store's part in the history, kept under `key` beside the app's. */
export interface HistorySection<T = unknown> {
  key: string
  capture(): T
  /** Put a captured value back. */
  apply(value: T): void
  /** How a change is told: field by field — arrays element by element — the
   *  default; or by the captured value's identity, for a value that is
   *  replaced whole and never edited in place. */
  compare?: 'fields' | 'identity'
}

/** A store's actions that are each one step of the history, labelled
 *  "`label`: action" — the action's own words from `labels`, or its name
 *  split into words. */
export interface HistoryActions {
  store: { getState: () => object; setState: (patch: object) => void }
  names: readonly string[]
  label: string
  labels?: Readonly<Record<string, string>>
}

/** A history of an editor's own, which undo and redo walk instead of the
 *  app's while it is active — and which opens the editor's workspace. */
export interface LocalHistory {
  workspace: Workspace
  /** How a step of it is named on the undo keys. */
  label: string
  active(): boolean
  canUndo(): boolean
  canRedo(): boolean
  undo(): void
  redo(): void
}

/** Everything one participant — a plugin, or a part of one — adds. */
export interface HistoryParticipant {
  sections?: readonly HistorySection[]
  actions?: readonly HistoryActions[]
  /** Something is open or running that a step must not move under. */
  blocked?(): boolean
  local?: LocalHistory
  /** A React hook the undo keys call, so they are drawn again when
   *  `blocked` or `local` may have changed. Read from the participants
   *  registered before the keys are first drawn. */
  useWatch?(): unknown
  /** Around a step: after the app has put the scan and the alignment of the
   *  other side in place, before the stores are; and after the app has
   *  measured again what the step changed. */
  beforeRestore?(patch: HistoryPatch): Promise<void>
  afterRestore?(patch: HistoryPatch, previous: HistorySnapshot): Promise<void>
}

const participants: HistoryParticipant[] = []

export function captureHistory(): HistorySnapshot {
  const snapshot: HistorySnapshot = captureCore()
  for (const p of participants) for (const s of p.sections ?? []) snapshot[s.key] = s.capture()
  return snapshot
}

/** How each key of a snapshot is compared: the app's identity keys, and the
 *  sections that asked for it. */
function comparedByIdentity(key: string): boolean {
  if (key === 'scope' || key === 'scan') return true
  for (const p of participants) for (const s of p.sections ?? []) if (s.key === key) return s.compare === 'identity'
  return false
}

interface Entry { before: HistoryPatch; after: HistoryPatch; label: string; workspace: Workspace; group: number }
interface HistoryState { past: Entry[]; future: Entry[]; restoring: boolean; importing: boolean; revision: number }
export const useHistory = create<HistoryState>(() => ({ past: [], future: [], restoring: false, importing: false, revision: 0 }))
const LIMIT = 64
const actionLabels: Record<string, string> = {
  commitDraft: 'save element', commitDimension: 'save dimension', commitDim: 'save dimension',
  commitSection: 'save section', resolveAlign: 'best-fit alignment', addPickPoint: 'add alignment pair',
}
let depth = 0
let group = 0
let nextGroup = 0
let paused = 0
let epoch = 0

interface Hooks {
  getScope: () => Uint32Array | null
  setScope: (scope: Uint32Array | null) => void
  getScan: () => object | null
  beforeRestore: (patch: HistoryPatch) => Promise<void>
  afterRestore: (patch: HistoryPatch, previous: HistorySnapshot) => Promise<void>
  runRestore: (job: () => Promise<void>) => Promise<void>
  blocked: () => boolean
}
const defaults: Hooks = { getScope: () => null, setScope: () => {}, getScan: () => null, beforeRestore: async () => {}, afterRestore: async () => {}, runRestore: (job) => job(), blocked: () => false }
let hooks = defaults
export function configureHistory(next: Partial<Hooks>): () => void {
  hooks = { ...defaults, ...next }
  return () => { hooks = defaults }
}
export const beginHistoryGroup = () => { group = ++nextGroup }
export const endHistoryGroup = () => { group = 0 }
export function clearHistory(): void {
  epoch++
  group = 0
  useHistory.setState((s) => ({ past: [], future: [], revision: s.revision + 1 }))
}

const sameValue = (a: unknown, b: unknown) => a === b ||
  (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => value === b[index]))
const same = (a: object, b: object) => Object.keys(a).every((k) => sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
function record(before: HistorySnapshot, after: HistorySnapshot, label: string, workspace: Workspace, generation: number) {
  if (generation !== epoch) return // A source replacement starts another document.
  const keys = Object.keys(before).filter((key) =>
    comparedByIdentity(key) ? before[key] !== after[key] : !same(before[key] as object, after[key] as object))
  if (!keys.length) return
  const previous = pick(before, keys), next = pick(after, keys)
  useHistory.setState((state) => {
    const last = state.past.at(-1)
    const entry = { before: previous, after: next, label, workspace, group }
    if (group && !state.future.length && last?.group === group && last.workspace === workspace) {
      return { past: [...state.past.slice(0, -1), { ...last, before: { ...previous, ...last.before }, after: { ...last.after, ...next } }], future: [] }
    }
    return { past: [...state.past.slice(-(LIMIT - 1)), entry], future: [] }
  })
}

/** Wrap a user command, including nested store actions, as a single step. */
export function historyAction<T>(label: string, job: () => T): T {
  if (depth || paused || useHistory.getState().restoring || useStore.getState().busy || hooks.blocked()) return job()
  const before = captureHistory(), workspace = useShell.getState().workspace, generation = epoch
  depth++
  try { return job() }
  finally { depth--; record(before, captureHistory(), label, workspace, generation) }
}

/** Async geometry commands must complete before their after-state is recorded. */
export async function historyAsync(label: string, job: () => Promise<void>): Promise<void> {
  if (paused || useHistory.getState().restoring) return job()
  const before = captureHistory(), workspace = useShell.getState().workspace, generation = epoch
  paused++
  try { await job() }
  finally { paused--; record(before, captureHistory(), label, workspace, generation) }
}

/** A dimension box with something in it — a slot filled, or an edit. The
 *  empty one Add dimension leaves open for the next is not in the way —
 *  not of undo, and not of the leave-page warning (see useRecovery). */
export const dimHolds = (d: { refs: readonly (number | null)[]; editId?: number } | null) =>
  d !== null && (d.editId !== undefined || d.refs.some((r) => r !== null))

export function historyBlocked(): boolean {
  const s = useStore.getState(), f = useFlat.getState(), d = useDeviation.getState(), t = useThickness.getState()
  // A kind merely in hand — the empty draft Create leaves behind — blocks
  // nothing; a box with work in it does.
  return useHistory.getState().restoring || paused > 0 || hooks.blocked() || s.busy || f.imageBusy ||
    d.nominalBusy || d.alignStatus === 'running' || d.mapStatus === 'running' || t.status === 'running' ||
    !!(draftHolds(s.draft) || dimHolds(s.dimDraft) || s.alignDraft || s.sectionDraft || flatDraftHolds(f.draft) || dimHolds(f.dimDraft) || f.tool.kind !== 'none') ||
    participants.some((p) => p.blocked?.())
}

/** The editor's history undo and redo walk instead of the app's, if one is
 *  active. */
export function activeLocalHistory(): LocalHistory | null {
  for (const p of participants) if (p.local?.active()) return p.local
  return null
}

function apply(patch: HistoryPatch) {
  if (patch.measure) useStore.setState(patch.measure)
  // An empty box in hand stays in hand across the step; one with work in it
  // (never, while undo is not blocked) would point at what the step moves.
  if (patch.flat) useFlat.setState((s) => ({ ...patch.flat, draft: flatDraftHolds(s.draft) ? null : s.draft, dimDraft: dimHolds(s.dimDraft) ? null : s.dimDraft, tool: { kind: 'none' }, subjectVersion: s.subjectVersion + 1 }))
  if (patch.deviation) useDeviation.setState({ ...patch.deviation, picking: false, pendingScan: null, marking: false })
  if (patch.thickness) useThickness.setState(patch.thickness)
  for (const p of participants) for (const s of p.sections ?? []) if (s.key in patch) s.apply(patch[s.key])
  if ('scope' in patch) {
    hooks.setScope(patch.scope ?? null)
    useDeviation.setState((s) => ({ scopeVersion: s.scopeVersion + 1 }))
  }
}

async function travel(redo: boolean): Promise<void> {
  if (historyBlocked()) return
  const local = activeLocalHistory()
  if (local) {
    useShell.getState().setWorkspace(local.workspace)
    if (redo) local.redo(); else local.undo()
    return
  }
  const entry = (redo ? useHistory.getState().future : useHistory.getState().past).at(-1)
  if (!entry) return
  const patch = redo ? entry.after : entry.before
  const previous = captureHistory()
  useHistory.setState({ restoring: true })
  epoch++
  try {
    await hooks.runRestore(async () => {
      await hooks.beforeRestore(patch)
      for (const p of participants) await p.beforeRestore?.(patch)
      apply(patch)
      useShell.getState().setWorkspace(entry.workspace)
      useHistory.setState((s) => redo
        ? { future: s.future.slice(0, -1), past: [...s.past, entry], revision: s.revision + 1 }
        : { past: s.past.slice(0, -1), future: [...s.future, entry], revision: s.revision + 1 })
      await hooks.afterRestore(patch, previous)
      for (const p of participants) await p.afterRestore?.(patch, previous)
      useStore.getState().setStatus(`${redo ? 'Redone' : 'Undone'}: ${entry.label}.`)
    })
  } catch (error) {
    // A participant that failed after the app's own part may have left the
    // app busy: nothing is running any more.
    useStore.setState({ busy: false })
    useStore.getState().setError(`History could not be restored — ${error instanceof Error ? error.message : String(error)}`)
  } finally { useHistory.setState({ restoring: false }) }
}
export const undo = () => travel(false)
export const redo = () => travel(true)

/** Explicit action lists exclude worker results, pointer hover and camera
 * navigation. Immutable store data is shared; files and map buffers are absent. */
let wrapActions: ((a: HistoryActions) => () => void) | null = null

/** Take part in the history — see HistoryParticipant. The returned function
 *  ends it. */
export function registerHistory(participant: HistoryParticipant): () => void {
  participants.push(participant)
  const unwrap = wrapActions ? (participant.actions ?? []).map((a) => wrapActions!(a)) : []
  return () => {
    unwrap.forEach((u) => u())
    const i = participants.indexOf(participant)
    if (i >= 0) participants.splice(i, 1)
  }
}

/** The participants' watch hooks, as the undo keys call them. */
export const historyWatchers = (): (() => unknown)[] => participants.flatMap((p) => (p.useWatch ? [p.useWatch] : []))

export function installHistory(): () => void {
  const cleanups: (() => void)[] = []
  function wrap<T extends object>(store: { getState: () => T; setState: (patch: Partial<T>) => void }, names: (keyof T)[], workspace: string, labels: Readonly<Record<string, string>> = actionLabels) {
    const original = store.getState()
    const patch: Partial<T> = {}
    for (const name of names) {
      const fn = original[name]
      if (typeof fn !== 'function') throw new Error(`Missing history action: ${String(name)}`)
      const label = `${workspace}: ${labels[String(name)] ?? actionLabels[String(name)] ?? String(name).replace(/([A-Z])/g, ' $1').toLowerCase()}`
      const replacement = (...args: unknown[]) => historyAction(label, () => {
        const deviation = useDeviation.getState()
        const targetId = useDeviation.getState().targetId
        const oldTarget = useStore.getState().elements.find((el) => el.id === targetId)
        const result = fn(...args)
        if ((store as unknown) === useStore) {
          const target = useStore.getState().elements.find((el) => el.id === targetId)
          if (oldTarget && !target) useDeviation.getState().clearElementMap()
          else if (oldTarget && (oldTarget.fit !== target?.fit || oldTarget.extend !== target?.extend) && useDeviation.getState().source === 'element') {
            useDeviation.getState().clearProbes()
          }
        }
        const nextDeviation = useDeviation.getState()
        if (nextDeviation.source === 'element' && (deviation.targetSide !== nextDeviation.targetSide ||
          deviation.targetFacingDeg !== nextDeviation.targetFacingDeg || deviation.targetScope !== nextDeviation.targetScope ||
          deviation.scopeVersion !== nextDeviation.scopeVersion)) nextDeviation.clearProbes()
        // Capture section sheets in the same step as deletion, before the UI
        // effect that normally removes orphaned sheets has a chance to run.
        if (name === 'removeSection') useFlat.getState().dropSections(useStore.getState().sections.map((s) => s.id))
        return result
      })
      patch[name] = replacement as T[keyof T]
      cleanups.push(() => { if (store.getState()[name] === replacement) store.setState({ [name]: fn } as Partial<T>) })
    }
    store.setState(patch)
    return () => {
      for (const name of names) {
        const fn = original[name]
        if (store.getState()[name] === patch[name]) store.setState({ [name]: fn } as Partial<T>)
      }
    }
  }
  wrap(useStore, ['commitDraft', 'pickDraftPoint', 'removeElement', 'toggleElementVisible', 'setAllElementsVisible', 'commitDimension', 'removeDimension', 'toggleDimensionVisible', 'setAllDimensionsVisible', 'commitSection', 'removeSection', 'toggleSectionVisible', 'setAllSectionsVisible'], '3D Measure')
  wrap(useFlat, ['commitDraft', 'deleteElement', 'toggleElementVisible', 'setAllElementsVisible', 'commitDim', 'deleteDimension', 'toggleDimensionVisible', 'setAllDimensionsVisible', 'finishCount', 'deleteCount', 'toggleCountVisible', 'addNote', 'setNoteText', 'moveNote', 'finishNote', 'deleteNote', 'toggleNoteVisible', 'addDatumPick', 'clearDatum', 'turnSheet', 'mirrorSheet', 'applyCalibration', 'applyProfile', 'setSplitAxes', 'setEdgeSensitivity', 'setShowEdges', 'setSnapToEdge', 'setShowGrid'], '2D Measure')
  wrap(useDeviation, ['setSource', 'setTarget', 'flipTargetSide', 'setTargetFacing', 'setShowElement', 'setTargetScope', 'markScope', 'clearScope', 'resolveAlign', 'revertToGlobal', 'clearAlign', 'setLocalMaxDistance', 'setRange', 'setMaxDistance', 'setBands', 'setTolerance', 'setShowHistogram', 'setShowNominal', 'setShowScan', 'setShowMap', 'setSplit', 'addProbe', 'removeProbe', 'clearProbes', 'addPickPoint', 'undoPair', 'clearPairs'], 'Deviation')
  wrap(useThickness, ['setMethod', 'setMaxThickness', 'setConeRays', 'setConeAngle', 'setNormalDeviation', 'setLow', 'setHigh', 'setBands', 'setLimit', 'setShowHistogram', 'addProbe', 'removeProbe', 'clearProbes'], 'Thickness')
  // The participants' actions: those registered already, and those that
  // register while the history stands.
  const wrapOf = (a: HistoryActions) =>
    wrap(a.store as { getState: () => Record<string, unknown>; setState: (p: Record<string, unknown>) => void }, [...a.names], a.label, a.labels)
  const unwrapParticipants = participants.flatMap((p) => (p.actions ?? []).map(wrapOf))
  wrapActions = wrapOf
  return () => {
    wrapActions = null
    unwrapParticipants.reverse().forEach((u) => u())
    cleanups.reverse().forEach((cleanup) => cleanup())
    clearHistory()
  }
}
