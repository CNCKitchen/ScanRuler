// SPDX-License-Identifier: AGPL-3.0-only
// Machine status strip: ready-lamp, what the tool is doing right now, the
// running tally of what has been measured, process details, and the imprint.

import { useStore } from '../state/store'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { pluginBusy, useCommandActivity, watchSession } from '../commands/activity'
import { useAgentLink } from '../commands/agentLink'
import { progressPhaseText, useTaskActivity } from '../state/taskActivity'
import { needsAttention } from '../state/taskHistory'
import { useDeviation } from '../state/deviationStore'
import { useThickness } from '../state/thicknessStore'
import { useFlat } from '../state/flatStore'
import { ProcessReporting } from './ProcessReporting'

export function StatusStrip() {
  const busy = useStore((s) => s.busy)
  const errorText = useStore((s) => s.errorText)
  const statusText = useStore((s) => s.statusText)
  const elements = useStore((s) => s.elements)
  const draft = useStore((s) => s.draft)
  const openImprint = useStore((s) => s.openImprint)
  // A command an agent is running: named here, for as long as it runs.
  const agent = useCommandActivity((s) => s.running)
  const agentConnected = useAgentLink((s) => s.status === 'connected')
  const tasks = useTaskActivity((s) => s.tasks)
  const history = useTaskActivity((s) => s.history)
  const attention = history.find(needsAttention)
  const taskList = Object.values(tasks)
  const task = taskList.find((t) => t.percent !== null) ?? taskList[0]
  const progress = useStore((s) => s.progress)
  const working = useStore((s) => s.working)
  const pluginWork = useSyncExternalStore(watchSession, pluginBusy, pluginBusy)
  const nominalBusy = useDeviation((s) => s.nominalBusy)
  const aligning = useDeviation((s) => s.alignStatus === 'running')
  const mapping = useDeviation((s) => s.mapStatus === 'running' || s.referenceStatus === 'running' || s.elementStatus === 'running')
  const volume = useDeviation((s) => s.volumeStatus === 'running')
  const measuring = useThickness((s) => s.status === 'running')
  const imageBusy = useFlat((s) => s.imageBusy)
  const edges = useFlat((s) => s.edgeStatus === 'running')

  const fitting = draft?.status === 'fitting' || elements.some((e) => e.status === 'fitting')
  const activity = working ?? (nominalBusy ? 'Loading reference' : imageBusy ? 'Loading image' : fitting ? 'Fitting elements'
    : aligning ? 'Aligning scan' : mapping ? 'Measuring deviation' : volume ? 'Finding volume errors'
      : measuring ? 'Measuring wall thickness' : edges ? 'Detecting image edges' : pluginWork)
  const active = Boolean(busy || agent || activity || task)
  const [processesOpen, setProcessesOpen] = useState(false)
  const [recent, setRecent] = useState(false)
  const [closeAt, setCloseAt] = useState<number | null>(null)
  const wasActive = useRef(active)
  useEffect(() => {
    if (attention) {
      setProcessesOpen(true)
      setRecent(true)
      setCloseAt(null)
    }
  }, [attention?.id])
  useEffect(() => {
    if (active) {
      if (!wasActive.current && !attention) setRecent(false)
      setCloseAt(null)
    }
    else if (wasActive.current && processesOpen && !attention) {
      setRecent(true)
      setCloseAt((history[0]?.endedAt ?? Date.now()) + 1800)
    }
    wasActive.current = active
  }, [active, processesOpen, attention, history])
  useEffect(() => {
    if (closeAt === null) return
    const timer = window.setTimeout(() => {
      setProcessesOpen(false)
      setCloseAt(null)
    }, Math.max(0, closeAt - Date.now()))
    return () => window.clearTimeout(timer)
  }, [closeAt])
  const dismiss = () => {
    useTaskActivity.getState().acknowledgeHistory()
    setProcessesOpen(false)
    setCloseAt(null)
  }
  const toggleProcesses = () => {
    if (processesOpen) dismiss()
    else {
      setRecent(!active || Boolean(attention))
      setCloseAt(null)
      setProcessesOpen(true)
    }
  }
  const lamp = errorText || attention ? 'lamp err' : active ? 'lamp busy' : 'lamp'
  const state = errorText || attention ? 'ERROR' : active ? 'WORKING' : 'READY'
  const fraction = (busy || working || aligning || mapping || volume || measuring) && progress !== null && Number.isFinite(progress)
    ? Math.round(Math.max(0, Math.min(100, progress * 100))) : null
  const percent = task ? task.percent : fraction
  const note = task?.text ?? (busy || working ? statusText || activity : activity) ?? statusText
  const phase = progressPhaseText(note, percent)

  const done = elements.filter((e) => e.fit)
  const dimensions = useStore((s) => s.dimensions)

  return (
    <>
    <ProcessReporting active={active} open={processesOpen} phase={phase} percent={percent} recent={recent}
      error={errorText} onClose={dismiss} onView={setRecent} />
    <footer className="strip">
      <div data-test="app-activity-state" role="status">
        {active || history.length > 0 ? (
          <button
            type="button"
            className="strip-process-toggle"
            data-test="process-toggle"
            aria-expanded={processesOpen}
            aria-controls="process-reporting"
            title="Show or hide process details"
            onClick={toggleProcesses}
          >
            <span className={lamp} /> {state}{state === 'WORKING' && percent !== null ? ` · phase ${percent}%` : ''}{!active ? attention ? ' · View details' : ' · Recent operations' : ''} <span aria-hidden="true">{processesOpen ? '▾' : '▴'}</span>
          </button>
        ) : <><span className={lamp} /> {state}</>}
      </div>
      {elements.length > 0 && (
        <div>
          ELEMENTS <b>{done.length}</b>
          {done.length !== elements.length && ` of ${elements.length}`} · DIM{' '}
          <b>{dimensions.length}</b>
        </div>
      )}
      <div className="msg grow">
        {errorText ? (
          <span className="warn">⚠ {errorText}</span>
        ) : agent ? (
          <span data-test="agent-running">
            <b>{agent.title}</b> <code>{agent.name}</code>
            {phase ? ` — ${phase}` : ''}
          </span>
        ) : active ? (
          <span data-test="task-progress">{phase}</span>
        ) : (
          statusText
        )}
      </div>
      <button
        className="stripimprint"
        onClick={() => openImprint(true)}
        title="Impressum & Datenschutzerklärung"
      >
        § <span className="btxt">IMPRINT</span>
      </button>
      <a href="https://www.cnckitchen.com" target="_blank" rel="noreferrer" data-test="local-note">
        {agentConnected ? (
          <>
            AGENT CONNECTED<span className="ltxt"> · WHAT IT READS GOES TO ITS AI MODEL</span>
          </>
        ) : (
          <>
            LOCAL ONLY<span className="ltxt"> · FILES NEVER LEAVE YOUR BROWSER</span>
          </>
        )}
      </a>
    </footer>
    </>
  )
}
