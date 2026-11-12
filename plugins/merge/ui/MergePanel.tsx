// SPDX-License-Identifier: AGPL-3.0-only
// The Merge faceplate: the scan and the layers opened beside it, how the
// layer in hand is laid on its target — moved, by picked pairs, by datums,
// then refined — and the merge itself. Laid out like Mesh Tools': what
// shapes the job, then what came of it.

import { useRef } from 'react'
import { useLength } from '../../../src/app/useUnits'
import { useStore } from '../../../src/state/store'
import { Icon } from '../../../src/ui/icons'
import { InfoDot } from '../../../src/ui/InfoDot'
import { HiddenFileInput, ModelSlot } from '../../../src/ui/ModelSlot'
import { NumberField } from '../../../src/ui/NumberField'
import { SCAN_ACCEPT } from '../../../src/core/formats'
import { BASE } from '../core/protocol'
import { autoDedupe, mergeDedupe, useMerge, type DatumKind, type LayerRow, type MergeTool } from '../state/mergeStore'
import { LayerList } from './LayerList'

import { count } from './mergeFormat'

const TOOLS: { id: MergeTool; label: string; title: string }[] = [
  { id: 'move', label: 'Move', title: 'Drag the layer near its place with the handle, or type where it goes — then Refine' },
  { id: 'pairs', label: 'Pairs', title: 'Click a point on the layer, then the same point on the target — three pairs or more, spread out' },
  { id: 'datums', label: 'Datums', title: 'Fit the same features on both — a face, a bore, a ball — two or more on each side' },
]

const DATUM_KINDS: { id: DatumKind; label: string }[] = [
  { id: 'plane', label: 'Plane' },
  { id: 'cylinder', label: 'Cylinder' },
  { id: 'sphere', label: 'Sphere' },
]

