// SPDX-License-Identifier: AGPL-3.0-only
// The 2D Measure faceplate: the scanned image, and the scale everything else
// will rest on. Element creation and dimensions grow in here as the workspace
// does; the layout follows the other panels — one group per concern, top to
// bottom in the order the work happens.

import { useState } from 'react'
import { toDpi } from '../core/flat/calibration'
import { flatMethod, flatMethodsForKind } from '../core/flat/construct'
import { datumFrame, fitInFrame } from '../core/flat/datum'
import { FLAT_KIND_LABELS } from '../core/flat/elements'
import { FLAT_ROLE_PROVIDERS } from '../core/flat/refs'
import { formatFlatDetail, formatFlatPrimary } from '../core/flat/summary'
import type { FlatElementKind } from '../core/flat/types'
import { IMAGE_ACCEPT, IMAGE_FORMATS } from '../core/formats'
import { useFlat } from '../state/flatStore'
import { InfoDot } from './InfoDot'
import { ModelSlot } from './ModelSlot'
import { NumberField } from './NumberField'

const FLAT_KINDS: FlatElementKind[] = ['point', 'line', 'circle', 'arc']

export function FlatPanel({ onOpenImage }: { onOpenImage: (file: File) => void }) {
  const imageName = useFlat((s) => s.imageName)
  const imageWidth = useFlat((s) => s.imageWidth)
  const imageHeight = useFlat((s) => s.imageHeight)
  const imageBusy = useFlat((s) => s.imageBusy)
  const meta = useFlat((s) => s.metaPxPerMm)
  const pxPerMm = useFlat((s) => s.pxPerMm)
  const calSource = useFlat((s) => s.calSource)
  const splitAxes = useFlat((s) => s.splitAxes)
  const calibrating = useFlat((s) => s.calibrating)
  const profiles = useFlat((s) => s.profiles)
  const edgeStatus = useFlat((s) => s.edgeStatus)
  const edgeCount = useFlat((s) => s.edgeCount)
  const edgeSensitivity = useFlat((s) => s.edgeSensitivity)
  const showEdges = useFlat((s) => s.showEdges)
  const elements = useFlat((s) => s.elements)
  const draft = useFlat((s) => s.draft)
  const selectedId = useFlat((s) => s.selectedId)
  const unit = useFlat((s) => (s.pxPerMm ? 'mm' : 'px'))
  const datum = useFlat((s) => s.datum)
  const datumPicking = useFlat((s) => s.datumPicking)
  const showGrid = useFlat((s) => s.showGrid)
  const flat = useFlat
  const frame = datum ? datumFrame(datum, pxPerMm) : null

  // The reference's true size, and what applying against it last said. Local:
  // they belong to the tool being open, not to the workspace.
  const [trueSize, setTrueSize] = useState(100)
  const [calError, setCalError] = useState<string | null>(null)
  const [profileName, setProfileName] = useState('')
  const [chosenProfile, setChosenProfile] = useState('')

  const picks = calibrating?.picks.length ?? 0
  const enough = calibrating
    ? calibrating.mode === 'distance'
      ? picks === 2
      : picks >= 3
    : false

  const apply = () => {
    const error = flat.getState().applyCalibration(trueSize)
    setCalError(error)
  }

  return (
    <aside className="panel">
      <div className="group">
        <div className="sec-head">
          Image
          <InfoDot title="The scan image">
            <p>
              A flatbed scan of the part — a <b>PNG</b> or <b>JPEG</b> straight from the scanner.
              Scan at the highest optical resolution you have; the pixels are the measurement.
            </p>
            <p>Drop it anywhere in the window. Nothing is uploaded.</p>
          </InfoDot>
        </div>
        <ModelSlot
          role="Image"
          name={imageName}
          detail={`${imageWidth.toLocaleString('en-US')} × ${imageHeight.toLocaleString('en-US')} px`}
          dotColor="#8b9099"
          busy={imageBusy}
          accept={IMAGE_ACCEPT}
          formats={IMAGE_FORMATS}
          onOpen={onOpenImage}
        />
        {!imageName && <p className="hint">Drop it anywhere in the window.</p>}
      </div>

      {imageName && (
        <div className="group">
          <div className="sec-head">
            Calibration
            <InfoDot title="Calibration">
              <p>
                Every millimetre this workspace reports is pixels divided by this scale. The
                file's own dpi is only <b>nominal</b> — scanner transports are off by real
                fractions of a percent — so measure the scale off something true: scan a gauge
                block, calliper-measured part or gauge pin along with the part.
              </p>
              <p>
                <b>Known distance</b> takes two picks across the reference and its true length.
                <b> Known diameter</b> takes three or more picks around a circle's edge and its
                true diameter.
              </p>
              <p>
                Scanners err differently along the two axes. Calibrating X and Y separately
                needs a reference laid along each axis in turn.
              </p>
            </InfoDot>
          </div>

          <p className="hint" data-test="flat-cal-status">
            {calSource === 'measured' && pxPerMm
              ? pxPerMm.x === pxPerMm.y
                ? `Calibrated: ${pxPerMm.x.toFixed(4)} px/mm (≈${toDpi(pxPerMm.x).toFixed(1)} dpi).`
                : `Calibrated: X ${pxPerMm.x.toFixed(4)} · Y ${pxPerMm.y.toFixed(4)} px/mm.`
              : calSource === 'metadata' && meta
                ? `Nominal, from the file: ${(meta.x * 25.4).toFixed(0)} dpi — ${(imageWidth / meta.x).toFixed(1)} × ${(imageHeight / meta.y).toFixed(1)} mm.`
                : 'The file declares no physical resolution — sizes are pixels until calibrated.'}
          </p>

          {!calibrating && (
            <>
              <button
                className="block"
                data-test="flat-cal-distance"
                onClick={() => {
                  setCalError(null)
                  flat.getState().startCalibration('distance')
                }}
              >
                Calibrate on a known distance
              </button>
              <button
                className="block"
                data-test="flat-cal-diameter"
                onClick={() => {
                  setCalError(null)
                  flat.getState().startCalibration('diameter')
                }}
              >
                Calibrate on a known diameter
              </button>
              <label className="checkrow">
                <input
                  type="checkbox"
                  data-test="flat-cal-split"
                  checked={splitAxes}
                  onChange={(e) => flat.getState().setSplitAxes(e.target.checked)}
                />
                <span>Calibrate X and Y separately</span>
              </label>
            </>
          )}

          {calibrating && (
            <>
              <p className="hint" data-test="flat-cal-collecting">
                {calibrating.mode === 'distance'
                  ? picks < 2
                    ? `Click the two ends of the reference on the image (${picks}/2). Zoom in first — the picks are the measurement.`
                    : 'Both ends picked — enter the true distance and apply.'
                  : picks < 3
                    ? `Click points around the reference circle's edge (${picks}, need 3+).`
                    : `${picks} points around the edge — more spread the error. Enter the true diameter and apply.`}
              </p>
              <NumberField
                label={calibrating.mode === 'distance' ? 'True distance' : 'True diameter'}
                testId="flat-cal-true"
                value={trueSize}
                step={1}
                min={0.001}
                unit="mm"
                onCommit={setTrueSize}
              />
              <button
                className="primary block"
                data-test="flat-cal-apply"
                disabled={!enough}
                onClick={apply}
              >
                Apply calibration
              </button>
              <div className="toolrow">
                <button
                  data-test="flat-cal-undo"
                  disabled={picks === 0}
                  onClick={() => flat.getState().undoCalPick()}
                >
                  Undo pick
                </button>
                <button data-test="flat-cal-cancel" onClick={() => flat.getState().cancelCalibration()}>
                  Cancel
                </button>
              </div>
            </>
          )}
          {calError && <p className="alarmtext">{calError}</p>}

          <div className="sec-head">Scanner profiles</div>
          <p className="hint">
            A measured calibration describes the scanner at one resolution, not the image — save
            it once, apply it to every scan from that scanner.
          </p>
          {profiles.length > 0 && (
            <div className="toolrow">
              <select
                data-test="flat-profile-select"
                value={chosenProfile}
                onChange={(e) => setChosenProfile(e.target.value)}
              >
                <option value="">Choose profile…</option>
                {profiles.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name}
                  </option>
                ))}
              </select>
              <button
                data-test="flat-profile-apply"
                disabled={!chosenProfile}
                onClick={() => flat.getState().applyProfile(chosenProfile)}
              >
                Apply
              </button>
              <button
                data-test="flat-profile-delete"
                disabled={!chosenProfile}
                onClick={() => {
                  flat.getState().deleteProfile(chosenProfile)
                  setChosenProfile('')
                }}
              >
                Delete
              </button>
            </div>
          )}
          {calSource === 'measured' && (
            <div className="toolrow">
              <input
                type="text"
                data-test="flat-profile-name"
                placeholder="e.g. V600 @ 600 dpi"
                value={profileName}
                onChange={(e) => setProfileName(e.target.value)}
              />
              <button
                data-test="flat-profile-save"
                disabled={!profileName.trim()}
                onClick={() => {
                  flat.getState().saveProfile(profileName)
                  setProfileName('')
                }}
              >
                Save
              </button>
            </div>
          )}
        </div>
      )}

      {imageName && (
        <div className="group">
          <div className="sec-head">
            Elements
            <InfoDot title="Elements">
              <p>
                Pick a shape, then click it on the image. Clicks <b>snap to the nearest detected
                edge</b> (subpixel) — hold <b>Alt</b> to place the raw click instead. More points
                than the minimum give a best fit, with the form error reported.
              </p>
              <p>
                Points can also be constructed: the midpoint of two, the intersection of two
                lines — the corner two edges meet at, however rounded the part is there — or a
                circle's center.
              </p>
            </InfoDot>
          </div>
          <div className="kindrow">
            {FLAT_KINDS.map((k) => (
              <button
                key={k}
                data-test={`flat-fit-${k}`}
                disabled={draft !== null || calibrating !== null}
                onClick={() => flat.getState().startDraft(k, flatMethodsForKind(k)[0].id)}
              >
                {FLAT_KIND_LABELS[k]}
              </button>
            ))}
          </div>

          {draft && (
            <>
              {flatMethodsForKind(draft.kind).length > 1 && (
                <label className="field">
                  <span>Method</span>
                  <select
                    data-test="flat-draft-method"
                    value={draft.method}
                    onChange={(e) => flat.getState().setDraftMethod(e.target.value)}
                  >
                    {flatMethodsForKind(draft.kind).map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <p className="hint" data-test="flat-draft-hint">
                {flatMethod(draft.method).hint}
              </p>
              {flatMethod(draft.method).slots?.map((slot, i) => (
                <label className="field" key={slot.label + i}>
                  <span>{slot.label}</span>
                  <select
                    data-test={`flat-draft-slot-${i}`}
                    value={draft.refs[i] ?? ''}
                    onChange={(e) =>
                      flat
                        .getState()
                        .setDraftRef(i, e.target.value === '' ? null : Number(e.target.value))
                    }
                  >
                    <option value="">Choose…</option>
                    {elements
                      .filter(
                        (el) =>
                          el.fit &&
                          FLAT_ROLE_PROVIDERS[slot.role].includes(el.kind) &&
                          !draft.refs.some((r, j) => j !== i && r === el.id),
                      )
                      .map((el) => (
                        <option key={el.id} value={el.id}>
                          {el.name}
                        </option>
                      ))}
                  </select>
                </label>
              ))}
              {flatMethod(draft.method).mode !== 'construct' && (
                <p className="hint" data-test="flat-draft-picks">
                  {flatMethod(draft.method).mode === 'edge'
                    ? `${draft.picks.length.toLocaleString('en-US')} edge points collected`
                    : `${draft.picks.length} point${draft.picks.length === 1 ? '' : 's'} picked`}
                  {draft.fit ? ' — fit ready' : ` (need ${flatMethod(draft.method).minPicks})`}
                </p>
              )}
              {draft.error && <p className="alarmtext">{draft.error}</p>}
              <button
                className="primary block"
                data-test="flat-create-element"
                disabled={!draft.fit}
                onClick={() => flat.getState().commitDraft()}
              >
                Create element
              </button>
              <div className="toolrow">
                <button
                  data-test="flat-draft-undo"
                  disabled={draft.picks.length === 0}
                  onClick={() => flat.getState().undoDraftPick()}
                >
                  Undo pick
                </button>
                <button data-test="flat-draft-cancel" onClick={() => flat.getState().cancelDraft()}>
                  Cancel
                </button>
              </div>
            </>
          )}

          {elements.length > 0 && (
            <div className="rows">
              {elements.map((el) => (
                <div
                  key={el.id}
                  className={'kv' + (el.visible ? '' : ' ghost') + (selectedId === el.id ? ' sel' : '')}
                  data-test="flat-element-row"
                  onClick={() => flat.getState().selectElement(selectedId === el.id ? null : el.id)}
                >
                  <span className="dot" style={{ background: el.color }} />
                  <span className="name">{el.name}</span>
                  {el.fit ? (
                    <b title={formatFlatDetail(el.fit, unit)}>
                      {formatFlatPrimary(fitInFrame(el.fit, frame), unit)}
                    </b>
                  ) : (
                    <b className="warn" title={el.error ?? undefined}>
                      no fit
                    </b>
                  )}
                  <button
                    className="iconbtn"
                    data-test="flat-element-delete"
                    title="Delete element"
                    onClick={(e) => {
                      e.stopPropagation()
                      flat.getState().deleteElement(el.id)
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {imageName && (
        <div className="group">
          <div className="sec-head">
            Datum
            <InfoDot title="Datum">
              <p>
                The part's own coordinate frame: the first pick is the <b>origin</b>, the second
                sets <b>+X</b>, and reported coordinates and line angles read in that frame from
                then on. Distances and angles between elements never change under a datum.
              </p>
              <p>
                Both picks snap to detected edges like any other pick — put the origin on a
                corner or a circle center, run X along a reference edge. The grid shows where
                the frame lies.
              </p>
            </InfoDot>
          </div>
          <p className="hint" data-test="flat-datum-status">
            {datumPicking
              ? datumPicking.picks.length === 0
                ? 'Click the origin on the image.'
                : 'Now click a point along +X — the grid follows the cursor.'
              : datum
                ? 'Datum set — coordinates read in the part frame.'
                : 'Image frame — origin at the bottom-left of the sheet.'}
          </p>
          {!datumPicking ? (
            <div className="toolrow">
              <button
                data-test="flat-datum-set"
                disabled={calibrating !== null}
                onClick={() => flat.getState().startDatum()}
              >
                {datum ? 'Re-set datum' : 'Set datum'}
              </button>
              <button
                data-test="flat-datum-clear"
                disabled={!datum}
                onClick={() => flat.getState().clearDatum()}
              >
                Clear
              </button>
            </div>
          ) : (
            <button className="block" data-test="flat-datum-cancel" onClick={() => flat.getState().cancelDatum()}>
              Cancel
            </button>
          )}
          {datum && (
            <label className="checkrow">
              <input
                type="checkbox"
                data-test="flat-datum-grid"
                checked={showGrid}
                onChange={(e) => flat.getState().setShowGrid(e.target.checked)}
              />
              <span>Show grid</span>
            </label>
          )}
        </div>
      )}

      {imageName && (
        <div className="group">
          <div className="sec-head">
            Edge detection
            <InfoDot title="Edge detection">
              <p>
                The image is swept once for edges — where brightness turns over — and each edge
                comes out as a chain of subpixel points, drawn in teal over the scan. Fits will
                consume these chains; the overlay shows what they would have to work with.
              </p>
              <p>
                Sensitivity decides how faint an edge still counts. Push it up if a real edge is
                missing, down if noise and paper texture come up as edges.
              </p>
            </InfoDot>
          </div>
          <p className="hint" data-test="flat-edge-status">
            {edgeStatus === 'running'
              ? 'Detecting edges…'
              : edgeStatus === 'ready'
                ? `${edgeCount.toLocaleString('en-US')} edge chains found.`
                : 'No edges detected yet.'}
          </p>
          <label className="field">
            <span>Sensitivity</span>
            <input
              type="range"
              data-test="flat-edge-sensitivity"
              min={0}
              max={1}
              step={0.05}
              value={edgeSensitivity}
              disabled={edgeStatus === 'running'}
              onChange={(e) => flat.getState().setEdgeSensitivity(Number(e.target.value))}
            />
          </label>
          <label className="checkrow">
            <input
              type="checkbox"
              data-test="flat-edge-show"
              checked={showEdges}
              onChange={(e) => flat.getState().setShowEdges(e.target.checked)}
            />
            <span>Show detected edges</span>
          </label>
        </div>
      )}
    </aside>
  )
}
