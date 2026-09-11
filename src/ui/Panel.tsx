// SPDX-License-Identifier: AGPL-3.0-only
// The left faceplate: everything the operator sets, and every number the tool
// reports. Controls at the top, readouts below, in the order the work happens.

import { useStore, type SelectMode } from '../state/store'
import { sectionElementsOf, useFlat } from '../state/flatStore'
import { usePulse } from '../app/useHints'
import { ELEMENT_KINDS } from '../core/elements/kinds'
import { describeCut, sectionRefName, tiltOf } from '../core/section/frame'
import { cutSummary } from '../core/section/slice'
import { formatPrimary } from '../core/summary'
import type { Rigid } from '../core/deviation/rigid'
import type { StepStyle } from '../core/exportStep'
import type { ElementKind, SigmaPreset } from '../core/types'
import { AlignmentSection } from './AlignmentSection'
import { CopyButton } from './CopyButton'
import { DimensionSection } from './DimensionSection'
import { ToleranceSection } from './ToleranceSection'
import { DraftEditor } from './DraftEditor'
import { ShowAllButton } from './ShowAllButton'
import { ElementRow } from './ElementRow'
import { InfoDot } from './InfoDot'
import { ModelSlot } from './ModelSlot'
import { SectionEditor } from './SectionEditor'

