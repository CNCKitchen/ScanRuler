// SPDX-License-Identifier: AGPL-3.0-only
// The Mesh Tools faceplate: the scan, the tools, the tool in hand — or with
// none, the parts in the viewport — and the edited copy. The tools are of the two kinds the workspace has — the edits,
// which change a copy of the scan until it is taken into use for every
// workspace (Remove islands, Delete marked, Flip normals, Cut, Mirror, Fill holes,
// Smooth, Shrink / expand, Boolean, Shell, and Wrap once applied), and those that leave the instrument as
// geometry for somebody else's: Reduce mesh, the scan reduced to a light mesh
// to model over in CAD, held within a tolerance and measured to prove it, and
// Trim to scan, a body cut to fit the scan's break, to print and glue in. Each tool is laid out like the
// thickness panel — what shapes the job, then what came of it — because each
// is the same kind of instrument: set it, run it, read it.

import { type ReactNode } from 'react'
import {
  scanEditFigure,
  scanEditText,
  useMeshTools,
  type MeshTool,
} from '../state/meshStore'
import { useStore } from '../../../src/state/store'
import { useUnits } from '../../../src/app/useUnits'
import { Icon } from '../../../src/ui/icons'
import { MeshIcon } from './meshIcons'
import { InfoDot } from '../../../src/ui/InfoDot'
import { ModelSlot } from '../../../src/ui/ModelSlot'
import { count } from './meshFormat'
import { PartsList } from './PartsList'
import { EditedCopy } from './EditedCopy'
import { ReduceTool } from './tools/ReduceTool'
import { IslandsTool } from './tools/IslandsTool'
import { DeleteTool } from './tools/DeleteTool'
import { FlipTool, type FlipScope } from './tools/FlipTool'
import { CutTool } from './tools/CutTool'
import { MirrorTool } from './tools/MirrorTool'
import { BooleanTool } from './tools/BooleanTool'
import { TrimTool } from './tools/TrimTool'
import { HolesTool } from './tools/HolesTool'
import { SmoothTool } from './tools/SmoothTool'
import { OffsetTool } from './tools/OffsetTool'
import { ShellTool } from './tools/ShellTool'
import { WrapTool } from './tools/WrapTool'
import type { MeshFormat } from '../../../src/core/exportMesh'

const TOOLS: { id: MeshTool; icon: ReactNode; label: string; title: string }[] = [
  {
    id: 'reduce',
    icon: <Icon name="reduceMesh" />,
    label: 'Reduce mesh',
    title: 'A light copy of the scan to model over in CAD, held within a tolerance you set — a preview, the scan staying as it is, until you apply it',
  },
  {
    id: 'islands',
    icon: <Icon name="islands" />,
    label: 'Remove islands',
    title: 'Find the specks floating off the scan — every piece joined to nothing else and smaller than a size you set — mark them on the part, and delete them once you say so',
  },
  {
    id: 'delete',
    icon: <Icon name="deleteSurface" />,
    label: 'Delete marked',
    title: 'Mark surface on the part by hand — a window, a brush or a lasso — and delete it from the scan: a fixture, a clamp, a patch of the table',
  },
  {
    id: 'flip',
    icon: <MeshIcon name="flipNormals" />,
    label: 'Flip normals',
    title: 'Turn the surface over so it faces the other way — the whole part, exported inside-out, or a patch you mark that faces in',
  },
  {
    id: 'cut',
    icon: <Icon name="cutPlane" />,
    label: 'Cut',
    title: 'Cut the scan with a plane and take one side off — the turntable it stood on, or half the part — closing it flat where the plane went through',
  },
  {
    id: 'mirror',
    icon: <Icon name="mirror" />,
    label: 'Mirror',
    title: 'Reflect the scan across a plane — the whole part, a left hand made of a right — or keep one side and mirror it onto the other to make the part symmetric',
  },
  {
    id: 'holes',
    icon: <Icon name="fillHoles" />,
    label: 'Fill holes',
    title: 'Close the holes a scanner left, every one smaller than a size you set, with patches that carry the surface across',
  },
  {
    id: 'smooth',
    icon: <Icon name="smoothMesh" />,
    label: 'Smooth',
    title: 'Take the scanner’s scatter out of the surface, never moving any point further than a limit you set, sharp edges held',
  },
  {
    id: 'offset',
    icon: <MeshIcon name="offsetSurface" />,
    label: 'Shrink/expand',
    title: 'Move the surface along its normal by a distance — out or in, the whole part or a marked region — not a scale: a bore gets narrower as the part grows',
  },
  {
    id: 'boolean',
    icon: <Icon name="combine" />,
    label: 'Boolean',
    title: 'Take a solid body out of the scan, add it, or keep what the two share — a bore the scanner could not see to the bottom of, cut out with a cylinder modelled in Reverse engineer',
  },
  {
    id: 'trim',
    icon: <MeshIcon name="trimToScan" />,
    label: 'Trim to scan',
    title: 'Cut a body modelled to mend a broken part to fit the scanned break — the missing piece, to print and glue in',
  },
  {
    id: 'shell',
    icon: <MeshIcon name="shellSolid" />,
    label: 'Shell/hollow',
    title: 'Hollow a closed part, leaving a wall of a thickness you set round a sealed cavity — or thicken an open surface into a solid',
  },
  {
    id: 'wrap',
    icon: <MeshIcon name="wrapSkin" />,
    label: 'Wrap',
    title: 'One closed skin round the part — everything inside dropped, every opening narrower than a gap you set bridged — for an assembly in one file, a part full of channels, a cracked scan',
  },
]

