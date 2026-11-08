// SPDX-License-Identifier: AGPL-3.0-only
// Mirror: the scan reflected across a plane — the whole part, or one side of
// it reflected onto the other to make it symmetric.

import { useShallow } from 'zustand/react/shallow'
import { isWorldAxis, SECTION_REF_KINDS, type SectionRef } from '../../../../src/core/section/frame'
import { useStore } from '../../../../src/state/store'
import { InfoDot } from '../../../../src/ui/InfoDot'
import { NumberField } from '../../../../src/ui/NumberField'
import { providersFor } from '../../../../src/ui/RefSelect'
import { PlaneRefOptions } from '../../../../src/ui/SectionEditor'
import { cutPlaneOf } from '../../core/cutPlane'
import { useMeshTools, type MirrorMode } from '../../state/meshStore'

const MODES: { id: MirrorMode; label: string; title: string }[] = [
  { id: 'whole', label: 'Whole part', title: 'Reflect the whole part across the plane — a left-hand part made of a right-hand one' },
  { id: 'symmetric', label: 'Symmetric', title: 'Keep one side of the part and reflect it onto the other, which it replaces' },
]

export function MirrorTool({ ready, busy, onMirror }: { ready: boolean; busy: boolean; onMirror: () => void }) {
  // Only what the panel reads: the whole store would render it again on
  // every write to it, the mirror preview's while its offset is dragged.
  const m = useMeshTools(
    useShallow((s) => ({
      editing: s.editing,
      mirrorKeep: s.mirrorKeep,
      mirrorMode: s.mirrorMode,
      mirrorOffset: s.mirrorOffset,
      mirrorOffsetAuto: s.mirrorOffsetAuto,
      mirrorRef: s.mirrorRef,
      setMirrorKeep: s.setMirrorKeep,
      setMirrorMode: s.setMirrorMode,
      setMirrorOffset: s.setMirrorOffset,
      setMirrorRef: s.setMirrorRef,
    })),
  )
  const elements = useStore((s) => s.elements)
  const modelCenter = useStore((s) => s.modelCenter)
  const modelSize = useStore((s) => s.modelSize)
  const options = providersFor(['plane', 'axis'], elements, undefined, SECTION_REF_KINDS)
  const plane = cutPlaneOf(m.mirrorRef, m.mirrorOffset, m.mirrorOffsetAuto, m.mirrorKeep, elements, modelCenter, undefined, 2 * modelSize)
  const axisName = isWorldAxis(m.mirrorRef) ? m.mirrorRef.toUpperCase() : null
  const parseRef = (v: string): SectionRef => (isWorldAxis(v) ? v : Number(v))
  const symmetric = m.mirrorMode === 'symmetric'

  return (
    <div className="group" data-test="mirror-tool">
      <div className="sec-head">
        Mirror
        <InfoDot title="Mirroring the scan">
          <p>
            The scan reflected across a plane. <b>Whole part</b> reflects all of it: the left-hand
            version of a right-hand bracket, a part scanned from its mirror image. The mirror
            image is drawn see-through over the part while the tool is in hand.
          </p>
          <p>
            <b>Symmetric</b> keeps one side of the part and reflects it onto the other, which it
            replaces: a symmetric part scanned well on one side only, or damaged on one side. The
            two halves join along the plane, so a closed part stays closed. A face lying in the
            plane, such as the cap of a part already cut there, is dropped. The side that is
            replaced is cut away on screen and the mirror image drawn in its place.
          </p>
          <p>
            The plane is taken as <b>Cut</b> takes it: across one of the scan's{' '}
            <b>coordinate planes</b>, or across an <b>element</b> with a direction. It starts
            through the middle of the part; type where it should be. The mirror is made on the
            edited copy; <b>Ctrl+Z</b> puts it back.
          </p>
        </InfoDot>
      </div>

      <div className="field">
        <span>Mirror</span>
        <div className="moderow" role="radiogroup" aria-label="What to mirror">
          {MODES.map((mode) => (
            <button
              key={mode.id}
              role="radio"
              aria-checked={m.mirrorMode === mode.id}
              className={m.mirrorMode === mode.id ? 'on' : undefined}
              data-test={`mirror-mode-${mode.id}`}
              disabled={busy}
              onClick={() => m.setMirrorMode(mode.id)}
              title={mode.title}
            >
              {mode.label}
            </button>
          ))}
        </div>
      </div>

      <label className="field">
        <span>Across</span>
        <select
          data-test="mirror-ref"
          value={String(m.mirrorRef)}
          disabled={busy}
          onChange={(e) => m.setMirrorRef(parseRef(e.target.value))}
        >
          <PlaneRefOptions options={options} />
          {!axisName && !options.some((el) => el.id === m.mirrorRef) && (
            <option value={String(m.mirrorRef)}>(deleted element)</option>
          )}
        </select>
      </label>

      <NumberField
        label={axisName ?? 'Offset'}
        testId="mirror-offset"
        value={plane?.offset ?? m.mirrorOffset}
        step={0.1}
        min={-1e6}
        kind="length"
        disabled={busy || !plane}
        onCommit={m.setMirrorOffset}
        hint={
          axisName
            ? `Where the plane is: its ${axisName} coordinate. It starts through the middle of the part.`
            : 'How far the plane is moved along the element’s direction from its centre. It starts through the middle of the part.'
        }
      />

      {symmetric && (
        <div className="field">
          <span>Keep</span>
          <div className="moderow" role="radiogroup" aria-label="Side to keep">
            {(['plus', 'minus'] as const).map((k) => (
              <button
                key={k}
                role="radio"
                aria-checked={m.mirrorKeep === k}
                className={m.mirrorKeep === k ? 'on' : undefined}
                data-test={`mirror-keep-${k}`}
                disabled={busy}
                onClick={() => m.setMirrorKeep(k)}
                title={
                  k === 'plus'
                    ? 'Keep the side the direction points to, and mirror it onto the other'
                    : 'Keep the other side, and mirror it onto this one'
                }
              >
                {`${k === 'plus' ? '+' : '−'}${axisName ?? ''} side`}
              </button>
            ))}
          </div>
        </div>
      )}

      <button
        className="primary block"
        data-test="mirror-scan"
        data-confirm={1}
        disabled={!ready || busy || !plane}
        onClick={onMirror}
      >
        {m.editing ? (
          <>
            <span className="spinner" />
            Mirroring…
          </>
        ) : symmetric ? (
          'Make symmetric'
        ) : (
          'Mirror'
        )}
      </button>
      {!plane && <p className="hint">Choose what to mirror across.</p>}
      {plane && ready && (
        <p className="hint" data-test="mirror-hint">
          {symmetric
            ? 'The side that is replaced is cut away and its new shape drawn in its place.'
            : 'The mirror image is drawn see-through over the part.'}
        </p>
      )}
    </div>
  )
}
