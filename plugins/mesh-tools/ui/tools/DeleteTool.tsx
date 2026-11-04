// SPDX-License-Identifier: AGPL-3.0-only
import { InfoDot } from '../../../../src/ui/InfoDot'
import { MarkTools } from '../../../../src/ui/MarkTools'
import type { DeleteToolState } from '../../app/useDeleteTool'
import { count } from '../meshFormat'

export function DeleteTool({ ready, busy, deletion: d }: {
  ready: boolean
  busy: boolean
  deletion: DeleteToolState
}) {
  const locked = busy || d.stage !== 0
  return (
    <div className="group" data-test="delete-tool">
      <div className="sec-head">
        Delete marked
        <InfoDot title="Deleting selected surface">
          <p>
            <b>Visible only</b> selects whole triangles visible in the current view,
            including surfaces viewed from underneath. Geometry hidden behind them is not selected,
            even in a transparent view. Geometric visibility checks include tiny triangles
            that fall between screen pixels.
          </p>
          <p>
            Select current view uses Add visible or Remove visible without replacing prior selection.
            Clear explicitly starts over. Invert across the entire mesh if needed. Rotate the model
            and use Add or Remove to refine only visible triangles. Release a stroke to update
            the selection. Shift-drag navigates; Escape cancels a stroke or returns to navigation.
          </p>
          <p>
            Orange is selected for deletion; the normal surface color is kept. Yellow lines mark
            shared-edge selection boundaries and selected open rims, not physical intersections.
            Preview, request deletion, then separately confirm removal. Cancel either confirmation
            to delete nothing. Unselected triangles and the vertices they use remain unchanged.
          </p>
          <p>
            The original scan file is untouched; Ctrl+Z restores the edited copy. Gaps stay open:
            inspect them before using Bridge gap or Fill holes. Temporary selections are not saved.
            <b> Through (legacy)</b> retains the old vertex-based selection, which can reach hidden surface.
          </p>
        </InfoDot>
      </div>
      <label className="field">
        <span>Selection depth</span>
        <select data-test="delete-selection-mode" value={d.mode} disabled={locked}
          onChange={(e) => d.setMode(e.target.value === 'through' ? 'through' : 'visible')}>
          <option value="visible">Visible only (current view)</option>
          <option value="through">Through (legacy)</option>
        </select>
      </label>
      {d.mode === 'visible' ? (
        <>
          <div className="toolrow">
            <button data-test="delete-select-view" disabled={!ready || locked} onClick={d.selectView}>Select current view</button>
            <button data-test="delete-invert" disabled={!ready || locked} onClick={d.invert}>Invert entire mesh</button>
          </div>
          <div className="toolrow" role="group" aria-label="Visible selection gesture">
            <button data-test="delete-navigate" className={d.gesture === null ? 'on' : ''}
              aria-pressed={d.gesture === null} disabled={locked} onClick={() => d.setGesture(null)}>Navigate</button>
            {(['window', 'brush', 'lasso'] as const).map((gesture) => (
              <button key={gesture} data-test={`delete-${gesture}`} className={d.gesture === gesture ? 'on' : ''} aria-pressed={d.gesture === gesture}
                disabled={!ready || locked} onClick={() => d.setGesture(d.gesture === gesture ? null : gesture)}>
                {gesture === 'window' ? 'Window' : gesture === 'brush' ? 'Brush' : 'Lasso'}
              </button>
            ))}
          </div>
          <div className="toolrow" role="group" aria-label="Selection operation">
            <button data-test="delete-add" className={!d.remove ? 'on' : ''} aria-pressed={!d.remove} disabled={locked} onClick={() => d.setRemove(false)}>Add visible</button>
            <button data-test="delete-remove" className={d.remove ? 'on' : ''} aria-pressed={d.remove} disabled={locked} onClick={() => d.setRemove(true)}>Remove visible</button>
            <button data-test="delete-clear" disabled={locked || d.count === 0} onClick={d.clear}>Clear</button>
          </div>
          {d.gesture === 'brush' && (
            <label className="field">
              <span>Brush diameter: {d.diameter} px</span>
              <input data-test="delete-brush-size" className="slider" aria-label="Visible brush diameter in pixels" type="range" min="2" max="200" value={d.diameter}
                disabled={locked} onChange={(e) => d.setDiameter(Number(e.target.value))} />
            </label>
          )}
          <p className="hint">Orange: selected. Normal surface color: kept. Yellow: selection boundary.</p>
        </>
      ) : d.stage === 0 ? (
        <MarkTools escapeNote="Legacy selection can mark hidden surface through the mesh." onClear={d.clear} />
      ) : <p className="hint">Legacy selection is locked while confirming deletion.</p>}
      <p data-test="delete-selection-count"><b>{count(d.count)}</b> triangles selected of {count(d.total)}.</p>
      {d.count > 0 && d.count === d.total && <p className="hint">The whole mesh is selected. Remove some triangles before deleting.</p>}
      {d.stage !== 0 ? (
        <div className="confirmbox" data-test="delete-confirm" role="alertdialog" aria-label={d.stage === 1 ? 'Request deletion' : 'Confirm actual removal'}>
          <p>
            {d.stage === 1
              ? <>Preview only: the <b>{count(d.count)} orange triangles</b> would be removed. Request deletion?</>
              : <>Final confirmation: remove exactly these <b>{count(d.count)} triangles</b> from the edited copy?</>}
          </p>
          <p className="hint">Unselected surface stays. Gaps remain open. Ctrl+Z restores the deletion.</p>
          <div className="toolrow">
            <button data-test="delete-keep" disabled={busy} onClick={() => d.setStage(0)}>Keep it</button>
            <button className="primary" data-test={d.stage === 1 ? 'delete-request' : 'delete-marked-confirm'}
              data-confirm={1} disabled={busy}
              onClick={() => d.stage === 1 ? d.setStage(2) : void d.applyDelete()}>
              {d.stage === 1 ? 'Request deletion...' : 'Confirm removal'}
            </button>
          </div>
        </div>
      ) : (
        <button className="primary block" data-test="delete-marked"
          disabled={!ready || busy || d.count === 0 || d.count === d.total} onClick={() => d.setStage(1)}>
          Preview deletion...
        </button>
      )}
    </div>
  )
}
