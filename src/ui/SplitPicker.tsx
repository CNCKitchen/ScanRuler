// SPDX-License-Identifier: AGPL-3.0-only
// Two viewports, two cameras, one list of corresponding points. Clicks
// alternate: a feature on the scan, then the same feature on the reference.
//
// The scan's half doubles as the place to say which surface the fit is measured
// on. Points fix the pose the fit starts from; the selection decides what it is
// allowed to settle onto, which is the other half of getting a scan with a
// fixture, a riser or a run of spray on it into the right place. Nothing
// selected means the whole scan, which is what nearly every part wants.

import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import * as THREE from 'three'
import { PickScene, type PickMarker } from '../viewer/PickScene'
import { schemeById } from '../viewer/navSchemes'
import { themeById } from '../viewer/viewThemes'
import type { MarkingChannel, SceneManager } from '../viewer/SceneManager'
import { useStore } from '../state/store'
import { brushRange, useMark, type MarkGesture } from '../state/markStore'
import { MARK_COLOR, pairColor, useDeviation } from '../state/deviationStore'
import { absoluteOrientation } from '../core/deviation/absoluteOrientation'
import { MIN_LOCAL_POINTS } from '../core/deviation/align'
import type { Vec3 } from '../core/types'
import { FitButton } from './FitButton'

/** Below this the picked points are effectively on one line. */
const MIN_CONDITIONING = 0.02

/** The four things the left button can be doing on the scan's half: placing a
 *  point, or taking surface with one of the three marking gestures. Same
 *  gestures, same words and same escape route as the marking tools in the
 *  panels — see MarkTools. */
const GESTURES: { id: MarkGesture | null; label: string; title: string }[] = [
  {
    id: null,
    label: '✥ Pick points',
    title: 'Click to place the next point, and orbit, pan and zoom as usual',
  },
  { id: 'window', label: '▭ Window', title: 'Drag a rectangle: every triangle inside it is selected' },
  { id: 'brush', label: '● Brush', title: 'Drag over the surface with a round brush' },
  { id: 'lasso', label: '⌇ Lasso', title: 'Draw a free outline: everything inside it is selected' },
]

