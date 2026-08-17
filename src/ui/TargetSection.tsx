// SPDX-License-Identifier: AGPL-3.0-only
// Choosing the element the scan is measured against — the whole of the setup
// for an element map, because the element was already measured on this scan.
// There is no button to press afterwards: the map is a few milliseconds of
// arithmetic, so it appears with the choice and follows every change to it.

import type { ElementTarget, MaterialSide } from '../core/deviation/elementField'
import { describeTarget, isDeviationTarget } from '../core/deviation/elementField'
import { elementKindInfo } from '../core/elements/kinds'
import type { Element } from '../state/store'
import { InfoDot } from './InfoDot'

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
  disabled,
  onSelect,
  onFlip,
  onGoToMeasure,
}: {
  className: string
  elements: Element[]
  targetId: number | null
  /** The chosen element as drawn, or null when nothing usable is chosen. */
  target: ElementTarget | null
  side: MaterialSide
  disabled: boolean
  onSelect: (id: number | null) => void
  onFlip: () => void
  onGoToMeasure: () => void
}) {
  // Only the kinds with a surface, and only the ones that have actually been
  // measured — a construction that has gone degenerate has no geometry to be
  // measured against.
  const options = elements.filter((e) => isDeviationTarget(e.fit))

  return (
    <div className={className}>
      <div className="sec-head">
        Element
        <InfoDot title="The element to measure against">
          <p>
            Any plane, cylinder or sphere from the Measure workspace. The map is measured over the
            element <b>as it is drawn</b> — extend it there with the grips and the measured region
            grows with it, which is how a plane fitted on one pad becomes a flatness map of the
            whole face it belongs to.
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
            No plane, cylinder or sphere measured yet. Fit one on the scan in the Measure workspace
            and it appears here.
          </p>
          <button className="block" data-test="target-goto-measure" onClick={onGoToMeasure}>
            Go to Measure…
          </button>
        </>
      ) : (
        <>
          <label className="field">
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

          {target && (
            <>
              <p className="hint" data-test="target-detail">
                {describeTarget(target)}
              </p>
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
