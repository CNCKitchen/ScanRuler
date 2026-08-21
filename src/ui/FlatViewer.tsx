// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState } from 'react'
import type { Vec2 } from '../core/flat/types'
import { FlatScene } from '../viewer/FlatScene'
import { schemeById } from '../viewer/navSchemes'
import { themeById } from '../viewer/viewThemes'
import { useStore } from '../state/store'

/** How much of the image the loupe shows (source pixels across its face) and
 *  how big its face is on screen. 30 px over 120 px is a fixed 4× — honest
 *  about the pixels, which at this magnification are the measurement. */
const LOUPE_SRC = 30
const LOUPE_SIZE = 120

/** The 2D Measure viewport, in the same thin-wrapper shape as Viewer:
 *  construct once, wire callbacks through refs so prop changes never
 *  re-create the scene. Mounted only while its workspace is up — unlike the
 *  3D viewport there is no expensive BVH to protect, and a dropped image
 *  redecodes in well under a second. */
export function FlatViewer({
  onReady,
  onPick,
  onPickDrag,
  onPickRemove,
  onNoteDrag,
  onNoteSelect,
  onRegion,
  onHover,
  loupe,
}: {
  /** The scene when it comes up, null when the viewport unmounts — so the
   *  owner never holds a disposed scene. */
  onReady: (scene: FlatScene | null) => void
  onPick: (p: Vec2, meta: { alt: boolean; unitsPerScreenPx: number }) => void
  /** A draft pin dragged to a new spot, by index. */
  onPickDrag: (index: number, p: Vec2, meta: { alt: boolean; unitsPerScreenPx: number }) => void
  /** A draft pin clicked in place — the pick is to be taken back. */
  onPickRemove: (index: number) => void
  /** A text note dragged to a new spot, and one clicked to open for typing. */
  onNoteDrag: (id: number, p: Vec2) => void
  onNoteSelect: (id: number) => void
  onRegion: (min: Vec2, max: Vec2) => void
  /** The cursor over the sheet (or off it) — the datum tool aims by it. */
  onHover?: (p: Vec2 | null) => void
  /** The magnifier over the cursor while a tool is placing points: what to
   *  magnify, how document units map back to image pixels, and whether a
   *  tool wants it at all. */
  loupe: {
    bitmap: () => ImageBitmap | null
    docPxPerUnit: () => { x: number; y: number }
    active: boolean
  }
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const loupeRef = useRef<HTMLCanvasElement>(null)
  const pickRef = useRef(onPick)
  pickRef.current = onPick
  const dragRef = useRef(onPickDrag)
  dragRef.current = onPickDrag
  const removeRef = useRef(onPickRemove)
  removeRef.current = onPickRemove
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
  const loupeOpts = useRef(loupe)
  loupeOpts.current = loupe

  const [webglError, setWebglError] = useState<string | null>(null)
  const sceneRef = useRef<FlatScene | null>(null)

  useEffect(() => {
    let scene: FlatScene
    try {
      scene = new FlatScene(
        containerRef.current!,
        themeById(useStore.getState().viewTheme),
      )
    } catch (e) {
      console.error(e)
      setWebglError(e instanceof Error ? e.message : String(e))
      return
    }
    scene.setNavScheme(schemeById(useStore.getState().navScheme))
    scene.onPick = (p, meta) => pickRef.current(p, meta)
    scene.onPickDrag = (i, p, meta) => dragRef.current(i, p, meta)
    scene.onPickRemove = (i) => removeRef.current(i)
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
      // same orientation as the sheet.
      ctx.save()
      ctx.translate(0, LOUPE_SIZE)
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
    readyRef.current(scene)
    return () => {
      sceneRef.current = null
      readyRef.current(null)
      scene.dispose()
    }
  }, [])

  // The scheme and theme dropdowns live in the status strip and serve every
  // viewport; this one follows them the same way the main view does.
  const navScheme = useStore((s) => s.navScheme)
  const viewTheme = useStore((s) => s.viewTheme)
  useEffect(() => {
    sceneRef.current?.setNavScheme(schemeById(navScheme))
  }, [navScheme])
  useEffect(() => {
    sceneRef.current?.setViewTheme(themeById(viewTheme))
  }, [viewTheme])
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
