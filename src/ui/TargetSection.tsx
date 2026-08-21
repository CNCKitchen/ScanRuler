// SPDX-License-Identifier: AGPL-3.0-only
// Choosing the element the scan is measured against — the whole of the setup
// for an element map, because the element was already measured on this scan.
// There is no button to press afterwards: the map is a few milliseconds of
// arithmetic, so it appears with the choice and follows every change to it.

import type { ElementTarget, MaterialSide } from '../core/deviation/elementField'
import { describeTarget, isDeviationTarget } from '../core/deviation/elementField'
import { elementKindInfo } from '../core/elements/kinds'
import type { Element } from '../state/store'
import { usePulse } from '../app/useHints'
import { InfoDot } from './InfoDot'
import { MarkTools } from './MarkTools'

/** Which side of the element the material is on, said in words rather than as a
 *  sign — what "outward" means depends on the shape, and a bore is the case
 *  where getting it wrong inverts the entire map. */
function sideLabel(fit: ElementTarget, side: MaterialSide): string {
  if (fit.kind === 'plane') return side === 1 ? 'along the normal' : 'against the normal'
  return side === 1 ? 'outside the surface' : 'inside the surface — a bore or a shell'
}

export function TargetSection({
  className,
  elements,
  targetId,
  target,
  side,
  shown,
  disabled,
  scope,
  scopeMarking,
  scopeCount,
  markCount,
  onSelect,
  onShown,
  onFlip,
  onScope,
  onScopeDone,
  onScopeClear,
  onGoToMeasure,
}: {
  className: string
  elements: Element[]
  targetId: number | null
  /** The chosen element as drawn, or null when nothing usable is chosen. */
  target: ElementTarget | null
  side: MaterialSide
  /** The elements are on the part — which is also what makes them clickable. */
  shown: boolean
  disabled: boolean
  /** Which part of the scan the map covers — everything the element bounds,
   *  or only a hand-marked region of it. */
  scope: 'all' | 'marked'
  /** The marking tools are out, collecting that region. */
  scopeMarking: boolean
  /** Points in the region the map is currently restricted to. */
  scopeCount: number
  /** Points currently marked on the part (live, while the tools are out). */
  markCount: number
  onSelect: (id: number | null) => void
  onShown: (v: boolean) => void
  onFlip: () => void
  onScope: (scope: 'all' | 'marked') => void
  onScopeDone: () => void
  onScopeClear: () => void
  onGoToMeasure: () => void
}) {
  // Only the kinds with a surface, and only the ones that have actually been
  // measured — a construction that has gone degenerate has no geometry to be
  // measured against.
  const options = elements.filter((e) => isDeviationTarget(e.fit))
  const pulseGo = usePulse('target-goto-measure')
  // A dropdown is a poor thing to ring on its own, so the whole row wears it —
  // label included, which is also what says what is being chosen.
  const pulseSelect = usePulse('target-select')

  return (
    <div className={className}>
      <div className="sec-head">
        Element
        <InfoDot title="The element to measure against">
          <p>
            Any plane, cylinder or sphere from the 3D Measure workspace. They are all drawn on the
            part, so you can <b>click one on the model</b> instead of using the dropdown — the
            choice is the same either way.
          </p>
          <p>
            The map is measured over the element <b>as it is drawn</b> — extend it in the Measure
            workspace with the grips and the measured region grows with it, which is how a plane
            fitted on one pad becomes a flatness map of the whole face it belongs to.
          </p>
          <p>
            A point and a line are not offered: the distance to them has no side, so there is no
            zero for the scale to run warm and cool around.
          </p>
        </InfoDot>
      </div>

      {options.length === 0 ? (
        <>
          <p className="hint">
            No plane, cylinder or sphere measured yet. Fit one on the scan in the 3D Measure workspace
            and it appears here.
          </p>
          <button
            className={pulseGo ? 'block pulse' : 'block'}
            data-test="target-goto-measure"
            onClick={onGoToMeasure}
          >
            Go to Measure…
          </button>
        </>
      ) : (
        <>
          <label className={pulseSelect && !disabled ? 'field pulse' : 'field'}>
            <span>Measure to</span>
            <select
              data-test="target-select"
              disabled={disabled}
              value={targetId ?? ''}
              onChange={(e) => onSelect(e.target.value === '' ? null : Number(e.target.value))}
            >
              <option value="">Select…</option>
              {options.map((el) => (
                <option key={el.id} value={el.id}>
                  {el.name} · {elementKindInfo(el.kind).noun}
                </option>
              ))}
            </select>
          </label>

          <label className="checkrow">
            <input
              type="checkbox"
              data-test="toggle-element"
              checked={shown}
              onChange={(e) => onShown(e.target.checked)}
            />
            <span>Show elements on the part</span>
            <InfoDot title="The elements on the part">
              <p>
                Every plane, cylinder and sphere the map could be measured against is drawn on the
                part, so that <b>clicking one chooses it</b> — the same choice as the dropdown
                above, made where you are looking. Switching this off takes them off the stage, and
                with them the clicking.
              </p>
              <p>
                The one in use is reduced to its <b>border</b>: it lies exactly on the surface being
                read, and a body there would wash the colour the reading is made of. It is also the
                one element a click passes straight through, so a click on the map it covers still
                pins a reading.
              </p>
              <p>An element hidden by its own eye in the 3D Measure workspace stays hidden here too.</p>
            </InfoDot>
          </label>

          {targetId === null && options.length > 1 && (
            <p className="hint">Click one on the part, or pick it above.</p>
          )}

          {target && (
            <>
              <p className="hint" data-test="target-detail">
                {describeTarget(target)}
              </p>

              <label className="field">
                <span>
                  Measured region
                  <InfoDot title="Which part of the scan is measured">
                    <p>
                      <b>Everything the element bounds</b> maps every scan point within the element
                      as drawn — the whole face a plane covers, all the way around a cylinder.
                    </p>
                    <p>
                      <b>Marked surface only</b> restricts the map to a region you mark by hand,
                      with the same window, brush and lasso the fits are marked with. Use it to read
                      one pad, one land or one sector against the element while the rest of the
                      surface stays out of the map and its statistics.
                    </p>
                    <p>
                      The region is yours until you clear it: it survives switching elements, so the
                      same patch can be read against several datums in a row.
                    </p>
                  </InfoDot>
                </span>
                <select
                  data-test="target-scope"
                  disabled={disabled}
                  value={scope}
                  onChange={(e) => onScope(e.target.value as 'all' | 'marked')}
                >
                  <option value="all">Everything the element bounds</option>
                  <option value="marked">Marked surface only</option>
                </select>
              </label>

              {scope === 'marked' &&
                (scopeMarking ? (
                  <>
                    <MarkTools
                      escapeNote="The region you have marked stays measured."
                      onClear={onScopeClear}
                    />
                    <button className="block" data-test="scope-done" onClick={onScopeDone}>
                      Put the marking tools away
                    </button>
                    {markCount === 0 && (
                      <p className="hint">
                        Nothing marked yet — the map is empty until you mark the surface to
                        measure.
                      </p>
                    )}
                  </>
                ) : (
                  <>
                    <p className="hint" data-test="scope-count">
                      {scopeCount.toLocaleString('en-US')} point{scopeCount === 1 ? '' : 's'} in
                      the marked region.
                    </p>
                    <button
                      className="block"
                      data-test="scope-edit"
                      disabled={disabled}
                      onClick={() => onScope('marked')}
                    >
                      Edit marked region…
                    </button>
                  </>
                ))}

              <div className="field">
                <span>
                  Material side
                  <InfoDot title="Which side the material is on">
                    <p>
                      Positive deviation is always too much material, so the tool has to know which
                      side of the element the part is. It reads that off the scan's own normals
                      around the element when you choose it.
                    </p>
                    <p>
                      Inside a bore the material is on the <i>inner</i> side, and a fitted plane's
                      normal points whichever way the fit happened to choose — so when the map comes
                      out inverted, this is the control that fixes it.
                    </p>
                  </InfoDot>
                </span>
                <div className="sidepick">
                  <b data-test="target-side">{sideLabel(target, side)}</b>
                  <button data-test="target-flip" disabled={disabled} onClick={onFlip}>
                    Flip
                  </button>
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}
