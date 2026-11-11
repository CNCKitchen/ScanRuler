// SPDX-License-Identifier: AGPL-3.0-only
// The word Mesh Tools puts on the stage of the other workspaces while an
// edited copy waits apart from the scan they measure.

import { count } from './meshFormat'

/** That the edited copy is not what this workspace measures, with the ways
 *  on: take it into use from here, go and look at it, or let it be — until
 *  the copy changes again. */
export function EditedCopyNote({ edits, busy, onUse, onShow, onDismiss }: { edits: number; busy: boolean; onUse: () => void; onShow: () => void; onDismiss: () => void }) {
  return (
    <div className="stagenote" data-test="edited-copy-note" role="status">
      <span className="note-text">
        Mesh Tools holds an edited copy of the scan ({count(edits)} edit{edits === 1 ? '' : 's'}) that is not in use — this
        workspace measures the scan as it was.
      </span>
      <span className="note-actions">
        <button data-test="edited-note-show" onClick={onShow} title="Go to Mesh Tools, where the copy is shown in the scan's place">
          Show
        </button>
        <button
          className="primary"
          data-test="edited-note-use"
          disabled={busy}
          onClick={onUse}
          title="Make the copy the scan every workspace measures — the elements are fitted again on it. Ctrl+Z goes back."
        >
          Use for analysis
        </button>
        <button className="x" data-test="edited-note-dismiss" onClick={onDismiss} title="Hide this until the copy changes again" aria-label="Hide">
          ×
        </button>
      </span>
    </div>
  )
}
