// SPDX-License-Identifier: AGPL-3.0-only
// The surface marking controls — gesture row, brush width, back faces, erase
// and clear — as one block, so both places that mark scan surface by hand offer
// the same tools and the same escape route: an element fitted to exactly the
// triangles the user chose, and the local fine fit in the deviation workspace.
//
// The reason this is shared rather than written twice: a marking gesture takes
// both plain mouse drags away from the camera while it is live, and a tool that
// quietly holds the mouse hostage in one workspace but not the other is worse
// than either behaviour on its own.

import { brushRange, useMark, type MarkGesture } from '../state/markStore'
import { useStore } from '../state/store'
import { InfoDot } from './InfoDot'

/** The marking modes, with plain navigation as one of them. A gesture takes
 *  both plain mouse drags away from the camera for as long as it is on, so
 *  which of the four is live has to be as visible as any other mode switch —
 *  and getting the camera back has to be one click, not an escape hatch. */
const GESTURES: { id: MarkGesture | null; label: string; title: string }[] = [
  {
    id: null,
    label: '✥ Navigate',
    title: 'Marking off — orbit, pan and zoom as usual. What is marked stays marked.',
  },
  {
    id: 'window',
    label: '▭ Window',
    title: 'Drag a rectangle: every triangle inside it is marked',
  },
  { id: 'brush', label: '● Brush', title: 'Drag over the surface with a round brush' },
  { id: 'lasso', label: '⌇ Lasso', title: 'Draw a free outline: everything inside it is marked' },
]

export function MarkTools({
  escapeNote,
  showCount = true,
  onClear,
}: {
  /** What a second Escape does from here — the two sessions back out of
   *  different things, and that is the only part of the story that differs. */
  escapeNote: string
  /** Show the running tally. Off where the panel already prints it elsewhere. */
  showCount?: boolean
  /** Rub out the whole marking. */
  onClear: () => void
}) {
  const m = useMark()
  const modelSize = useStore((s) => s.modelSize)
  const brush = brushRange(modelSize)

  return (
    <>
      <div className="moderow" data-test="mark-gestures">
        {GESTURES.map((g) => (
          <button
            key={g.id ?? 'navigate'}
            className={m.gesture === g.id ? 'on' : ''}
            data-test={`mark-${g.id ?? 'navigate'}`}
            aria-pressed={m.gesture === g.id}
            title={g.title}
            // Clicking the live gesture again hands the camera back — the same
            // key that armed it disarms it.
            onClick={() => m.setGesture(m.gesture === g.id ? null : g.id)}
          >
            {g.label}
          </button>
        ))}
      </div>
      <p className="hint">
        {m.gesture === null
          ? 'Marking is off — the camera has both drags back.'
          : 'Left-drag marks, right-drag rubs out.'}
        <InfoDot title="Marking tools" testId="mark-help">
          <p>
            <b>Window</b> marks every triangle inside a dragged rectangle. <b>Brush</b> paints with a
            round tip, for working along an edge. <b>Lasso</b> takes everything inside a free
            outline.
          </p>
          <p>
            While a tool is live it takes both plain drags: left marks, right rubs out, and Alt
            inverts either way. Shift-drag still orbits and the middle button is untouched.
          </p>
          <p>
            <b>Navigate</b>, Esc, or clicking the live tool again hands the drags back to the camera;
            what is marked stays marked. {escapeNote}
          </p>
        </InfoDot>
      </p>

      {m.gesture === 'brush' && (
        <>
          <label className="field">
            <span>Brush Ø (mm)</span>
            <input
              type="number"
              step="any"
              min={0}
              data-test="mark-brush-diameter"
              value={Number(m.diameter.toFixed(3))}
              onChange={(e) => e.target.value !== '' && m.setDiameter(Number(e.target.value))}
            />
          </label>
          <input
            className="slider"
            type="range"
            min={brush.min}
            max={brush.max}
            step={(brush.max - brush.min) / 200}
            value={Math.min(Math.max(m.diameter, brush.min), brush.max)}
            aria-label="Brush diameter"
            onChange={(e) => m.setDiameter(Number(e.target.value))}
          />
        </>
      )}

      <label className="checkrow">
        <input
          type="checkbox"
          data-test="mark-backfaces"
          checked={m.backfaces}
          onChange={(e) => m.setBackfaces(e.target.checked)}
        />
        <span>Mark faces pointing away too</span>
        <InfoDot title="Faces pointing away">
          <p>
            Off, only surface turned towards you is taken, so a window dragged over a closed part
            cannot quietly mark the far wall as well.
          </p>
          <p>
            On, the gesture goes straight through — useful for taking a whole rib or boss in one
            sweep, and for a scan whose normals came out inverted.
          </p>
        </InfoDot>
      </label>

      <div className="toolrow">
        <button
          className={m.erase ? 'on' : ''}
          data-test="mark-erase"
          aria-pressed={m.erase}
          onClick={() => m.setErase(!m.erase)}
          title="The gesture takes marking away instead of laying it down — the right button always does, and Alt inverts either way"
        >
          {m.erase ? '◐ Erasing' : '◑ Erase'}
        </button>
        <button data-test="mark-clear" disabled={m.count === 0} onClick={onClear}>
          Clear marking
        </button>
      </div>

      {showCount && (
        <div className="kv">
          <span className="name">Marked</span>
          <b data-test="mark-count">{m.count.toLocaleString('en-US')} points</b>
        </div>
      )}
    </>
  )
}

/**
 * The viewport line for a live marking session: which gesture is live, what the
 * buttons do while it is, and the way back to the camera. Shared for the same
 * reason the controls are — the answer to "why is my drag not orbiting" has to
 * read the same in both workspaces.
 */
export function markChipText(
  gesture: MarkGesture | null,
  count: number,
  /** What the gesture is being asked to take, e.g. "the surface to fit on". */
  target: string,
  /** Where Escape leads from here, idle and with a gesture live. */
  escape: { idle: string; live: string },
): string {
  const tally = count === 0 ? '' : ` · ${count.toLocaleString('en-US')} points marked`
  if (gesture === null) {
    return `Marking off — orbit and pan as usual · pick a tool in the panel to mark${tally} · ${escape.idle}`
  }
  const verb =
    gesture === 'window'
      ? `Drag a window over ${target}`
      : gesture === 'lasso'
        ? `Draw a lasso around ${target}`
        : `Drag the brush over ${target}`
  return `${verb}${tally} · right-drag rubs out · Shift-drag orbits · ${escape.live}`
}