export function MergePanel({
  onOpenScan,
  onOpenLayer,
  onSetLayer,
  onRemoveLayer,
  onMove,
  onAlignPairs,
  onAlignDatums,
  onRefine,
  onAutoAlign,
  onStop,
  onMerge,
  onConfirm,
}: {
  onOpenScan: (file: File) => void
  onOpenLayer: (file: File) => void
  onSetLayer: (id: string, patch: Partial<Pick<LayerRow, 'color' | 'visible' | 'units' | 'locked'>>) => void
  onRemoveLayer: (id: string) => void
  /** Put the layer in hand at its pose moved by `t`, mm. */
  onMove: (t: [number, number, number]) => void
  onAlignPairs: () => void
  onAlignDatums: () => void
  onRefine: () => void
  /** Lay the layer in hand on its target from no start. */
  onAutoAlign: () => void
  onStop: () => void
  onMerge: () => void
  onConfirm: (yes: boolean) => void
}) {
  const scanName = useStore((s) => s.fileName)
  const scanPoints = useStore((s) => s.vertexCount)
  const scanIsCloud = useStore((s) => s.scanIsCloud)
  const scanBusy = useStore((s) => s.busy)
  const layers = useMerge((s) => s.layers)
  const selected = useMerge((s) => s.selected)
  const target = useMerge((s) => s.target)
  const tool = useMerge((s) => s.tool)
  const gizmoMode = useMerge((s) => s.gizmoMode)
  const pairs = useMerge((s) => s.pairs)
  const datums = useMerge((s) => s.datums)
  const datumKind = useMerge((s) => s.datumKind)
  const runningText = useMerge((s) => s.running)
  const confirming = useMerge((s) => s.confirming)
  const dedupe = useMerge(mergeDedupe)
  const { setTarget, setTool, setGizmoMode, setPairs, clearDatums, setDatumKind, setDedupe } = useMerge.getState()
  const len = useLength()
  const layerInput = useRef<HTMLInputElement>(null)
  const running = runningText !== null
  // The question a merge onto a mesh asks holds everything else until answered.
  const busy = scanBusy || running || confirming !== null
  const layer = layers.find((l) => l.id === selected) ?? null
  const targets = layers.filter((l) => l.id !== selected)
  const pairsDone = pairs.filter((p) => p.target !== null).length
  const layerDatums = layer ? (datums[layer.id] ?? []) : []
  const targetDatums = datums[target] ?? []
  const shown = layers.filter((l) => l.visible).length
  const auto = autoDedupe(layers)
  const targetName = target === BASE ? 'the scan' : (layers.find((l) => l.id === target)?.name ?? 'the scan')

  return (
    <aside className="panel merge-panel">
      <div className="group">
        <div className="sec-head">
          Model
          <InfoDot title="Merging scans">
            <p>
              The scan is the base: every layer is laid on it, and the merge writes the base and the
              layers shown as one point cloud in its place — where the scan stands, its alignment and
              everything measured on it kept. With no scan open, the first file becomes the scan.
            </p>
            <p>
              Each layer is another pass of the same part, in a frame of its own. Lay it near its
              place — by hand, by picked pairs or by datums — then <b>Refine</b> it onto its target; or
              let <b>Auto align</b> find its place from the shapes alone.
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
        <HiddenFileInput inputRef={layerInput} accept={SCAN_ACCEPT} onOpen={onOpenLayer} />
        <div className="toolrow">
          <button data-test="merge-open-layer" disabled={busy} onClick={() => layerInput.current?.click()} title="Open another pass of the part beside the scan — a point cloud or a mesh">
            <Icon name="load" size={16} />
            {scanName ? 'Open layer…' : 'Open scan…'}
          </button>
        </div>
      </div>

      <LayerList busy={busy} onSet={onSetLayer} onRemove={onRemoveLayer} />

      {layer && (
        <div className="group" data-test="merge-align">
          <div className="sec-head">
            Align {layer.name}
            <InfoDot title="Aligning a layer">
              <p>
                <b>Move</b> it near its place by hand, or lay it on by <b>Pairs</b> — the same point
                clicked on the layer and on the target, three or more — or by <b>Datums</b> — the same
                features fitted on both, two or more a side. Then <b>Refine</b> closes what is left.
              </p>
              <p>
                <b>Auto align</b> needs no start: it matches the shapes of the two, tries the poses
                that fit, and keeps the best. When another pose fits about as well — a part that
                repeats or is near symmetric — it says so: check the result.
              </p>
              <p>
                A refine from where the layer happened to open is no one's guess and is never called
                confident. A refine that drifts off its picks or datums, a low overlap, or an overlap
                that lets the layer slide is shown as a warning: check the result before merging.
              </p>
            </InfoDot>
          </div>
          <label className="field">
            <span>Onto</span>
            <select data-test="merge-target" value={target} disabled={busy} onChange={(e) => setTarget(e.target.value)}>
              <option value={BASE}>The scan</option>
              {targets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <div className="moderow merge-tools" role="radiogroup" aria-label="How to lay the layer">
            {TOOLS.map((t) => (
              <button
                key={t.id}
                role="radio"
                aria-checked={tool === t.id}
                className={tool === t.id ? 'on' : undefined}
                data-test={`merge-tool-${t.id}`}
                disabled={busy || layer.locked}
                title={layer.locked ? 'Unlock the layer to move it' : t.title}
                onClick={() => setTool(tool === t.id ? null : t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
          {layer.locked && <p className="hint">Locked — it stays where it is.</p>}

          {tool === 'move' && !layer.locked && (
            <>
              <div className="moderow" role="radiogroup" aria-label="Handle">
                {(['translate', 'rotate'] as const).map((mode) => (
                  <button key={mode} role="radio" aria-checked={gizmoMode === mode} className={gizmoMode === mode ? 'on' : undefined} data-test={`merge-gizmo-${mode}`} onClick={() => setGizmoMode(mode)}>
                    {mode === 'translate' ? 'Slide' : 'Turn'}
                  </button>
                ))}
              </div>
              {(['X', 'Y', 'Z'] as const).map((axis, i) => (
                <NumberField
                  key={axis}
                  label={axis}
                  testId={`merge-move-${axis.toLowerCase()}`}
                  // To the thousandth: a pose solved by a fit carries noise past it.
                  value={Math.round(layer.pose.t[i] * 1000) / 1000}
                  step={1}
                  min={-1e6}
                  kind="length"
                  disabled={busy}
                  onCommit={(v) => {
                    const t: [number, number, number] = [layer.pose.t[0], layer.pose.t[1], layer.pose.t[2]]
                    t[i] = v
                    onMove(t)
                  }}
                />
              ))}
              <p className="hint">Drag the handle in the viewport, or type where the layer's origin goes.</p>
            </>
          )}

          {tool === 'pairs' && (
            <>
              <div className="kv" data-test="merge-pairs">
                <span className="name">Pairs picked</span>
                <b>{count(pairsDone)}</b>
              </div>
              <p className="hint">
                {pairs.length > pairsDone
                  ? `Now the same point on ${targetName}.`
                  : `Click a point on ${layer.name}, then the same point on ${targetName}. Three or more, spread out.`}
              </p>
              <div className="toolrow">
                <button data-test="merge-pairs-clear" disabled={busy || pairs.length === 0} onClick={() => setPairs([])}>
                  Clear
                </button>
                <button className="primary" data-test="merge-pairs-align" disabled={busy || pairsDone < 3} onClick={onAlignPairs} title={pairsDone < 3 ? 'Pick three pairs first' : 'Lay the layer on by the pairs, then refine it'}>
                  Align by pairs
                </button>
              </div>
            </>
          )}

          {tool === 'datums' && (
            <>
              <div className="moderow merge-datum-kinds" role="radiogroup" aria-label="Datum kind">
                {DATUM_KINDS.map((k) => (
                  <button key={k.id} role="radio" aria-checked={datumKind === k.id} className={datumKind === k.id ? 'on' : undefined} data-test={`merge-datum-${k.id}`} onClick={() => setDatumKind(k.id)}>
                    {k.label}
                  </button>
                ))}
              </div>
              <div className="kv" data-test="merge-datums-layer">
                <span className="name">On {layer.name}</span>
                <b>{layerDatums.map((d) => d.kind).join(', ') || '—'}</b>
              </div>
              <div className="kv" data-test="merge-datums-target">
                <span className="name">On {targetName}</span>
                <b>{targetDatums.map((d) => d.kind).join(', ') || '—'}</b>
              </div>
              <p className="hint">Click a feature on each side to fit it, in the same order on both: the first sets the direction, the second the turn about it, a third the origin.</p>
              <div className="toolrow">
                <button
                  data-test="merge-datums-clear"
                  disabled={busy || (layerDatums.length === 0 && targetDatums.length === 0)}
                  onClick={() => {
                    clearDatums(layer.id)
                    clearDatums(target)
                  }}
                >
                  Clear
                </button>
                <button
                  className="primary"
                  data-test="merge-datums-align"
                  disabled={busy || layerDatums.length < 2 || targetDatums.length < 2}
                  onClick={onAlignDatums}
                  title={layerDatums.length < 2 || targetDatums.length < 2 ? 'Needs two datums on each side' : 'Lay the layer on by the datums, then refine it'}
                >
                  Align by datums
                </button>
              </div>
            </>
          )}

          <div className="toolrow merge-refine">
            {running ? (
              <button data-test="merge-stop" onClick={onStop} title="Stop the alignment — the layer stays where it was (Esc)">
                Stop
              </button>
            ) : (
              <>
                <button data-test="merge-auto-align" disabled={busy || layer.locked} onClick={onAutoAlign} title={`Find where ${layer.name} goes on ${targetName} from the shapes alone — no start needed`}>
                  Auto align
                </button>
                <button className="primary" data-test="merge-refine" disabled={busy || layer.locked} onClick={onRefine} title={`Refine ${layer.name} onto ${targetName} from where it stands`}>
                  Refine
                </button>
              </>
            )}
          </div>
          {runningText && <p className="hint" data-test="merge-running">{runningText}</p>}
        </div>
      )}

      {layers.length > 0 && (
        <div className="group" data-test="merge-merge">
          <div className="sec-head">
            Merge
            <InfoDot title="Merging">
              <p>
                The scan and the layers shown become one point cloud, put in place of the scan as one
                step of the undo history. A point of a layer within the distance below of one already
                kept is dropped as the same point; the scan's own points always stay.
              </p>
            </InfoDot>
          </div>
          <label className="checkrow">
            <input
              type="checkbox"
              data-test="merge-dedupe-on"
              checked={dedupe !== null}
              disabled={busy}
              onChange={(e) => setDedupe(e.target.checked ? (auto ?? 0.1) : null)}
            />
            <span>Drop doubled points</span>
          </label>
          {dedupe !== null && (
            <NumberField
              label="Within"
              testId="merge-dedupe"
              value={dedupe}
              step={0.01}
              min={0.0001}
              kind="length"
              disabled={busy}
              onCommit={(v) => setDedupe(v)}
              hint="Starts at the layers' point spacing."
            />
          )}
          {confirming ? (
            <div className="merge-confirm" data-test="merge-confirm" role="alertdialog" aria-label="Merge onto a mesh">
              <p>{confirming}</p>
              <div className="toolrow">
                <button data-test="merge-confirm-no" onClick={() => onConfirm(false)} title="Leave the scan as it is (Esc)">
                  Keep the mesh
                </button>
                <button className="primary" data-test="merge-confirm-yes" data-confirm={1} onClick={() => onConfirm(true)} title="Merge into a point cloud (Enter)">
                  Merge
                </button>
              </div>
            </div>
          ) : (
            <div className="toolrow">
              <button className="primary" data-test="merge-run" disabled={busy || shown === 0} onClick={onMerge} title={shown === 0 ? 'Show a layer to merge' : `The scan and ${shown} layer${shown === 1 ? '' : 's'} as one point cloud`}>
                Merge {shown} layer{shown === 1 ? '' : 's'}
              </button>
            </div>
          )}
          {dedupe !== null && <p className="hint">Doubles within {len.fmt(dedupe, 3)} go.</p>}
        </div>
      )}
    </aside>
  )
}