export function MeshPanel({
  onOpenScan,
  onReduce,
  onApplyReduction,
  onDiscardReduction,
  onExport,
  onRemoveIslands,
  onDeleteMarked,
  onFlip,
  onClearMarking,
  onCut,
  onMirror,
  onFillHoles,
  onSmooth,
  onOffset,
  onShell,
  onWrap,
  onCancelWrap,
  onApplyWrap,
  onDiscardWrap,
  onBoolean,
  onTrim,
  onExportTrimmed,
  onExportEdited,
  onUseEdited,
  onDiscardEdited,
}: {
  onOpenScan: (file: File) => void
  onReduce: () => void
  /** Make the reduced mesh the edited copy, or put it away. */
  onApplyReduction: () => void
  onDiscardReduction: () => void
  onExport: (format: MeshFormat) => void
  onRemoveIslands: () => void
  onDeleteMarked: () => void
  /** Turn the whole part over, or the surface marked on it. */
  onFlip: (scope: FlipScope) => void
  onClearMarking: () => void
  onCut: () => void
  onMirror: () => void
  onFillHoles: () => void
  onSmooth: () => void
  onOffset: () => void
  onShell: (mode: 'hollow' | 'thicken') => void
  /** Wrap the mesh, stop the wrap running, make it the edited copy, or put
   *  it away. */
  onWrap: () => void
  onCancelWrap: () => void
  onApplyWrap: () => void
  onDiscardWrap: () => void
  onBoolean: () => void
  /** Cut the body in hand to the break marked on the part, and save the
   *  piece as an STL. */
  onTrim: () => void
  onExportTrimmed: (format: MeshFormat) => void
  /** Save the edited copy as an STL. */
  onExportEdited: (format: MeshFormat) => void
  /** Take the edited copy into use for every workspace, or throw it away. */
  onUseEdited: () => void
  onDiscardEdited: () => void
}) {
  const scanName = useStore((s) => s.fileName)
  const scanTriangles = useStore((s) => s.triangleCount)
  const scanBusy = useStore((s) => s.busy)
  const tool = useMeshTools((s) => s.tool)
  const setTool = useMeshTools((s) => s.setTool)
  const running = useMeshTools((s) => s.status === 'running' || s.trimStatus === 'running' || s.wrapStatus === 'running' || s.editing)
  const edits = useMeshTools((s) => s.edits)
  const units = useUnits()

  const busy = scanBusy || running

  return (
    <aside className="panel">
      <div className="group">
        <div className="sec-head">
          Model
          <InfoDot title="The scan">
            <p>
              The part as scanned — an <b>STL</b>, <b>PLY</b> or <b>OBJ</b> in millimetres. Align it
              first in 3D Measure if it should land in CAD on its datums: a reduced mesh is made
              from the scan where it stands, and exported there.
            </p>
            <p>
              <b>Remove islands</b>, <b>Delete marked</b>, <b>Flip normals</b>, <b>Cut</b>, <b>Mirror</b>, <b>Fill holes</b>,{' '}
              <b>Smooth</b>, <b>Shrink/expand</b>, <b>Boolean</b> and <b>Shell/hollow</b> edit a copy of the scan, shown
              here in its place; every other workspace
              goes on measuring the scan as it was until <b>Use for analysis</b> takes the copy into
              use. <b>Reduce mesh</b> makes a light mesh beside it — of the copy, when there is one —
              which <b>Apply</b> makes the edited copy, <b>Wrap</b> a closed skin round it the same way,
              and <b>Trim to scan</b> a piece cut to fit its break.
            </p>
          </InfoDot>
        </div>
        <ModelSlot
          role="Scan"
          name={scanName}
          detail={`${count(scanTriangles)} triangles${edits.length > 0 ? ' · edited' : ''}`}
          dotColor="#8b9099"
          busy={busy}
          onOpen={onOpenScan}
        />
        {!scanName && <p className="hint">Drop it anywhere in the window.</p>}
      </div>

      <div className="group">
        <div className="sec-head">
          Tools
          <InfoDot title="Mesh tools">
            <p>
              Tools that work on the mesh itself rather than measure it. The edits are made on a copy
              of the scan — each one step of the undo history, kept in a saved project — and reach the
              other workspaces only when the copy is taken into use.
            </p>
          </InfoDot>
        </div>
        <div className="kindrow featurekeys three" role="radiogroup" aria-label="Mesh tool">
          {TOOLS.map((t) => (
            <button
              key={t.id}
              role="radio"
              aria-checked={tool === t.id}
              className={tool === t.id ? 'on' : undefined}
              data-test={`mesh-tool-${t.id}`}
              disabled={busy}
              title={t.title}
              onClick={() => setTool(tool === t.id ? null : t.id)}
            >
              {t.icon}
              <span>{t.label}</span>
            </button>
          ))}
        </div>
        {tool === null && (
          <p className="hint" data-test="mesh-no-tool">
            Pick a tool. <b>Escape</b>, or its key again, puts the one in hand away.
          </p>
        )}
      </div>

      {tool === null ? (
        <PartsList busy={busy} onExportReduced={onExport} onExportTrimmed={onExportTrimmed} />
      ) : tool === 'reduce' ? (
        <ReduceTool ready={Boolean(scanName)} busy={busy} onReduce={onReduce} onApply={onApplyReduction} onDiscard={onDiscardReduction} onExport={onExport} />
      ) : tool === 'islands' ? (
        <IslandsTool ready={Boolean(scanName)} busy={busy} onRemove={onRemoveIslands} />
      ) : tool === 'delete' ? (
        <DeleteTool ready={Boolean(scanName)} busy={busy} onDelete={onDeleteMarked} onClear={onClearMarking} />
      ) : tool === 'flip' ? (
        <FlipTool ready={Boolean(scanName)} busy={busy} onFlip={onFlip} onClear={onClearMarking} />
      ) : tool === 'cut' ? (
        <CutTool ready={Boolean(scanName)} busy={busy} onCut={onCut} />
      ) : tool === 'mirror' ? (
        <MirrorTool ready={Boolean(scanName)} busy={busy} onMirror={onMirror} />
      ) : tool === 'holes' ? (
        <HolesTool ready={Boolean(scanName)} busy={busy} onFill={onFillHoles} />
      ) : tool === 'boolean' ? (
        <BooleanTool ready={Boolean(scanName)} busy={busy} onBoolean={onBoolean} />
      ) : tool === 'trim' ? (
        <TrimTool ready={Boolean(scanName)} busy={busy} onTrim={onTrim} onExport={onExportTrimmed} onClear={onClearMarking} />
      ) : tool === 'offset' ? (
        <OffsetTool ready={Boolean(scanName)} busy={busy} onOffset={onOffset} onClear={onClearMarking} />
      ) : tool === 'shell' ? (
        <ShellTool ready={Boolean(scanName)} busy={busy} onShell={onShell} />
      ) : tool === 'wrap' ? (
        <WrapTool ready={Boolean(scanName)} busy={busy} onWrap={onWrap} onCancel={onCancelWrap} onApply={onApplyWrap} onDiscard={onDiscardWrap} />
      ) : (
        <SmoothTool ready={Boolean(scanName)} busy={busy} onSmooth={onSmooth} onClear={onClearMarking} />
      )}

      <EditedCopy busy={busy} onUse={onUseEdited} onDiscard={onDiscardEdited} onExport={onExportEdited} />

      {edits.length > 0 && (
        <div className="group" data-test="scan-edits">
          <div className="g-label">
            <span>In use for analysis</span>
            <span>{edits.length}</span>
          </div>
          {edits.map((e, i) => (
            <div key={i} className="kv" data-test="scan-edit">
              <span className="name">{scanEditText(e, units)}</span>
              <b>{scanEditFigure(e, units)}</b>
            </div>
          ))}
          <p className="hint">
            Edits taken into use: every workspace measures the scan as these left it. Ctrl+Z steps
            back through them; a saved project keeps the scan as it now is.
          </p>
        </div>
      )}
    </aside>
  )
}

