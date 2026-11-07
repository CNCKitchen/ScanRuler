// SPDX-License-Identifier: AGPL-3.0-only
// The Mesh Tools workspace's part in the app, for one render: the
// workspace's verbs (useMeshWorkspace), the two maps it shows — how far the
// reduced mesh strays from the scan, and how far the edited copy is from the
// scan in use — the marking it asks for, the reduced mesh standing in for
// the scan, Trim to scan's piece and break, and what it puts on the stage and
// in the view bar — see src/plugins/api.ts.

import { meshSceneOf } from '../viewer/meshScene'
import { useEffect, useRef, useState } from 'react'
import type { PluginHost, PluginRuntime } from '../../../src/plugins/api'
import { useStore } from '../../../src/state/store'
import { useShell } from '../../../src/state/shellStore'
import { useMark } from '../../../src/state/markStore'
import { MapLegend } from '../../../src/ui/MapLegend'
import { formatSigned } from '../../../src/ui/format'
import { useLength } from '../../../src/app/useUnits'
import { lengthInputText } from '../../../src/core/units'
import { Icon, type IconName } from '../../../src/ui/icons'
import type { PickHit } from '../../../src/viewer/SceneManager'
import { DELETE_MARK_COLOR, FLIP_MARK_COLOR, OFFSET_MARK_COLOR, reductionApplied, SMOOTH_MARK_COLOR, TRIM_MARK_COLOR, useMeshTools, type MeshView, type TrimView, type WrapView } from '../state/meshStore'
import { reductionScale } from '../core/reduce'
import { MeshPanel } from '../ui/MeshPanel'
import { exportReducedMesh } from './exportReduced'
import { exportTrimmedMesh } from './exportTrimmed'
import { exportEditedMesh } from './exportEdited'
import { useMeshWorkspace } from './useMeshWorkspace'
import { createMeshToolsSession, installMeshToolsSession } from './meshToolsSession'

const MESH_VIEWS: { id: MeshView; icon: IconName; label: string; title: string }[] = [
  {
    id: 'reduced',
    icon: 'wsMesh',
    label: 'Reduced',
    title: 'The reduced mesh with every triangle edge drawn — what goes to CAD',
  },
  {
    id: 'deviation',
    icon: 'compare',
    label: 'Accuracy',
    title: 'The scan coloured by how far the reduced mesh strays from it — green on it, a dark cap past the tolerance',
  },
  {
    id: 'scan',
    icon: 'scan',
    label: 'Scan',
    title: 'The scan as it is, at its full density',
  },
]

const TRIM_VIEWS: { id: TrimView; icon: IconName; label: string; title: string }[] = [
  {
    id: 'piece',
    icon: 'combine',
    label: 'Piece',
    title: 'The piece cut to fit the break, its mating face in teal, over the scan ghosted — what goes to print',
  },
  {
    id: 'gap',
    icon: 'compare',
    label: 'Gap',
    title: 'The piece’s mating face coloured by how far it is from the part, against the offset — read where it lies over the break, grey past its rim',
  },
  {
    id: 'break',
    icon: 'scan',
    label: 'Break',
    title: 'The scan with the break marked on it, and the bodies on offer — to put the break right, or pick another body',
  },
]

const WRAP_VIEWS: { id: WrapView; icon: IconName; label: string; title: string }[] = [
  {
    id: 'wrap',
    icon: 'wsMesh',
    label: 'Wrap',
    title: 'The wrap, amber where it bridges an opening rather than lying on the part',
  },
  {
    id: 'inside',
    icon: 'compare',
    label: 'Inside',
    title: 'The wrap see-through over the part — what is inside it goes with it',
  },
  {
    id: 'scan',
    icon: 'scan',
    label: 'Scan',
    title: 'The part as it is',
  },
]

