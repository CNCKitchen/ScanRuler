// SPDX-License-Identifier: AGPL-3.0-only
// Densify: the triangles cut until none has an edge longer than a length
// set, the surface where it was — for an STL exported from CAD (issue 42).

import { InfoDot } from '../../../../src/ui/InfoDot'
import { NumberField } from '../../../../src/ui/NumberField'
import { useMeshTools } from '../../state/meshStore'

export function DensifyTool({ ready, busy, onDensify }: { ready: boolean; busy: boolean; onDensify: () => void }) {
  const edge = useMeshTools((s) => s.densifyEdge)
  const setEdge = useMeshTools((s) => s.setDensifyEdge)
  const editing = useMeshTools((s) => s.editing)

  return (
    <div className="group" data-test="densify-tool">
      <div className="sec-head">
        Densify
        <InfoDot title="Densifying">
          <p>
            An STL exported from CAD is cut into as few triangles as hold its shape: a flat face is
            a fan of long, thin triangles from its edges, with no point inside it. A fit, a
            segmentation or a section looking for points on that face finds none — the noise the
            checks read on it is the bend between facets.
          </p>
          <p>
            <b>Densify</b> cuts every edge longer than the length below at its middle, again and
            again, until none is. Each new point lies on the facet it was cut from, so the surface
            stays exactly where it was, and the mesh stays as closed as it was. A scan needs none
            of this: its points are dense already.
          </p>
          <p>
            Read radii afterwards off the rim points, which lie on the circle CAD drew: a facet's
            middle lies inside it by the sagitta. <b>Ctrl+Z</b> takes the step back.
          </p>
        </InfoDot>
      </div>

      <NumberField
        label="Longest edge"
        testId="densify-edge"
        value={edge}
        step={0.1}
        min={0.001}
        kind="length"
        disabled={busy}
        onCommit={setEdge}
        hint="No edge left longer than this. It starts at a hundredth of the part's size; halving it makes about four times the triangles."
      />

      <div className="toolrow">
        <button className="primary" data-test="densify-run" data-confirm={1} disabled={!ready || busy} onClick={onDensify} title="Cut the triangles down to the longest edge set">
          {editing ? (
            <>
              <span className="spinner" />
              Densifying…
            </>
          ) : (
            'Densify'
          )}
        </button>
      </div>
    </div>
  )
}
