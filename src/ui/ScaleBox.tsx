// SPDX-License-Identifier: AGPL-3.0-only
// The Scale part box of the Alignment group: lengths measured on the scan
// held against the same lengths on the real part, or a factor typed outright.
// The scan is scaled when Scale part is pressed — see app/partScale.

import { useMemo } from 'react'
import { factorProblem, sizeLooksOff, type ScaleReference } from '../core/scanScale'
import { useLength } from '../app/useUnits'
import { useStore } from '../state/store'
import {
  diameterElements,
  freshScaleRef,
  lengthDimensions,
  measuredOf,
  scaleFromDraft,
  type ScaleRefDraft,
} from '../state/scaleModel'
import { InfoDot } from './InfoDot'

/** A row's choice as the select holds it. */
const valueOf = (r: ScaleRefDraft): string =>
  r.kind === 'points' ? 'points' : r.id === null ? '' : `${r.kind === 'dimension' ? 'd' : 'e'}:${r.id}`

const factorText = (f: number): string => `×${+f.toPrecision(6)}`
const pctText = (share: number): string => `${share >= 0 ? '+' : '−'}${Math.abs(share * 100).toFixed(2)} %`

export function ScaleBox({
  refusal,
  onApply,
}: {
  /** Why the scan cannot be scaled now, or null. */
  refusal: string | null
  onApply: (factor: number, references: ScaleReference[]) => void
}) {
  const draft = useStore((s) => s.scaleDraft)!
  const elements = useStore((s) => s.elements)
  const dimensions = useStore((s) => s.dimensions)
  const sections = useStore((s) => s.sections)
  const modelSize = useStore((s) => s.modelSize)
  const busy = useStore((s) => s.busy)
  const setDraft = useStore((s) => s.setScaleDraft)
  const cancel = useStore((s) => s.cancelScale)
  const len = useLength()

  const dims = lengthDimensions(dimensions)
  const diameters = diameterElements(elements)
  const state = { elements, sections, dimensions }
  const read = useMemo(
    () => {
      try {
        return scaleFromDraft(draft, { elements, sections, dimensions }, len.fromDisplay)
      } catch (e) {
        return { combined: null, references: [], problem: e instanceof Error ? e.message : String(e) }
      }
    },
    [draft, elements, sections, dimensions, len],
  )
  const factor = draft.mode === 'factor' ? draft.factor : (read.combined?.factor ?? NaN)
  const ready = Number.isFinite(factor) && factorProblem(factor) === null
  const across = 2 * modelSize
  const off = sizeLooksOff(across)

  const setRow = (i: number, row: ScaleRefDraft) => setDraft({ refs: draft.refs.map((r, j) => (j === i ? row : r)) })
  const choose = (i: number, value: string) => {
    const keep = draft.refs[i].true
    if (value === 'points') setDraft({ refs: draft.refs.map((r, j) => (j === i ? { ...freshScaleRef('points'), true: keep } : r)), pickRow: i })
    else if (value === '') setRow(i, { kind: 'dimension', id: null, true: keep })
    else setRow(i, { kind: value[0] === 'd' ? 'dimension' : 'element', id: Number(value.slice(2)), true: keep })
    if (value !== 'points' && draft.pickRow === i) setDraft({ pickRow: null })
  }

  return (
    <div className="draftbox" data-test="scale-box">
      <div className="sec-head">
        Scale part
        <InfoDot title="Scale part">
          <p>
            Makes the scan its true size. A photogrammetry scan — from Meshroom, say — is right in shape
            but has no size of its own: it comes out in whatever units the program chose.
          </p>
          <p>
            Measure a length on the scan as usual — two planes and the distance between them, a bore’s
            diameter, two balls’ centres — then pick it here and type how long it really is, from
            calipers on the real part. Several lengths are averaged, the longer ones counting more,
            and each says how far it is off the rest, so a bad one shows.
          </p>
          <p>
            The best lengths are long and run between centres — hole to hole, ball to ball: a centre
            stays put when the scanned surface sits a little proud or sunk, which photogrammetry
            surfaces do. A fitted element averages thousands of points; two clicked points are
            quick but each is one spot of noise.
          </p>
          <p>
            The part is scaled about its zero point. Elements, dimensions and sections scale with
            it; the fit to a reference part is made again. Scale before modelling on the scan.
          </p>
        </InfoDot>
      </div>
      <label className="field">
        <span>From</span>
        <select
          data-test="scale-mode"
          value={draft.mode}
          onChange={(e) => setDraft({ mode: e.target.value as 'reference' | 'factor', pickRow: null })}
        >
          <option value="reference">Measured lengths</option>
          <option value="factor">A factor</option>
        </select>
      </label>

      {draft.mode === 'reference' ? (
        <>
          {dims.length === 0 && diameters.length === 0 && (
            <p className="hint" data-test="scale-nothing">
              No length is measured yet. Measure one — two planes and a distance, a cylinder’s diameter —
              or click two points on the scan.
            </p>
          )}
          {draft.refs.map((ref, i) => {
            const m = measuredOf(ref, state)
            const weighed = read.combined?.references.find((r) => r.label === m.label && Math.abs(r.measured - m.measured) < 1e-12)
            const picking = draft.pickRow === i
            return (
              <div className="dro" key={i} data-test={`scale-ref-${i}`}>
                <label className="field">
                  <span>Length {draft.refs.length > 1 ? i + 1 : ''}</span>
                  <select data-test={`scale-ref-${i}-what`} value={valueOf(ref)} onChange={(e) => choose(i, e.target.value)}>
                    <option value="">Select…</option>
                    {dims.length > 0 && (
                      <optgroup label="Dimensions">
                        {dims.map((d) => (
                          <option key={d.id} value={`d:${d.id}`}>
                            {d.name}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    {diameters.length > 0 && (
                      <optgroup label="Diameters">
                        {diameters.map((e) => (
                          <option key={e.id} value={`e:${e.id}`}>
                            {e.name} Ø
                          </option>
                        ))}
                      </optgroup>
                    )}
                    <option value="points">Two points on the scan</option>
                  </select>
                </label>
                {ref.kind === 'points' && (
                  <div className="toolrow">
                    <button
                      data-test={`scale-ref-${i}-pick`}
                      className={picking ? 'on' : ''}
                      onClick={() => setDraft({ pickRow: picking ? null : i, refs: draft.refs.map((r, j) => (j === i && r.kind === 'points' && !picking ? { ...r, points: [] } : r)) })}
                    >
                      {picking ? `Picking — ${ref.points.length} / 2 on the scan…` : ref.points.length === 2 ? 'Pick again' : 'Pick 2 points'}
                    </button>
                  </div>
                )}
                <label className="field">
                  <span>True length ({len.word()})</span>
                  <input
                    type="number"
                    step="any"
                    min="0"
                    data-test={`scale-ref-${i}-true`}
                    value={Number.isFinite(ref.true) ? ref.true : ''}
                    onChange={(e) => setRow(i, { ...ref, true: e.target.value === '' ? NaN : Number(e.target.value) })}
                  />
                </label>
                {Number.isFinite(m.measured) && (
                  <div className="dro-note" data-test={`scale-ref-${i}-reading`}>
                    On the scan {len.fmt(m.measured, 4)}
                    {weighed && ` — asks for ${factorText(weighed.factor)}`}
                    {weighed && read.combined!.references.length > 1 && `, ${pctText(weighed.off)} off the average`}
                  </div>
                )}
                {draft.refs.length > 1 && (
                  <div className="toolrow">
                    <button
                      data-test={`scale-ref-${i}-remove`}
                      onClick={() => setDraft({ refs: draft.refs.filter((_, j) => j !== i), pickRow: null })}
                    >
                      Remove
                    </button>
                  </div>
                )}
              </div>
            )
          })}
          <div className="toolrow">
            <button data-test="scale-add-ref" onClick={() => setDraft({ refs: [...draft.refs, freshScaleRef('dimension')] })}>
              + Another length
            </button>
          </div>
          {read.problem && <p className="hint">{read.problem}</p>}
          {read.combined && read.combined.references.length > 1 && read.combined.spread > 0.01 && (
            <p className="alarmtext" data-test="scale-spread">
              The lengths disagree by up to {(read.combined.spread * 100).toFixed(1)} % — check the one furthest off:
              a fit running onto a chamfer, a typo, or a length taken across a different feature.
            </p>
          )}
        </>
      ) : (
        <>
          <label className="field">
            <span>Factor</span>
            <input
              type="number"
              step="any"
              min="0"
              data-test="scale-factor"
              value={Number.isFinite(draft.factor) ? draft.factor : ''}
              onChange={(e) => setDraft({ factor: e.target.value === '' ? NaN : Number(e.target.value) })}
            />
          </label>
          {off && off.guesses.length > 0 && (
            <div className="toolrow">
              {off.guesses.map((g) => (
                <button key={g.factor} data-test={`scale-guess-${g.factor}`} title={`The file was in ${g.word}`} onClick={() => setDraft({ factor: g.factor })}>
                  {factorText(g.factor)} ({g.word})
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {ready && (
        <p className="hint" data-test="scale-result">
          {factorText(factor)} — the part {len.fmt(across, 3)} across now, {len.fmt(across * factor, 3)} after.
        </p>
      )}
      {refusal && (
        <p className="alarmtext" data-test="scale-refusal">
          {refusal}
        </p>
      )}
      <button
        className="primary block"
        data-test="apply-scale"
        data-confirm={1}
        disabled={!ready || busy || refusal !== null}
        onClick={() => onApply(factor, draft.mode === 'factor' ? [] : read.references)}
      >
        Scale part
      </button>
      <div className="toolrow">
        <button data-test="cancel-scale" onClick={cancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}
