// SPDX-License-Identifier: AGPL-3.0-only
// The Cloud Tools faceplate: the cloud, how points are marked to go —
// floating pieces, past a plane, by hand — and the one Delete that takes
// what is marked. Laid out like Merge's: what shapes the job, then what
// came of it.

import { useLength } from '../../../src/app/useUnits'
import { workspaceUnavailable } from '../../../src/app/workspaceAvailability'
import { plugins } from '../../../src/plugins/registry'
import { useShell } from '../../../src/state/shellStore'
import { useMark } from '../../../src/state/markStore'
import { useStore } from '../../../src/state/store'
import { InfoDot } from '../../../src/ui/InfoDot'
import { MeshCloudOffer } from '../../../src/ui/MeshCloudOffer'
import { MarkTools } from '../../../src/ui/MarkTools'
import { ModelSlot } from '../../../src/ui/ModelSlot'
import { NumberField } from '../../../src/ui/NumberField'
import { useCloudTools, type CloudTool, type PlaneAxis } from '../state/cloudStore'

const TOOLS: { id: CloudTool; label: string; title: string }[] = [
  { id: 'floating', label: 'Floating', title: 'Mark the pieces floating off the main body — specks, scraps of the table, spray' },
  { id: 'plane', label: 'Plane', title: 'Mark everything past a plane — the base the part stood on, a clamp below it' },
  { id: 'hand', label: 'By hand', title: 'Mark points with a window, a brush or a lasso — or touch up what another tool marked' },
]

const AXES: { id: PlaneAxis; label: string }[] = [
  { id: 0, label: 'X' },
  { id: 1, label: 'Y' },
  { id: 2, label: 'Z' },
]

const count = (n: number) => n.toLocaleString('en-US')

/** Where a cleaned cloud goes next to become a parametric model: the
 *  workspace that builds one on the cloud, when this build has it. Named by
 *  its id, never imported — a build stands without it. */
const MODEL_WORKSPACE = 'reverse'

function NextSteps({ busy }: { busy: boolean }) {
  // Read as the scan changes: the workspace may say no to this scan.
  useStore((s) => s.scanIsCloud)
  const tab = plugins().find((p) => p.workspace?.id === MODEL_WORKSPACE)?.workspace
  const why = tab ? workspaceUnavailable(MODEL_WORKSPACE) : null
  return (
    <div className="group" data-test="cloud-next">
      <div className="sec-head">
        Next
        <InfoDot title="From a clean cloud to a model">
          <p>
            Once the cloud holds only the part, build the model over it: sketch on its sections,
            extrude and revolve, and export a solid STEP body
            {tab ? <> — in <b>{tab.label}</b>, which works on the cloud as it is</> : null}. The tools
            that need a surface ask for a mesh: <b>Mesh this cloud</b> makes one, trimmed to the points.
          </p>
        </InfoDot>
      </div>
      {tab && (
        <button
          className="block"
          data-test="cloud-next-model"
          disabled={busy || why !== null}
          title={why ?? `Open ${tab.label} on this cloud — sketch on its sections, extrude and revolve, export a solid STEP body`}
          onClick={() => useShell.getState().setWorkspace(MODEL_WORKSPACE)}
        >
          Build the model in {tab.label} →
        </button>
      )}
      <MeshCloudOffer busy={busy} />
    </div>
  )
}

