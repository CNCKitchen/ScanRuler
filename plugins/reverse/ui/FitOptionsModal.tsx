// SPDX-License-Identifier: AGPL-3.0-only
// Fit options — how Fit all chains cuts the slice. A window of its own, so
// the sketch box keeps to its three commands: opened from the box, floating
// beside it with no backdrop, because the point of the detail slider is to
// watch the pieces on the part change as it moves. It can be dragged off
// whatever it covers by its head. The options are a preference (rePrefs
// .fitOptions); the fit tolerance belongs to the sketch in hand. A change
// refits the chains already fitted, as one step for undo — on release for
// the slider, at once for a switch.

import { useEffect, useRef, useState } from 'react'
import { useUnits } from '../../../src/app/useUnits'
import { lengthField, NumberInput } from '../../../src/ui/NumberField'
import type { SketchChains } from '../app/useReverseWorkspace'
import { DEFAULT_FIT_OPTIONS, type FitOptions } from '../core/fitOptions'
import { useRePrefs } from '../state/rePrefs'
import { useReverse } from '../state/reStore'

const DETAIL_NAMES = ['Coarse', 'Coarser', 'Medium', 'Finer', 'Fine']

export function FitOptionsModal({ open, onClose, chainsOf }: { open: boolean; onClose: () => void; chainsOf: () => SketchChains | null }) {
  const options = useRePrefs((s) => s.fitOptions)
  const setOptions = useRePrefs((s) => s.setFitOptions)
  const tolerance = useReverse((s) => s.sketchDraft?.tolerance ?? null)
  // The tolerance is held in millimetres and typed in the units shown.
  const field = lengthField(useUnits())
  const fittedCount = useReverse((s) => (s.sketchDraft ? Object.keys(s.sketchDraft.fitted).length : 0))
  const pieces = useReverse((s) => {
    const d = s.sketchDraft
    if (!d) return 0
    let n = 0
    for (const f of Object.values(d.fitted)) n += f.order.length
    return n
  })
  const [offset, setOffset] = useState<[number, number]>([0, 0])
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null)
  // The slider's value while it is held: the fit follows on release.
  const [detail, setDetail] = useState(options.detail)
  useEffect(() => setDetail(options.detail), [options.detail])

  // Escape closes it, and never reaches the sketch behind — which would put
  // the tool down.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  if (!open) return null

  const refit = (next: FitOptions) => {
    const chains = chainsOf()
    if (chains && fittedCount > 0) useReverse.getState().refitChains(chains.chains, next)
  }
  const change = (patch: Partial<FitOptions>) => {
    const next = { ...options, ...patch }
    setOptions(next)
    refit(next)
  }
  const commitDetail = () => {
    if (detail !== options.detail) change({ detail })
  }

  return (
    <div
      className="modal fitoptions"
      data-test="fit-options"
      role="dialog"
      aria-labelledby="fit-options-title"
      style={{ transform: `translate(${offset[0]}px, ${offset[1]}px)` }}
    >
      <div
        className="modalhead draghead"
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest('button')) return
          drag.current = { x: e.clientX, y: e.clientY, ox: offset[0], oy: offset[1] }
          e.currentTarget.setPointerCapture(e.pointerId)
        }}
        onPointerMove={(e) => {
          const d = drag.current
          if (d) setOffset([d.ox + e.clientX - d.x, d.oy + e.clientY - d.y])
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
      >
        <h2 id="fit-options-title">Fit options</h2>
        <button className="x" data-test="fit-options-close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>

      <div className="setting">
        <label htmlFor="fit-detail">Detail</label>
        <div className="range">
          <input
            id="fit-detail"
            data-test="fit-detail"
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={detail}
            onChange={(e) => setDetail(Number(e.target.value))}
            onPointerUp={commitDetail}
            onKeyUp={commitDetail}
            onBlur={commitDetail}
          />
          <output htmlFor="fit-detail">{DETAIL_NAMES[Math.min(4, Math.floor(detail * 5))]}</output>
        </div>
        <small>
          <b>Coarse</b> gives few, long pieces: a wall that bows or wanders is one line, a blob in
          a corner is cut out for the corner its sides make, and a round no bigger than the
          wander becomes a sharp corner. <b>Fine</b> gives every small feature a piece of its
          own.
        </small>
      </div>

      <div className="setting">
        <label htmlFor="fit-tolerance">Fit tolerance</label>
        <span className="unitfield">
          <NumberInput
            id="fit-tolerance"
            step={field.step(0.01)}
            min="0"
            data-test="sketch-tolerance"
            placeholder="auto"
            value={tolerance}
            text={field.text}
            onCommit={(typed) => {
              // Committed whole, on blur or Enter: each keystroke taken alone
              // cleared "0.0" on the way to 0.05.
              const v = typed === null ? null : field.read(typed)
              useReverse.getState().setSketchTolerance(v === null || !(v > 0) ? null : v)
              refit(options)
            }}
          />
          <i>{field.word}</i>
        </span>
        <small>
          How far an arc may miss its slice points. Left blank the chain's own scatter decides; a
          noisier scan wants it raised. Detail works on top of it.
        </small>
      </div>

      <label className="checkrow">
        <input type="checkbox" data-test="fit-join" checked={options.joinCorners} onChange={(e) => change({ joinCorners: e.target.checked })} />
        <span>Join corners — sides carried on to where they cross, fillets made tangent</span>
      </label>

      <label className="checkrow">
        <input type="checkbox" data-test="fit-align" checked={options.alignAxes} onChange={(e) => change({ alignAxes: e.target.checked })} />
        <span>Align lines to the sheet's axes when they run close to one</span>
      </label>
      <div className="setting indent">
        <label htmlFor="fit-align-degrees">Within</label>
        <span className="unitfield">
          <NumberInput
            id="fit-align-degrees"
            min="0.5"
            max="10"
            step="0.5"
            data-test="fit-align-degrees"
            disabled={!options.alignAxes}
            value={options.alignDegrees}
            onCommit={(v) => {
              if (v !== null && v > 0 && v !== options.alignDegrees) change({ alignDegrees: v })
            }}
          />
          <i>°</i>
        </span>
      </div>
      <label className="checkrow indent">
        <input
          type="checkbox"
          data-test="fit-align-45"
          disabled={!options.alignAxes}
          checked={options.alignDiagonals}
          onChange={(e) => change({ alignDiagonals: e.target.checked })}
        />
        <span>Lines near 45° too</span>
      </label>
      <small className="dim">
        Aligned lines get a horizontal or vertical relation, shown as an inferred chip that can be
        taken off. The axes are the sheet's: on a part that lies askew, select a side and use
        Align first.
      </small>

      <div className="modalfoot">
        <span className="dim" data-test="fit-options-status">
          {fittedCount > 0 ? `${pieces} piece${pieces === 1 ? '' : 's'} on ${fittedCount} chain${fittedCount === 1 ? '' : 's'} — changes refit them` : 'Takes effect on Fit all chains'}
        </span>
        <button data-test="fit-options-reset" onClick={() => change({ ...DEFAULT_FIT_OPTIONS })}>
          Reset
        </button>
      </div>
    </div>
  )
}
