// SPDX-License-Identifier: AGPL-3.0-only
// The Reverse engineer faceplate: the scan, the kernel's standing, the
// feature tools, the editors, the feature list and the body list — in the
// shape of the measure panel, so an operator at home in one is at home here.
// An extrude or a revolve is set up the way CAD does it: the profiles are
// clicked in the viewport, the body shows as a ghost with grips to drag,
// and the numbers in the box follow the grips as the grips follow them.

import { Fragment, useEffect, useRef, useState } from 'react'
import { bodyMaker, dependentsOf, type Feature, type PlaneRef, type SketchFeature } from '../core/features'
import { describePlaneRef } from '../core/resolve'
import { worldPlaneName, type WorldAxis } from '../../../src/core/section/frame'
import { AXIS_COLORS } from '../../../src/viewer/axisGizmo'
import { bodyColor, coordinatePlaneShown, describeSketch, editingFeatureId, openFeatureEditor, reEditorOpen, selectionItems, useReverse, type FeatureDraft } from '../state/reStore'
import type { FeatureResult } from '../core/build'
import { SuppressedRow, SuppressKey, useFeatureMenu } from './FeatureMenu'
import { SweepIcon } from './SweepFields'
import { useStore } from '../../../src/state/store'
import { useThickness } from '../../../src/state/thicknessStore'
import { useLength } from '../../../src/app/useUnits'
import type { SketchChains } from '../app/useReverseWorkspace'
import { ElementRow } from '../../../src/ui/ElementRow'
import { Icon } from '../../../src/ui/icons'
import { InfoDot } from '../../../src/ui/InfoDot'
import { ModelSlot } from '../../../src/ui/ModelSlot'
import { SketchEditor } from './SketchEditor'
import { ParameterList } from './ParameterList'
import { drivenBy, featureExpressionErrors } from '../core/parameters'
import { ContextChips, SKETCH_STARTED } from './ContextChips'
import { BodyList } from './BodyList'
import { bodiesOfPick } from '../core/bodyFolders'
import { ThreadIcon } from './ThreadIcon'
import { bodyFeatureReading, FEATURE_ICONS, keyParameter } from './featureReading'
import { PlaybackBar, PlaybackKey } from './Playback'
import { KeyIcon } from './reIcons'
import { StepFileKey } from './featureFields'
import { PlaneSelect } from './PlaneSelect'
import { ExtrudeEditor } from './ExtrudeEditor'
import { ExportMeshButton } from '../../../src/ui/ExportMeshButton'
import type { MeshFormat } from '../../../src/core/exportMesh'
import { MESH_RESOLUTIONS } from '../core/meshResolution'
import { useRePrefs } from '../state/rePrefs'
import { RevolveEditor } from './RevolveEditor'
import { FeatureEditor } from './FeatureEditor'
import { NoteList } from './NoteList'
import { fittedOf, useFitMarks } from '../app/reFitMarks'

/** The coordinate planes' rows in the body list, in CAD's order: XY, XZ, YZ. */
const PLANE_ROWS: readonly WorldAxis[] = ['z', 'y', 'x']
const axisColor = (axis: WorldAxis) => `#${AXIS_COLORS[axis].toString(16).padStart(6, '0')}`

/** The expressions behind a feature's numbers, for its row's tooltip:
 *  " · extent.to = height + 5", or nothing. */
function exprNote(f: Feature): string {
  const exprs = 'exprs' in f && f.exprs ? Object.entries(f.exprs) : []
  return exprs.length > 0 ? ` · ${exprs.map(([slot, e]) => `${slot} = ${e}`).join(', ')}` : ''
}

/** Export mesh, and how finely: the visible solid bodies as an STL or a
 *  3MF for a printer — which meshes a STEP to its own tolerance — at one of
 *  the named resolutions (core/meshResolution), the one chosen kept. */
function MeshExportRow({ disabled, onExport }: { disabled: boolean; onExport: (format: MeshFormat) => void }) {
  const chosen = useRePrefs((s) => s.meshResolution)
  const len = useLength()
  return (
    <div data-test="export-body-mesh-row">
      <ExportMeshButton testId="export-body-mesh" block disabled={disabled} title="Write the visible solid bodies as an STL or a 3MF, meshed as finely as the resolution below says — what a slicer prints as it is" onExport={onExport} />
      <div className="moderow" role="radiogroup" aria-label="Mesh resolution" data-test="export-mesh-resolution" title="How finely Export mesh meshes the bodies">
        {MESH_RESOLUTIONS.map((r) => (
          <button
            key={r.id}
            role="radio"
            aria-checked={chosen === r.id}
            className={chosen === r.id ? 'on' : undefined}
            data-test={`export-mesh-${r.id}`}
            title={`${r.label}: no triangle further than ${len.fmt(r.chord, 3)} off a curved face, none turning more than ${Math.round(r.angleDeg * 10) / 10}° round it — finer is larger`}
            onClick={() => useRePrefs.getState().setMeshResolution(r.id)}
          >
            {r.label}
          </button>
        ))}
      </div>
    </div>
  )
}

