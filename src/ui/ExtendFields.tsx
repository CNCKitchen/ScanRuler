// SPDX-License-Identifier: AGPL-3.0-only
// How far past the measured surface the element being made is drawn: one
// field per side, matching one grip per side in the viewport. Millimetres,
// positive outward, and negative to pull an edge back in — the clamp that
// stops an element being given away entirely lives in the store, so anything
// can be typed here and what comes back is what was allowed.

import { InfoDot } from './InfoDot'
import { useStore } from '../state/store'
import {
  extendedSpans,
  extensionOf,
  isExtended,
  sideValue,
  sides,
  type ExtendSide,
  type ExtendableFit,
} from '../core/elements/extend'

const SIDE_LABEL: Record<ExtendSide, string> = {
  start: 'Start',
  end: 'End',
  uMin: '− U',
  uMax: '+ U',
  vMin: '− V',
  vMax: '+ V',
}

export function ExtendFields({ fit }: { fit: ExtendableFit }) {
  const extend = useStore((s) => s.draft?.extend)
  const setDraftExtend = useStore((s) => s.setDraftExtend)
  const squareDraftExtend = useStore((s) => s.squareDraftExtend)
  const resetDraftExtend = useStore((s) => s.resetDraftExtend)

  const ext = extensionOf(fit, extend)
  const spans = extendedSpans(fit, ext)
  const plane = fit.kind === 'plane'

  return (
    <div className="extend">
      <div className="g-label">
        <span>
          Extend
          <InfoDot title="Extending an element">
            <p>
              How far past the surface it was measured on the element is <b>drawn and exported</b>.
              A cylinder grows out of each end, a plane out of each of its four edges — type the
              millimetres here, or drag the grips on the element itself in the viewport.
            </p>
            <p>
              <b>U</b> and <b>V</b> are the patch's own two axes, the ones its extents are reported
              along. The four fields sit in the same order as the four grips.
            </p>
            <p>
              Nothing measured changes: the fit, its sigma and the patch size it reports stay the
              surface the scan actually covered, and a dimension still warns when it leaves it. Only
              the shape you see and the shape CAD receives get longer. Negative values pull an edge
              back in.
            </p>
          </InfoDot>
        </span>
        <b data-test="extend-size">
          {plane
            ? `${spans[0].toFixed(2)} × ${spans[1].toFixed(2)} mm`
            : `${spans[0].toFixed(3)} mm long`}
        </b>
      </div>

      <div className="extend-grid">
        {sides(ext).map((side) => (
          <SideField
            key={side}
            label={SIDE_LABEL[side]}
            value={sideValue(ext, side)}
            testId={`extend-${side}`}
            onCommit={(v) => setDraftExtend(side, v)}
          />
        ))}
      </div>

      <div className="toolrow">
        {plane && (
          <button
            data-test="extend-square"
            title="Grow the shorter axis out to the longer one, so the patch is square"
            onClick={squareDraftExtend}
          >
            Make square
          </button>
        )}
        <button
          data-test="extend-reset"
          disabled={!isExtended(ext)}
          title="Back to exactly the measured surface"
          onClick={resetDraftExtend}
        >
          Reset
        </button>
      </div>
    </div>
  )
}

/** One side's millimetres. Committed on blur or Enter like every other number
 *  in the panel, and re-keyed on the value so a grip dragged in the viewport
 *  types itself into the field. */
function SideField({
  label,
  value,
  testId,
  onCommit,
}: {
  label: string
  value: number
  testId: string
  onCommit: (v: number) => void
}) {
  return (
    <label className="extend-field">
      <span>{label}</span>
      <input
        type="number"
        step="any"
        data-test={testId}
        key={value}
        defaultValue={round(value)}
        onBlur={(e) => {
          const v = Number(e.target.value)
          if (Number.isFinite(v)) onCommit(v)
          // Rewrite the text either way: a commit the store clamps back to
          // the value already held re-renders nothing, and the rejected text
          // would otherwise stay. A changed value re-keys the input over this.
          e.target.value = String(round(value))
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
        }}
      />
    </label>
  )
}

/** Three decimals is a micrometre — past what a grip dragged across the screen
 *  means, and enough for anything typed. */
function round(v: number): number {
  return Math.round(v * 1000) / 1000
}