export function Panel({
  onOpenScan,
  onStartDraft,
  onSelectMode,
  onDraftSigma,
  onClearPaint,
  onUndoPick,
  onCancelDraft,
  onConfirmDraft,
  onPickPoint,
  onDelete,
  onEditElement,
  onStartSection,
  onEditSection,
  onDeleteSection,
  onCancelSection,
  onConfirmSection,
  onCopy,
  onStartAlignment,
  onApplyAlignment,
  onApplyManual,
  onResetAlignment,
  onExportStep,
  onExportStl,
}: {
  onOpenScan: (file: File) => void
  onStartDraft: (kind: ElementKind) => void
  /** Switch between clicking a point and marking the surface by hand. */
  onSelectMode: (mode: SelectMode) => void
  /** The open draft's outlier cut-off changed: it re-fits on what it has. */
  onDraftSigma: (k: SigmaPreset) => void
  /** Rub out the whole hand-marked surface. */
  onClearPaint: () => void
  onUndoPick: () => void
  onCancelDraft: () => void
  onConfirmDraft: () => void
  /** Fill dimension slot n by picking a new point on the scan. */
  onPickPoint: (slot: number) => void
  onDelete: (id: number) => void
  /** Re-open an element: the same box it was created in, with its seeds or its
   *  marked surface back on the scan. */
  onEditElement: (id: number) => void
  /** Cut the scan with a plane, to measure the cut in the 2D workspace. */
  onStartSection: () => void
  onEditSection: (id: number) => void
  onDeleteSection: (id: number) => void
  onCancelSection: () => void
  onConfirmSection: () => void
  onCopy: () => void
  onStartAlignment: () => void
  /** Bake the computed datum alignment into the part. */
  onApplyAlignment: (m: Rigid) => void
  /** Bake a typed-in move / rotate into the part. */
  onApplyManual: (m: Rigid) => void
  onResetAlignment: () => void
  onExportStep: () => void
  /** Save the scan as an STL in the pose it is currently shown in. */
  onExportStl: () => void
}) {
  const fileName = useStore((s) => s.fileName)
  const busy = useStore((s) => s.busy)
  const triangleCount = useStore((s) => s.triangleCount)
  const elements = useStore((s) => s.elements)
  const draft = useStore((s) => s.draft)
  const dimDraft = useStore((s) => s.dimDraft)
  const alignDraft = useStore((s) => s.alignDraft)
  const sections = useStore((s) => s.sections)
  const sectionDraft = useStore((s) => s.sectionDraft)
  // What has been measured on each section's sheet, in the 2D workspace: it
  // is drawn with the section here and goes into the STEP file under its
  // name, so the row says how much there is and the export key knows.
  const flatSubject = useFlat((s) => s.subject)
  const flatElements = useFlat((s) => s.elements)
  const flatSheets = useFlat((s) => s.sheets)
  const measuredOn = (id: number) =>
    sectionElementsOf({ subject: flatSubject, elements: flatElements, sheets: flatSheets }, id).filter(
      (el) => el.fit,
    ).length
  const anyMeasuredOnSections = sections.some((sec) => measuredOn(sec.id) > 0)
  const stepStyle = useStore((s) => s.stepStyle)
  const setStepStyle = useStore((s) => s.setStepStyle)
  const toggleElementVisible = useStore((s) => s.toggleElementVisible)
  const setAllElementsVisible = useStore((s) => s.setAllElementsVisible)
  const toggleSectionVisible = useStore((s) => s.toggleSectionVisible)
  const setAllSectionsVisible = useStore((s) => s.setAllSectionsVisible)
  // Which shape to fit is the user's to decide, so the ring goes round the row
  // rather than singling one of them out.
  const pulseKind = usePulse('kindrow')

  // While anything is being assembled the row keys stand down: re-opening a
  // second element or dimension would throw away what is already in the box.
  const editorOpen =
    draft !== null || dimDraft !== null || alignDraft !== null || sectionDraft !== null

  // Elements currently referenced by the dimension, construction, alignment
  // or section being built — marked in the list to mirror their glow in the
  // viewport.
  const selectedIds = new Set(
    [
      ...(dimDraft?.refs ?? []),
      ...(draft?.refs ?? []),
      ...(alignDraft ? [alignDraft.primary, alignDraft.secondary, alignDraft.origin] : []),
      sectionDraft?.ref ?? null,
    ].filter((r): r is number => typeof r === 'number'),
  )

  return (
    <aside className="panel">
      <div className="group">
        <div className="sec-head">
          Model
          <InfoDot title="The scan">
            <p>
              The part as measured — an <b>STL</b>, <b>PLY</b> or <b>OBJ</b> from your scanner. Drop
              it anywhere in the window, or use the button.
            </p>
            <p>
              Units are assumed to be millimetres. Nothing is uploaded: the file is read and the
              whole measurement runs in this browser.
            </p>
          </InfoDot>
        </div>
        <ModelSlotBlock
          fileName={fileName}
          triangleCount={triangleCount}
          busy={busy}
          onOpenScan={onOpenScan}
        />
      </div>

      <AlignmentSection
        onStartAlignment={onStartAlignment}
        onApplyAlignment={onApplyAlignment}
        onApplyManual={onApplyManual}
        onResetAlignment={onResetAlignment}
      />

      {draft === null && sectionDraft === null && (
        <div className="group">
          <div className="sec-head">
            Create element
            <InfoDot title="Elements">
              <p>
                Every measurement here starts with an element — a plane, a cylinder, a sphere, a
                circle, a point or a line. Dimensions are then measured between them, never between
                raw triangles.
              </p>
              <p>
                An element is either <b>fitted</b> to the scan, by clicking the feature and letting
                the tool find the surface; <b>picked</b> straight off the mesh, for a single point;
                or <b>constructed</b> from elements you already have — an axis through two circles,
                a midpoint between two points, a plane offset from another.
              </p>
              <p>
                Which of those a kind offers appears as <i>Created</i> once you choose it.
              </p>
              <p>
                <b>Section</b> is not an element but a cut: the scan sliced with a plane taken
                across an element&apos;s direction, to be measured on the sheet of the 2D Measure
                workspace.
              </p>
            </InfoDot>
          </div>
          <div className={pulseKind && !busy ? 'kindrow pulse' : 'kindrow'}>
            {ELEMENT_KINDS.map((k) => (
              <button
                key={k.id}
                data-test={`fit-${k.id}`}
                disabled={!fileName || busy}
                onClick={() => onStartDraft(k.id)}
              >
                {k.label}
              </button>
            ))}
            <button
              data-test="fit-section"
              disabled={!fileName || busy}
              title="Cut the scan with a plane, to measure the cut in the 2D Measure workspace"
              onClick={onStartSection}
            >
              Section
            </button>
          </div>
        </div>
      )}

      <DraftEditor
        onSelectMode={onSelectMode}
        onDraftSigma={onDraftSigma}
        onClearPaint={onClearPaint}
        onUndoPick={onUndoPick}
        onCancelDraft={onCancelDraft}
        onConfirmDraft={onConfirmDraft}
      />

      <SectionEditor onCancel={onCancelSection} onConfirm={onConfirmSection} />

      {elements.length > 0 && (
        <div className="group">
          <div className="g-label">
            <span>Elements</span>
            <ShowAllButton
              anyVisible={elements.some((e) => e.visible)}
              what="elements"
              testId="elements-show-all"
              onSet={setAllElementsVisible}
            />
            <b>{elements.length}</b>
          </div>
          {elements.map((el) => (
            <ElementRow
              key={el.id}
              name={el.name}
              color={el.color}
              visible={el.visible}
              reading={
                el.status === 'fitting' ? (
                  <b className="working">
                    <span className="spinner" />
                    fitting
                  </b>
                ) : el.fit ? (
                  <b>{formatPrimary(el.fit)}</b>
                ) : (
                  <b className="warn" title={el.message}>
                    ⚠
                  </b>
                )
              }
              selected={selectedIds.has(el.id) || draft?.editId === el.id}
              editorOpen={editorOpen}
              editDisabled={el.status === 'fitting'}
              onEdit={() => onEditElement(el.id)}
              onToggleVisible={() => toggleElementVisible(el.id)}
              onDelete={() => onDelete(el.id)}
            />
          ))}
        </div>
      )}

      {sections.length > 0 && (
        <div className="group">
          <div className="g-label">
            <span>Sections</span>
            <ShowAllButton
              anyVisible={sections.some((sec) => sec.visible)}
              what="sections"
              testId="sections-show-all"
              onSet={setAllSectionsVisible}
            />
            <b>{sections.length}</b>
          </div>
          {sections.map((sec) => {
            const where = describeCut(
              sectionRefName(sec.ref, elements),
              sec.offset,
              tiltOf(sec.refDir, sec.frame.normal),
            )
            const chains = sec.cut ? cutSummary(sec.cut).chains : 0
            const measured = measuredOn(sec.id)
            return (
              <ElementRow
                key={sec.id}
                testId="section-row"
                name={sec.name}
                color={sec.color}
                visible={sec.visible}
                reading={
                  sec.cut ? (
                    <b title={where}>
                      {chains} edge{chains === 1 ? '' : 's'}
                      {measured > 0 && ` · ${measured} element${measured === 1 ? '' : 's'}`}
                    </b>
                  ) : sec.message ? (
                    <b className="warn" title={sec.message}>
                      ⚠
                    </b>
                  ) : (
                    <b className="working">
                      <span className="spinner" />
                      cutting
                    </b>
                  )
                }
                selected={sectionDraft?.editId === sec.id}
                editorOpen={editorOpen}
                onEdit={() => onEditSection(sec.id)}
                onToggleVisible={() => toggleSectionVisible(sec.id)}
                onDelete={() => onDeleteSection(sec.id)}
              />
            )
          })}
          <p className="hint">
            Measure a section in the <b>2D Measure</b> workspace. What you fit on its sheet is drawn
            on the cut here and goes into the STEP file with the section.
          </p>
        </div>
      )}

      <DimensionSection editorOpen={editorOpen} onPickPoint={onPickPoint} />
      <ToleranceSection editorOpen={editorOpen} />

      {fileName && (
        <>
          <div className="divider" />
          <label className="field">
            <span>
              STEP as
              <InfoDot title="What the STEP file contains">
                <p>
                  <b>Solids &amp; faces:</b> each element as geometry CAD can build on — a plane as a
                  bounded planar face with real edges, a cylinder and a sphere as closed solid
                  bodies, each its own named body in the tree. Sketch on them, offset them, cut with
                  them.
                </p>
                <p>
                  <b>Construction surfaces:</b> the same geometry as trimmed analytic surfaces and
                  curves in one set, with no topology — the form metrology packages hand measured
                  datums over in. Unmistakably reference geometry rather than a part, and the safer
                  choice for an importer that chokes on bodies.
                </p>
                <p>
                  Points and lines are points and lines either way. Whatever an element has been
                  extended to is what gets written, and a sphere, cylinder or circle given an
                  assumed Ø when it was created is written at that Ø — everything else as measured.
                </p>
                <p>
                  What was measured on a section's sheet in 2D Measure — its points, lines, circles
                  and arcs — comes too, as curves lying in the cutting plane, in a group named after
                  the section. Cut a section through a bore, fit its circle on the sheet, and CAD
                  gets a circle in space to sketch on.
                </p>
              </InfoDot>
            </span>
            <select
              data-test="step-style"
              value={stepStyle}
              onChange={(e) => setStepStyle(e.target.value as StepStyle)}
            >
              <option value="solids">Solids &amp; faces</option>
              <option value="surfaces">Construction surfaces</option>
            </select>
          </label>
          <div className="toolrow">
            <CopyButton
              label="Copy summary"
              disabled={elements.every((e) => !e.fit)}
              onCopy={onCopy}
            />
            <button
              data-test="export-step"
              disabled={elements.every((e) => !e.fit) && !anyMeasuredOnSections}
              onClick={onExportStep}
              title="Export the created elements — and what was measured on the sections — as analytic geometry in a STEP file"
            >
              Export STEP
            </button>
            <button
              data-test="export-stl"
              disabled={busy}
              onClick={onExportStl}
              title="Save the scan as an STL where it now stands — any alignment or move you applied comes with it"
            >
              Export STL
            </button>
          </div>
        </>
      )}
    </aside>
  )
}

// Kept out of the main component so the file-slot block reads as one unit.
function ModelSlotBlock({
  fileName,
  triangleCount,
  busy,
  onOpenScan,
}: {
  fileName: string | null
  triangleCount: number
  busy: boolean
  onOpenScan: (file: File) => void
}) {
  return (
    <>
      <ModelSlot
        role="Scan"
        name={fileName}
        detail={`${triangleCount.toLocaleString('en-US')} triangles`}
        dotColor="#8b9099"
        busy={busy}
        onOpen={onOpenScan}
      />
      {!fileName && <p className="hint">Drop it anywhere in the window.</p>}
    </>
  )
}
