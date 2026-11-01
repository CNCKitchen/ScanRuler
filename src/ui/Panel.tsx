// SPDX-License-Identifier: AGPL-3.0-only
// The left faceplate: everything the operator sets, and every number the tool
// reports. Controls at the top, readouts below, in the order the work happens.

import { useEffect } from 'react'
import { useShell } from '../state/shellStore'
import { DockPanel, ProjectTree, MeasureSearch, type MeasureAction } from './MeasurePanels'
import { dimensionTypeInfo } from '../core/dimensions'
import { draftHolds, useStore, type SelectMode } from '../state/store'
import { sectionElementsOf, useFlat } from '../state/flatStore'
import { usePulse } from '../app/useHints'
import { ELEMENT_KINDS, elementKindInfo } from '../core/elements/kinds'
import { describeCut, sectionRefName, tiltOf } from '../core/section/frame'
import { describeShadow } from '../core/section/shadow'
import { isExtruded } from '../state/sectionModel'
import { cutSummary } from '../core/section/slice'
import { formatPrimary } from '../core/summary'
import type { CloudFormat } from '../core/exportPointCloud'
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
import { Icon, type IconName } from './icons'
import { InfoDot } from './InfoDot'
import { ModelSlot } from './ModelSlot'
import { SectionEditor } from './SectionEditor'
import { ExportMeshButton } from './ExportMeshButton'
import type { MeshFormat } from '../core/exportMesh'
import { useUnits } from '../app/useUnits'

/** The picture on each element type's key. */
const KIND_ICON: Record<(typeof ELEMENT_KINDS)[number]['id'], IconName> = {
  point: 'elPoint',
  line: 'elLine',
  plane: 'elPlane',
  sphere: 'elSphere',
  cylinder: 'elCylinder',
  cone: 'elCone',
  circle: 'elCircle',
  torus: 'elTorus',
}

