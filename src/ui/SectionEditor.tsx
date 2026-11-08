// SPDX-License-Identifier: AGPL-3.0-only
// The box a section is made or edited in: whether it is a cut or a shadow,
// what to cut across — an element, or one of the scan's coordinate planes —
// the offset along its direction, typed here or dragged on the part, the
// tilt the gizmo's rings have given it, a shadow's play and tolerance, and
// what the cut produces. Renders nothing without a section draft.

import { describeShadow } from '../core/section/shadow'
import { useLength } from '../app/useUnits'
import { typedFigure, useFieldUnits } from './NumberField'
import { cutSummary } from '../core/section/slice'
import {
  isRadialRef,
  isWorldAxis,
  SECTION_REF_KINDS,
  sectionRefName,
  tiltOf,
  WORLD_AXES,
  worldPlaneName,
  type SectionRef,
} from '../core/section/frame'
import { isShadow, shadowParams, type SectionKind } from '../state/sectionModel'
import { sectionDraftColorOf, sectionDraftReady, useStore } from '../state/store'
import { InfoDot } from './InfoDot'
import { NameField, providersFor } from './RefSelect'
import { tintStyle } from './tint'

/** What a section or a cut can go along, as a select's options: the
 *  coordinate planes, then the elements on offer. */
export function PlaneRefOptions({ options }: { options: readonly { id: number; name: string }[] }) {
  return (
    <>
      <optgroup label="Coordinate planes">
        {WORLD_AXES.map((a) => (
          <option key={a} value={a}>
            {worldPlaneName(a)}
          </option>
        ))}
      </optgroup>
      {options.length > 0 && (
        <optgroup label="Elements">
          {options.map((el) => (
            <option key={el.id} value={el.id}>
              {el.name}
            </option>
          ))}
        </optgroup>
      )}
    </>
  )
}

