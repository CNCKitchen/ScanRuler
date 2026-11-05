// SPDX-License-Identifier: AGPL-3.0-only
// The 2D Measure viewport and what it is wired to: the settings the sheet
// view follows as the main view does, and the loupe over the cursor, which
// shows the image's own pixels, turned and mirrored as the sheet is,
// because at that magnification the pixels are the measurement.

import { useEffect, useRef, useState, type RefObject } from 'react'
import type { SheetPose } from '../core/flat/datum'
import type { Vec2 } from '../core/flat/types'
import type { HandleEnd } from '../state/flatStore'
import { FlatScene } from '../viewer/FlatScene'
import { schemeById } from '../viewer/navSchemes'
import { sceneTheme } from '../viewer/viewThemes'
import { usePrefs } from '../state/prefsStore'
import { useStore } from '../state/store'

/** How much of the image the loupe shows (source pixels across its face) and
 *  how big its face is on screen. 30 px over 120 px is a fixed 4× — honest
 *  about the pixels, which at this magnification are the measurement. */
const LOUPE_SRC = 30
const LOUPE_SIZE = 120

/** A sheet view following the settings dialog as the main view does: the
 *  navigation scheme, the theme with the dark mode, and the two line
 *  widths. */
export function useFlatSceneSettings(sceneRef: RefObject<FlatScene | null>): void {
  const navScheme = useStore((s) => s.navScheme)
  const viewTheme = useStore((s) => s.viewTheme)
  useEffect(() => {
    sceneRef.current?.setNavScheme(schemeById(navScheme))
  }, [navScheme])
  const dark = usePrefs((s) => s.dark)
  useEffect(() => {
    sceneRef.current?.setViewTheme(sceneTheme(viewTheme, dark))
  }, [viewTheme, dark])
  const sheetLines = usePrefs((s) => s.sheetLines)
  useEffect(() => {
    sceneRef.current?.setLineWidth(sheetLines)
  }, [sheetLines])
  const edgeLines = usePrefs((s) => s.edgeLines)
  useEffect(() => {
    sceneRef.current?.setEdgeWidth(edgeLines)
  }, [edgeLines])
}

/** The 2D Measure viewport, in the same thin-wrapper shape as Viewer:
 *  construct once, wire callbacks through refs so prop changes never
 *  re-create the scene. Mounted when its workspace is first opened and kept
 *  from then on: there is no BVH to protect here, but a new viewport is a new
 *  WebGL context, and the tab is one people switch back and forth with. While
 *  its workspace is not up it is paused and out of the layout. */
