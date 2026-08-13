import { useRef, useState } from 'react'
import { elementColor, useStore } from '../state/store'
import { pairDistances, SIGMA_LABELS, type DoneElement } from '../core/summary'
import type { SigmaPreset } from '../core/types'

const REPO_URL = 'https://github.com/cnckitchen/3DScanEvaluator'

export function Sidebar({
  onOpenFile,
  onStartDraft,
  onUndoPick,
  onCancelDraft,
  onConfirmDraft,
  onDelete,
  onClearAll,
  onCopy,
}: {
  onOpenFile: (file: File) => void
  onStartDraft: () => void
  onUndoPick: () => void
  onCancelDraft: () => void
  onConfirmDraft: () => void
  onDelete: (id: number) => void
  onClearAll: () => void
  onCopy: () => void
}) {
  const fileName = useStore((s) => s.fileName)
  const busy = useStore((s) => s.busy)
  const triangleCount = useStore((s) => s.triangleCount)
  const elements = useStore((s) => s.elements)
  const draft = useStore((s) => s.draft)
  const draftColor = elementColor(useStore((s) => s.nextNumber))
  const settings = useStore((s) => s.settings)
  const showOverlays = useStore((s) => s.showOverlays)
  const setSigma = useStore((s) => s.setSigma)
  const setShowOverlays = useStore((s) => s.setShowOverlays)

  const inputRef = useRef<HTMLInputElement>(null)
  const [copied, setCopied] = useState(false)

  const done = elements.filter((e) => e.status === 'done' && e.center) as (typeof elements[number] &
    DoneElement)[]
  const pairs = pairDistances(done)

  const draftHint =
    draft === null
      ? ''
      : draft.picks.length === 0
        ? 'Click a point on the sphere in the 3D view.'
        : 'Add more points if the sphere is split across unconnected patches, then create it.'

  return (
    <aside className="sidebar">
      <header>
        <h1>3D Scan Evaluator</h1>
        <p className="tagline">Ball-bar accuracy testing for 3D scans</p>
      </header>

      <button className="primary" onClick={() => inputRef.current?.click()}>
        Open model…
      </button>
      <input
        ref={inputRef}
        type="file"
        accept=".stl,.ply,.obj"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) onOpenFile(f)
          e.target.value = ''
        }}
      />
      <p className="hint">STL, PLY or OBJ — or drop a file anywhere. Units are assumed to be mm.</p>
      {fileName && (
        <div className="file-info">
          {fileName} · {triangleCount.toLocaleString('en-US')} triangles
        </div>
      )}

      {draft === null && (
        <section>
          <h2>Fitting</h2>
          <button
            className="primary block"
            data-test="fit-sphere"
            disabled={!fileName || busy}
            onClick={onStartDraft}
          >
            Create fitting sphere
          </button>
          {fileName && (
            <p className="hint">Pick points on a sphere, check the preview, then create it.</p>
          )}
        </section>
      )}

      {draft !== null && (
        <section className="draft" style={{ borderTopColor: draftColor }}>
          <h2 style={{ color: draftColor }}>
            <span className="dot" style={{ background: draftColor }} />
            New fitting sphere
          </h2>
          <p className="hint">{draftHint}</p>
          <div className="draft-fields">
            <label className="field">
              <span>Method</span>
              <select value={settings.method} disabled>
                <option value="gaussian">Gaussian best-fit</option>
              </select>
            </label>
            <label className="field">
              <span>Used points</span>
              <select
                value={settings.sigma}
                onChange={(e) => setSigma(Number(e.target.value) as SigmaPreset)}
              >
                {([3, 2, 1, 0] as SigmaPreset[]).map((k) => (
                  <option key={k} value={k}>
                    {SIGMA_LABELS[k]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div
            className={`draft-status ${draft.status}`}
            data-test="draft-status"
            style={draft.status === 'ready' ? { borderColor: draftColor, color: draftColor } : undefined}
          >
            {draft.status === 'empty' && 'No points picked yet'}
            {draft.status === 'fitting' && (
              <>
                <span className="spinner" />
                Fitting…
              </>
            )}
            {draft.status === 'failed' && (draft.message ?? 'Fit failed')}
            {draft.status === 'ready' && `Preview · Ø ${draft.diameter!.toFixed(3)} mm`}
          </div>
          {draft.status === 'ready' && (
            <div className="draft-detail">
              σ {draft.sigma!.toFixed(4)} mm · {draft.usedPoints!.toLocaleString('en-US')} of{' '}
              {draft.regionSize!.toLocaleString('en-US')} points · {draft.picks.length} pick
              {draft.picks.length === 1 ? '' : 's'}
            </div>
          )}
          <button
            className="primary block"
            data-test="create-sphere"
            disabled={draft.status !== 'ready'}
            onClick={onConfirmDraft}
          >
            Create sphere
          </button>
          <div className="actions plain">
            <button disabled={draft.picks.length === 0} onClick={onUndoPick}>
              Undo point
            </button>
            <button data-test="cancel-draft" onClick={onCancelDraft}>
              Cancel
            </button>
          </div>
        </section>
      )}

      {elements.length > 0 && (
        <section>
          <h2>Spheres</h2>
          {elements.map((el) => (
            <div className="element-row" key={el.id}>
              <span className="dot" style={{ background: el.color }} />
              <span className="name">{el.name}</span>
              <span className={`value ${el.status}`}>
                {el.status === 'fitting' ? (
                  <>
                    <span className="spinner" />
                    Fitting…
                  </>
                ) : (
                  `Ø ${el.diameter!.toFixed(3)} mm`
                )}
              </span>
              <button className="icon" title={`Delete ${el.name}`} onClick={() => onDelete(el.id)}>
                ✕
              </button>
            </div>
          ))}
        </section>
      )}

      {pairs.length > 0 && (
        <section>
          <h2>Center distances</h2>
          {pairs.map((p) => (
            <div className="distance-row" key={`${p.a.id}-${p.b.id}`}>
              <span className="name">
                {p.a.name} ↔ {p.b.name}
              </span>
              <span className="value">{p.dist.toFixed(3)} mm</span>
            </div>
          ))}
        </section>
      )}

      <div className="actions">
        <button
          disabled={done.length === 0}
          onClick={() => {
            onCopy()
            setCopied(true)
            setTimeout(() => setCopied(false), 2000)
          }}
        >
          {copied ? 'Copied ✓' : 'Copy summary'}
        </button>
        <button disabled={elements.length === 0 && draft === null} onClick={onClearAll}>
          Clear all
        </button>
      </div>

      <label className="toggle">
        <input
          type="checkbox"
          checked={showOverlays}
          onChange={(e) => setShowOverlays(e.target.checked)}
        />
        Show fitted spheres &amp; distances
      </label>

      <footer>
        <p>Runs entirely in your browser — your files never leave your computer.</p>
        <p>
          <a href="https://www.cnckitchen.com" target="_blank" rel="noreferrer">
            by CNC Kitchen
          </a>
          {' · '}
          <a href={REPO_URL} target="_blank" rel="noreferrer">
            Source
          </a>
        </p>
      </footer>
    </aside>
  )
}
