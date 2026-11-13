// SPDX-License-Identifier: AGPL-3.0-only
import { APP_VERSION } from '../version'
import type { TaskReport } from './taskActivity'

export type TaskOutcome = 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'timed-out' | 'unknown'

export interface TaskRecord extends TaskReport {
  id: string
  outcome: TaskOutcome
  endedAt: number
  message: string | null
  version: string
  acknowledged: boolean
}

export const historyKey = 'scanruler.process-history.v1'
export const historyLimit = 20
let nextRecord = 0

export const outcomeLabel: Record<TaskOutcome, string> = {
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted',
  'timed-out': 'Timed out waiting - work may still be running',
  unknown: 'Ended - outcome not reported',
}

export function diagnosticText(text: string): string {
  return text
    .replace(/\b(?:https?|file|blob):[^\s"'<>]+/gi, '[URL removed]')
    .replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\r\n"'<>|]*/g, '[path removed]')
    .replace(/(^|[\s("'=])\/(?:[^/\s"'<>]+\/)*[^/\s"'<>]+/g, '$1[path removed]')
    .replace(/\bauthorization\s*[:=][^\r\n]*/gi, 'authorization=[removed]')
    .replace(/\b(token|password|secret|authorization)\s*[:=]\s*\S+/gi, '$1=[removed]')
    .slice(0, 1000)
}

export function safeTask(task: TaskReport): TaskReport {
  return {
    label: diagnosticText(task.label),
    text: diagnosticText(task.text),
    percent: task.percent,
    startedAt: task.startedAt,
    updatedAt: task.updatedAt,
    ...(task.notice ? { notice: diagnosticText(task.notice) } : {}),
  }
}

export function taskRecord(task: TaskReport, outcome: TaskOutcome, message: string | null = null, endedAt = Date.now()): TaskRecord {
  return {
    ...safeTask(task),
    id: `${endedAt}-${++nextRecord}`,
    outcome,
    endedAt,
    message: message ? diagnosticText(message) : null,
    version: APP_VERSION,
    acknowledged: false,
  }
}

export function needsAttention(record: TaskRecord): boolean {
  return !record.acknowledged && (record.outcome === 'failed' || record.outcome === 'interrupted' || record.outcome === 'timed-out')
}

function isTask(value: unknown): value is TaskReport {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return typeof v.label === 'string' && typeof v.text === 'string'
    && (v.percent === null || (typeof v.percent === 'number' && Number.isFinite(v.percent) && v.percent >= 0 && v.percent <= 100))
    && isTimestamp(v.startedAt)
    && (v.updatedAt === null || isTimestamp(v.updatedAt))
    && (v.notice === undefined || typeof v.notice === 'string')
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 8.64e15
}

function isRecord(value: unknown): value is TaskRecord {
  if (!value || typeof value !== 'object' || !isTask(value)) return false
  const v = value as TaskReport & Partial<TaskRecord>
  return typeof v.id === 'string' && typeof v.outcome === 'string' && Object.hasOwn(outcomeLabel, v.outcome)
    && isTimestamp(v.endedAt)
    && (v.message === null || typeof v.message === 'string')
    && typeof v.version === 'string' && typeof v.acknowledged === 'boolean'
}

export function readTaskHistory(storage: Pick<Storage, 'getItem'>): TaskRecord[] {
  const raw = storage.getItem(historyKey)
  if (!raw) return []
  const value: unknown = JSON.parse(raw)
  if (!value || typeof value !== 'object') throw new Error('Invalid process history.')
  const data = value as Record<string, unknown>
  if (!Array.isArray(data.history) || !data.history.every(isRecord) || !Array.isArray(data.pending) || !data.pending.every(isTask)) {
    throw new Error('Invalid process history records.')
  }
  if (data.savedAt !== undefined && !isTimestamp(data.savedAt)) throw new Error('Invalid process history checkpoint.')
  const interrupted = data.pending.map(task => taskRecord(task, 'interrupted',
    'The previous page session ended before an outcome was recorded. Cause unknown; elapsed time is the last saved observation. Work was not automatically retried.',
    isTimestamp(data.savedAt) ? Math.max(task.startedAt, data.savedAt) : task.updatedAt ?? task.startedAt))
  return [...interrupted, ...data.history.map(record => ({
    ...record, ...safeTask(record), message: record.message ? diagnosticText(record.message) : null,
  }))].slice(0, historyLimit)
}

export function writeTaskHistory(storage: Pick<Storage, 'setItem'>, tasks: Record<string, TaskReport>, history: TaskRecord[]): void {
  storage.setItem(historyKey, JSON.stringify({
    savedAt: Date.now(),
    pending: Object.values(tasks).map(safeTask),
    history: history.slice(0, historyLimit),
  }))
}

export function diagnosticsReport(tasks: Record<string, TaskReport>, history: TaskRecord[]): string {
  return JSON.stringify({
    app: 'ScanRuler',
    version: APP_VERSION,
    capturedAt: new Date().toISOString(),
    active: Object.values(tasks).map(safeTask),
    recent: history.map(record => ({
      ...record, ...safeTask(record),
      message: record.message ? diagnosticText(record.message) : null,
      elapsedMs: Math.max(0, record.endedAt - record.startedAt),
    })),
  }, null, 2)
}