function Half({
  title,
  subtitle,
  geometry,
  markers,
  active,
  channel,
  tools,
  onPick,
  onPaintChange,
}: {
  title: string
  subtitle: string
  geometry: THREE.BufferGeometry
  markers: PickMarker[]
  active: boolean
  /** The scan's marking, for the half that is allowed to lay it down. */
  channel?: MarkingChannel
  tools?: ReactNode
  onPick: (p: Vec3) => void
  onPaintChange?: (count: number) => void
}) {
  const holder = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<PickScene | null>(null)
  const pickRef = useRef(onPick)
  pickRef.current = onPick
  const paintRef = useRef(onPaintChange)
  paintRef.current = onPaintChange

  // The same buttons as the main viewport: turning a part here to find a
  // feature is the same job as turning it there.
  const navScheme = useStore((s) => s.navScheme)
  const viewTheme = useStore((s) => s.viewTheme)

  // The marking tools, read here rather than in the row that draws them: the
  // scene has to be re-armed on every change of any of them, and re-arming
  // keeps whatever is already marked.
  const markGesture = useMark((s) => s.gesture)
  const markErase = useMark((s) => s.erase)
  const markBackfaces = useMark((s) => s.backfaces)
  const brushDiameter = useMark((s) => s.diameter)
  const marks = channel !== undefined

  useEffect(() => {
    const scene = new PickScene(
      holder.current!,
      geometry,
      themeById(useStore.getState().viewTheme),
      channel,
    )
    scene.onPick = (p) => pickRef.current(p)
    scene.onPaintChange = (count) => paintRef.current?.(count)
    scene.setNavScheme(schemeById(useStore.getState().navScheme))
    sceneRef.current = scene
    return () => {
      scene.dispose()
      sceneRef.current = null
    }
    // The channel is the scan's for as long as the scan is loaded, and this
    // view only exists while one is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geometry])

  useEffect(() => {
    sceneRef.current?.setNavScheme(schemeById(navScheme))
  }, [navScheme])

  useEffect(() => {
    sceneRef.current?.setViewTheme(themeById(viewTheme))
  }, [viewTheme])

  useEffect(() => {
    sceneRef.current?.setMarkers(markers)
  }, [markers])

  // Armed from the moment the half opens, with no gesture live: the marking
  // keeps its tint and the camera keeps both plain drags until one of the three
  // is picked. Never disarmed from here — that would rub the selection out, and
  // the selection outlives the tool in the user's hand.
  useEffect(() => {
    if (!marks) return
    sceneRef.current?.setPaintBrush({
      color: MARK_COLOR,
      diameter: brushDiameter,
      erase: markErase,
      gesture: markGesture,
      backfaces: markBackfaces,
    })
  }, [marks, brushDiameter, markErase, markGesture, markBackfaces])

  return (
    <div className={'splithalf' + (active ? ' active' : '')}>
      <div className="splithead">
        <b>{title}</b>
        <span>{subtitle}</span>
      </div>
      {tools}
      <div className="splitview" ref={holder}>
        <FitButton onFit={() => sceneRef.current?.fitToView()} />
      </div>
    </div>
  )
}

/** The scan half's second line: what the left button does on it, and what has
 *  been selected so far. */
function PickTools({ onClear }: { onClear: () => void }) {
  const m = useMark()
  const modelSize = useStore((s) => s.modelSize)
  const brush = brushRange(modelSize)
  const short = m.count > 0 && m.count < MIN_LOCAL_POINTS

  return (
    <div className="picktools" data-test="pick-tools">
      <div className="moderow">
        {GESTURES.map((g) => (
          <button
            key={g.id ?? 'pick'}
            className={m.gesture === g.id ? 'on' : ''}
            data-test={`pick-${g.id ?? 'points'}`}
            aria-pressed={m.gesture === g.id}
            title={g.title}
            // Clicking the live gesture again hands the camera back and the
            // clicks back to picking — the same key disarms it.
            onClick={() => m.setGesture(m.gesture === g.id ? null : g.id)}
          >
            {g.label}
          </button>
        ))}
      </div>
      {m.gesture === 'brush' && (
        <label className="picksize">
          <span>Ø</span>
          <input
            type="number"
            step="any"
            min={0}
            data-test="pick-brush-diameter"
            value={Number(m.diameter.toFixed(3))}
            onChange={(e) => e.target.value !== '' && m.setDiameter(Number(e.target.value))}
          />
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
        </label>
      )}
      {m.gesture !== null && (
        <>
          <button
            className={m.erase ? 'on' : ''}
            data-test="pick-erase"
            aria-pressed={m.erase}
            title="The gesture takes surface out of the selection instead of adding it — the right button always does, and Alt inverts either way"
            onClick={() => m.setErase(!m.erase)}
          >
            {m.erase ? '◐ Erasing' : '◑ Erase'}
          </button>
          <button
            className={m.backfaces ? 'on' : ''}
            data-test="pick-backfaces"
            aria-pressed={m.backfaces}
            title="Take surface facing away from you as well — off, a window cannot quietly select the far wall of a closed part"
            onClick={() => m.setBackfaces(!m.backfaces)}
          >
            ⧉ Through
          </button>
        </>
      )}
      <button data-test="pick-clear" disabled={m.count === 0} onClick={onClear}>
        Clear selection
      </button>
      <span className={short ? 'pickcount short' : 'pickcount'} data-test="pick-count">
        {m.count === 0
          ? 'Nothing selected — the whole scan is fitted'
          : short
            ? `${m.count.toLocaleString('en-US')} points — too few to fit on, select more or clear it`
            : `${m.count.toLocaleString('en-US')} points selected — only these are fitted`}
      </span>
    </div>
  )
}

export function SplitPicker({
  scene,
  scanGeometry,
  nominalGeometry,
  scanName,
  nominalName,
  onAlign,
  onStop,
  onClearSelection,
  onCancel,
}: {
  /** The main viewport, borrowed for the one marking the scan has. */
  scene: SceneManager
  scanGeometry: THREE.BufferGeometry
  nominalGeometry: THREE.BufferGeometry
  scanName: string
  nominalName: string
  onAlign: () => void
  /** Stop the fit that is running, wherever it has got to. */
  onStop: () => void
  onClearSelection: () => void
  onCancel: () => void
}) {
  const {
    pairs,
    pendingScan,
    addPickPoint,
    undoPair,
    clearPairs,
    alignStatus,
    alignStopping,
    alignMessage,
  } = useDeviation()
  const markCount = useMark((s) => s.count)
  const markGesture = useMark((s) => s.gesture)
  // Borrowed once and kept: it is the scan's mask, and the scan outlives this
  // view.
  const channel = useMemo(() => scene.markingChannel(), [scene])

  const scanMarkers: PickMarker[] = pairs.map((p, i) => ({
    point: p.scan,
    label: String(i + 1),
    color: pairColor(i),
  }))
  if (pendingScan) {
    scanMarkers.push({ point: pendingScan, label: String(pairs.length + 1), color: pairColor(pairs.length) })
  }
  const nominalMarkers: PickMarker[] = pairs.map((p, i) => ({
    point: p.nominal,
    label: String(i + 1),
    color: pairColor(i),
  }))

  const waitingFor = pendingScan ? 'nominal' : 'scan'
  const running = alignStatus === 'running'
  const selecting = markGesture !== null

  // Three points fix a pose only if they are not on one line — the rotation
  // about that line would be free. Solving as they are placed says so while
  // there is still something to do about it, rather than refusing the
  // alignment after the fact.
  const solved =
    pairs.length >= 3
      ? absoluteOrientation(pairs.map((p) => p.scan), pairs.map((p) => p.nominal))
      : null
  const degenerate = solved !== null && solved.conditioning < MIN_CONDITIONING
  // A selection too small to fit on is refused by the fit itself; saying so
  // here keeps the button from being the place it is found out.
  const tooFew = markCount > 0 && markCount < MIN_LOCAL_POINTS
  const enough = pairs.length >= 3 && !degenerate && !tooFew

  return (
    <div className="splitpicker" data-test="split-picker">
      <div className="splitbody">
        <Half
          title="Scan"
          subtitle={scanName}
          geometry={scanGeometry}
          markers={scanMarkers}
          active={waitingFor === 'scan' && !selecting}
          channel={channel}
          tools={<PickTools onClear={onClearSelection} />}
          onPick={(p) => addPickPoint('scan', p)}
          onPaintChange={(count) => useMark.getState().setCount(count)}
        />
        <Half
          title="Reference"
          subtitle={nominalName}
          geometry={nominalGeometry}
          markers={nominalMarkers}
          active={waitingFor === 'nominal' && !selecting}
          onPick={(p) => addPickPoint('nominal', p)}
        />
      </div>

      <div className="splitbar">
        <div className="splitstep">
          <b>
            {selecting
              ? 'Selecting the surface to fit on — drag on the scan'
              : waitingFor === 'scan'
                ? `Click point ${pairs.length + 1} on the scan`
                : `Now click the same feature on the reference`}
          </b>
          <span>
            {selecting
              ? 'Left-drag selects, right-drag takes it back, Shift-drag still orbits · Pick points when you are done'
              : degenerate
                ? `${pairs.length} pairs, but they are nearly in a line — add one well away from it.`
                : enough
                  ? `${pairs.length} pairs — enough to align. More improves the starting guess.`
                  : `${pairs.length} of 3 pairs. Spread them out: three points in a line cannot fix a rotation.`}
          </span>
        </div>
        <div className="splitpins">
          {pairs.map((_, i) => (
            <span key={i} className="pinchip" style={{ background: pairColor(i) }}>
              {i + 1}
            </span>
          ))}
          {pendingScan && (
            <span className="pinchip half" style={{ borderColor: pairColor(pairs.length) }}>
              {pairs.length + 1}
            </span>
          )}
        </div>
        <div className="grow" />
        {alignMessage && alignStatus === 'failed' && (
          <span className="splitwarn">{alignMessage}</span>
        )}
        {solved && !degenerate && (
          <span className="splitfit">picked spread {solved.rms.toFixed(2)} mm</span>
        )}
        <button disabled={running || (!pairs.length && !pendingScan)} onClick={undoPair}>
          Undo
        </button>
        <button disabled={running || (!pairs.length && !pendingScan)} onClick={clearPairs}>
          Clear
        </button>
        <button data-test="split-cancel" disabled={running} onClick={onCancel}>
          Cancel
        </button>
        {running ? (
          <button
            className="primary"
            data-test="split-stop"
            disabled={alignStopping}
            onClick={onStop}
          >
            <span className="spinner" />
            {alignStopping ? 'Stopping…' : 'Stop'}
          </button>
        ) : (
          <button
            className="primary"
            data-test="split-align"
            disabled={!enough}
            onClick={onAlign}
          >
            Align from these points
          </button>
        )}
      </div>
    </div>
  )
}
