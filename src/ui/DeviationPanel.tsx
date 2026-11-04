// SPDX-License-Identifier: AGPL-3.0-only
// The deviation faceplate. What the scan is measured against comes first,
// because it decides how much setup there is: a reference part has to be loaded
// and best-fitted here — neither model belongs in a top bar shared with the
// other workspaces — while a fitted element needs only to be chosen. Everything
// below the two is the same, because the map they produce is the same map.

import { useShallow } from 'zustand/react/shallow'
import { MIN_LOCAL_POINTS } from '../core/deviation/align'
import { MAX_DEFLECTION_SCALE, MIN_DEFLECTION_SCALE } from '../core/deviation/deflection'
import { DEFAULT_MAP_FACING_DEG } from '../core/deviation/deviation'
import { REFERENCE_ACCEPT, REFERENCE_FORMATS } from '../core/formats'
import { mapHeld, useDeviation, type DeviationSource } from '../state/deviationStore'
import { useMark } from '../state/markStore'
import { useStore } from '../state/store'
import { targetFitOf } from '../app/useElementField'
import { usePulse } from '../app/useHints'
import { CopyButton } from './CopyButton'
import { formatSigned } from './format'
import { useLength } from '../app/useUnits'
import { lengthInputText } from '../core/units'
import { InfoDot } from './InfoDot'
import { MarkTools } from './MarkTools'
import { ModelSlot } from './ModelSlot'
import { NumberField } from './NumberField'
import { ProbeList } from './ProbeList'
import { ScaleControls } from './ScaleControls'
import { TargetSection } from './TargetSection'
import { VolumeSection } from './VolumeSection'
import { ExportMeshButton } from './ExportMeshButton'
import type { MeshFormat } from '../core/exportMesh'
import type { Vec3 } from '../core/types'

const SOURCES: { id: DeviationSource; label: string; what: string }[] = [
  { id: 'reference', label: 'Reference model', what: 'the nominal CAD part, best-fitted onto the scan' },
  { id: 'element', label: 'Fitted element', what: 'a plane, cylinder or sphere measured on this scan' },
]