export function Panel({
  onOpenScan,
  onStartDraft,
  onSelectMode,
  onDraftSigma,
  onDraftKnownDiameter,
  onClearPaint,
  onUndoPick,
  onCancelDraft,
  onRestoreDraft,
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
  onAutoAlign,
  onAlignSymmetry,
  onStartAlignment,
  onApplyAlignment,
  onApplyManual,
  onResetAlignment,
  onExportStep,
  onExportMesh,
  onExportCloud,
  onFindSymmetry,
}: {
  onOpenScan: (file: File) => void
  onStartDraft: (kind: ElementKind) => void
  /** Switch between clicking a point and marking the surface by hand. */
  onSelectMode: (mode: SelectMode) => void
  /** The open draft's outlier cut-off changed: it re-fits on what it has. */
  onDraftSigma: (k: SigmaPreset) => void
  /** The open sphere's known diameter was typed in or cleared: it re-fits. */
  onDraftKnownDiameter: (mm: number | undefined) => void
  /** Rub out the whole hand-marked surface. */
  onClearPaint: () => void
  onUndoPick: () => void
  onCancelDraft: () => void
  /** Bring back the draft that was discarded with a marked surface on it,
   *  marking and all — see store.discarded. */
  onRestoreDraft: () => void
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
  onAutoAlign: () => void
  onAlignSymmetry: () => void
  onStartAlignment: () => void
  /** Bake the computed datum alignment into the part. */
  onApplyAlignment: (m: Rigid) => void
  /** Bake a typed-in move / rotate into the part. */
  onApplyManual: (m: Rigid) => void
  onResetAlignment: () => void
  onExportStep: () => void
  /** Save the scan as an STL in the pose it is currently shown in. */
  onExportMesh: (format: MeshFormat) => void
  /** Save the scan as a point cloud, in the chosen format, in the same pose. */
  onExportCloud: () => void
  /** Search the scan for its mirror plane, for the open symmetry-plane draft. */
  onFindSymmetry: () => void
}) {
  const fileName = useStore((s) => s.fileName)
  const busy = useStore((s) => s.busy)
  // Every reading in the lists is written in the units shown.
  const units = useUnits()
  const triangleCount = useStore((s) => s.triangleCount)
  const elements = useStore((s) => s.elements)
  const draft = useStore((s) => s.draft)
  const discarded = useStore((s) => s.discarded)
  const forgetDiscarded = useStore((s) => s.forgetDiscarded)
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
  // An extruded shadow is a solid of its own, in the solids form.
  const anyBlock = stepStyle === 'solids' && sections.some((sec) => isExtruded(sec) && sec.cut?.shadow)
  const setStepStyle = useStore((s) => s.setStepStyle)
  const cloudFormat = useStore((s) => s.cloudFormat)
  const setCloudFormat = useStore((s) => s.setCloudFormat)
  const toggleElementVisible = useStore((s) => s.toggleElementVisible)
  const setAllElementsVisible = useStore((s) => s.setAllElementsVisible)
  const toggleSectionVisible = useStore((s) => s.toggleSectionVisible)
  const setAllSectionsVisible = useStore((s) => s.setAllSectionsVisible)
  // Which shape to fit is the user's to decide, so the ring goes round the row
  // rather than singling one of them out.
  const pulseKind = usePulse('kindrow')

  // While anything is being assembled the row keys stand down: re-opening a
  // second element or dimension would throw away what is already in the box.
  // A kind merely in hand, its box still empty, is not in the way.
  const editorOpen =
    draftHolds(draft) || dimDraft !== null || alignDraft !== null || sectionDraft !== null

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

  const panel = useShell((s) => s.measurePanel)
  const setPanel = useShell((s) => s.setMeasurePanel)
  const projectOpen = useShell((s) => s.projectOpen)
  const setProjectOpen = useShell((s) => s.setProjectOpen)
  const selection = useStore((s) => s.selectedElementIds)
  const collapsed = useShell((s) => s.contextCollapsed)
  const setCollapsed = useShell((s) => s.setContextCollapsed)
  useEffect(() => { setCollapsed(false) }, [draft?.kind, draft?.editId, dimDraft?.type, alignDraft !== null, sectionDraft !== null, panel, setCollapsed])
  const activeTool = Boolean(draft || dimDraft || alignDraft || sectionDraft)
  const contextOpen = (activeTool || panel !== null) && !collapsed
  const utilityPanel = panel === 'search' || panel === 'export'
  const title = utilityPanel ? (panel === 'search' ? 'Find a tool' : 'Export') : draft ? (draft.editId !== undefined ? 'Edit element' : `Create ${elementKindInfo(draft.kind).noun}`)
    : dimDraft ? (dimensionTypeInfo(dimDraft.type).family === 'tolerance' ? 'Tolerance' : 'Dimension')
    : alignDraft ? 'Align scan' : sectionDraft ? 'Cross section'
    : panel === 'alignment' ? 'Align / move scan' : 'Create'
  const begin = (kind: ElementKind) => { setPanel(null); onStartDraft(kind) }
  const closeContext = () => { if (utilityPanel) setPanel(null); else if (activeTool) setCollapsed(true); else setPanel(null) }
  const actions: MeasureAction[] = [
    ...ELEMENT_KINDS.map((kind) => ({ name: `Create ${kind.noun}`, keywords: kind.id === 'cylinder' ? 'Hole, bore, shaft, diameter' : kind.id === 'plane' ? 'Flat face, datum, surface' : `Fit or construct a ${kind.noun}`, run: () => begin(kind.id), reason: busy ? 'Wait for the current operation to finish' : !fileName ? 'Open a scan first' : activeTool ? 'Finish or cancel the current tool first' : undefined })),
    { name: 'New dimension', keywords: 'Distance, angle, diameter, measurement', run: () => { setPanel(null); useStore.getState().startDimension('dist-point-point') }, reason: busy ? 'Wait for the current operation to finish' : activeTool ? 'Finish or cancel the current tool first' : elements.some((e) => e.fit) ? undefined : 'Create an element first' },
    { name: 'Cross section', keywords: 'Slice, cut, 2D outline', run: () => { setPanel(null); onStartSection() }, reason: busy ? 'Wait for the current operation to finish' : !fileName ? 'Open a scan first' : activeTool ? 'Finish or cancel the current tool first' : undefined },
    { name: 'Align / move scan', keywords: 'Position, rotate, datum', run: () => setPanel('alignment'), reason: busy ? 'Wait for the current operation to finish' : !fileName ? 'Open a scan first' : activeTool ? 'Finish or cancel the current tool first' : undefined },
    { name: 'Export', keywords: 'STEP, mesh, point cloud, summary', run: () => setPanel('export'), reason: fileName ? undefined : 'Open a scan first' },
  ]

  return <>
    <div className="measure-actions" aria-label="Measurement tools">
      {activeTool && collapsed && <button className="primary" onClick={() => setCollapsed(false)}>Show {title.toLowerCase()}</button>}
      <button className="project-toggle" aria-controls="measure-project" aria-expanded={projectOpen} onClick={() => {
        if (contextOpen && matchMedia('(max-width: 1199px)').matches) { setCollapsed(true); setProjectOpen(true) }
        else setProjectOpen(!projectOpen)
      }}>Project</button>
      {(['plane', 'cylinder', 'sphere', 'point'] as const).map((kind) => <button key={kind}
        data-test={`fit-${kind}`} aria-pressed={draft?.kind === kind && draft.editId === undefined}
        disabled={!fileName || busy || draft?.editId !== undefined || dimDraft !== null || alignDraft !== null || sectionDraft !== null}
        onClick={() => begin(kind)}><Icon name={KIND_ICON[kind]} size={20} /><span>{elementKindInfo(kind).label}</span></button>)}
      <button data-test="measure-more" disabled={activeTool} title={activeTool ? 'Finish or cancel the current tool first' : 'All measurement tools'} aria-expanded={panel === 'create'} onClick={() => setPanel(panel === 'create' ? null : 'create')}>More</button>
    </div>
    <DockPanel side="project" title="Project" open={projectOpen} onClose={() => setProjectOpen(false)}>
      <div className="group">
        <div className="sec-head">
          Model
          <InfoDot title="The scan">
            <p>
              The part as measured — an <b>STL</b>, <b>PLY</b> or <b>OBJ</b> from your scanner. Drop
              it anywhere in the window, or use the button.
            </p>
            <p>
              Choose the source units when opening an STL. PLY and OBJ are read in millimetres; 3MF carries its own units. Nothing is uploaded: the file is read and the
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


      <div className="project-commands">
        <button data-test="measure-align" onClick={() => setPanel('alignment')} disabled={!fileName || activeTool}>Align / move</button>
        <button data-test="measure-export" onClick={() => setPanel('export')} disabled={!fileName}>Export</button>
      </div>
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
          <ProjectTree>{elements.map((el) => (
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
                  <b>{formatPrimary(el.fit, units)}</b>
                ) : (
                  <b className="warn" title={el.message}>
                    ⚠
                  </b>
                )
              }
              selected={selectedIds.has(el.id) || selection.includes(el.id) || draft?.editId === el.id}
              onSelect={(additive) => { if (!activeTool) useStore.getState().selectElement(el.id, additive) }}
              onRename={(name) => useStore.getState().renameElement(el.id, name)}
              icon={KIND_ICON[el.kind]}
              editorOpen={editorOpen}
              editDisabled={el.status === 'fitting'}
              onEdit={() => onEditElement(el.id)}
              onToggleVisible={() => toggleElementVisible(el.id)}
              onDelete={() => onDelete(el.id)}
            />
          ))}</ProjectTree>
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
              sec.kind,
              units,
            )
            const chains = sec.cut ? cutSummary(sec.cut).chains : 0
            const shadow = sec.cut?.shadow ? describeShadow(sec.cut.shadow, units) : null
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
                      {shadow ? `${shadow.loops} · ${shadow.area}` : `${chains} edge${chains === 1 ? '' : 's'}`}
                      {measured > 0 && ` · ${measured} element${measured === 1 ? '' : 's'}`}
                    </b>
                  ) : sec.message ? (
                    <b className="warn" title={sec.message}>
                      ⚠
                    </b>
                  ) : (
                    <b className="working">
                      <span className="spinner" />
                      {sec.kind === 'shadow' ? 'projecting' : 'cutting'}
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


      {fileName && <div className="project-measurements">
        <div className="section-title"><h3>Dimensions</h3><button data-test="new-dimension" disabled={!elements.some((e) => e.fit) || activeTool} onClick={() => { setPanel(null); useStore.getState().startDimension('dist-point-point') }}>+ New</button></div>
        {elements.length === 0 && <p className="hint">Fit a surface or pick a point, then measure it.</p>}
        <DimensionSection part="results" editorOpen={editorOpen} onPickPoint={onPickPoint} />
        <details className="tolerance-disclosure"><summary>Geometric tolerances</summary>
          <button data-test="new-tolerance" disabled={!elements.some((e) => e.fit) || activeTool} onClick={() => { setPanel(null); useStore.getState().startDimension('form-flatness') }}>New tolerance</button>
          <ToleranceSection part="results" editorOpen={editorOpen} />
        </details>
      </div>}
      {selection.length > 0 && !activeTool && <div className="selection-actions" aria-label="Selected element actions">
        <p>{selection.length} {selection.length === 1 ? 'element' : 'elements'} selected</p>
        {selection.length === 1 && <button onClick={() => onEditElement(selection[0])}>Edit selected element</button>}
        <button onClick={() => { setPanel(null); useStore.getState().startDimension('dist-point-point'); selection.forEach((id) => useStore.getState().selectDimensionElement(id)) }}>Measure selection</button>
        <button className="ghost" onClick={() => useStore.getState().selectElement(null)}>Clear selection</button>
      </div>}
    </DockPanel>
    <DockPanel side="context" title={title} open={contextOpen} onClose={closeContext} hideActions={utilityPanel}>
      {utilityPanel && activeTool && <button className="block" onClick={() => setPanel(null)}>Return to current tool</button>}
      {panel === 'search' && <MeasureSearch actions={actions} />}
      {panel === 'create' && !activeTool && <><p className="hint">Choose the shape that matches the feature on your scan.</p>
      {sectionDraft === null && (
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
                The kind stays in hand after <b>Create</b>, ready for the next one, as a sketch
                tool does — <b>Cancel</b> or <b>Esc</b> puts it down; on a box with picks in it,
                <b> Esc</b> first empties the box.
              </p>
              <p>
                <b>Section</b> is not an element but a cut: the scan sliced with a plane taken
                across an element&apos;s direction, to be measured on the sheet of the 2D Measure
                workspace.
              </p>
            </InfoDot>
          </div>
          <div className={pulseKind && !busy ? 'kindrow featurekeys three pulse' : 'kindrow featurekeys three'}>
            {ELEMENT_KINDS.map((k) => (
              // The kind in hand is shown pressed, as the sketch's tools are;
              // while an element is being edited, or a dimension or tolerance
              // assembled, that box is the one thing open and the row stands
              // down.
              <button
                key={k.id}
                data-test={['plane', 'cylinder', 'sphere', 'point'].includes(k.id) ? undefined : `fit-${k.id}`}
                className={draft?.kind === k.id && draft.editId === undefined ? 'on' : undefined}
                aria-pressed={draft?.kind === k.id && draft.editId === undefined}
                disabled={!fileName || busy || draft?.editId !== undefined || dimDraft !== null}
                onClick={() => begin(k.id)}
              >
                <Icon name={KIND_ICON[k.id]} />
                <span>{k.label}</span>
              </button>
            ))}
            <button
              data-test="fit-section"
              disabled={!fileName || busy || dimDraft !== null}
              title="Cut the scan with a plane, to measure the cut in the 2D Measure workspace"
              onClick={onStartSection}
            >
              <Icon name="section" />
              <span>Section</span>
            </button>
          </div>
        </div>
      )}


      </>}
      <div hidden={utilityPanel || (panel !== 'alignment' && alignDraft === null)}>
      <AlignmentSection
        dockActions={panel === 'alignment' || alignDraft !== null}
        onAutoAlign={onAutoAlign}
        onAlignSymmetry={onAlignSymmetry}
        onStartAlignment={onStartAlignment}
        onApplyAlignment={onApplyAlignment}
        onApplyManual={onApplyManual}
        onResetAlignment={onResetAlignment}
      />

      </div>
      {/* A draft discarded with a marked surface on it — a second Esc, a slip
          onto Cancel, another editor taking the panel — is not gone: the
          marking is minutes of work, so it waits here, where the draft was,
          until the next element is started. Out of the way while an
          alignment or a section has the panel; back when they close. */}
      {discarded?.selection && !draft && !alignDraft && !sectionDraft && (
        <div className="group" data-test="discarded-draft">
          <div className="g-label">
            <span>
              Discarded{' '}
              {discarded.editId !== undefined
                ? `edit of ${elements.find((e) => e.id === discarded.editId)?.name ?? 'element'}`
                : elementKindInfo(discarded.kind).noun}
            </span>
            <b>{discarded.selection.length.toLocaleString('en-US')} points</b>
          </div>
          <p className="hint">
            Its marked surface is kept until the next element is started — bring it back to carry
            on where you were, marking and all.
          </p>
          <div className="toolrow">
            <button data-test="restore-draft" onClick={onRestoreDraft}>
              Restore
            </button>
            <button data-test="forget-draft" onClick={forgetDiscarded}>
              Forget
            </button>
          </div>
        </div>
      )}

      <div hidden={utilityPanel}>
      <DraftEditor
        onSelectMode={onSelectMode}
        onDraftSigma={onDraftSigma}
        onDraftKnownDiameter={onDraftKnownDiameter}
        onClearPaint={onClearPaint}
        onUndoPick={onUndoPick}
        onCancelDraft={onCancelDraft}
        onConfirmDraft={onConfirmDraft}
        onFindSymmetry={onFindSymmetry}
      />

      <SectionEditor onCancel={onCancelSection} onConfirm={onConfirmSection} />


      {dimDraft !== null && dimensionTypeInfo(dimDraft.type).family === 'dimension' && <DimensionSection part="editor" editorOpen={editorOpen} onPickPoint={onPickPoint} />}
      {dimDraft !== null && dimensionTypeInfo(dimDraft.type).family === 'tolerance' && <ToleranceSection part="editor" editorOpen={editorOpen} />}
      </div>
      {panel === 'export' && <>
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
          <label className="field">
            <span>
              Point cloud as
              <InfoDot title="What the point cloud contains">
                <p>
                  Every vertex of the scan with its normal, where the part now stands — any
                  alignment or move you applied comes with it — for the reverse-engineering tools
                  that model over points rather than triangles. Millimetres, like everything here.
                </p>
                <p>
                  <b>PLY:</b> binary and compact, read by Geomagic, CloudCompare, MeshLab, ReCap and
                  most others. Points only, no faces — a reader that wants a cloud gets a cloud.
                </p>
                <p>
                  <b>XYZ text:</b> one point per line, x y z nx ny nz — the universal fallback, the
                  same file ASC readers take. Autodesk ReCap turns either into an RCP for AutoCAD
                  and Inventor.
                </p>
              </InfoDot>
            </span>
            <select
              data-test="cloud-format"
              value={cloudFormat}
              onChange={(e) => setCloudFormat(e.target.value as CloudFormat)}
            >
              <option value="ply">PLY (binary, with normals)</option>
              <option value="xyz">XYZ text (x y z nx ny nz)</option>
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
              disabled={elements.every((e) => !e.fit) && !anyMeasuredOnSections && !anyBlock}
              onClick={onExportStep}
              title="Export the created elements — and what was measured on the sections, and the extruded shadows — as analytic geometry in a STEP file"
            >
              Export STEP
            </button>
            <ExportMeshButton
              testId="export-mesh"
              disabled={busy}
              onExport={onExportMesh}
              title="Save the scan as an STL or a 3MF where it now stands — any alignment or move you applied comes with it"
            />
            <button
              data-test="export-cloud"
              disabled={busy}
              onClick={onExportCloud}
              title="Save the scan as a point cloud where it now stands — every vertex with its normal, any alignment or move you applied included"
            >
              Export cloud
            </button>
          </div>
        </>
      )}
      </>}
    </DockPanel>
    <div className="sr-only" aria-live="polite">{activeTool ? title : `${selection.length} elements selected`}{draft ? `. Preview ${draft.status}.` : ''}</div>
  </>

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
