// SPDX-License-Identifier: AGPL-3.0-only
// Delete marked: the surface marked by hand taken off the scan.

import { ToolActions } from '../../../../src/ui/ToolActions'
import { useMark } from '../../../../src/state/markStore'
import { InfoDot } from '../../../../src/ui/InfoDot'
import { MarkTools } from '../../../../src/ui/MarkTools'
import { useMeshTools } from '../../state/meshStore'
import { count } from '../meshFormat'

export function DeleteTool({
  ready,
  busy,
  onDelete,
  onClear,
}: {
  ready: boolean
  busy: boolean
  onDelete: () => void
  onClear: () => void
}) {
  const marked = useMark((s) => s.count)
  const editing = useMeshTools((s) => s.editing)
  const confirming = useMeshTools((s) => s.confirming)
  const setConfirming = useMeshTools((s) => s.setConfirming)

  return (
    <div className="group" data-test="delete-tool">
      <div className="sec-head">
        Delete marked
        <InfoDot title="Deleting marked surface">
          <p>
            What the scanner saw that is not the part: the clamp that held it, the fixture it sat
            in, a patch of the table, a finger. Mark it on the part with a <b>window</b>, a{' '}
            <b>brush</b> or a <b>lasso</b> — marked surface turns orange — and delete it. A
            triangle goes when all three of its corners are marked, exactly the triangles shown in
            orange.
          </p>
          <p>
            It is deleted from the edited copy. The hole it leaves stays open — close it with{' '}
            <b>Fill holes</b> if the part should be closed there. <b>Ctrl+Z</b> puts the surface
            back.
          </p>
        </InfoDot>
      </div>

      <MarkTools escapeNote="The marking stays until it is deleted or cleared." onClear={onClear} />

      {confirming && marked > 0 ? (
        <div className="confirmbox" data-test="delete-confirm" role="alertdialog" aria-label="Delete the marked surface">
          <p>
            Delete the surface marked on the part — <b>{count(marked)} points</b> — from the edited
            copy?
          </p>
          <p className="hint">Ctrl+Z puts it back.</p>
          <div className="toolrow">
            <button data-test="delete-keep" onClick={() => setConfirming(false)} title="Leave the scan as it is (Esc)">
              Keep it
            </button>
            <ToolActions><button
              className="primary"
              data-test="delete-marked-confirm"
              data-confirm={1}
              disabled={busy}
              onClick={onDelete}
              title="Take the marked surface off the scan (Enter)"
            >
              Delete
            </button></ToolActions>
          </div>
        </div>
      ) : (
        <ToolActions><button
          className="primary block"
          data-test="delete-marked"
          disabled={!ready || busy || marked === 0}
          onClick={() => setConfirming(true)}
        >
          {editing ? (
            <>
              <span className="spinner" />
              Deleting…
            </>
          ) : (
            'Delete marked surface…'
          )}
        </button></ToolActions>
      )}
      {ready && marked === 0 && !editing && <p className="hint">Pick Window, Brush or Lasso and mark what is to go.</p>}
    </div>
  )
}
