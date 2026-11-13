// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { processDuration, progressPhaseText, useTaskActivity, type TaskReport } from '../state/taskActivity'
import { diagnosticsReport, needsAttention, outcomeLabel } from '../state/taskHistory'
import { InfoDot } from './InfoDot'

export function ProcessReporting({ active, open, phase, percent, recent, error, onClose, onView }: {
  active: boolean; open: boolean; phase: string; percent: number | null
  recent: boolean; error: string | null; onClose(): void; onView(recent: boolean): void
}) {
  const tasks = useTaskActivity((s) => s.tasks)
  const history = useTaskActivity((s) => s.history)
  const storageWarning = useTaskActivity((s) => s.storageWarning)
  const tracked = Object.keys(tasks).length > 0
  const [now, setNow] = useState(Date.now)
  const [observed, setObserved] = useState<TaskReport | null>(null)
  const [copyError, setCopyError] = useState('')
  const [copyNotice, setCopyNotice] = useState<{ left: number; bottom: number } | null>(null)
  const box = useRef<HTMLElement>(null)
  const height = useRef(220)
  const hadTracked = useRef(false)
  useEffect(() => {
    if (tracked) hadTracked.current = true
    if (!active || tracked) {
      if (!active && observed && !hadTracked.current && open && !recent) useTaskActivity.getState().recordObserved(observed, error ? 'failed' : 'unknown',
        error || 'Application activity ended without a reported outcome.')
      if (!active) hadTracked.current = false
      setObserved(null)
      return
    }
    const at = Date.now()
    setObserved((before) => before?.text === (phase || 'Operation pending') && before.percent === percent ? before : ({
      text: phase || 'Operation pending',
      percent,
      label: 'Application activity',
      startedAt: before?.startedAt ?? at,
      updatedAt: before ? at : null,
    }))
  }, [active, tracked, phase, percent, error, observed, open, recent])
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [active])
  useLayoutEffect(() => {
    if (open && active && !recent && box.current) height.current = box.current.getBoundingClientRect().height
  }, [open, active, recent, tasks, observed])
  useEffect(() => {
    if (copyNotice === null) return
    const timer = window.setTimeout(() => setCopyNotice(null), 2500)
    return () => window.clearTimeout(timer)
  }, [copyNotice])

  if (!open && copyNotice === null) return null
  const copy = async (button: HTMLButtonElement) => {
    const anchor = button.getBoundingClientRect()
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable in this browser.')
      await navigator.clipboard.writeText(diagnosticsReport(tasks, history))
      setCopyError('')
      setCopyNotice({
        left: Math.max(12, Math.min(anchor.left, window.innerWidth - Math.min(340, window.innerWidth - 24) - 12)),
        bottom: window.innerHeight - anchor.top + 8,
      })
    } catch (error) {
      setCopyNotice(null)
      setCopyError(`Copy failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const showHistory = recent || !active
  const recentEntries = [...history.filter(needsAttention), ...history.filter(record => !needsAttention(record))]
  const entries = Object.entries(tasks)
  if (entries.length === 0 && observed) entries.push(['application', observed])
  const firstStarted = Math.min(now, ...entries.map(([, task]) => task.startedAt))
  const lastUpdated = Math.max(0, ...entries.map(([, task]) => task.updatedAt ?? 0))
  return (
    <>
    {open && <section ref={box} id="process-reporting" className={`process-reporting${showHistory ? ' process-reporting-history' : ''}`}
      style={showHistory ? { height: height.current } : undefined} data-test="process-reporting" aria-label="Process reporting">
      <header>
        <span>{showHistory ? 'Recent operations' : <button className="process-reporting-title" onClick={() => onView(true)}
          title="Show recent operations">{`Processes (${entries.length || 1})`}</button>}
          <InfoDot title="Process reporting" testId="process-help">
            <p>Overall timing covers currently listed processes. Elapsed time includes waiting; a quiet interval does not necessarily mean work has stalled.</p>
            <p>Percentages apply to the reported phase, not the whole operation. Some library calls cannot report while executing.</p>
            <p>If the browser's main thread is blocked, this panel cannot update until it becomes responsive again.</p>
            <p>Recent history covers tracked requests, not proof of a valid CAD model. Application activity without a reported outcome is labelled unknown. This panel cannot cancel work.</p>
            <p>Up to 20 outcomes and pending request summaries are kept in this tab's session storage. Reload recovery is best effort; closing the tab or a browser crash may lose it. A restored pending request is interrupted, not automatically retried.</p>
            <p>Diagnostics contain timing, phases and reported errors, not geometry. Paths and URLs are redacted; review the text before sharing it.</p>
          </InfoDot>
        </span>
        {showHistory ? <button className="strip-process-toggle" aria-label="Dismiss process report" onClick={onClose}>Close</button>
          : <span className="process-reporting-notice">This panel cannot cancel work.</span>}
      </header>
      <div className="process-reporting-body">
        {showHistory ? (
          <ul aria-label="Recent operations">
            {history.length === 0 && <li>No recent outcomes recorded.</li>}
            {recentEntries.map(record => (
              <li key={record.id} data-test="process-history-entry">
                <b className={`process-outcome process-outcome-${record.outcome}`}>{outcomeLabel[record.outcome]}</b>
                <div>{record.label}</div>
                {record.message && <div>{record.message}</div>}
                <div>{record.outcome === 'interrupted' ? 'Last observed elapsed' : 'Elapsed'}: {processDuration(record.endedAt - record.startedAt)}</div>
                <div>Last phase: {record.text}</div>
                <time dateTime={new Date(record.endedAt).toISOString()}>{new Date(record.endedAt).toLocaleTimeString()}</time>
              </li>
            ))}
          </ul>
        ) : <>
        <div className="process-reporting-overall" data-test="process-overall">
          <div>Overall elapsed: {processDuration(now - firstStarted)}</div>
          <div>{lastUpdated ? `Overall last update: ${processDuration(now - lastUpdated)} ago` : 'Overall: No update received yet'}</div>
        </div>
        <ul>
          {entries.map(([id, task]) => (
            <li key={id} data-test="process-entry">
              <b>{task.label}</b>
              <div>Elapsed: {processDuration(now - task.startedAt)}</div>
              <div>{task.updatedAt === null
                ? 'No update received yet'
                : `Last update: ${processDuration(now - task.updatedAt)} ago`}</div>
              {(task.text !== task.label || task.percent !== null) && (
                <div className="process-reporting-phase">{progressPhaseText(task.text, task.percent)}{task.percent !== null ? ` (${task.percent}%)` : ''}</div>
              )}
              {task.percent !== null && <progress max={100} value={task.percent} aria-label={`${task.label}: reported phase progress`} />}
              {task.notice && <div className="process-outcome-timed-out">{task.notice}</div>}
            </li>
          ))}
        </ul>
        </>}
        {storageWarning && <p role="alert">{storageWarning}</p>}
        {copyError && <p role="alert">{copyError}</p>}
      </div>
      {showHistory && <footer className="process-reporting-actions">
        <button className="strip-process-toggle" onClick={event => void copy(event.currentTarget)} data-test="copy-process-diagnostics">Copy diagnostics</button>
        <button className="strip-process-toggle" onClick={() => useTaskActivity.getState().clearHistory()} data-test="clear-process-history">Clear history</button>
        {active && <button className="strip-process-toggle" onClick={() => onView(false)}>Active ({entries.length || 1})</button>}
      </footer>}
    </section>}
    {copyNotice !== null && <div className="process-copy-notice" style={copyNotice} role="status" data-test="process-copy-notice">
      Diagnostics copied to clipboard. No file was saved. Paste into chat or a text editor.
    </div>}
    </>
  )
}
