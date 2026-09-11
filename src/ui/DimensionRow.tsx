// SPDX-License-Identifier: AGPL-3.0-only
// One finished dimension, read the way the preview above it is: a DRO window
// with the name and kind over it, the elements it runs between beside the
// row keys, and a note or a warning under it. Shared by the 3D and 2D
// dimension lists, and by the tolerances.

import { verdictLines, type Verdict } from '../core/dimensions'
import { ValueWindow, type ReadValue } from './DroValue'
import { RowTools } from './RowTools'

export function WarningNote({ text }: { text: string }) {
  return <p className="warnnote">⚠ {text}</p>
}

/** How a reading stands to the limit typed for it: the allowance restated
 *  and the signed deviation, with the alarm under them when it is over —
 *  or, when the two would say the same number, the alarm alone. */
export function VerdictNote({ verdict }: { verdict: Verdict }) {
  const lines = verdictLines(verdict)
  const alarm = verdict.pass ? undefined : lines[lines.length - 1]
  const note = lines.length > 1 || verdict.pass ? lines[0] : undefined
  return (
    <>
      {note && (
        <div className="dro-note verdict" data-test="verdict">
          {note}
        </div>
      )}
      {alarm && (
        <p className="warnnote fail" data-test="fail">
          ✕ {alarm}
        </p>
      )}
    </>
  )
}

export function DimensionRow({
  name,
  visible,
  title,
  value,
  verdict,
  testPrefix = 'dimension',
  editorOpen,
  onEdit,
  onToggleVisible,
  onDelete,
}: {
  name: string
  visible: boolean
  /** The referenced element names, joined — what the dimension runs between. */
  title: string
  value: ReadValue
  /** Present when a limit was typed and there is a value to hold to it. */
  verdict?: Verdict
  /** The data-test stem of the row and its value: "dimension" or "tolerance". */
  testPrefix?: string
  /** True while anything is being assembled — the edit key stands down, since
   *  re-opening would throw away what is already in the box. */
  editorOpen: boolean
  onEdit: () => void
  onToggleVisible: () => void
  onDelete: () => void
}) {
  return (
    <div className={'dro hero dim' + (visible ? '' : ' ghost')} data-test={`${testPrefix}-row`}>
      <div className="dro-label">
        <span>
          {name} · {value.label}
        </span>
        <span className="dro-tools">
          <span className="dro-title">{title}</span>
          <RowTools
            name={name}
            visible={visible}
            editTestId={`edit-${testPrefix}`}
            editDisabled={editorOpen}
            editTitle={
              editorOpen
                ? 'Finish what is open first'
                : `Edit ${name} — change its type or what it measures between`
            }
            onEdit={onEdit}
            onToggleVisible={onToggleVisible}
            onDelete={onDelete}
          />
        </span>
      </div>
      <ValueWindow value={value} testId={`${testPrefix}-value`} over={verdict ? !verdict.pass : false} />
      {verdict && <VerdictNote verdict={verdict} />}
      {value.detail && !value.invalid && <div className="dro-note">{value.detail}</div>}
      {(value.warning ?? value.invalid) && (
        <WarningNote text={(value.warning ?? value.invalid)!} />
      )}
    </div>
  )
}
