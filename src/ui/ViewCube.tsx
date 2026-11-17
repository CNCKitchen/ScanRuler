// SPDX-License-Identifier: AGPL-3.0-only
// The controls of the view cube, laid over the corner of the canvas the
// cube is drawn in (viewer/viewCube.ts). Laid out as CAD's view cubes are:
// Home at the top left, a menu at the bottom right, an arrow by each side of
// a face looked at square-on that turns the next face round to the front,
// and two curved arrows at the top right that roll the view about the line
// of sight.
//
// The roll arrows are what a scan that came in tilted is stood upright with:
// a click rolls a quarter turn, a drag up or down rolls by as much as it
// goes, with the angle shown and Shift holding it to 5° steps, and a double
// click stands the part upright again. The cube itself is drawn on the
// canvas; this layer asks the scene what the pointer is on, so a click on a
// face, an edge or a corner turns to it and a drag on the cube orbits.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { useStore } from '../state/store'
import type { SceneManager } from '../viewer/SceneManager'
import type * as THREE from 'three'
import type { CubeRegion, OrbitStep } from '../viewer/viewCubeMath'
import { VIEW_CUBE_HALF } from '../viewer/viewCube'

/** How far a drag on a roll arrow rolls, per pixel — two pixels a degree,
 *  fine enough to square a part up by eye. */
const ROLL_DEG_PER_PX = 0.5
/** Pointer travel that makes a press a drag rather than a click. */
const DRAG_PX = 3
/** Two clicks on a roll arrow this close together are a double click. */
const DOUBLE_CLICK_MS = 350
/** How long the angle stays up after a click rolls the view. */
const READOUT_MS = 1200

const H = VIEW_CUBE_HALF
const toDeg = (r: number) => (r * 180) / Math.PI
const toRad = (d: number) => (d * Math.PI) / 180

/** Whether turns should land at once rather than swing: asked per turn, so
 *  a change of the setting takes without a reload. */
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
/** A turn's duration: the scene's own, or none with reduced motion. */
const turnMs = () => (reducedMotion() ? 0 : undefined)

/** An angle as the readout shows it: whole degrees, a true minus sign. */
function formatRoll(deg: number): string {
  const d = Math.round(deg)
  return `${d < 0 ? '−' : ''}${Math.abs(d)}°`
}

/** Points on the circle the roll arrows run round, in the SVG's units: the
 *  angle counter-clockwise from screen-right, as on paper. */
function onArc(r: number, deg: number): [number, number] {
  return [r * Math.cos(toRad(deg)), -r * Math.sin(toRad(deg))]
}

const ROLL_R = 1.98
const f3 = (n: number) => n.toFixed(3)

/** A curved arrow from `from` to `to` degrees round the cube, its head at
 *  `to`: a band, so it can be filled and outlined. */
function curvedArrow(from: number, to: number): string {
  const r = ROLL_R
  const w = 0.13
  const sweepOut = to > from ? 0 : 1
  const sweepIn = 1 - sweepOut
  const [ax, ay] = onArc(r + w, from)
  const [bx, by] = onArc(r + w, to)
  const [cx, cy] = onArc(r - w, to)
  const [dx, dy] = onArc(r - w, from)
  // The head: wider than the band, its point a little further round.
  const ahead = to > from ? 16 : -16
  const [hx1, hy1] = onArc(r + 2.4 * w, to)
  const [hx2, hy2] = onArc(r - 2.4 * w, to)
  const [px, py] = onArc(r, to + ahead)
  return [
    `M${f3(dx)} ${f3(dy)}`,
    `L${f3(ax)} ${f3(ay)}`,
    `A${r + w} ${r + w} 0 0 ${sweepOut} ${f3(bx)} ${f3(by)}`,
    `L${f3(hx1)} ${f3(hy1)}`,
    `L${f3(px)} ${f3(py)}`,
    `L${f3(hx2)} ${f3(hy2)}`,
    `L${f3(cx)} ${f3(cy)}`,
    `A${r - w} ${r - w} 0 0 ${sweepIn} ${f3(dx)} ${f3(dy)}`,
    'Z',
  ].join(' ')
}

/** The centre line of a curved arrow, head included: stroked wide and
 *  unseen, it is what the pointer hits — the drawn band alone is a few
 *  pixels across. */
function arrowSpine(from: number, to: number): string {
  const [ax, ay] = onArc(ROLL_R, from)
  const [bx, by] = onArc(ROLL_R, to + (to > from ? 12 : -12))
  return `M${f3(ax)} ${f3(ay)} A${ROLL_R} ${ROLL_R} 0 0 ${to > from ? 0 : 1} ${f3(bx)} ${f3(by)}`
}