export function SectionEditor({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void
  onConfirm: () => void
}) {
  const draft = useStore((s) => s.sectionDraft)
  const elements = useStore((s) => s.elements)
  const sections = useStore((s) => s.sections)
  const color = useStore(sectionDraftColorOf)
  const setRef = useStore((s) => s.setSectionDraftRef)
  const setOffset = useStore((s) => s.setSectionDraftOffset)
  const setName = useStore((s) => s.setSectionDraftName)
  const setKind = useStore((s) => s.setSectionDraftKind)
  const setShadow = useStore((s) => s.setSectionDraftShadow)
  // The lengths typed here are held in millimetres and typed in the units
  // shown.
  const len = useLength()
  const u = useFieldUnits('length', undefined)

  if (draft === null) return null

  const edited = draft.editId !== undefined ? sections.find((x) => x.id === draft.editId) : undefined
  const options = providersFor(['plane', 'axis'], elements, undefined, SECTION_REF_KINDS)
  const summary = draft.cut ? cutSummary(draft.cut) : null
  const ready = sectionDraftReady(draft)
  const orphan = draft.axis !== null && draft.ref === null
  const tilt = draft.frame ? tiltOf(draft.refDir, draft.frame.normal) : 0
  const refName = sectionRefName(draft.ref, elements)
  const radial = isRadialRef(draft.ref) ? draft.ref : null
  const shadow = isShadow(draft)
  const kind: SectionKind = shadow ? 'shadow' : 'cut'
  const params = shadowParams(draft)
  const shape = shadow && draft.cut?.shadow ? draft.cut.shadow : null
  const words = shape ? describeShadow(shape, len.units) : null
  const shownOffset = u.text(round(draft.offset))
  const shownLen = (mm: number): string => u.text(mm)

  const hint = !draft.axis
    ? shadow
      ? 'Choose the plane to project onto — click an element or one of the XY, YZ, XZ planes in the viewport, or pick it above. The scan is seen along the plane’s normal.'
      : 'Choose what to cut across — click an element or one of the XY, YZ, XZ planes in the viewport, or pick it above. The plane runs across an element’s direction: a plane’s normal, the axis of a cylinder, cone or line, a circle’s normal.'
    : orphan
      ? 'The element this was cut along has gone; the plane stays where it was. Slide or tilt it with the gizmo, or choose another element to move it.'
      : shadow
        ? 'The scan’s outline seen along the plane’s normal — its widest extent, every indentation filled — drawn in the middle of the part. Tilt the plane with the rings to look from another way.'
        : 'Slide the plane along its direction — drag the arrow, type the offset, or click the scan where it should cut — and tilt it by dragging one of the rings, then create.'

  return (
    <div className="draftbox" style={{ borderLeftColor: color }} data-test="section-editor">
      <div className="sec-head">
        <span className="dot" style={{ background: color }} />
        {edited ? `Edit ${edited.name}` : 'New section'}
        <InfoDot title="Sections">
          <p>
            A section is the scan cut with a plane. It becomes a <b>source in the 2D Measure
            workspace</b>, listed there beside the flatbed image: the cut’s edges lie on the
            sheet at true size, ready to be snapped to, fitted and measured exactly like a
            scan image’s edges.
          </p>
          <p>
            The plane is taken <b>across an element’s direction</b> — a plane’s normal, the
            axis of a cylinder, cone or line, a circle’s normal — or across one of the scan’s
            <b> coordinate axes</b>: while nothing is chosen, the XY, YZ and XZ planes are
            offered through the part’s centre, and clicking one takes it. The plane is moved
            along its direction by the offset. Zero cuts through the element’s own centre — for
            a face that is the face itself, so offset into the part to cut through its walls —
            and for a coordinate plane the offset is the plane’s coordinate on that axis.
          </p>
          <p>
            The gizmo on the plane <b>slides</b> it by the arrow and <b>tilts</b> it by the two
            rings, each about one of the sheet’s own axes through the point the gizmo sits on. A
            tilted plane is recorded with its tilt off what it was taken across; <b>Square</b>{' '}
            turns it back. A <b>click on the scan</b> slides the plane, direction and tilt kept,
            to pass through the point clicked.
          </p>
          <p>
            The plane is fixed when the section is created. Re-fitting or deleting the element
            it was cut along leaves the section where it is; a datum alignment moves it with
            the part.
          </p>
          <p>
            A <b>shadow</b> is the whole scan projected along the plane’s normal onto it — the
            outline the part casts, its widest extent with every indentation filled, where a
            cut is only what one plane passes through. It is what a straight-walled bin, a foam
            cutout or a pocket for the part is drawn from: on the 2D sheet, then out as DXF.
            The outline is read as lines and arcs, the way a sketch is drawn, to the{' '}
            <b>tolerance</b>, and always lies outside the part: at least the <b>play</b> and at
            most the play plus twice the tolerance outside its exact silhouette. A positive play
            is clearance; a negative one, a press fit. Where two lines meet turning by less than{' '}
            <b>Round below</b> (30° by default) the corner is rounded by an arc tangent to both,
            so a faceted curve comes out smooth; a sharper corner stays sharp, and 0 keeps them all.
          </p>
        </InfoDot>
      </div>

      {draft.editId !== undefined && (
        <NameField value={draft.name ?? ''} testId="section-name" onChange={setName} />
      )}

      <div className="field">
        <span id="section-kind-label">Kind</span>
        <div className="keys" role="radiogroup" aria-labelledby="section-kind-label">
          {(['cut', 'shadow'] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={kind === k}
              className={kind === k ? 'on' : undefined}
              data-test={`section-kind-${k}`}
              title={
                k === 'cut'
                  ? 'The scan where the plane passes through it'
                  : 'The whole scan projected along the plane’s normal onto it — its outline'
              }
              onClick={() => setKind(k)}
            >
              {k === 'cut' ? 'Cut' : 'Shadow'}
            </button>
          ))}
        </div>
      </div>

      <label className="field">
        <span>{shadow ? 'Project onto' : 'Cut along'}</span>
        <select
          data-test="section-ref"
          value={isRadialRef(draft.ref) ? 'radial' : (draft.ref ?? '')}
          onChange={(e) => setRef(parseRef(e.target.value))}
        >
          <option value="">{orphan ? '(deleted element)' : 'Select…'}</option>
          {/* A plane through an axis is made by command; here it is kept,
              or swapped for one of the others. */}
          {radial && <option value="radial">{refName ?? 'Through an axis'}</option>}
          <PlaneRefOptions options={options} />
        </select>
      </label>

      {radial && (
        <label className="field">
          <span>Angle (°)</span>
          <input
            type="number"
            step="any"
            data-test="section-angle"
            key={round(radial.angleDeg)}
            defaultValue={round(radial.angleDeg)}
            onBlur={(e) => {
              // Text left as shown commits nothing: the field rounds the
              // angle, and tabbing through it would re-cut the plane there.
              // Nor does an emptied field or a typo.
              const v = typedFigure(e.target)
              if (v !== null && e.target.value !== String(round(radial.angleDeg))) setRef({ ...radial, angleDeg: v })
              e.target.value = String(round(radial.angleDeg))
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
            }}
          />
        </label>
      )}

      {/* A shadow has no offset to give: it is the same outline anywhere
          along the normal, and is drawn in the middle of the part. */}
      {!shadow && (
        <label className="field">
          {/* A plane still square to a coordinate axis has a coordinate, not an
              offset: its Z is what the field holds. */}
          <span>{isWorldAxis(draft.ref) && tilt === 0 ? `${draft.ref.toUpperCase()} (${u.word})` : `Offset (${u.word})`}</span>
          <input
            type="number"
            step="any"
            data-test="section-offset"
            disabled={!draft.axis}
            title="Where the plane lies along its normal, which is where it cuts the part"
            // Re-keyed on the value, so a grip dragged in the viewport types
            // itself into the field.
            key={shownOffset}
            defaultValue={shownOffset}
            onBlur={(e) => {
              // Text left as it was shown commits nothing: in inches it is
              // rounded, and committing it back would move the plane.
              const typed = typedFigure(e.target)
              if (e.target.value !== shownOffset && typed !== null) setOffset(u.read(typed))
              e.target.value = shownOffset
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
            }}
          />
        </label>
      )}

      {shadow && (
        <>
          <label className="field">
            <span>Play ({u.word})</span>
            <input
              type="number"
              step="any"
              data-test="section-play"
              title="How far outside the part the outline lies: positive is clearance, negative a press fit"
              key={`play-${shownLen(params.play)}`}
              defaultValue={shownLen(params.play)}
              onBlur={(e) => {
                const typed = typedFigure(e.target)
                if (typed !== null && e.target.value !== shownLen(params.play)) setShadow({ play: u.read(typed) })
                e.target.value = shownLen(shadowParams(useStore.getState().sectionDraft ?? {}).play)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
              }}
            />
          </label>
          <label className="field">
            <span>Tolerance ({u.word})</span>
            <input
              type="number"
              step="any"
              min="0"
              data-test="section-tolerance"
              title="How closely the lines and arcs follow the outline; it is traced on cells of half of it"
              key={`tol-${shownLen(params.tolerance)}`}
              defaultValue={shownLen(params.tolerance)}
              onBlur={(e) => {
                const typed = typedFigure(e.target)
                if (typed !== null && e.target.value !== shownLen(params.tolerance) && typed > 0) setShadow({ tolerance: u.read(typed) })
                e.target.value = shownLen(shadowParams(useStore.getState().sectionDraft ?? {}).tolerance)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
              }}
            />
          </label>
          <label className="field">
            <span>Round below (°)</span>
            <input
              type="number"
              step="any"
              min="0"
              max="180"
              data-test="section-smooth"
              title="Corners where the outline turns by less than this are rounded; sharper ones stay sharp. 0 keeps every corner sharp."
              key={`smooth-${params.smoothDeg}`}
              defaultValue={params.smoothDeg}
              onBlur={(e) => {
                const v = typedFigure(e.target)
                if (v !== null && v >= 0) setShadow({ smoothDeg: v })
                e.target.value = String(shadowParams(useStore.getState().sectionDraft ?? {}).smoothDeg)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
              }}
            />
          </label>
          <label className="checkrow">
            <input
              type="checkbox"
              data-test="section-extrude"
              checked={params.extrude}
              onChange={(e) => setShadow({ extrude: e.target.checked })}
            />
            <span title="A block through the part along the plane’s normal, drawn here and written to the STEP file as a solid">
              Extrude to the part’s thickness
            </span>
          </label>
        </>
      )}

      {tilt > 0 && (
        <div className="field">
          <span>Tilt</span>
          <span className="tilt" data-test="section-tilt">
            {tilt.toFixed(1)}°{refName ? ` off ${refName}` : ''}
            {draft.ref !== null && (
              <button
                type="button"
                data-test="section-square"
                title="Turn the plane square to what it was taken across again"
                onClick={() => setRef(draft.ref)}
              >
                Square
              </button>
            )}
          </span>
        </div>
      )}

      <p className="hint" data-test="section-hint">
        {hint}
      </p>

      <div className="dro">
        <div className="dro-label">
          <span>{shadow ? 'Shadow' : 'Cut'}</span>
          {shadow
            ? words && <span data-test="section-band">{words.band}</span>
            : summary && <span data-test="section-points">{summary.points.toLocaleString('en-US')} points</span>}
        </div>
        <div
          className={
            'dro-window ' +
            draft.status +
            (draft.status === 'slicing' ? ' working' : draft.status === 'failed' ? ' alarm' : '')
          }
          data-test="section-status"
        >
          {draft.status === 'empty' && (
            <b style={{ fontSize: 12, fontWeight: 400, color: 'var(--dim)' }}>No element chosen</b>
          )}
          {draft.status === 'slicing' && (
            <b>
              <span className="spinner" />
              {shadow ? 'Projecting…' : 'Cutting…'}
            </b>
          )}
          {draft.status === 'failed' && <b>{draft.message ?? 'Failed'}</b>}
          {draft.status === 'ready' &&
            (shadow && words && summary && summary.chains > 0 ? (
              <b className="tinted" style={tintStyle(color, { fontSize: 13 })} data-test="section-shadow-readout">
                {words.loops} · {words.area}
              </b>
            ) : summary && summary.chains > 0 ? (
              <b className="tinted" style={tintStyle(color, { fontSize: 13 })}>
                {summary.chains} edge chain{summary.chains === 1 ? '' : 's'}
              </b>
            ) : (
              <b style={{ fontSize: 12, fontWeight: 400, color: 'var(--dim)' }}>
                {shadow ? 'The scan casts no shadow on this plane' : 'The plane misses the scan'}
              </b>
            ))}
        </div>
        {shape?.widened && draft.status === 'ready' && (
          <p className="hint" data-test="section-shadow-cell">
            A part this size is traced on {len.fmt(shape.cell, 2)} cells, not{' '}
            {len.fmt(shape.tolerance / 2, 2)}: features narrower than that may close.
          </p>
        )}
        {shape && params.extrude && draft.status === 'ready' && shape.loops.length > 0 && (
          <p className="hint" data-test="section-extrude-height">
            A block {len.fmt(shape.extent.max - shape.extent.min, 2)} high, through the part from
            its lowest point to its highest — exported as a solid with STEP as Solids &amp; faces.
          </p>
        )}
      </div>

      <button
        className="primary block"
        data-test="create-section"
        disabled={!ready}
        onClick={onConfirm}
      >
        {edited ? 'Save changes' : 'Create section'}
      </button>
      <div className="toolrow">
        <button data-test="cancel-section" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}

/** The select's value back into a reference: an axis letter, an element id,
 *  or nothing. The plane through an axis is never chosen afresh here — it
 *  is only the one the draft already has. */
function parseRef(value: string): SectionRef | null {
  if (value === '' || value === 'radial') return null
  if (isWorldAxis(value)) return value
  return Number(value)
}

/** Three decimals is a micrometre — past what a grip dragged across the
 *  screen means, and enough for anything typed. */
function round(v: number): number {
  return Math.round(v * 1000) / 1000
}
