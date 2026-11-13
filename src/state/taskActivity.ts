// SPDX-License-Identifier: AGPL-3.0-only
import { create } from 'zustand'
import { historyLimit, readTaskHistory, taskRecord, writeTaskHistory, type TaskOutcome, type TaskRecord } from './taskHistory'

export interface TaskProgress {
  text: string
  percent: number | null
}

export interface TaskReport extends TaskProgress {
  label: string
  startedAt: number
  updatedAt: number | null
  notice?: string
}

export function processDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export function progressPhaseText(text: string, percent: number | null): string {
  if (percent === null) return text
  return text.replace(/\s*(?::|-)?\s*(\d+(?:\.\d+)?)%\s*$/, (suffix, value: string) =>
    Number(value) === percent ? '' : suffix)
}

interface TaskActivity {
  tasks: Record<string, TaskReport>
  history: TaskRecord[]
  storageWarning: string | null
  setTask(id: string, progress: TaskProgress | null): void
  heardTask(id: string): void
  finishTask(id: string, outcome: TaskOutcome, message?: string): void
  timeoutTask(id: string, message: string): void
  recordObserved(task: TaskReport, outcome: TaskOutcome, message: string): void
  acknowledgeHistory(): void
  clearHistory(): void
}

let history: TaskRecord[] = []
let storageWarning: string | null = null
if (typeof window !== 'undefined') {
  try { history = readTaskHistory(window.sessionStorage) }
  catch (error) {
    console.warn('Process history could not be restored.', error)
    storageWarning = 'Process history could not be restored. Previous activity may be unavailable.'
  }
}

export const useTaskActivity = create<TaskActivity>((set) => ({
  tasks: {},
  history,
  storageWarning,
  setTask: (id, progress) => set((state) => {
    const tasks = { ...state.tasks }
    if (progress) {
      const before = tasks[id]
      const now = Date.now()
      tasks[id] = {
        ...progress,
        label: before?.label ?? progress.text,
        startedAt: before?.startedAt ?? now,
        updatedAt: before ? now : null,
        ...(before?.notice ? { notice: before.notice } : {}),
      }
    }
    else {
      // Older callers only report that activity ended, not whether it succeeded.
      const task = tasks[id]
      delete tasks[id]
      if (task) return { tasks, history: [taskRecord(task, 'unknown'), ...state.history].slice(0, historyLimit) }
    }
    return { tasks }
  }),
  heardTask: (id) => set((state) => {
    const task = state.tasks[id]
    return task ? { tasks: { ...state.tasks, [id]: { ...task, updatedAt: Date.now() } } } : state
  }),
  finishTask: (id, outcome, message) => set((state) => {
    const task = state.tasks[id]
    if (!task) return state
    const tasks = { ...state.tasks }
    delete tasks[id]
    return { tasks, history: [taskRecord(task, outcome, message ?? (task.notice ? 'A late reply arrived after the response timeout.' : null)),
      ...state.history].slice(0, historyLimit) }
  }),
  timeoutTask: (id, message) => set((state) => {
    const task = state.tasks[id]
    if (!task || task.notice) return state
    return {
      tasks: { ...state.tasks, [id]: { ...task, notice: message } },
      history: [taskRecord(task, 'timed-out', message), ...state.history].slice(0, historyLimit),
    }
  }),
  recordObserved: (task, outcome, message) => set((state) => ({
    history: [taskRecord(task, outcome, message), ...state.history].slice(0, historyLimit),
  })),
  acknowledgeHistory: () => set((state) => ({ history: state.history.map(record => ({ ...record, acknowledged: true })) })),
  clearHistory: () => set({ history: [] }),
}))

// Keep progress persistence bounded; starts and terminal outcomes are written immediately.
if (typeof window !== 'undefined') {
  let timer: ReturnType<typeof setTimeout> | undefined
  let failed = false
  const flush = () => {
    clearTimeout(timer)
    timer = undefined
    const state = useTaskActivity.getState()
    try { writeTaskHistory(window.sessionStorage, state.tasks, state.history) }
    catch (error) {
      if (failed) return
      failed = true
      console.warn('Process history could not be saved.', error)
      useTaskActivity.setState({ storageWarning: 'Process history cannot be saved in this tab. Reload recovery is unavailable.' })
    }
  }
  useTaskActivity.subscribe((state, before) => {
    if (state.tasks === before.tasks && state.history === before.history) return
    if (state.history !== before.history || Object.keys(state.tasks).length !== Object.keys(before.tasks).length) flush()
    else timer ??= setTimeout(flush, 1000)
  })
  window.addEventListener('pagehide', flush)
  flush()
}