const ORBIT_ARROWS: { step: OrbitStep; at: [number, number]; points: string; title: string }[] = [
  { step: 'up', at: [0, -1.36], points: '-0.24,0.1 0.24,0.1 0,-0.16', title: 'Turn to the face above' },
  { step: 'down', at: [0, 1.36], points: '-0.24,-0.1 0.24,-0.1 0,0.16', title: 'Turn to the face below' },
  { step: 'left', at: [-1.36, 0], points: '0.1,-0.24 0.1,0.24 -0.16,0', title: 'Turn to the face on the left' },
  { step: 'right', at: [1.36, 0], points: '-0.1,-0.24 -0.1,0.24 0.16,0', title: 'Turn to the face on the right' },
]

const ROLL_ARROWS = [
  { clockwise: false, from: 62, to: 102, label: 'Roll the view counter-clockwise', test: 'view-cube-roll-ccw' },
  { clockwise: true, from: 28, to: -12, label: 'Roll the view clockwise', test: 'view-cube-roll-cw' },
] as const

/** Enter or Space on a drawn button does what a click does. */
function onActivate(run: () => void) {
  return (e: ReactKeyboardEvent) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    run()
  }
}

type Drag =
  | { kind: 'cube'; id: number; x: number; y: number; x0: number; y0: number; region: CubeRegion | null; pivot: THREE.Vector3 | null }
  | { kind: 'roll'; id: number; y0: number; roll0: number; moved: boolean; clockwise: boolean }