export function FlatViewer({
  active,
  onReady,
  onResync,
  onPick,
  onPickDrag,
  onPinClick,
  onHandleDrag,
  onHandleReset,
  onNoteDrag,
  onNoteSelect,
  onRegion,
  onHover,
  loupe,
}: {
  /** Whether the workspace is on screen. False pauses the scene; the owner
   *  hides the viewport's slot. */
  active: boolean
  /** The scene when it comes up, null when the viewport unmounts — so the
   *  owner never holds a disposed scene. */
  onReady: (scene: FlatScene | null) => void
  /** The scene is shown again after being kept: lay the sheet out on it once
   *  more, as onReady did when it was new. */
  onResync: (scene: FlatScene) => void
  onPick: (p: Vec2, meta: { alt: boolean; unitsPerScreenPx: number }) => void
  /** A draft pin dragged to a new spot, by index. */
  onPickDrag: (index: number, p: Vec2, meta: { alt: boolean; unitsPerScreenPx: number }) => void
  /** A draft pin clicked in place — the pick taken back, or a spline closed
   *  on its first point; the store decides. */
  onPinClick: (index: number) => void
  /** One end of a spline draft's tangent handle dragged to a spot. */
  onHandleDrag: (index: number, end: HandleEnd, p: Vec2, meta: { alt: boolean; unitsPerScreenPx: number }) => void
  /** A handle clicked in place — the tangent there goes automatic again. */
  onHandleReset: (index: number) => void
  /** A text note dragged to a new spot, and one clicked to open for typing. */
  onNoteDrag: (id: number, p: Vec2) => void
  onNoteSelect: (id: number) => void
  onRegion: (min: Vec2, max: Vec2) => void
  /** The cursor over the sheet (or off it) — the alignment tool aims by it. */
  onHover?: (p: Vec2 | null) => void
  /** The magnifier over the cursor while a tool is placing points: what to
   *  magnify, how document units map back to image pixels, how the sheet is
   *  shown (the alignment, the mirror and the quarter turns together; the
   *  loupe turns and flips with it), and whether a tool wants it at all. */
  loupe: {
    bitmap: () => ImageBitmap | null
    docPxPerUnit: () => { x: number; y: number }
    pose: () => SheetPose
    active: boolean
  }
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const loupeRef = useRef<HTMLCanvasElement>(null)
  const pickRef = useRef(onPick)
  pickRef.current = onPick
  const dragRef = useRef(onPickDrag)
  dragRef.current = onPickDrag
  const pinClickRef = useRef(onPinClick)
  pinClickRef.current = onPinClick
  const handleDragRef = useRef(onHandleDrag)
  handleDragRef.current = onHandleDrag
  const handleResetRef = useRef(onHandleReset)
  handleResetRef.current = onHandleReset
  const noteDragRef = useRef(onNoteDrag)
  noteDragRef.current = onNoteDrag
  const noteSelectRef = useRef(onNoteSelect)
  noteSelectRef.current = onNoteSelect
  const regionRef = useRef(onRegion)
  regionRef.current = onRegion
  const hoverRef = useRef(onHover)
  hoverRef.current = onHover
  const readyRef = useRef(onReady)
  readyRef.current = onReady
  const resyncRef = useRef(onResync)
  resyncRef.current = onResync
  const activeRef = useRef(active)
  activeRef.current = active
  /** The state the scene was last put in, so that only a change is acted on. */
  const wasActive = useRef(active)
  const loupeOpts = useRef(loupe)
  loupeOpts.current = loupe

  const [webglError, setWebglError] = useState<string | null>(null)
  const sceneRef = useRef<FlatScene | null>(null)

  useEffect(() => {
    let scene: FlatScene
    try {
      scene = new FlatScene(
        containerRef.current!,
        sceneTheme(useStore.getState().viewTheme, usePrefs.getState().dark),
      )
      scene.setLineWidth(usePrefs.getState().sheetLines)
      scene.setEdgeWidth(usePrefs.getState().edgeLines)
    } catch (e) {
      console.error(e)
      setWebglError(e instanceof Error ? e.message : String(e))
      return
    }
    scene.setNavScheme(schemeById(useStore.getState().navScheme))
    scene.onPick = (p, meta) => pickRef.current(p, meta)
    scene.onPickDrag = (i, p, meta) => dragRef.current(i, p, meta)
    scene.onPinClick = (i) => pinClickRef.current(i)
    scene.onHandleDrag = (i, end, p, meta) => handleDragRef.current(i, end, p, meta)
    scene.onHandleReset = (i) => handleResetRef.current(i)
    scene.onNoteDrag = (id, p) => noteDragRef.current(id, p)
    scene.onNoteSelect = (id) => noteSelectRef.current(id)
    scene.onRegion = (min, max) => regionRef.current(min, max)
    // The loupe follows the cursor over the sheet, magnifying the pixels
    // around it with a crosshair on the exact spot a click would measure.
    scene.onHoverPoint = (p, clientX, clientY) => {
      hoverRef.current?.(p)
      const canvas = loupeRef.current
      const opts = loupeOpts.current
      const bitmap = opts.bitmap()
      if (!canvas) return
      if (!p || !opts.active || !bitmap) {
        canvas.style.display = 'none'
        return
      }
      const rect = containerRef.current!.getBoundingClientRect()
      canvas.style.display = 'block'
      canvas.style.left = `${clientX - rect.x + 18}px`
      canvas.style.top = `${clientY - rect.y + 18}px`
      const per = opts.docPxPerUnit()
      const cx = p[0] * per.x
      const cy = p[1] * per.y
      const ctx = canvas.getContext('2d')!
      ctx.imageSmoothingEnabled = false
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, LOUPE_SIZE, LOUPE_SIZE)
      // The bitmap was decoded flipped (document y up); drawing it back to a
      // y-down canvas flips once more, which is what puts the loupe in the
      // same orientation as the sheet — mirrored across the document's X
      // axis if the sheet is shown so, then rolled about its centre by as
      // much as the sheet is shown rolled, the order the pose is defined
      // in, so what is under the cursor looks the same in the glass as on
      // the stage. (A positive canvas rotation is clockwise on screen; the
      // roll counts counter-clockwise.)
      const pose = opts.pose()
      ctx.save()
      ctx.translate(LOUPE_SIZE / 2, LOUPE_SIZE / 2)
      ctx.rotate(-pose.roll)
      if (pose.mirror) ctx.scale(1, -1)
      ctx.translate(-LOUPE_SIZE / 2, LOUPE_SIZE / 2)
      ctx.scale(1, -1)
      ctx.drawImage(
        bitmap,
        cx - LOUPE_SRC / 2,
        cy - LOUPE_SRC / 2,
        LOUPE_SRC,
        LOUPE_SRC,
        0,
        0,
        LOUPE_SIZE,
        LOUPE_SIZE,
      )
      ctx.restore()
      ctx.strokeStyle = 'rgba(255, 176, 32, 0.9)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(LOUPE_SIZE / 2, 0)
      ctx.lineTo(LOUPE_SIZE / 2, LOUPE_SIZE)
      ctx.moveTo(0, LOUPE_SIZE / 2)
      ctx.lineTo(LOUPE_SIZE, LOUPE_SIZE / 2)
      ctx.stroke()
    }
    sceneRef.current = scene
    scene.setPaused(!activeRef.current)
    wasActive.current = activeRef.current
    readyRef.current(scene)
    return () => {
      sceneRef.current = null
      readyRef.current(null)
      scene.dispose()
    }
  }, [])

  // Shown again after being kept. The sheet and its layers were pushed as the
  // stores changed, hidden or not, but the sheet is framed as a fresh viewport
  // frames it, and a layer that was pushed against a collapsed layout is laid
  // again at the real size.
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene || wasActive.current === active) return
    wasActive.current = active
    scene.setPaused(!active)
    if (active) resyncRef.current(scene)
  }, [active])

  // The scheme and theme settings live in the settings dialog and serve every
  // viewport; this one follows them the same way the main view does.
  useFlatSceneSettings(sceneRef)
  // A tool going away must take the loupe with it, not wait for a mouse move.
  useEffect(() => {
    if (!loupe.active && loupeRef.current) loupeRef.current.style.display = 'none'
  }, [loupe.active])

  return (
    <div className="viewport" ref={containerRef}>
      <canvas
        ref={loupeRef}
        className="loupe"
        width={LOUPE_SIZE}
        height={LOUPE_SIZE}
        style={{ display: 'none' }}
      />
      {webglError !== null && (
        <div className="webgl-missing" role="alert">
          <b>The 2D view could not be started.</b>
          <p>
            This tool draws everything with WebGL, and your browser refused to create a WebGL
            context. Usually that means hardware acceleration is switched off or the graphics
            driver is blocklisted.
          </p>
          <p className="webgl-missing-detail">{webglError}</p>
        </div>
      )}
    </div>
  )
}
