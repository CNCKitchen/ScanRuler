// SPDX-License-Identifier: AGPL-3.0-only
// The edited copy of the scan: the edits it carries, the copy put to use or
// discarded, and its deviation from the scan it was made from.

import { useStore } from '../../../src/state/store'
import { useUnits } from '../../../src/app/useUnits'
import { InfoDot } from '../../../src/ui/InfoDot'
import { ExportMeshButton } from '../../../src/ui/ExportMeshButton'
import type { MeshFormat } from '../../../src/core/exportMesh'
import { scanEditFigure, scanEditText, useMeshTools } from '../state/meshStore'
import { count } from './meshFormat'

/** The copy of the scan the tools have edited, and what to do with it: the
 *  edits made on it, how large it is, and the buttons that take it into use
 *  or throw it away. */
export function EditedCopy({ busy, onUse, onMeasure, onDiscard, onExport }: { busy: boolean; onUse: () => void; onMeasure: () => void; onDiscard: () => void; onExport: (format: MeshFormat) => void }) {
  const pending = useMeshTools((s) => s.pending)
  const triangles = useMeshTools((s) => s.copyTriangles)
  const scanTriangles = useStore((s) => s.triangleCount)
  const units = useUnits()
  if (triangles === null) return null

  return (
    <div className="group" data-test="edited-copy">
      <div className="sec-head">
        Edited copy
        <InfoDot title="The edited copy">
          <p>
            The tools edit a copy of the scan, shown here in its place. Every other workspace — the
            elements, the deviation and thickness maps, Reverse engineer — goes on measuring the scan
            as it was, so nothing is fitted again until you say so.
          </p>
          <p>
            <b>Use for analysis</b> makes the copy the scan every workspace measures: the elements
            are fitted again on it and the maps measured again. <b>Discard</b> throws the copy away.
            Both are one step of the undo history, and a saved project keeps the copy.{' '}
            <b>Export mesh</b> saves the copy as it stands, as an STL or a 3MF, in the pose the scan is shown in.
          </p>
          <p>
            <b>Deviation</b>, in the view bar under the part, colours the copy by how far it is from
            the scan in use — what smoothing or an expansion moved, where a patch stands off the surface. Surface an edit made where the scan had none
            — a filled hole, a cut's cap, a hollow's inner wall — has nothing to measure against and is grey.
          </p>
        </InfoDot>
      </div>
      <div className="kv" data-test="edited-triangles">
        <span className="name">Triangles</span>
        <b>
          {count(triangles)}
          <span className="dim"> · scan in use {count(scanTriangles)}</span>
        </b>
      </div>
      {pending.map((e, i) => (
        <div key={i} className="kv" data-test="pending-edit">
          <span className="name">{scanEditText(e, units)}</span>
          <b>{scanEditFigure(e, units)}</b>
        </div>
      ))}
      <p className="hint">
        Not in use yet — every other workspace measures the scan as it was. <b>Deviation</b> in the
        view bar shows how far the copy is from it.
      </p>
      <div className="toolrow">
        <button data-test="discard-edited" disabled={busy} onClick={onDiscard} title="Throw the copy and its edits away — Ctrl+Z brings them back">
          Discard
        </button>
        <ExportMeshButton
          testId="export-edited"
          disabled={busy}
          onExport={onExport}
          title="Save the copy as an STL or a 3MF where it now stands — any alignment applied to the scan comes with it"
        />
        <button
          className="primary"
          data-test="use-edited"
          disabled={busy}
          onClick={onUse}
          title="Make the copy the scan every workspace measures — the elements are fitted again on it"
        >
          Use for analysis
        </button>
      </div>
      <button className="block" data-test="measure-edited" disabled={busy} onClick={onMeasure}
        title="Take the edited mesh into use, refit existing elements and open 3D Measure. Ctrl+Z reverses taking it into use.">
        Measure edited mesh
      </button>
      <p className="hint">Loads the repairs into analysis and refits existing measurements. Your source file is not overwritten. New surface in missing scan areas needs a reference model to assess deviation.</p>
    </div>
  )
}