export function ViewCube({ scene }: { scene: () => SceneManager | null }) {
  const projection = useStore((s) => s.projection)
  const setProjection = useStore((s) => s.setProjection)
  const [active, setActive] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [faceOn, setFaceOn] = useState(false)
  const [overCube, setOverCube] = useState(false)
  const [readout, setReadout] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const drag = useRef<Drag | null>(null)
  const lastRollClick = useRef<{ at: number; clockwise: boolean } | null>(null)
  const readoutTimer = useRef<number | undefined>(undefined)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuButtonRef = useRef<SVGGElement>(null)

  const shown = active || dragging || menuOpen

  // While the controls are up, keep up with the view: the orbit arrows are
  // offered only on a face looked at square-on, and the view may be turning
  // under the pointer — a click's swing, or the keyboard.
  useEffect(() => {
    if (!shown) return
    let frame = 0
    const poll = () => {
      const s = scene()
      if (s) setFaceOn(s.viewCubeFace() !== null)
      frame = requestAnimationFrame(poll)
    }
    poll()
    return () => cancelAnimationFrame(frame)
  }, [shown, scene])

  useEffect(() => () => window.clearTimeout(readoutTimer.current), [])

  // The menu takes the focus when it opens, and goes away on a press
  // anywhere else or Escape — handing the focus back to its button.
  useEffect(() => {
    if (!menuOpen) return
    menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const away = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setMenuOpen(false)
      menuButtonRef.current?.focus()
    }
    window.addEventListener('pointerdown', away, true)
    window.addEventListener('keydown', esc)
    return () => {
      window.removeEventListener('pointerdown', away, true)
      window.removeEventListener('keydown', esc)
    }
  }, [menuOpen])

  const showReadout = useCallback((text: string | null, linger: boolean) => {
    window.clearTimeout(readoutTimer.current)
    setReadout(text)
    if (linger && text !== null) readoutTimer.current = window.setTimeout(() => setReadout(null), READOUT_MS)
  }, [])

  /** Light what is under the pointer on the cube, or nothing. */
  const hover = (at: { clientX: number; clientY: number } | null) => {
    const region = scene()?.hoverViewCube(at ? { x: at.clientX, y: at.clientY } : null) ?? null
    setOverCube(region !== null)
  }

  const endDrag = () => {
    drag.current = null
    setDragging(false)
  }

  // ---- the cube: a click turns to what it lands on, a drag orbits ----

  const onCubeDown = (e: ReactPointerEvent<SVGRectElement>) => {
    if (e.button !== 0) return
    const s = scene()
    if (!s) return
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { kind: 'cube', id: e.pointerId, x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, region: s.viewCubeAt(e.clientX, e.clientY), pivot: null }
    setDragging(true)
  }

  const onCubeMove = (e: ReactPointerEvent<SVGRectElement>) => {
    const s = scene()
    if (!s) return
    const d = drag.current
    if (!d || d.kind !== 'cube' || d.id !== e.pointerId) {
      if (!d) hover(e)
      return
    }
    if (!d.pivot) {
      if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < DRAG_PX) return
      d.pivot = s.viewCubeDragPivot()
      hover(null)
    }
    s.viewCubeDrag(e.clientX - d.x, e.clientY - d.y, d.pivot)
    d.x = e.clientX
    d.y = e.clientY
  }

  const onCubeUp = (e: ReactPointerEvent<SVGRectElement>) => {
    const d = drag.current
    if (!d || d.kind !== 'cube' || d.id !== e.pointerId) return
    endDrag()
    const s = scene()
    if (!s) return
    if (!d.pivot && d.region) s.viewCubeTo(d.region, turnMs())
    hover(e)
  }

  // ---- the roll arrows: click a quarter turn, drag to dial, double-click upright ----

  const rollStep = (clockwise: boolean) => {
    const s = scene()
    if (!s) return
    s.rollBy(clockwise ? -Math.PI / 2 : Math.PI / 2, turnMs())
    showReadout(formatRoll(toDeg(s.screenRoll())), true)
  }

  const onRollDown = (clockwise: boolean) => (e: ReactPointerEvent<SVGPathElement>) => {
    if (e.button !== 0) return
    const s = scene()
    if (!s) return
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { kind: 'roll', id: e.pointerId, y0: e.clientY, roll0: toDeg(s.screenRoll()), moved: false, clockwise }
    setDragging(true)
  }

  const onRollMove = (e: ReactPointerEvent<SVGPathElement>) => {
    const d = drag.current
    const s = scene()
    if (!d || d.kind !== 'roll' || d.id !== e.pointerId || !s) return
    const dy = e.clientY - d.y0
    if (!d.moved && Math.abs(dy) < DRAG_PX) return
    d.moved = true
    // Down the screen turns the part clockwise, the way the clockwise arrow
    // runs down the cube's right side.
    const step = e.shiftKey ? 5 : 1
    const deg = Math.round((d.roll0 - dy * ROLL_DEG_PER_PX) / step) * step
    s.setScreenRoll(toRad(deg), 0)
    showReadout(formatRoll(toDeg(s.screenRoll())), false)
  }

  const onRollUp = (e: ReactPointerEvent<SVGPathElement>) => {
    const d = drag.current
    const s = scene()
    if (!d || d.kind !== 'roll' || d.id !== e.pointerId || !s) return
    endDrag()
    if (d.moved) {
      showReadout(formatRoll(toDeg(s.screenRoll())), true)
      return
    }
    const now = performance.now()
    const last = lastRollClick.current
    if (last && last.clockwise === d.clockwise && now - last.at < DOUBLE_CLICK_MS) {
      lastRollClick.current = null
      s.setScreenRoll(0, turnMs())
      showReadout(formatRoll(toDeg(s.screenRoll())), true)
    } else {
      lastRollClick.current = { at: now, clockwise: d.clockwise }
      rollStep(d.clockwise)
    }
  }

  /** A menu entry: do it, then put the menu away and the focus back. */
  const menuItem = (run: (s: SceneManager) => void) => () => {
    const s = scene()
    if (s) run(s)
    setMenuOpen(false)
    menuButtonRef.current?.focus()
  }

  /** Up and Down walk the menu's entries, round from either end. */
  const onMenuKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return
    e.preventDefault()
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
    const at = items.indexOf(document.activeElement as HTMLButtonElement)
    const next =
      e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
    items[next]?.focus()
  }

  return (
    <div
      className={`viewcube${shown ? ' viewcube-active' : ''}`}
      ref={rootRef}
      data-test="view-cube"
      onPointerEnter={() => setActive(true)}
      onPointerLeave={() => {
        if (drag.current) return
        setActive(false)
        hover(null)
      }}
      onPointerMove={(e) => {
        // Over a control, nothing on the cube is under the pointer.
        if (!drag.current && !(e.target as Element).classList?.contains('viewcube-hit')) hover(null)
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        setMenuOpen(true)
      }}
    >
      <svg viewBox={`${-H} ${-H} ${2 * H} ${2 * H}`} role="group" aria-label="View cube">
        <rect
          className="viewcube-hit"
          x={-H}
          y={-H}
          width={2 * H}
          height={2 * H}
          style={{ cursor: overCube ? 'pointer' : 'default' }}
          onPointerDown={onCubeDown}
          onPointerMove={onCubeMove}
          onPointerUp={onCubeUp}
          onPointerCancel={endDrag}
          onLostPointerCapture={() => {
            if (drag.current?.kind === 'cube') endDrag()
          }}
        />

        <g
          className="viewcube-button viewcube-corner"
          data-test="view-cube-home"
          transform={`translate(${-H + 0.42} ${-H + 0.42})`}
          role="button"
          tabIndex={0}
          aria-label="Home view"
          onClick={() => scene()?.goHome(turnMs())}
          onKeyDown={onActivate(() => scene()?.goHome(turnMs()))}
        >
          <title>Home — turn to the home view and fit the model</title>
          <rect x={-0.42} y={-0.42} width={0.84} height={0.84} className="viewcube-pad" />
          <path d="M-0.26 0.02 L0 -0.22 L0.26 0.02 L0.17 0.02 L0.17 0.24 L0.05 0.24 L0.05 0.09 L-0.05 0.09 L-0.05 0.24 L-0.17 0.24 L-0.17 0.02 Z" />
        </g>

        <g
          ref={menuButtonRef}
          className="viewcube-button viewcube-corner"
          data-test="view-cube-menu"
          transform={`translate(${H - 0.42} ${H - 0.42})`}
          role="button"
          tabIndex={0}
          aria-label="View options"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((o) => !o)}
          onKeyDown={onActivate(() => setMenuOpen((o) => !o))}
        >
          <title>View options</title>
          <rect x={-0.42} y={-0.42} width={0.84} height={0.84} className="viewcube-pad" />
          <path d="M-0.22 -0.18 L0.22 -0.18 L0.22 -0.1 L-0.22 -0.1 Z M-0.2 0 L0.2 0 L0 0.22 Z" />
        </g>

        {ORBIT_ARROWS.map((a) => (
          <g
            key={a.step}
            className={`viewcube-button viewcube-reveal${faceOn ? '' : ' viewcube-off'}`}
            data-test={faceOn ? `view-cube-orbit-${a.step}` : undefined}
            transform={`translate(${a.at[0]} ${a.at[1]})`}
            role="button"
            tabIndex={0}
            aria-label={a.title}
            onClick={() => scene()?.viewCubeOrbit(a.step, turnMs())}
            onKeyDown={onActivate(() => scene()?.viewCubeOrbit(a.step, turnMs()))}
          >
            <title>{a.title}</title>
            <circle r={0.36} className="viewcube-pad" />
            <polygon points={a.points} />
          </g>
        ))}

        {ROLL_ARROWS.map((a) => (
          <g
            key={a.test}
            className="viewcube-button viewcube-reveal viewcube-roll"
            data-test={a.test}
            role="button"
            tabIndex={0}
            aria-label={`${a.label} 90°`}
            onKeyDown={onActivate(() => rollStep(a.clockwise))}
            onPointerDown={onRollDown(a.clockwise)}
            onPointerMove={onRollMove}
            onPointerUp={onRollUp}
            onPointerCancel={endDrag}
          >
            <title>{`${a.label} 90° — drag up or down to roll by any angle (Shift: 5° steps), double-click to stand the part upright`}</title>
            <path className="viewcube-spine" d={arrowSpine(a.from, a.to)} />
            <path d={curvedArrow(a.from, a.to)} />
          </g>
        ))}
      </svg>

      {readout !== null && (
        <div className="viewcube-readout" data-test="view-cube-roll" role="status">
          {readout}
        </div>
      )}

      {menuOpen && (
        <div className="viewcube-popup" role="menu" aria-label="View options" ref={menuRef} onKeyDown={onMenuKey}>
          <button type="button" role="menuitem" onClick={menuItem((sc) => sc.goHome(turnMs()))}>
            Go home
          </button>
          <button type="button" role="menuitem" onClick={menuItem((sc) => sc.setHomeView())}>
            Set current view as home
          </button>
          <button type="button" role="menuitem" onClick={menuItem((sc) => sc.resetHomeView())}>
            Reset home
          </button>
          <button type="button" role="menuitem" onClick={menuItem((sc) => sc.setScreenRoll(0, turnMs()))}>
            Stand upright
          </button>
          <hr />
          {(['orthographic', 'perspective'] as const).map((p) => (
            <button key={p} type="button" role="menuitemradio" aria-checked={projection === p} onClick={menuItem(() => setProjection(p))}>
              <svg className="viewcube-check" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <path d="M3.5 8.5l3 3 6-7" />
              </svg>
              {p === 'orthographic' ? 'Orthographic' : 'Perspective'}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