export function useMeshPlugin(host: PluginHost): PluginRuntime {
  const { sceneRef } = host
  // The workspace's verbs, which its commands run too — see
  // meshToolsSession. The maps it shows are the session's: how far the
  // reduced mesh strays from each scan vertex, and how far the edited copy
  // is from the scan in use at each of the copy's vertices.
  const [tools] = useState(() =>
    createMeshToolsSession({
      clientRef: host.clientRef,
      sceneRef,
      sources: host.sources,
      imports: host.imports,
      swapScan: host.swapScan,
      remapScan: host.remapScan,
      remeasureScan: host.remeasureScan,
    }),
  )
  useEffect(() => installMeshToolsSession(tools), [tools])
  useEffect(() => tools.watch(), [tools])
  const { reduceField, reduceRgb, copyField, copyRgb } = tools
  const {
    runReduce, applyReduction, discardReduction, removeIslands, deleteMarked, flipScan, cutScan, mirrorScan, fillScanHoles, smoothScan, offsetScan, shellScan, booleanScan, trimScan,
    wrap, cancelWrap, applyWrap, discardWrap, adoptEditedCopy, discardEditedCopy,
  } = useMeshWorkspace(tools)
  // The units on screen: the maps' figures and the status lines of the
  // panel's runs are in them. A command's run leaves them out, and is in mm.
  const len = useLength()
  const units = len.units
  const signed = (v: number) => formatSigned(v, units)

  const onMesh = useShell((s) => s.workspace === 'mesh')
  const fileName = useStore((s) => s.fileName)
  const report = useMeshTools((s) => s.report)
  const applied = useMeshTools(reductionApplied)
  const tool = useMeshTools((s) => s.tool)
  const meshView = useMeshTools((s) => s.view)
  const setMeshView = useMeshTools((s) => s.setView)
  const resultVersion = useMeshTools((s) => s.resultVersion)
  // The reduction's result three ways while Reduce mesh is in hand: the
  // reduced mesh as it will go to CAD, the scan painted with how far it
  // strays, or the scan alone; with any other tool, the scan as it is.
  const view: MeshView = tool === 'reduce' ? meshView : 'scan'
  const reductionShown = report !== null && view !== 'scan'
  const reduceMapShown = report !== null && view === 'deviation'
  // The edited copy against the scan in use — on offer whatever the tool,
  // and taking the stage from a view of the reduction when asked.
  const hasCopy = useMeshTools((s) => s.copyTriangles !== null)
  const copyDeviation = useMeshTools((s) => s.copyDeviation)
  const setCopyDeviation = useMeshTools((s) => s.setCopyDeviation)
  const copyStats = useMeshTools((s) => (s.copyDeviation ? s.copyDeviationStats : null))
  const copyMapVersion = useMeshTools((s) => s.copyDeviationVersion)
  const copyMapShown = copyStats !== null && !reductionShown
  const copyKeyOn = hasCopy && copyDeviation && !reductionShown

  // The reduced mesh stands in for the scan while it is what is being looked
  // at: the two lie on the same surface, and drawn together each would show
  // through the other in patches. A fresh result is a fresh mesh, which
  // arrives hidden. With no tool in hand the parts list says which of the
  // two is shown, or neither.
  const listing = onMesh && tool === null && fileName !== null
  const reducedListed = useMeshTools((s) => listing && s.report !== null && s.shownReduced)
  const scanListed = useMeshTools((s) => s.shownScan)
  const showReduced = (onMesh && report !== null && view === 'reduced') || reducedListed
  useEffect(() => {
    meshSceneOf(sceneRef.current)?.setReducedVisible(showReduced)
  }, [showReduced, resultVersion, sceneRef])

  // The wrap on hand, while Wrap is in hand: in the scan's place, or
  // see-through over it.
  const wrapMade = useMeshTools((s) => s.wrapMade !== null)
  const wrapView = useMeshTools((s) => s.wrapView)
  const setWrapView = useMeshTools((s) => s.setWrapView)
  const wrapVersion = useMeshTools((s) => s.wrapVersion)
  const wrapShown = onMesh && tool === 'wrap' && wrapMade && wrapView !== 'scan' ? wrapView : null
  useEffect(() => {
    meshSceneOf(sceneRef.current)?.setWrapView(wrapShown)
  }, [wrapShown, wrapVersion, sceneRef])

  // The surface Delete marked is to take, the region Flip normals is to turn
  // over, the one Smooth is to smooth alone, the one Shrink / expand is to
  // move, or the break Trim to scan is to cut with — a marking of one of
  // them, never carried from one to another: orange marked to go is not
  // amber marked to flip, blue marked to smooth, violet marked to move, nor
  // teal marked as the break.
  const markingFor = useMeshTools((s) =>
    s.tool === 'delete'
      ? 'delete'
      : s.tool === 'flip'
        ? 'flip'
        : s.tool === 'smooth' && s.smoothScope === 'marked'
        ? 'smooth'
        : s.tool === 'offset' && s.offsetScope === 'marked'
          ? 'offset'
          : s.tool === 'trim'
            ? 'trim'
            : null,
  )
  // Trim to scan's piece and how it is looked at: over it, the break stays
  // marked on the ghosted scan, the marking tools stood down.
  const made = useMeshTools((s) => s.trimMade)
  const trimMade = made !== null
  const trimView = useMeshTools((s) => s.trimView)
  const setTrimView = useMeshTools((s) => s.setTrimView)
  const onPiece = trimMade && trimView !== 'break'
  const gapLegend = onMesh && tool === 'trim' && made !== null && trimView === 'gap' && made.report.fit !== null ? made : null
  const session = onMesh ? markingFor : null
  const lastSession = useRef(session)
  useEffect(() => {
    if (lastSession.current === session) return
    const was = lastSession.current
    lastSession.current = session
    if (was !== null && session !== null) {
      sceneRef.current?.clearPaint()
      useMark.getState().setCount(0)
    }
  }, [session, sceneRef])

  // A click on a hole's ring fills that hole alone.
  useEffect(() => {
    const scene = sceneRef.current
    if (scene) meshSceneOf(scene).onHolePick = (index) => void fillScanHoles(index, { units })
  })

  /** The map on show at a point of the part: the reduction's while Reduce
   *  mesh shows it, else the edited copy's while that is asked for. */
  const readingAt = (hit: PickHit) => {
    const m = useMeshTools.getState()
    const shown = m.tool === 'reduce' && m.report !== null && m.view !== 'scan'
    const values = shown ? (m.view === 'deviation' ? reduceField.current : null) : m.copyDeviation && m.copyDeviationStats ? copyField.current : null
    if (!values) return null
    const [a, b, c] = hit.vertices
    const [wa, wb, wc] = hit.weights
    const value = values[a] * wa + values[b] * wb + values[c] * wc
    if (!Number.isFinite(value)) return null
    return { value, x: hit.clientX, y: hit.clientY, text: `${signed(value)} ${len.word()}`, muted: false }
  }

  return {
    readingAt,
    // The maps are read by hovering; they have no pins to set.
    pick: () => {},
    hoverReadout: reduceMapShown || copyMapShown,
    hideScan: showReduced || wrapShown === 'wrap' || (listing && !scanListed),
    // The view bar's Scan key: with no tool in hand, the same switch as the
    // scan's eye in the parts list; with one, what is on the stage is the
    // tool's to say.
    scanKey: {
      shown: {
        on: !showReduced && wrapShown !== 'wrap' && (!listing || scanListed),
        set: (on) => useMeshTools.getState().setPartShown('scan', on),
        disabled: !fileName
          ? 'Load a scan first'
          : listing
            ? undefined
            : tool === 'reduce'
              ? 'The view keys say what is shown of the reduction'
              : tool === 'wrap'
                ? 'The view keys say what is shown of the wrap'
                : 'The scan is what the tool works on — close the tool to put it away',
      },
    },
    marking: session
      ? {
          color:
            session === 'smooth'
              ? SMOOTH_MARK_COLOR
              : session === 'offset'
                ? OFFSET_MARK_COLOR
                : session === 'trim'
                  ? TRIM_MARK_COLOR
                  : session === 'flip'
                    ? FLIP_MARK_COLOR
                    : DELETE_MARK_COLOR,
          gestures: !(session === 'trim' && onPiece),
        }
      : null,
    // Read as the paint runs: the maps land in the refs before the store says
    // so.
    get field() {
      if (reduceMapShown && reduceField.current && report) {
        return { values: reduceField.current, rgb: reduceRgb, scale: reductionScale(report.settings.tolerance) }
      }
      // Grey where an edit made surface the scan never had.
      if (copyMapShown && copyStats && copyField.current) {
        return { values: copyField.current, rgb: copyRgb, scale: reductionScale(copyStats.range) }
      }
      return null
    },
    fieldVersion: `${view}:${resultVersion}:${copyMapShown}:${copyMapVersion}`,
    startPane: {
      title: 'Cleaning up and reducing a scan',
      blurb:
        'Load a scan and clean it up — clear the stray islands, delete what is not the part, turn it the right way out, cut off the base it stood on, mirror it, fill its holes, smooth out the scatter, expand or shrink it, hollow it, wrap it in one closed skin — and reduce it to a light mesh to model over in CAD, held within a tolerance you set, measured against the scan to prove it, and exported where you aligned it. STL, PLY, OBJ or 3MF, in millimetres — everything stays in this browser.',
    },
    panel: (
      <MeshPanel
        onOpenScan={(f) => void host.openScan(f)}
        onReduce={() => void runReduce(units)}
        onApplyReduction={() => void applyReduction({ units })}
        onDiscardReduction={discardReduction}
        onExport={(format) => exportReducedMesh(sceneRef, format, units)}
        onRemoveIslands={() => void removeIslands({ units })}
        onDeleteMarked={() => void deleteMarked(undefined, { units })}
        onFlip={(scope) => void flipScan(scope === 'marked' ? 'marked' : null, { units })}
        onClearMarking={() => {
          sceneRef.current?.clearPaint()
          useMark.getState().setCount(0)
          useMeshTools.getState().setConfirming(false)
        }}
        onCut={() => void cutScan({ units })}
        onMirror={() => void mirrorScan({ units })}
        onFillHoles={() => void fillScanHoles(undefined, { units })}
        onSmooth={() => void smoothScan(undefined, { units })}
        onOffset={() => void offsetScan(undefined, { units })}
        onShell={(mode) => void shellScan(mode, { units })}
        onWrap={() => void wrap(units)}
        onCancelWrap={cancelWrap}
        onApplyWrap={() => void applyWrap({ units })}
        onDiscardWrap={discardWrap}
        onBoolean={() => void booleanScan({ units })}
        onTrim={() => void trimScan(undefined, units)}
        onExportTrimmed={(format) => exportTrimmedMesh(sceneRef, format, units)}
        onExportEdited={exportEditedMesh}
        onUseEdited={() => void adoptEditedCopy()}
        onDiscardEdited={() => void discardEditedCopy()}
      />
    ),
    overlay: (
      <>
        {reduceMapShown && report && (
          <MapLegend
            id="reduce"
            unit={len.word()}
            // The ends of the ramp are the tolerance: past it is a dark cap.
            scale={reductionScale(report.settings.tolerance)}
            stats={[
              {
                label: `±${lengthInputText(report.settings.tolerance, units)}`,
                value: `${((report.within / report.measured) * 100).toFixed(2)} %`,
              },
              { label: '99.9 %', value: len.fmt(report.p999, 3, { bare: true }) },
              { label: 'max', value: len.fmt(report.max, 3, { bare: true }) },
              { label: 'RMS', value: len.fmt(report.rms, 3, { bare: true }) },
            ]}
            format={signed}
            histogram={null}
            showHistogram={false}
            zeroAt={0}
            // Signed from the reduced mesh's side: a scan point outside it is
            // the mesh cutting into the part there.
            ends={{ high: 'mesh inside the scan', low: 'mesh outside the scan' }}
          />
        )}
        {copyMapShown && copyStats && (
          <MapLegend
            id="copy"
            unit={len.word()}
            scale={reductionScale(copyStats.range)}
            stats={[
              { label: 'max', value: len.fmt(copyStats.maxAbs, 3, { bare: true }) },
              { label: 'RMS', value: len.fmt(copyStats.rms, 3, { bare: true }) },
              ...(copyStats.added > 0
                ? [{ label: 'added', value: `${((copyStats.added / (copyStats.added + copyStats.measured)) * 100).toFixed(1)} %` }]
                : []),
            ]}
            format={signed}
            histogram={null}
            showHistogram={false}
            zeroAt={0}
            // Signed from the scan's side: a point of the copy outside the
            // scan is surface an edit moved out.
            ends={{ high: 'copy outside the scan', low: 'copy inside the scan' }}
          />
        )}
        {gapLegend && gapLegend.report.fit && (
          <MapLegend
            id="trim-gap"
            unit={len.word()}
            scale={reductionScale(gapLegend.gapRange)}
            stats={[
              { label: 'median', value: signed(gapLegend.report.fit.median) },
              { label: '5 %', value: signed(gapLegend.report.fit.p05) },
              { label: '95 %', value: signed(gapLegend.report.fit.p95) },
              { label: 'least', value: signed(gapLegend.report.fit.min) },
            ]}
            format={signed}
            histogram={null}
            showHistogram={false}
            zeroAt={0}
            // Against the offset: a point further off the part than it is
            // reads high, one nearer reads low.
            ends={{ high: 'further off the part', low: 'nearer the part' }}
          />
        )}
        {tool === 'reduce' && !report && !applied && fileName && (
          <div className="hintchip" data-test="mesh-ready-chip">
            Part loaded — reduce the mesh in the panel
          </div>
        )}
      </>
    ),
    viewKeys: (
      <>
        {tool === 'reduce' && (
          <div className="keys" role="radiogroup" aria-label="What to show of the reduction">
            {MESH_VIEWS.map((v) => (
              <button
                key={v.id}
                role="radio"
                aria-checked={meshView === v.id}
                className={meshView === v.id ? 'on' : undefined}
                data-test={`mesh-view-${v.id}`}
                disabled={report === null}
                onClick={() => setMeshView(v.id)}
                title={report !== null ? v.title : 'Reduce the scan first — the view keys show the result'}
              >
                <Icon name={v.icon} size={16} />
                {v.label}
              </button>
            ))}
          </div>
        )}
        {tool === 'wrap' && (
          <div className="keys" role="radiogroup" aria-label="What to show of the wrap">
            {WRAP_VIEWS.map((v) => (
              <button
                key={v.id}
                role="radio"
                aria-checked={wrapMade && wrapView === v.id}
                className={wrapMade && wrapView === v.id ? 'on' : undefined}
                data-test={`wrap-view-${v.id}`}
                disabled={!wrapMade}
                onClick={() => setWrapView(v.id)}
                title={wrapMade ? v.title : 'Wrap the part first — the view keys show the wrap'}
              >
                <Icon name={v.icon} size={16} />
                {v.label}
              </button>
            ))}
          </div>
        )}
        {tool === 'trim' && (
          <div className="keys" role="radiogroup" aria-label="What to show of the trim">
            {TRIM_VIEWS.map((v) => (
              <button
                key={v.id}
                role="radio"
                aria-checked={trimMade && trimView === v.id}
                className={trimMade && trimView === v.id ? 'on' : undefined}
                data-test={`trim-view-${v.id}`}
                disabled={!trimMade}
                onClick={() => setTrimView(v.id)}
                title={trimMade ? v.title : 'Trim a body to the break first — the view keys show the piece'}
              >
                <Icon name={v.icon} size={16} />
                {v.label}
              </button>
            ))}
          </div>
        )}
        <div className="keys">
          <button
            className={copyKeyOn ? 'on' : undefined}
            data-test="toggle-copy-deviation"
            aria-pressed={copyKeyOn}
            disabled={!hasCopy}
            onClick={() => {
              if (copyKeyOn) {
                setCopyDeviation(false)
                return
              }
              if (reductionShown) setMeshView('scan')
              setCopyDeviation(true)
            }}
            title={
              hasCopy
                ? 'Colour the edited copy by how far it is from the scan in use — what smoothing moved, where a patch stands off the surface; surface an edit added is grey'
                : 'Edit the scan first — the deviation shows how far the edited copy is from the scan in use'
            }
          >
            <Icon name="compare" size={16} />
            Deviation
          </button>
        </div>
      </>
    ),
  }
}