export function CloudPanel({ onOpenScan, onDelete, onClear }: { onOpenScan: (file: File) => void; onDelete: () => void; onClear: () => void }) {
  const scanName = useStore((s) => s.fileName)
  const scanPoints = useStore((s) => s.vertexCount)
  const scanIsCloud = useStore((s) => s.scanIsCloud)
  const scanBusy = useStore((s) => s.busy)
  const center = useStore((s) => s.modelCenter)
  const tool = useCloudTools((s) => s.tool)
  const percent = useCloudTools((s) => s.percent)
  const axis = useCloudTools((s) => s.axis)
  const offset = useCloudTools((s) => s.offset)
  const side = useCloudTools((s) => s.side)
  const floating = useCloudTools((s) => s.floating)
  const runningText = useCloudTools((s) => s.running)
  const confirming = useCloudTools((s) => s.confirming)
  const { setTool, setPercent, setAxis, setOffset, setSide, setConfirming } = useCloudTools.getState()
  const marked = useMark((s) => s.count)
  const len = useLength()
  const running = runningText !== null
  const ready = scanName !== null && scanIsCloud && !scanBusy
  const busy = scanBusy || running
  const at = offset ?? center[axis]
  const f = floating && floating.percent === percent ? floating : null
  const axisName = AXES[axis].label

  return (
    <aside className="panel cloud-panel">
      <div className="group">
        <div className="sec-head">
          Point cloud
          <InfoDot title="Cleaning up a point cloud">
            <p>
              Each tool marks points in red: <b>Floating</b> the pieces off the main body, <b>Plane</b> the
              points past a plane, <b>By hand</b> what you mark with a window, a brush or a lasso — also
              to touch up what another tool marked. Nothing goes until you press <b>Delete</b>.
            </p>
            <p>
              A delete writes what is left as a new cloud in the scan's place, keeping its alignment and
              everything measured on it. <b>Ctrl+Z</b> puts the points back.
            </p>
          </InfoDot>
        </div>
        <ModelSlot
          role="Scan"
          name={scanName}
          detail={`${count(scanPoints)} ${scanIsCloud ? 'points' : 'vertices'}`}
          dotColor="#8b9099"
          busy={busy}
          onOpen={onOpenScan}
        />
        {scanName && !scanIsCloud && <p className="warnnote">⚠ This scan is a mesh — Mesh Tools cleans a mesh up.</p>}
      </div>

      <div className="group" data-test="cloud-tools">
        <div className="sec-head">Mark to delete</div>
        <div className="moderow cloud-three" role="radiogroup" aria-label="How to mark points">
          {TOOLS.map((t) => (
            <button
              key={t.id}
              role="radio"
              aria-checked={tool === t.id}
              className={tool === t.id ? 'on' : undefined}
              data-test={`cloud-tool-${t.id}`}
              disabled={!ready || busy}
              title={t.title}
              onClick={() => setTool(tool === t.id ? null : t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tool === 'floating' && (
          <>
            <label className="field" title="A piece of the cloud smaller than this share of the main body, by points, is marked">
              <span>Smaller than</span>
              <input
                className="slider"
                type="range"
                data-test="cloud-percent-slider"
                min={0}
                max={100}
                step={0.5}
                value={percent}
                disabled={busy}
                onChange={(e) => setPercent(Number(e.target.value))}
              />
            </label>
            <NumberField
              label="% of the main body"
              testId="cloud-percent"
              value={percent}
              step={0.5}
              min={0}
              unit="%"
              disabled={busy}
              onCommit={setPercent}
              hint="A piece joined to nothing else is floating when it has fewer points than this share of the main body — the largest piece. 0 % marks none, 100 % every piece but the main body."
            />
            {f && (
              <>
                <div className="kv" data-test="cloud-pieces">
                  <span className="name">Pieces in the cloud</span>
                  <b>{count(f.pieces)}</b>
                </div>
                <div className="kv" data-test="cloud-floating">
                  <span className="name">Floating, marked</span>
                  <b>
                    {count(f.floating)} · {count(f.points)} points
                  </b>
                </div>
                {f.largestKept > 0 && (
                  <p className="hint">
                    The largest other piece that stays has {count(f.largestKept)} points —{' '}
                    {((f.largestKept / f.mainPoints) * 100).toFixed(1)} % of the main body.
                  </p>
                )}
              </>
            )}
          </>
        )}

        {tool === 'plane' && (
          <>
            <div className="moderow cloud-three" role="radiogroup" aria-label="The plane's axis">
              {AXES.map((a) => (
                <button
                  key={a.id}
                  role="radio"
                  aria-checked={axis === a.id}
                  className={axis === a.id ? 'on' : undefined}
                  data-test={`cloud-axis-${a.label.toLowerCase()}`}
                  disabled={busy}
                  title={`A plane square to ${a.label}`}
                  onClick={() => setAxis(a.id)}
                >
                  {a.label}
                </button>
              ))}
            </div>
            <NumberField
              label={`At ${axisName}`}
              testId="cloud-plane-at"
              value={at}
              step={0.5}
              min={-Infinity}
              kind="length"
              disabled={busy}
              onCommit={setOffset}
              hint="Where the plane crosses its axis, as the part is shown. It starts through the middle of the part."
            />
            <div className="moderow" role="radiogroup" aria-label="Which side goes">
              {([-1, 1] as const).map((s) => (
                <button
                  key={s}
                  role="radio"
                  aria-checked={side === s}
                  className={side === s ? 'on' : undefined}
                  data-test={`cloud-side-${s > 0 ? 'plus' : 'minus'}`}
                  disabled={busy}
                  onClick={() => setSide(s)}
                >
                  {s > 0 ? `Above (+${axisName})` : `Below (−${axisName})`}
                </button>
              ))}
            </div>
            <p className="hint">The points {side > 0 ? 'above' : 'below'} {len.fmt(at, 2)} on {axisName} are marked.</p>
          </>
        )}

        {tool === 'hand' && <MarkTools escapeNote="The marking stays until it is deleted or cleared." onClear={onClear} />}
      </div>

      <div className="group">
        {confirming && marked > 0 ? (
          <div className="confirmbox" data-test="cloud-confirm" role="alertdialog" aria-label="Delete the marked points">
            <p>
              Delete the <b>{count(marked)} points</b> marked in red?
            </p>
            <p className="hint">Ctrl+Z puts them back.</p>
            <div className="toolrow">
              <button data-test="cloud-keep" onClick={() => setConfirming(false)} title="Leave the cloud as it is (Esc)">
                Keep them
              </button>
              <button className="primary" data-test="cloud-delete-confirm" data-confirm={1} disabled={busy} onClick={onDelete} title="Take the marked points out of the cloud (Enter)">
                Delete
              </button>
            </div>
          </div>
        ) : (
          <button className="primary block" data-test="cloud-delete" disabled={!ready || busy || marked === 0} onClick={() => setConfirming(true)}>
            {running ? (
              <>
                <span className="spinner" />
                Deleting…
              </>
            ) : marked > 0 ? (
              `Delete ${count(marked)} marked points…`
            ) : (
              'Delete marked points…'
            )}
          </button>
        )}
        {ready && marked === 0 && !running && <p className="hint">Pick a tool above to mark what is to go.</p>}
      </div>

      {ready && <NextSteps busy={busy} />}
    </aside>
  )
}