export function DeviationPanel({
  onOpenScan,
  onOpenNominal,
  onAlign,
  onStopAlign,
  onPickPoints,
  onMeasure,
  onMapFacing,
  onStartMarking,
  onStopMarking,
  onClearMarking,
  onLocalFit,
  onRevertLocal,
  onSelectTarget,
  onScopeChange,
  onScopeDone,
  onScopeClear,
  onGoToMeasure,
  onCopy,
  onExportMesh,
  onMeasureVolume,
  onFrame,
}: {
  onOpenScan: (file: File) => void
  onOpenNominal: (file: File) => void
  onAlign: () => void
  /** Stop the fit that is running, wherever it has got to. */
  onStopAlign: () => void
  onPickPoints: () => void
  onMeasure: () => void
  /** Set the reference map's facing limit — it decides which surface each
   *  point is measured against, so the map is measured again under it. */
  onMapFacing: (deg: number | null) => void
  /** Bring the marking tools out, and put them away again. */
  onStartMarking: () => void
  onStopMarking: () => void
  onClearMarking: () => void
  /** Refine the fit on the marked surface only. */
  onLocalFit: () => void
  onRevertLocal: () => void
  /** Measure against this element — the material side is detected as it is
   *  chosen, so this cannot be a plain store setter. */
  onSelectTarget: (id: number | null) => void
  /** Whole scan or a hand-marked region — switching to the marked scope opens
   *  the marking tools. */
  onScopeChange: (scope: 'all' | 'marked') => void
  /** Tools away, region kept. */
  onScopeDone: () => void
  /** Region rubbed out, tools stay out. */
  onScopeClear: () => void
  /** Over to the workspace where elements are made, for a panel that has none
   *  to offer yet. */
  onGoToMeasure: () => void
  onCopy: () => void
  /** Save the scan as an STL in the pose it is currently shown in — here, that
   *  means with the best fit onto the reference baked in. */
  onExportMesh: (format: MeshFormat) => void
  /** Measure the deviation as volumes under the alignment in hand. */
  onMeasureVolume: () => void
  /** Frame a box of the reference's frame in the viewport. */
  onFrame: (min: Vec3, max: Vec3) => void
}) {
  const scanName = useStore((s) => s.fileName)
  const scanTriangles = useStore((s) => s.triangleCount)
  const scanBusy = useStore((s) => s.busy)
  // Only the slice this panel actually reads: the store is also written on
  // every map repaint and probe, and re-rendering the whole panel for fields
  // it never shows would be paid on every one of them.
  // Every length here is held in millimetres and shown in the units shown.
  const len = useLength()
  const inches = len.units === 'in'
  const setting = (mm: number): string => `${lengthInputText(mm, len.units)} ${len.word()}`
  const d = useDeviation(
    useShallow((s) => ({
      align: s.align,
      alignMessage: s.alignMessage,
      alignStatus: s.alignStatus,
      alignStopping: s.alignStopping,
      animate: s.animate,
      animScale: s.animScale,
      bands: s.bands,
      clearProbes: s.clearProbes,
      elementStatus: s.elementStatus,
      flipTargetSide: s.flipTargetSide,
      globalAlign: s.globalAlign,
      localMaxDistance: s.localMaxDistance,
      mapFacingDeg: s.mapFacingDeg,
      mapStatus: s.mapStatus,
      marking: s.marking,
      maxDistance: s.maxDistance,
      nominalBusy: s.nominalBusy,
      nominalName: s.nominalName,
      nominalStep: s.nominalStep,
      nominalTriangles: s.nominalTriangles,
      probes: s.probes,
      range: s.range,
      removeProbe: s.removeProbe,
      scopeCount: s.scopeCount,
      targetScope: s.targetScope,
      setAnimate: s.setAnimate,
      setAnimScale: s.setAnimScale,
      setBands: s.setBands,
      setLocalMaxDistance: s.setLocalMaxDistance,
      setMaxDistance: s.setMaxDistance,
      setRange: s.setRange,
      setShowElement: s.setShowElement,
      setShowHistogram: s.setShowHistogram,
      setSource: s.setSource,
      setTargetFacing: s.setTargetFacing,
      setTolerance: s.setTolerance,
      showElement: s.showElement,
      showHistogram: s.showHistogram,
      showScan: s.showScan,
      source: s.source,
      stats: s.stats,
      targetFacingDeg: s.targetFacingDeg,
      targetId: s.targetId,
      targetSide: s.targetSide,
      tolerance: s.tolerance,
    })),
  )
  const markCount = useMark((s) => s.count)
  const elements = useStore((s) => s.elements)
  const pulseAlign = usePulse('align-auto')
  const pulseMeasure = usePulse('measure-deviation')

  const onElement = d.source === 'element'
  const busy = scanBusy || d.nominalBusy || d.alignStatus === 'running' || d.mapStatus === 'running'
  const ready = Boolean(scanName && d.nominalName)
  const aligned = d.alignStatus === 'done' && d.align !== null
  // Whichever map this panel is reading. The two are held side by side, so the
  // scale, the figures and the pins below follow the source rather than
  // whichever was measured last.
  const hasMap = mapHeld(d)
  const target = targetFitOf(elements, d.targetId)

  // A fit that lands far from the surface, or that had a near-tie for the best
  // starting pose, is worth saying out loud — it is the one case where the
  // automatic match quietly produces a wrong-looking map.
  const suspect = aligned && d.align!.source !== 'local' && (d.align!.ambiguous || d.align!.rms > 1)
  const enough = markCount >= MIN_LOCAL_POINTS
  // While the marking tools are out they own the workflow, so everything that
  // belongs to another step fades back — loading models, the global fit, and
  // reading the map are all things to do before or after, not during. Faded
  // rather than disabled, and back to full strength under the pointer: none of
  // it stops working, it just stops competing for attention.
  const aside = d.marking ? 'group muted' : 'group'

  return (
    <aside className="panel">
      <div className={aside}>
        <div className="sec-head">
          Measure against
          <InfoDot title="What the deviation is measured from">
            <p>
              Both choices paint the same map onto the scan — a signed distance, warm where there
              is too much material and cool where there is too little. They differ in what the zero
              of that scale is.
            </p>
            <p>
              A <b>reference model</b> is the whole nominal part. It answers "is this the shape it
              was drawn as", and needs the CAD file loaded and best-fitted onto the scan first.
            </p>
            <p>
              A <b>fitted element</b> is one plane, cylinder or sphere you measured on this scan in
              the 3D Measure workspace. It answers "is this face flat, is this bore round, does this
              surface sit where the datum says" — and since it was measured on the scan it is
              already in the scan's frame, so there is no reference file and no alignment.
            </p>
          </InfoDot>
        </div>
        <div className="sourcerow">
          {SOURCES.map((s) => (
            <button
              key={s.id}
              data-test={`source-${s.id}`}
              className={d.source === s.id ? 'on' : undefined}
              title={`Measure the scan against ${s.what}`}
              disabled={busy}
              onClick={() => d.setSource(s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <div className={aside}>
        <div className="sec-head">
          {onElement ? 'Model' : 'Models'}
          <InfoDot title={onElement ? 'The scan' : 'Scan and reference'}>
            {onElement ? (
              <p>
                The part as measured — an <b>STL</b>, <b>PLY</b> or <b>OBJ</b> in millimetres. Drop
                it anywhere in the window. Measuring against an element needs nothing else: the
                element is measured on this same scan.
              </p>
            ) : (
              <>
                <p>
                  The part as scanned, and the nominal CAD part it should match. Drop either one
                  anywhere in the window. Nothing is uploaded.
                </p>
                <p>
                  The scan is an <b>STL</b>, <b>PLY</b> or <b>OBJ</b> in millimetres. The reference
                  takes those too, and also a <b>STEP</b> file straight from CAD — its exact
                  surfaces are tessellated here, finely enough that the conversion sits well below
                  anything the scan can resolve.
                </p>
              </>
            )}
          </InfoDot>
        </div>
        <ModelSlot
          role="Scan"
          name={scanName}
          detail={`${scanTriangles.toLocaleString('en-US')} triangles`}
          dotColor="#8b9099"
          busy={busy}
          onOpen={onOpenScan}
        />
        {!onElement && (
          <ModelSlot
            role="Reference"
            name={d.nominalName}
            detail={
              d.nominalStep
                ? `${d.nominalTriangles.toLocaleString('en-US')} triangles · STEP at ${setting(d.nominalStep.surfaceDeviation)}`
                : `${d.nominalTriangles.toLocaleString('en-US')} triangles`
            }
            dotColor="#7f8ba0"
            busy={busy}
            accept={REFERENCE_ACCEPT}
            formats={REFERENCE_FORMATS}
            onOpen={onOpenNominal}
          />
        )}
      </div>

      {onElement && (
        /* Not `aside`: in element mode the marking tools live inside this very
           section, so it stays at full strength while they are out. */
        <TargetSection
          className="group"
          elements={elements}
          targetId={d.targetId}
          target={target}
          side={d.targetSide}
          shown={d.showElement}
          disabled={!scanName || busy}
          scope={d.targetScope}
          scopeMarking={d.marking}
          scopeCount={d.scopeCount}
          markCount={markCount}
          onSelect={onSelectTarget}
          onShown={d.setShowElement}
          onFlip={d.flipTargetSide}
          onScope={onScopeChange}
          onScopeDone={onScopeDone}
          onScopeClear={onScopeClear}
          onGoToMeasure={onGoToMeasure}
        />
      )}

      {!onElement && (
      <div className={aside}>
        <div className="sec-head">
          Best fit
          <InfoDot title="Best fit">
            <p>
              Brings the scan onto the reference before anything is measured. Rotation and
              translation only — no scale, so a scanner scale error stays visible in the map instead
              of being quietly absorbed by the alignment.
            </p>
            <p>
              <b>Align automatically</b> searches for the pose on its own and is what you want
              almost always. <b>Align by picking points</b> is the fallback for a part it gets wrong
              — usually one symmetric enough to match the wrong way round.
            </p>
          </InfoDot>
        </div>
        <button
          className={pulseAlign ? 'primary block pulse' : 'primary block'}
          data-test="align-auto"
          data-confirm={d.globalAlign ? undefined : 1}
          disabled={!ready || busy}
          onClick={onAlign}
        >
          {d.alignStatus === 'running' ? (
            <>
              <span className="spinner" />
              Aligning…
            </>
          ) : (
            'Align automatically'
          )}
        </button>
        {/* A fit can run for a minute on a large reference, and the answer is
            sometimes visibly wrong long before it finishes. Stopping leaves
            everything as it was — see alignStopped. While the fine fit's tools
            are out the stop belongs beside *that* button instead, so there is
            never a pair of them to choose between. */}
        {d.alignStatus === 'running' && !d.marking ? (
          <button
            className="block"
            data-test="align-stop"
            disabled={d.alignStopping}
            title="Stop the fit where it is — the alignment in hand is kept and nothing is measured. Esc does the same."
            onClick={onStopAlign}
          >
            {d.alignStopping ? 'Stopping…' : 'Stop aligning'}
          </button>
        ) : (
          <button
            className="block"
            data-test="align-points"
            disabled={!ready || busy}
            onClick={onPickPoints}
          >
            Align by picking points…
          </button>
        )}

        {d.alignMessage && <p className="alarmtext">{d.alignMessage}</p>}

        {/* A reference modelled on the scan stands in the scan's own frame:
            no fit was run, which is worth saying since the map then shows
            the model's own offsets. */}
        {aligned && d.align!.source === 'built' && (
          <p className="hint" data-test="align-built">
            No best fit was run: the reference was modelled on this scan, in its frame, so the map
            shows the model's own offsets. <i>Align automatically</i> fits it anyway.
          </p>
        )}
        {aligned && (
          <>
            {d.align!.underconstrained && (
              <p className="warnnote">
                ⚠ The marked surface faces one way only, so the fit could correct the distance
                across it and nothing else — the part is still free to slide along it. Mark a second
                surface facing another way to pin it down.
              </p>
            )}
            {suspect && (
              <p className="alarmtext">
                {d.align!.ambiguous
                  ? 'Another starting pose fitted almost as well — this part may be symmetric enough to match the wrong way round. Check it against the reference, and pick points if it is wrong.'
                  : 'The scan is still far from the reference after fitting. Try aligning by picking points.'}
              </p>
            )}
            {d.mapStatus !== 'ready' && (
              <button
                className={pulseMeasure ? 'primary block pulse' : 'primary block'}
                data-test="measure-deviation"
                data-confirm={2}
                disabled={busy}
                onClick={onMeasure}
              >
                {d.mapStatus === 'running' ? (
                  <>
                    <span className="spinner" />
                    Measuring…
                  </>
                ) : (
                  'Measure deviation'
                )}
              </button>
            )}
          </>
        )}
      </div>
      )}

      {!onElement && aligned && (
        <div className="group">
          <div className="sec-head">
            Local fine fit
            <InfoDot title="Local fine fit">
              <p>An optional second step, once the global fit is in — most parts do not need it.</p>
              <p>
                Scan spray, print supports, risers, fixturing and any geometry the reference does
                not have all pull on the whole-scan fit, and no number of passes will shake them
                loose. Mark the surfaces that really are the part and the fit is computed on those
                alone.
              </p>
              <p>
                Only the alignment narrows: the map that follows is still measured everywhere on the
                scan.
              </p>
            </InfoDot>
          </div>

          {!d.marking ? (
            <button
              className="block"
              data-test="local-start"
              disabled={busy}
              onClick={onStartMarking}
            >
              Mark surface to fit on…
            </button>
          ) : (
            <>
              {!d.showScan && (
                <p className="warnnote">
                  ⚠ The scan is hidden, so there is nothing to mark on — show it again with the{' '}
                  <b>Scan</b> key on the view bar. What is already marked is still there.
                </p>
              )}
              <MarkTools
                escapeNote="Esc a second time closes this step and clears the marking."
                onClear={onClearMarking}
              />

              <NumberField
                label="Max search distance"
                testId="local-max-distance"
                value={d.localMaxDistance}
                step={0.1}
                min={0.0001}
                kind="length"
                onCommit={d.setLocalMaxDistance}
                hint={
                  <>
                    <p>
                      How far a marked point may reach for reference surface while the fine fit
                      runs.
                    </p>
                    <p>
                      Keep it tight: the global fit already has the part within{' '}
                      {inches ? 'a few thousandths, so 0.04 in' : 'a few tenths, so a millimetre'} is
                      generous. Raising it lets the marked surface reach a neighbouring feature and
                      settle onto that instead.
                    </p>
                  </>
                }
              />

              <button
                className="primary block"
                data-test="local-fit"
                data-confirm={1}
                disabled={busy || !enough}
                onClick={onLocalFit}
              >
                {d.alignStatus === 'running' ? (
                  <>
                    <span className="spinner" />
                    Fine fitting…
                  </>
                ) : (
                  'Fit on marked surface'
                )}
              </button>
              {d.alignStatus === 'running' && (
                <button
                  className="block"
                  data-test="local-stop"
                  disabled={d.alignStopping}
                  title="Stop the fit where it is — the alignment in hand is kept, the marking stays as it is, and nothing is measured. Esc does the same."
                  onClick={onStopAlign}
                >
                  {d.alignStopping ? 'Stopping…' : 'Stop fitting'}
                </button>
              )}
              {!enough && (
                <p className="hint">
                  Drag on the scan to mark the surface to fit on — at least {MIN_LOCAL_POINTS}{' '}
                  points. Right-drag rubs out, Shift-drag still orbits.
                </p>
              )}
              <button
                className="block"
                data-test="mark-done"
                title="Closes this step and clears the marking — Esc does the same, once the camera has its buttons back"
                onClick={onStopMarking}
              >
                Put the marking tools away
              </button>
            </>
          )}

          {d.globalAlign && d.align!.source === 'local' && (
            <button
              className="block"
              data-test="local-revert"
              disabled={busy}
              onClick={onRevertLocal}
            >
              Back to the global fit
            </button>
          )}
        </div>
      )}

      {!onElement && aligned && <VolumeSection className={aside} onMeasure={onMeasureVolume} onFrame={onFrame} />}

      {hasMap && (
        <>
          <div className={aside}>
            <div className="sec-head">
              Colour scale
              <InfoDot title="Colour scale">
                <p>
                  How the measured deviation is painted onto the scan. Zero always sits at the
                  centre of the scale, on green; anything past either end is drawn in a dark cap so
                  it cannot be mistaken for the limit itself.
                </p>
                <p>
                  <b>Positive is outside the reference</b> — material the reference does not have,
                  painted warm. <b>Negative is inside it</b> — material the reference has and the
                  scan does not, painted cool. Both ends of the scale say so beside the map.
                </p>
                <p>
                  The slider is logarithmic, so the same control serves{' '}
                  {inches ? 'a 0.001 in print and a 0.2 in' : `a 0.02 ${len.word()} print and a 5 ${len.word()}`}{' '}
                  warp. <b>Bands</b> replaces the continuous ramp with discrete steps, which is
                  easier to read off a screenshot or a printed report.
                </p>
                <p>
                  Showing and hiding what is on the stage changes nothing that was measured — it
                  only changes what you are looking at.
                </p>
              </InfoDot>
            </div>
            <input
              className="slider"
              type="range"
              data-test="range-slider"
              min={Math.log10(len.toDisplay(10 ** -3))}
              max={Math.log10(len.toDisplay(10 ** 1.4))}
              step={0.01}
              // Logarithmic: a scale that has to serve both a 0.02 mm print and
              // a 5 mm warp cannot be linear without one end being unusable. It
              // runs in the units shown, so it settles on figures round in them.
              value={Math.log10(len.toDisplay(d.range))}
              onChange={(e) => d.setRange(len.fromDisplay(Number((10 ** Number(e.target.value)).toPrecision(2))))}
            />
            <NumberField
              label="Range ±"
              testId="range-value"
              value={d.range}
              step={0.01}
              min={0.0001}
              kind="length"
              onCommit={d.setRange}
              hint="Half-width of the colour scale. Zero always sits at the centre, on green; positive is outside the reference, negative inside it, and anything past either end is drawn in a dark cap."
            />
            <ScaleControls
              bands={d.bands}
              onBands={d.setBands}
              showHistogram={d.showHistogram}
              onShowHistogram={d.setShowHistogram}
              histogramTestId="toggle-histogram"
            />
            {/* Showing the elements belongs to the Element section rather than
                here: they are on the part from the moment this workspace opens,
                which is before there is any colour scale to put a switch on.
                The scan and the reference are the view bar's Scan and
                Reference keys. */}
          </div>

          <div className={aside}>
            <div className="sec-head">
              Deformation
              <InfoDot title="Animated deformation">
                <p>
                  Plays the map as motion, the way an FE package animates a deformed shape: the part
                  moves from the shape it should have to the shape it was measured at, with the
                  deviation multiplied by the <b>scale</b>, and back again, on a loop.
                </p>
                <p>
                  Each point moves along the line its deviation was measured on —{' '}
                  {onElement ? 'straight off the element' : 'straight off the reference surface'} —
                  so a warp, a twist or a wall leaning in shows as the part bending that way.
                </p>
                <p>
                  What is exaggerated is how the part as a whole has deformed. The motion is
                  smoothed over about a hundredth of the part’s size, so the scanner’s
                  noise and the edges of holes stay at their true size and ride along instead of
                  being blown up into fur. A reading past the end of the <b>colour scale</b> moves
                  only as far as the end, and points with no reading, the grey ones, stay where
                  they are — widen the range to let more of the part move.
                </p>
                <p>
                  The scale starts where the end of the colour scale moves by about a twentieth of
                  the part, and follows the range until you set one. At <b>1×</b> the part moves
                  exactly as far as it is out.
                </p>
                <p>
                  Only the picture moves. The colours, the figures, the hover reading and the pins
                  are the part as measured, and so is an exported scan.
                </p>
              </InfoDot>
            </div>
            <button
              className={d.animate ? 'block on' : 'block'}
              data-test="animate-deformation"
              // The marking tools work on the scan where it is; the motion
              // waits until they are put away.
              disabled={d.marking}
              onClick={() => d.setAnimate(!d.animate)}
            >
              {d.animate ? 'Stop the animation' : 'Animate the deformation'}
            </button>
            <input
              className="slider"
              type="range"
              data-test="anim-scale-slider"
              min={Math.log10(MIN_DEFLECTION_SCALE)}
              max={3}
              step={0.01}
              // Logarithmic for the same reason as the colour range: a warp of
              // millimetres wants a few times, a print true to hundredths wants
              // hundreds.
              value={Math.log10(d.animScale)}
              onChange={(e) => d.setAnimScale(Number((10 ** Number(e.target.value)).toPrecision(2)))}
            />
            <NumberField
              label="Scale"
              testId="anim-scale"
              value={d.animScale}
              step={1}
              min={MIN_DEFLECTION_SCALE}
              unit="×"
              onCommit={(v) => d.setAnimScale(Math.min(v, MAX_DEFLECTION_SCALE))}
              hint={`How many times the deviation is exaggerated at the far end of the loop. 1× is the part as measured; 20× moves a ${
                inches ? '0.005 in deviation by 0.1 in' : `0.1 ${len.word()} deviation by 2 ${len.word()}`
              }.`}
            />
            {d.animate && !d.showScan && (
              <p className="hint">
                The scan is hidden, so there is nothing to watch move — show it again with the{' '}
                <b>Scan</b> key on the view bar.
              </p>
            )}
          </div>

          <div className={aside}>
            <div className="sec-head">What counts as measured</div>
            <NumberField
              label="Max search distance"
              testId="max-distance"
              value={d.maxDistance}
              step={0.1}
              min={0.0001}
              kind="length"
              onCommit={d.setMaxDistance}
              hint={
                onElement ? (
                  <>
                    <p>How far off the element a scan point may be and still be measured.</p>
                    <p>
                      Beyond it the surface is left in plain grey and kept out of the statistics —
                      which is what keeps a neighbouring feature inside the element's footprint from
                      being reported as enormous error.
                    </p>
                    <p>
                      Display only, so it can be dialled either way with the map following
                      immediately. How far the element reaches <i>sideways</i> is set by extending
                      it in the 3D Measure workspace.
                    </p>
                  </>
                ) : (
                  <>
                    <p>How far a scan point may look for reference surface.</p>
                    <p>
                      Beyond it there is nothing to deviate from, so that surface is left in plain
                      grey and kept out of the statistics — which is what stops scan spray and a
                      stray fixture from being reported as enormous error.
                    </p>
                    <p>Display only: it never affects the alignment.</p>
                  </>
                )
              }
            />
            {onElement && (
              <>
                <label className="checkrow">
                  <input
                    type="checkbox"
                    data-test="toggle-facing"
                    checked={d.targetFacingDeg !== null}
                    onChange={(e) => d.setTargetFacing(e.target.checked ? 60 : null)}
                  />
                  <span>Surface must face the element</span>
                  <InfoDot title="Surface must face the element">
                    <p>
                      An element is a surface with a side to it, and only the scan surface lying on
                      that side is the surface being measured. A plane fitted on the top of a{' '}
                      {inches ? '0.4 in' : `10 ${len.word()}`} plate reaches the underside of it too
                      — and would report it as {inches ? '0.4 in' : 'ten millimetres'} of missing
                      material.
                    </p>
                    <p>
                      With this on, a scan point whose own normal points away from the element's is
                      left out, so the far side of a wall and the back of a rib stay grey.
                    </p>
                  </InfoDot>
                </label>
                {d.targetFacingDeg !== null && (
                  <NumberField
                    label="Max. deviation of normals"
                    testId="facing-deg"
                    value={d.targetFacingDeg}
                    step={5}
                    min={1}
                    unit="°"
                    onCommit={(v) => d.setTargetFacing(v)}
                    hint="How far the scan may be from facing the way the element faces and still count. Wide enough to keep a genuinely warped surface, tight enough to leave the other side of a wall out."
                  />
                )}
              </>
            )}
            {!onElement && (
              <>
                <label className="checkrow">
                  <input
                    type="checkbox"
                    data-test="toggle-map-facing"
                    disabled={busy}
                    checked={d.mapFacingDeg !== null}
                    onChange={(e) => onMapFacing(e.target.checked ? DEFAULT_MAP_FACING_DEG : null)}
                  />
                  <span>Reference must face the same way</span>
                  <InfoDot title="Reference must face the same way">
                    <p>
                      The nearest reference surface is not always the one a point came off. Across
                      a thin wall, a point sunk more than half the wall's thickness is nearer the
                      far side of the wall than its own — and reads too small, or with the wrong
                      sign once it is through.
                    </p>
                    <p>
                      With this on, reference surface facing away from the scan at that point is
                      stepped over, and the point is measured against the nearest surface that
                      faces its way. A point with no such surface anywhere near is left grey.
                    </p>
                    <p>
                      Everywhere else the reading is the plain closest point, as before. Which way
                      the scan faces is read off its own normals. Changing this measures the map
                      again.
                    </p>
                  </InfoDot>
                </label>
                {d.mapFacingDeg !== null && (
                  <NumberField
                    label="Max. deviation of normals"
                    testId="map-facing-deg"
                    value={d.mapFacingDeg}
                    step={5}
                    min={1}
                    unit="°"
                    disabled={busy}
                    onCommit={(v) => onMapFacing(v)}
                    hint="How far the reference surface may be from facing the way the scan does and still be measured against. 90° steps over only surface facing away. Tighter also re-reads the steep sides of edges the scan has rounded over, against the face beside the nearest one."
                  />
                )}
              </>
            )}
            <NumberField
              label="Tolerance ±"
              value={d.tolerance}
              step={0.01}
              min={0.0001}
              kind="length"
              onCommit={d.setTolerance}
              hint={
                <>
                  <p>
                    The band the <b>within ±{setting(d.tolerance)}</b> figure under the scale counts.
                  </p>
                  <p>
                    It is a tally, not a filter: it does not change the colours or what was
                    measured. Set the range to the same number if you want the map itself to draw
                    the line.
                  </p>
                </>
              }
            />
          </div>

          <ProbeList
            className={aside}
            probes={d.probes}
            rowTestId="probe-row"
            format={(v) => formatSigned(v, len.units)}
            onRemove={d.removeProbe}
            onClear={d.clearProbes}
          />
        </>
      )}

      {scanName && (
        <div className={'tailrow' + (d.marking ? ' muted' : '')}>
          <div className="divider" />
          {hasMap && (
            // Its figures are the map in hand's and its settings the new ones'
            // until the map being measured lands.
            <CopyButton className="block" label="Copy report" disabled={onElement && d.elementStatus === 'running'} onCopy={onCopy} />
          )}
          <ExportMeshButton
            block
            testId="export-mesh"
            disabled={scanBusy}
            onExport={onExportMesh}
            title={
              onElement
                ? 'Save the scan as an STL or a 3MF where it now stands'
                : 'Save the scan as an STL or a 3MF where it now stands — the best fit onto the reference is baked in'
            }
          />
        </div>
      )}
    </aside>
  )
}