export function ReversePanel({ onOpenScan, onExportStep, onExportMesh, onCompare, chainsOf }: { onOpenScan: (file: File) => void; onExportStep: () => void; onExportMesh: (format: MeshFormat) => void; onCompare: () => void; chainsOf: () => SketchChains | null }) {
  const fileName = useStore((s) => s.fileName)
  const triangleCount = useStore((s) => s.triangleCount)
  const busy = useStore((s) => s.busy)
  const sections = useStore((s) => s.sections)
  const elements = useStore((s) => s.elements)
  const kernelStatus = useReverse((s) => s.kernelStatus)
  const kernelMessage = useReverse((s) => s.kernelMessage)
  const kernelVersion = useReverse((s) => s.kernelVersion)
  const features = useReverse((s) => s.features)
  const rolledBack = useReverse((s) => s.rolledBack)
  const playback = useReverse((s) => s.playback)
  const results = useReverse((s) => s.results)
  const bodies = useReverse((s) => s.bodies)
  const bodyStyles = useReverse((s) => s.bodyStyles)
  const planesShown = useReverse((s) => s.planesShown)
  const building = useReverse((s) => s.building)
  const buildError = useReverse((s) => s.buildError)
  const sketchDraft = useReverse((s) => s.sketchDraft)
  const extrudeDraft = useReverse((s) => s.extrudeDraft)
  const revolveDraft = useReverse((s) => s.revolveDraft)
  const featureDraft = useReverse((s) => s.featureDraft)
  const len = useLength()
  const re = useReverse
  // Draw the rows again when a number is marked fitted or forgotten.
  useFitMarks((s) => s.version)
  const editorOpen = reEditorOpen({ sketchDraft, extrudeDraft, revolveDraft, featureDraft })
  const scope = useReverse((s) => s.parameterTable.scope)
  /** The feature reopened for editing: the rows after it are drawn set
   *  aside, as the part is built without them while the box is open. */
  const editingId = editingFeatureId({ sketchDraft, extrudeDraft, revolveDraft, featureDraft })
  const editingAt = editingId === null ? -1 : features.findIndex((f) => f.id === editingId)
  // The box opens above the list, where a row edited from the bottom of a
  // long list cannot see it: the panel scrolls up to it.
  const editorRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (editorOpen) editorRef.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' })
  }, [editorOpen])
  const names = (id: number) => features.find((f) => f.id === id)?.name ?? `feature ${id}`
  /** A body by the id of the feature that made it — its name in the body
   *  list (Solid 1, Shell 2), or the feature's while it is not built. */
  const bodyNames = (id: number) => bodies.find((b) => b.id === id)?.name ?? names(id)
  /** What a solid feature did with its solid, as its row says it: the
   *  bodies it joined or cut, by name, as the last build found them — or
   *  that it is a body of its own. */
  const resultText = (f: { id: number; op: 'new' | 'join' | 'cut'; target?: number }, r: FeatureResult | undefined) => {
    if (f.op === 'new') return 'New body'
    if (f.target !== undefined) return `${f.op === 'join' ? 'Joins' : 'Cuts'} ${bodyNames(f.target)}`
    const met = [...new Set((r?.bodies ?? []).filter((id) => bodyMaker(id) !== f.id))]
    if (f.op === 'join') return met.length > 0 ? `Joins ${met.map(bodyNames).join(', ')}` : 'Join · touches no body, a body of its own'
    return met.length > 0 ? `Cuts ${met.map(bodyNames).join(', ')}` : 'Cut'
  }
  /** The shell's wall from the Thickness map's reading of the part, when
   *  one was measured: its mean, to the twentieth of a millimetre — or, in
   *  inches, to the round inch step beside it (0.005 in). */
  const startShell = (init?: Partial<FeatureDraft>) => {
    const t = useThickness.getState()
    const mean = t.status === 'ready' && t.stats && Number.isFinite(t.stats.mean) && t.stats.mean > 0 ? t.stats.mean : null
    const inchStep = len.step(0.05)
    const wall = mean === null ? null : len.units === 'mm' ? Math.round(mean * 20) / 20 : len.fromDisplay(Math.round(len.toDisplay(mean) / inchStep) * inchStep)
    re.getState().startFeature('shell', { ...(wall !== null ? { thickness: wall, thicknessFrom: 'map' as const } : {}), ...init })
  }
  const ready = kernelStatus === 'ready'
  const sketches = features.filter((f): f is SketchFeature => f.kind === 'sketch')
  const hasBody = bodies.length > 0 && ready
  /** The bodies a Move opens on: those of the rows picked in the body list
   *  and of what is selected on the part, or the one body there is. */
  const movingBodies = (): number[] => {
    const s = re.getState()
    const listed = bodiesOfPick(s.bodyFolders, s.listSelection)
    const picked = [...new Set([...bodies.filter((b) => listed.has(b.id)).map((b) => b.id), ...selectionItems(s.selection).map((i) => i.bodyId)])]
    return picked.length > 0 ? picked : bodies.length === 1 ? [bodies[0].id] : []
  }
  const hasSolidElement = elements.some((e) => e.fit && (e.fit.kind === 'plane' || e.fit.kind === 'cylinder' || e.fit.kind === 'cone' || e.fit.kind === 'sphere' || e.fit.kind === 'torus'))
  const hasShadow = sections.some((x) => x.kind === 'shadow')
  // A Patch network's sheet is a skin of the part: it goes into the file too.
  const canExport = bodies.some((b) => b.visible && (b.closed || (b.surface && features.some((f) => f.kind === 'network' && f.id === bodyMaker(b.id))))) && !building
  const canCompare = Boolean(fileName) && bodies.some((b) => b.visible && !b.surface) && !building && !busy

  // The rollback bar: dragged between the rows, it lands in the gap nearest
  // the cursor — counted in rows above it — and the list is rolled there as
  // it is let go. While dragged it is drawn where it would land.
  const featureListRef = useRef<HTMLDivElement | null>(null)
  const [rollDrag, setRollDrag] = useState<number | null>(null)
  // A playback moves the bar itself, and the rows stand down while it runs:
  // the row it has come to is lit and kept in sight.
  const barLocked = editorOpen || playback !== null
  const playedId = playback && playback.at > 0 ? (features[playback.at - 1]?.id ?? null) : null
  // The features the parameter pointed at drives, lit as its row is.
  const parameterLit = useReverse((s) => s.parameterLit)
  const parameterList = useReverse((s) => s.parameters)
  const litName = parameterList.find((p) => p.id === parameterLit)?.name
  const drivenLit = new Set(litName ? drivenBy(litName, parameterList, features) : [])
  useEffect(() => {
    if (playedId === null) return
    const rows = featureListRef.current?.querySelectorAll<HTMLElement>('[data-test="feature-row"]')
    rows?.[features.findIndex((f) => f.id === playedId)]?.scrollIntoView?.({ block: 'nearest' })
  }, [playedId, features])
  const gapAt = (clientY: number): number => {
    const rows = featureListRef.current?.querySelectorAll<HTMLElement>('[data-test="feature-row"], [data-test="feature-row-rolled"]') ?? []
    let above = 0
    for (const row of rows) {
      const r = row.getBoundingClientRect()
      if (clientY > r.top + r.height / 2) above++
    }
    return above
  }
  const bar = (
    <div
      className={'rollbar' + (rollDrag !== null ? ' dragging' : '') + (barLocked ? ' off' : '')}
      data-test="rollback-bar"
      data-at={features.length}
      title={playback ? 'The playback moves the rollback bar — stop it to move the bar by hand' : editorOpen ? 'Finish what is open first' : 'The rollback bar — drag it up to set the features below it aside and add one earlier in the history; drag it down, or press To end, to build them again'}
      onPointerDown={(e) => {
        if (barLocked || e.button !== 0) return
        e.currentTarget.setPointerCapture(e.pointerId)
        setRollDrag(features.length)
      }}
      onPointerMove={(e) => {
        if (rollDrag !== null) setRollDrag(gapAt(e.clientY))
      }}
      onPointerUp={(e) => {
        if (rollDrag === null) return
        const at = gapAt(e.clientY)
        setRollDrag(null)
        re.getState().rollTo(at)
      }}
      onPointerCancel={() => setRollDrag(null)}
    >
      <span className="grip" />
      {rolledBack.length > 0 && rollDrag === null && !playback && (
        <button data-test="rollback-end" disabled={editorOpen} title="Move the rollback bar to the end of the list: every feature is built again" onPointerDown={(e) => e.stopPropagation()} onClick={() => re.getState().rollTo(null)}>
          To end
        </button>
      )}
    </div>
  )
  /** What stands in the gap under `count` rows: the bar where the list is
   *  rolled to, and a mark where a drag would put it — the bar itself stays
   *  put while it is dragged, a moved element being one that has let go of
   *  the pointer. */
  const marks = (count: number) => (
    <>
      {count === features.length && bar}
      {rollDrag !== null && rollDrag !== features.length && count === rollDrag && <div className="rollmark" data-test="rollback-mark" />}
    </>
  )

  const startSketchOn = (ref: PlaneRef) => {
    const store = useStore.getState()
    if (!re.getState().startSketchOn(ref)) store.setError('That plane is not available any more.')
    else store.setStatus(SKETCH_STARTED)
  }

  // A right click on a feature's row: suppress it, or its kind.
  const featureMenu = useFeatureMenu(featureListRef, editorOpen)

  return (
    <aside className="panel">
      <div className="group">
        <div className="sec-head">
          Model
          <InfoDot title="Reverse engineering">
            <p>
              Turn the scan into a <b>solid body</b> CAD opens as one: sketch on a section, a fitted
              plane or a coordinate plane, extrude or revolve the sketch's regions, and export the
              bodies as STEP.
            </p>
            <p>
              The body is built in the frame the part stands in now — align the part onto its
              fitted planes first, in the 3D Measure workspace, so the model is square.
            </p>
            <p>
              Modelling runs on <b>Open CASCADE Technology</b> (LGPL-2.1 with the Open CASCADE
              exception), compiled to WebAssembly by occt-wasm and loaded as a separate file when
              this workspace is first opened. Everything stays in this browser.
            </p>
          </InfoDot>
        </div>
        <ModelSlot role="Scan" name={fileName} detail={`${triangleCount.toLocaleString('en-US')} triangles`} dotColor="#8b9099" busy={busy} onOpen={onOpenScan} />
        <p className="hint" data-test="kernel-status">
          {kernelStatus === 'idle' && 'CAD kernel: waiting.'}
          {kernelStatus === 'loading' && (
            <>
              <span className="spinner" /> Loading the CAD kernel (Open CASCADE, about 5 MB)…
            </>
          )}
          {kernelStatus === 'ready' && `CAD kernel ready — ${kernelVersion}.`}
          {kernelStatus === 'unavailable' && <>
            <span className="warn">⚠ {kernelMessage}</span>
            <button data-test="retry-kernel" onClick={() => useReverse.getState().setKernel('idle')}>Retry CAD kernel</button>
          </>}
        </p>
      </div>

      <ParameterList />

      {!editorOpen && (
        <div className="group">
          <div className="sec-head">
            Create feature
            <InfoDot title="Features">
              <p>
                <b>Sketch</b> on a plane: the slice the plane cuts through the scan is fitted with
                lines and arcs, corners are inferred and the profile closed. The sketch then shows
                on the part. <b>Extrude</b> picks the sketch's regions in the viewport and pulls
                them by a distance, to a plane, between two planes or symmetrically; <b>Revolve</b>{' '}
                turns them about a line, a cylinder's axis or a sketch line. Both show the body
                as a ghost with grips to drag while they are set up.
              </p>
              <p>
                Every extrude or revolve makes a <b>new body</b>, or <b>joins</b> or <b>cuts</b>{' '}
                one made before. Features rebuild in order whenever one changes; one whose plane or
                sketch has gone says so and the rest still build.
              </p>
            </InfoDot>
          </div>
          <label className="field">
            <span>Sketch on</span>
            <PlaneSelect value={null} testId="sketch-plane-select" placeholder="Choose a plane…" onChange={startSketchOn} />
          </label>
          <div className="kindrow featurekeys" data-test="feature-keys">
            <button data-test="feature-extrude" disabled={!ready || sketches.length === 0} title="Extrude a sketch's regions — pick them in the viewport" onClick={() => re.getState().startExtrude()}>
              <Icon name="extrude" />
              <span>Extrude</span>
            </button>
            <button data-test="feature-revolve" disabled={!ready || sketches.length === 0} title="Revolve a sketch's regions about an axis" onClick={() => re.getState().startRevolve()}>
              <Icon name="revolve" />
              <span>Revolve</span>
            </button>
            <button data-test="feature-extract" disabled={!fileName || !ready || (!hasSolidElement && !hasShadow)} title="A measured plane, cylinder, cone or sphere as a body at its extents, extended as in 3D Measure — a boss or a pin without a sketch — or a shadow section as its block, the outline through the part's thickness" onClick={() => re.getState().startFeature('extract')}>
              <Icon name="extract" />
              <span>Extract</span>
            </button>
            <StepFileKey testId="feature-import" disabled={!ready} title="Bring a STEP file in as bodies of its own — a bought-in part, a mating part, the CAD model to check the scan against. A body for every solid in the file, named as the file names its parts; Move body puts them where they belong" onFile={(file) => re.getState().startFeature('import', { file, name: file.name.replace(/\.(step|stp)$/i, '') })}>
              <KeyIcon name="importStep" />
              <span>Import STEP</span>
            </StepFileKey>
            <button data-test="feature-shell" disabled={!hasBody} title="Hollow the body to a wall — click the faces to open, or none for a closed hollow; the wall comes from the Thickness map when one was measured" onClick={() => startShell()}>
              <Icon name="shell" />
              <span>Shell</span>
            </button>
            <button data-test="feature-fillet" disabled={!hasBody} title="Round edges of the body — click them; the radius is read off the scan across the first" onClick={() => re.getState().startFeature('fillet')}>
              <Icon name="fillet" />
              <span>Fillet</span>
            </button>
            <button data-test="feature-chamfer" disabled={!hasBody} title="Chamfer edges of the body — click them" onClick={() => re.getState().startFeature('chamfer')}>
              <Icon name="chamfer" />
              <span>Chamfer</span>
            </button>
            <button data-test="feature-draft" disabled={!hasBody} title="Lean faces of the body about a neutral plane — a moulding's draft, put on after the fact: click the flat face that stays, then the faces to lean" onClick={() => re.getState().startFeature('draft')}>
              <Icon name="draft" />
              <span>Draft</span>
            </button>
            <button data-test="feature-move-face" disabled={!hasBody} title="Offset faces of the body by a distance — a flat face along its normal, a round face in radius; several picked together grow or shrink as a whole, a cylinder's wall and its ends. One face can be snapped onto the scan instead: pick it, take Snap to scan, and click the scan where it should lie" onClick={() => re.getState().startFeature('moveFace')}>
              <Icon name="moveFace" />
              <span>Move face</span>
            </button>
            <button data-test="feature-delete-face" disabled={!hasBody} title="Delete faces of the body and heal the gap — a fillet, a chamfer, a hole or a boss taken out, the faces round it run on to close over where it was: click a face of it, and the rest of the round or hole comes with it" onClick={() => re.getState().startFeature('deleteFace')}>
              <KeyIcon name="deleteFace" />
              <span>Delete face</span>
            </button>
            <button data-test="feature-hole" disabled={!hasBody} title="A hole through the body along a cylinder or circle element, or a round face of the body" onClick={() => re.getState().startFeature('hole')}>
              <Icon name="hole" />
              <span>Hole</span>
            </button>
            <button data-test="feature-thread" disabled={!hasBody} title="A modeled screw thread on a round face of the body — a bolt's on a boss, a nut's in a bore: ISO metric, UNC or UNF, a 45° form that prints without supports, or a diameter and pitch of your own, with an offset for clearance when printing" onClick={() => re.getState().startFeature('thread')}>
              <ThreadIcon />
              <span>Thread</span>
            </button>
            <button data-test="feature-cut-plane" disabled={!hasBody} title="Cut the body at a plane and keep one side" onClick={() => re.getState().startFeature('cutPlane')}>
              <Icon name="cutPlane" />
              <span>Cut by plane</span>
            </button>
            <button data-test="feature-mirror" disabled={!hasBody} title="Mirror the body about a plane, joined with the source" onClick={() => re.getState().startFeature('mirror')}>
              <Icon name="mirror" />
              <span>Mirror</span>
            </button>
            <button data-test="feature-boolean" disabled={!hasBody || bodies.length < 2} title="Join, cut or intersect two bodies made separately — or trim a sheet by a solid, or sew two sheets into one, before Thicken" onClick={() => re.getState().startFeature('boolean')}>
              <Icon name="combine" />
              <span>Combine</span>
            </button>
            <button data-test="feature-sheet" disabled={!ready || sketches.length === 0} title="A sketch's pieces — an open chain will do — extruded as a surface: a cutter to split a body with" onClick={() => re.getState().startFeature('sheet')}>
              <Icon name="sheet" />
              <span>Sheet</span>
            </button>
            <button data-test="feature-split" disabled={!hasBody || bodies.length < 2} title="Split a body by a sheet and keep the fragments that lie on the scan — or trim a sheet by sheets or solids, keeping its pieces on the scan" onClick={() => re.getState().startFeature('split')}>
              <Icon name="split" />
              <span>Split</span>
            </button>
            <button data-test="feature-loft" disabled={!ready || sketches.length < 2} title="A solid through the profiles of two or more sketches on their own planes" onClick={() => re.getState().startFeature('loft')}>
              <Icon name="loft" />
              <span>Loft</span>
            </button>
            <button data-test="feature-sweep" disabled={!ready || sketches.length < 2} title="A sketch's region swept along a chain of lines and arcs in another sketch — a bent bar, a handle, a rim that follows a curve" onClick={() => re.getState().startFeature('sweep')}>
              <SweepIcon />
              <span>Sweep</span>
            </button>
            <button data-test="feature-pattern" disabled={!hasBody} title="Copies of the body about an axis, along a direction, or in a grid" onClick={() => re.getState().startFeature('pattern')}>
              <Icon name="pattern" />
              <span>Pattern</span>
            </button>
            <button data-test="feature-move-body" disabled={!hasBody} title="Move and turn bodies — the ones selected on the part or picked in the body list (Ctrl+click or Shift+click rows for several), or click them on the part: drag the gizmo's arrows and rings, or type the distances and angles. Tick Copy to move a copy and leave the body where it is" onClick={() => re.getState().startFeature('moveBody', { bodies: movingBodies() })}>
              <KeyIcon name="moveBody" />
              <span>Move body</span>
            </button>
            <button data-test="feature-offset-body" disabled={!hasBody} title="Grow a body all round by a distance, or shrink it — kept beside it as a body of its own, a keep-out round a part or the pocket that holds it with clearance" onClick={() => re.getState().startFeature('offsetBody')}>
              <KeyIcon name="offsetBody" />
              <span>Offset body</span>
            </button>
            <button data-test="feature-surface" disabled={!fileName || !ready} title="A smooth freeform surface fitted through a region of the scan — click faces or mark them — for the trim to close into a solid with the others" onClick={() => re.getState().startFeature('surface')}>
              <Icon name="surface" />
              <span>Fit surface</span>
            </button>
            <button data-test="feature-network" disabled={!fileName || !ready} title="Curves drawn on the scan, and the regions they close filled with patches fitted to the scan together — tangent across every curve not marked a crease, sharing their edges: a sheet, or a solid where the network closes. For a freeform skin that folds back or wants more than one patch" onClick={() => re.getState().startFeature('network')}>
              <Icon name="surface" />
              <span>Patch network</span>
            </button>
            <button data-test="feature-trim" disabled={!fileName || !ready || (!bodies.some((b) => b.surface) && !hasSolidElement)} title="Close a set of fitted surfaces, sheets and measured planes, cylinders, cones and spheres into a solid: the faces they cut space into are kept where they lie on the scan and sewn" onClick={() => re.getState().startFeature('trim')}>
              <Icon name="trim" />
              <span>Trim</span>
            </button>
            <button data-test="feature-thicken" disabled={!ready || !bodies.some((b) => b.surface)} title="Make a sheet or a fitted surface a solid of a thickness — a freeform thin shell's wall from its one skin, where a shell or an offset of a lofted body will not go" onClick={() => re.getState().startFeature('thicken')}>
              <KeyIcon name="shell" />
              <span>Thicken</span>
            </button>
          </div>
          {sketches.length === 0 && fileName && <p className="hint">Start with a sketch: choose a plane above, or cut a section in the 3D Measure workspace.</p>}
          {sketches.length === 0 && !fileName && <p className="hint">Start with a sketch: choose a coordinate plane above. No scan is needed to model.</p>}
        </div>
      )}

      <ContextChips />
      <div ref={editorRef} data-test="re-editor">
        <SketchEditor chainsOf={chainsOf} />
        <ExtrudeEditor />
        <RevolveEditor />
        <FeatureEditor />
      </div>

      {features.length + rolledBack.length > 0 && (
        <div className="group" ref={featureListRef}>
          <div className="g-label">
            <span>
              Features
              <InfoDot title="The feature list">
                <p>
                  The part is built from the top down. The <b>rollback bar</b> under the list is dragged up to go back in its history: the features below it are set aside, the part stands as it stood there, and whatever is made next goes in at the bar — a fillet before the shell, a cut before the pattern. Drag it back down, or press <b>To end</b>, and the rest is built again on top of what was added.
                </p>
                <p>A feature below the bar that loses what it stood on is marked in its row, as any feature that fails or builds with a warning is: the name red or amber, a ⚠. Open it to read what went wrong.</p>
                <p>
                  <b>Play</b> builds the part up again step by step for the camera: the bar goes to the top and moves down one feature at a time, each held a moment once it is built, and returns where it was at the end. <b>Space</b> holds it or carries it on, the <b>arrow keys</b> step it, <b>Escape</b> ends it. The caption in the viewport names each step.
                </p>
              </InfoDot>
            </span>
            {building && (
              <span className="working">
                <span className="spinner" /> building
              </span>
            )}
            {!playback && <PlaybackKey />}
            <b>{rolledBack.length > 0 ? `${features.length} of ${features.length + rolledBack.length}` : features.length}</b>
          </div>
          <PlaybackBar />
          {marks(0)}
          {features.map((f) => {
            // Suppressed: left out of the build — a row of its own, greyed,
            // its suppress key struck through.
            if (f.suppressed)
              return (
                <Fragment key={f.id}>
                  <SuppressedRow feature={f} icon={FEATURE_ICONS[f.kind]} locked={editorOpen} />
                  {marks(features.indexOf(f) + 1)}
                </Fragment>
              )
            const r = results[f.id]
            // The row is an icon and a name, as a CAD tree's rows are; what
            // the feature stands on and reads — the plane, the body
            // operation, the distance, the counts — is the tooltip's, and
            // a failure or a warning shows as a mark, its words in the box.
            const about =
              f.kind === 'sketch'
                ? `${describeSketch(f.sketch)} on ${describePlaneRef(f.plane, { sections, elements }, len.units)}`
                : f.kind === 'extrude' || f.kind === 'revolve'
                  ? `${resultText(f, r)} · ${keyParameter(f, len.units)}${exprNote(f)} · ${f.kind === 'extrude' && f.face ? `pulls a face of ${bodyNames(f.face.body)}` : `${f.regions.length} profile${f.regions.length === 1 ? '' : 's'} of ${features.find((g) => g.id === f.sketchId)?.name ?? 'a sketch'}`}`
                  : (() => {
                      const b = bodyFeatureReading(f, bodyNames, { sections, elements }, len.units)
                      const extra = r?.surface ? ` · σ ${len.fmt(r.surface.rms, 3)}` : r?.trim ? (r.trim.closed ? ` · solid, ${r.trim.kept} of ${r.trim.faces} faces` : ` · open, ${r.trim.openEdges.length} open edge${r.trim.openEdges.length === 1 ? '' : 's'}`) : ''
                      return `${b.text}${extra} — ${b.title}`
                    })()
            // A number an agent had fitted to the scan: said so, with how well.
            const fitted = fittedOf(f.id, f)
            // What went wrong is only marked here — the row tinted, a ⚠ —
            // and said in full in the feature's box (BuildSays).
            const warned = r?.status === 'ok' && Boolean(r.warning)
            const reading =
              r?.status === 'failed' ? (
                <b className="error" data-test="feature-failed" title="Failed to build — open it (✎) to see why">
                  ⚠
                </b>
              ) : r?.trim && !r.trim.closed ? (
                <b className="warn" title={about}>
                  ⚠ open
                </b>
              ) : warned ? (
                <b className="warn" data-test="feature-warned" title={`Built, with ${r.stepsBetween?.length ? `${r.stepsBetween.length} step${r.stepsBetween.length === 1 ? '' : 's'} between features` : 'a warning'} — open it (✎) to see ${r.stepsBetween?.length === 1 || !r.stepsBetween?.length ? 'it' : 'them'}`}>
                  ⚠
                </b>
              ) : fitted ? (
                <b
                  className="fitted"
                  data-test="feature-fitted"
                  title={Object.entries(fitted)
                    .map(([k, v]) => `${k} fitted to the scan: ${v.value}${v.sigma !== null ? ` ± ${v.sigma}` : ''} (nominal ${v.nominal}${v.sigmas !== null ? `, ${v.sigmas} σ off` : ''}, ${v.points} points)`)
                    .join('\n')}
                >
                  fit
                </b>
              ) : null
            const blocked = dependentsOf(f.id, [...features, ...rolledBack]).length > 0
            const bodyOf =
              f.kind === 'sketch'
                ? null
                : f.kind === 'extrude' || f.kind === 'revolve' || f.kind === 'extract' || f.kind === 'loft' || f.kind === 'sweep' || f.kind === 'thicken'
                  ? (r?.bodies?.[0] ?? f.target ?? f.id)
                  : f.kind === 'sheet' || f.kind === 'surface' || f.kind === 'network' || f.kind === 'trim'
                    ? f.id
                    : f.kind === 'import' || f.kind === 'moveBody'
                      ? (r?.bodies?.[0] ?? (f.kind === 'moveBody' ? (f.bodies[0] ?? f.id) : f.id))
                      : f.body
            return (
              <Fragment key={f.id}>
              <ElementRow
                testId="feature-row"
                name={f.name}
                picture={<KeyIcon name={FEATURE_ICONS[f.kind]} size={15} />}
                title={about}
                color={bodyOf === null ? '#3d8fd6' : (bodyStyles[bodyOf]?.color ?? bodies.find((b) => b.id === bodyOf)?.color ?? bodyColor(bodyOf))}
                // A sketch's eye shows it on the part or hides it; any other
                // feature's row has the suppress key there — hiding its tool
                // hid nothing, the body it made being the body list's.
                visible={f.kind !== 'sketch' || f.visible}
                eyeKey={f.kind === 'sketch' ? undefined : <SuppressKey feature={f} locked={editorOpen || playback !== null} />}
                reading={reading}
                tone={r?.status === 'failed' ? 'error' : warned ? 'warn' : undefined}
                selected={editingId === f.id || playedId === f.id || drivenLit.has(f.id)}
                muted={editingAt >= 0 && features.indexOf(f) > editingAt}
                editorOpen={editorOpen || playback !== null}
                onEdit={() => openFeatureEditor(f.id)}
                onToggleVisible={() => re.getState().toggleFeatureVisible(f.id)}
                onDelete={() => {
                  if (blocked) useStore.getState().setError(`${f.name} is built on by a later feature — delete that first.`)
                  else re.getState().removeFeature(f.id)
                }}
              />
              {r?.status === 'ok' && r.note && (
                <p className="hint rowerror" data-test="feature-note">
                  {r.note}
                </p>
              )}
              {(() => {
                // An expression of the feature's that cannot be read now — a
                // parameter gone from under it: the number it last came to
                // stands, and the row says so.
                const errs = Object.values(featureExpressionErrors(f, scope))
                return errs.length > 0 ? (
                  <p className="hint warn rowerror" data-test="feature-expr-error">
                    {errs.join(' · ')}
                  </p>
                ) : null
              })()}
              {marks(features.indexOf(f) + 1)}
              </Fragment>
            )
          })}
          {/* Below the bar: set aside, not built, there to come back. */}
          {rolledBack.map((f, i) => (
            <Fragment key={f.id}>
              <div className="kv ghost rolled" data-test="feature-row-rolled" title={playback ? `${f.name} is still to come in the playback` : `${f.name} is below the rollback bar — not built until the bar is moved below it`}>
                <span className="dot" />
                <span className="name">{f.name}</span>
                <b>{playback ? 'to come' : 'rolled back'}</b>
              </div>
              {marks(features.length + i + 1)}
            </Fragment>
          ))}
          {buildError && <p className="hint warn" data-test="build-error">⚠ {buildError}</p>}
        </div>
      )}

      {featureMenu}

      {/* The coordinate planes head the list the bodies land in, as CAD's
          browser has its origin planes over its bodies. */}
      <BodyList bodies={bodies}>
        {PLANE_ROWS.map((axis) => {
          const shown = coordinatePlaneShown(planesShown, axis, fileName !== null)
          const name = worldPlaneName(axis)
          return (
            <div key={axis} className={'kv planerow' + (shown ? '' : ' ghost')} data-test="plane-row" title={`The ${name} through the origin — click it in the viewport to sketch on it`}>
              <span className="dot plane" style={{ background: axisColor(axis) }} />
              <span className="name">{name}</span>
              <b>{axis} = 0</b>
              <button className={'x eye' + (shown ? '' : ' off')} data-test="plane-visible" title={shown ? `Hide the ${name}` : `Show the ${name} at the origin`} onClick={() => re.getState().setPlaneShown(axis, !shown)}>
                <Icon name={shown ? 'eye' : 'eyeOff'} size={14} />
              </button>
            </div>
          )
        })}
      </BodyList>

      {/* What the person wants of the part, pinned on it for the agent — while
          the agent connection is on. */}
      <NoteList />

      {/* A body leaves the tool whether or not a scan stood behind it; only the
          comparison needs one. */}
      {(fileName || bodies.length > 0) && (
        <>
          <div className="divider" />
          <div className="toolrow">
            <button className="withicon" data-test="export-body-step" disabled={!canExport} onClick={onExportStep} title="Write every visible body into one STEP file as solids — what FreeCAD and Fusion open as a body">
              <Icon name="exportStep" size={18} />
              Export body STEP
            </button>
            <button className="withicon" data-test="compare-in-deviation" disabled={!canCompare} onClick={onCompare} title="Measure the scan against the visible bodies in the Deviation workspace — its scale, histogram, pins and report. The bodies go in as the reference part; no best fit is run, they stand in the scan's frame already">
              <Icon name="compare" size={18} />
              Compare in Deviation
            </button>
          </div>
          <MeshExportRow disabled={!canExport} onExport={onExportMesh} />
        </>
      )}
    </aside>
  )
}

