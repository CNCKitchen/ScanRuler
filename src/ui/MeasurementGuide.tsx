// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState } from 'react'
import { draftHolds, useStore } from '../state/store'
import { useShell } from '../state/shellStore'
import { useHistory } from '../state/historyStore'
import type { ElementKind } from '../core/types'
import { useLength } from '../app/useUnits'
import { onScan } from '../app/scanEvents'

const TASKS = [
  { label: 'Angle between flat faces', kind: 'plane', count: 2, dimension: 'angle-plane-plane', surface: 'each of the two flat faces' },
  { label: 'Distance between parallel faces', kind: 'plane', count: 2, dimension: 'dist-plane-plane', surface: 'each of the two parallel flat faces' },
  { label: 'Hole or shaft diameter', kind: 'cylinder', count: 1, dimension: 'size-diameter', surface: 'the curved wall of the hole or shaft' },
] as const
const TITLES = ['Open a scan', 'Check its scale', 'Choose a measurement', 'Fit the surfaces', 'Create the dimension', 'Try Undo and Redo', 'Save editable work']

/** Progress follows actual geometry and history. Back reviews instructions;
 * it never undoes, cancels or creates an operation behind the user's back. */
export function MeasurementGuide({ onStart }: { onStart: (kind: ElementKind) => void }) {
  const [open, setOpen] = useState(false)
  const [scaleChecked, setScaleChecked] = useState(false)
  const [taskIndex, setTaskIndex] = useState<number | null>(null)
  const [review, setReview] = useState<number | null>(null)
  const [sawUndo, setSawUndo] = useState(false)
  const [recovered, setRecovered] = useState(false)
  const file = useStore(s => s.fileName)
  const size = useStore(s => s.modelSize)
  const elements = useStore(s => s.elements)
  const dimensions = useStore(s => s.dimensions)
  const draft = useStore(s => s.draft)
  const busy = useStore(s => s.busy)
  const dimDraft = useStore(s => s.dimDraft)
  const otherDraft = useStore(s => Boolean(s.alignDraft || s.sectionDraft))
  const canUndo = useHistory(s => s.past.length > 0)
  const futureCount = useHistory(s => s.future.length)
  const undoAvailable = futureCount > 0
  const saves = useShell(s => s.saveDownloads)
  const [initialSaves, setInitialSaves] = useState(saves)
  const len = useLength()
  const task = taskIndex === null ? null : TASKS[taskIndex]
  const fitted = task ? elements.filter(e => e.kind === task.kind && e.fit).length : 0
  const measured = Boolean(task && dimensions.some(d => d.type === task.dimension))
  useEffect(() => onScan({ loaded: () => {
    // Import identity is not a filename: scanner exports often reuse a name.
    setScaleChecked(false); setTaskIndex(null); setSawUndo(false); setRecovered(false); setReview(null)
    setInitialSaves(useShell.getState().saveDownloads)
  } }), [])
  const previousHistory = useRef({ futureCount, measured })
  useEffect(() => {
    if (open && task && previousHistory.current.measured && futureCount > previousHistory.current.futureCount) setSawUndo(true)
    previousHistory.current = { futureCount, measured }
  }, [open, task, futureCount, measured])
  useEffect(() => { if (sawUndo && !undoAvailable && measured) setRecovered(true) }, [sawUndo, undoAvailable, measured])
  const step = !file ? 0 : !scaleChecked ? 1 : !task ? 2 : fitted < task.count ? 3 : !measured && !sawUndo ? 4 : !recovered ? 5 : 6
  const shown = Math.min(review ?? step, step)
  const target = shown === 0 ? '[data-test=start-scan] button' : shown === 3 ? '[data-test=create-element]' : shown === 4 ? '[data-test=add-dimension]' : shown === 5 ? '[data-test=undo]' : shown === 6 ? '[data-test=save-project]' : null
  useEffect(() => {
    if (!open || !target) return
    const control = document.querySelector(target)
    control?.classList.add('guide-target')
    return () => control?.classList.remove('guide-target')
  }, [open, target, draft?.fit, dimDraft])
  if (!open) return <button className="guide-open" data-test="open-measure-guide" onClick={() => setOpen(true)}>Guided measurement</button>
  return <section className="measurement-guide" aria-labelledby="measurement-guide-title" data-test="measurement-guide">
    <p className="guide-step" role="status">Step {shown + 1} of {TITLES.length}</p>
    <h3 id="measurement-guide-title">{TITLES[shown]}</h3>
    {shown === 0 && <p>Open your scanner’s mesh, or choose the measurement sample in the canvas. No CAD modeling is needed. If asked, choose the units used when exporting the scan.</p>}
    {shown === 1 && <>
      <p>The scan’s corner-to-corner size is approximately <strong>{len.fmt(size * 2)}</strong>. Does that make sense for the physical part?</p>
      <p>Check the export units if the scale is wrong. Before trusting a result, compare a known size with a physical measurement. Correct units alone do not prove scanner accuracy.</p>
      <button data-test="guide-scale-checked" onClick={() => { setScaleChecked(true); setReview(null) }}>The scale looks right</button>
    </>}
    {shown === 2 && <div className="guide-tasks">{TASKS.map((item, i) => <button key={item.dimension} data-test={`guide-task-${i}`} onClick={() => { setTaskIndex(i); setReview(null); setSawUndo(false); setRecovered(false) }}>{item.label}</button>)}</div>}
    {shown === 3 && task && <>
      <p>Fit {task.surface}. {fitted} of {task.count} surfaces ready.</p>
      <p>A fit finds an ideal shape from many scan points. Click the surface, inspect the highlighted patch, then use <strong>Create {task.kind}</strong>. Cancel lets you retry a wrong pick.</p>
      {draft?.fit && <p className="guide-quality">Check the preview’s scatter and accepted points. A small scatter means a close fit to these points, not a guarantee that the scanner measured the true part accurately. Exclude neighboring faces or fixtures if they were picked.</p>}
      <button data-test="guide-start-fit" disabled={busy || otherDraft || Boolean(dimDraft) || Boolean(draft && draft.kind !== task.kind)} onClick={() => { setReview(null); useShell.getState().setContextCollapsed(false); if (!draft) onStart(task.kind) }}>Show {task.kind} tool</button>
    </>}
    {shown === 4 && task && <>
      <p>Select the fitted {task.kind === 'plane' ? 'planes' : 'cylinder'} in the dimension’s reference fields. Check the value and units in the preview, then choose <strong>Add dimension</strong>.</p>
      <button data-test="guide-start-dimension" disabled={busy || otherDraft || draftHolds(draft)} onClick={() => { useStore.getState().cancelDraft(); useShell.getState().setMeasurePanel(null); useStore.getState().startDimension(task.dimension); setReview(null) }}>Create this dimension</button>
    </>}
    {shown === 5 && <p>{dimDraft ? 'The dimension is saved. Press Escape to put away the empty dimension tool, then use Undo and Redo in the top bar.' : sawUndo ? 'Now use Redo in the top bar to restore your measurement.' : !canUndo ? 'This reopened project has no undo history yet. Make a small edit with Edit in the Project panel, then use Undo and Redo to try recovery.' : 'Use Undo in the top bar to remove the latest committed operation, then Redo to restore it. The guide follows the real history; Back below only reviews instructions.'}</p>}
    {shown === 6 && <>
      <p>Save Project in the top bar downloads the scan and editable measurements. Copy report shares readings; STEP exports fitted geometry for CAD.</p>
      {saves > initialSaves ? <p role="status">Project download started. Check your browser’s downloads for the file. You can reopen it with Load.</p> : <p>Choose Save Project to keep your work. A browser recovery checkpoint is separate from your downloaded project.</p>}
    </>}
    <div className="toolrow">
      <button disabled={shown === 0} onClick={() => setReview(Math.max(0, shown - 1))}>Back</button>
      {review !== null && <button onClick={() => setReview(null)}>Current step</button>}
      <button onClick={() => setOpen(false)}>{shown === 6 && saves > initialSaves ? 'Finish guide' : 'Skip guide'}</button>
    </div>
  </section>
}
