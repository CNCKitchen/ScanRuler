// SPDX-License-Identifier: AGPL-3.0-only
import * as THREE from 'three'
import { Line2 } from 'three/addons/lines/Line2.js'
import { LineGeometry } from 'three/addons/lines/LineGeometry.js'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js'
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js'
import { gridSpacing, poseAxes, sheetPose } from '../core/flat/datum'
import type { EdgeChains } from '../core/flat/edges'
import { splineMidpoint, splinePolyline, type HandleEnd, type SplineHandle } from '../core/flat/spline'
import type { FlatFit, Vec2 } from '../core/flat/types'
import type { PixelsPerMm } from '../core/flat/image'
import { dimStrokes, type DimShape } from '../core/flat/dimStrokes'
import { EDGE_LINE_DEFAULT, SHEET_LINE_DEFAULT } from './lineWidths'
import type { ControlScheme } from './navSchemes'
import { OrthoViewport } from './orthoViewport'
import { pinLabel } from './overlays'
import type { ViewTheme } from './viewThemes'

/**
 * The 2D Measure workspace's viewport: the scanned sheet on the stage, face
 * on. The third consumer of the OrthoViewport chassis — same renderer, same
 * navigation buttons, same theming as every other view — with the navigator
 * flattened: orbit gestures pan, because a sheet has no third dimension to
 * turn into.
 *
 * The sheet lives in millimetres from the moment it is built: the image is a
 * plane of (pixels × mm-per-pixel) size with its bottom-left corner at the
 * origin, so a raycast hit IS the document coordinate and everything drawn on
 * top — points, fitted geometry, dimension labels — shares one frame. When
 * the calibration changes the sheet is rescaled, not rebuilt.
 */
/** An axis-aligned box in document units. */
type DocBox = { x0: number; y0: number; x1: number; y1: number }

/** A sketch dimension for setSketchDimensions: what it measures and where
 *  its number sits, the number as written, and the id its edits go under —
 *  without one the number is only shown, and a click goes through it to the
 *  sheet. */
export interface SketchDimensionItem {
  shape: DimShape
  value: string
  /** The number to type over, and the text the field opens with when the
   *  number is written as something other than itself. */
  edit?: { id: number; value: number; text?: string }
}

/** A selection box dragged over the sheet — see setBoxSelect. */
export interface SheetBox {
  /** The screen rectangle laid on the sheet: its corners in document
   *  units, in order round it — turned with the view when the view is. */
  corners: [Vec2, Vec2, Vec2, Vec2]
  /** Dragged leftward: a crossing box, which takes whatever it touches.
   *  Dragged rightward it is a window, which takes only what lies wholly
   *  inside it — as CAD reads a box. */
  crossing: boolean
  /** Ctrl or Shift held: what the box takes joins the selection. */
  additive: boolean
}

/** An arrowhead of a sketch dimension, screen pixels: slim, as a drawing's. */
const DIM_ARROW_PX = { length: 11, half: 2.6 }

/** How wide a dimension's number is written, screen pixels — the gap its
 *  dimension line leaves for it (12.5 px monospace digits, as its label is styled). */
const dimTextPx = (value: string) => value.length * 7.6

export class FlatScene {
  private viewport: OrthoViewport
  private material: THREE.MeshBasicMaterial
  private geometry = new THREE.PlaneGeometry(1, 1)
  private sheet: THREE.Mesh
  private texture: THREE.Texture | null = null
  /** Pixel size of the loaded image; zero while nothing is loaded. */
  private imagePx = { width: 0, height: 0 }
  private mmPerPx: PixelsPerMm = { x: 1, y: 1 }
  /** Where the sheet lies, in document units: an image from the origin up
   *  to its size in millimetres, a section around its cut. */
  private bounds = { x0: 0, y0: 0, x1: 0, y1: 0 }
  /** How the sheet is shown: the alignment's +X (document units) that runs
   *  to the right of the screen — null while the sheet lies as scanned —
   *  whether it is mirrored, and the quarter turns it is shown round on top
   *  of that, counter-clockwise. The camera rolls, and looks at the sheet
   *  from behind to mirror it; the sheet and everything drawn on it stay in
   *  document units, so a pick lands where it lands whichever way it is
   *  looked at. */
  private alignDir: Vec2 | null = null
  private mirror = false
  private turns = 0
  /** The calibration tool's picks, drawn over the sheet. */
  private calGroup = new THREE.Group()
  private calCleanup: (() => void)[] = []
  /** Tallies: every counted feature wears its running number. */
  private countGroup = new THREE.Group()
  private countCleanup: (() => void)[] = []
  /** Free text notes: DOM labels that, unlike every other label, take the
   *  pointer — a press on one drags it across the sheet. */
  private noteGroup = new THREE.Group()
  private noteCleanup: (() => void)[] = []
  /** The datum-aligned grid: its frame, and the spacing it was last drawn
   *  at — the tick watches the zoom and redraws when the 1-2-5 ladder says a
   *  different rung. */
  private gridGroup = new THREE.Group()
  private gridCleanup: (() => void)[] = []
  private gridFrame: { origin: Vec2; xDir: Vec2 } | null = null
  private gridSpacingDrawn = 0
  private gridExtentDrawn: DocBox | null = null
  /** Measured elements and the draft being built, in document units. */
  private elementGroup = new THREE.Group()
  /** Translucent fills — the closed regions of a sketch. */
  private fillGroup = new THREE.Group()
  private fillCleanup: (() => void)[] = []
  /** Round dots of a fixed size on screen — where a sketch's pieces end. */
  private dotGroup = new THREE.Group()
  private dotCleanup: (() => void)[] = []
  private dotTexture: THREE.Texture | null = null
  /** The cursor the sheet wears when nothing under the hand says otherwise
   *  — a crosshair while a drawing tool is armed. */
  private baseCursor = ''
  private sheetDragging: { moved: boolean } | null = null
  /** Something the owner would drag lies under the cursor — a sketch piece:
   *  the navigator steps aside for the press, as it does for a pin. */
  private dragHover = false
  private elementCleanup: (() => void)[] = []
  private dimensionGroup = new THREE.Group()
  private dimensionCleanup: (() => void)[] = []
  /** What opens each sketch dimension's number for typing, by its id. */
  private dimensionOpeners = new Map<number, { div: HTMLElement; open: () => void }>()
  /** A sketch's dimensions as they were last set — see setSketchDimensions:
   *  their lines and arrowheads are sized in screen pixels, so they are made
   *  again when the zoom moves off `px`. */
  private sketchDims: { items: readonly SketchDimensionItem[]; color: number; px: number } | null = null
  private dimStrokeGroup = new THREE.Group()
  private dimStrokeCleanup: (() => void)[] = []
  private draftGroup = new THREE.Group()
  private draftCleanup: (() => void)[] = []
  /** Fitted geometry and callouts draw as screen-space fat lines (a WebGL
   *  LineBasicMaterial is one pixel whatever it asks for). Every such
   *  material needs the canvas size; this is the one copy they all read.
   *  Each is kept with the width it has at the default setting, which the
   *  operator's line-width setting scales — see setLineWidth. */
  private lineResolution = new THREE.Vector2(1, 1)
  private lineMaterials = new Map<LineMaterial, number>()
  private lineScale = 1
  /** The draft's hand picks in document units, kept for hit-testing: a press
   *  on one of them starts a drag instead of a pan or a pick. */
  private draftPicks: Vec2[] = []
  private dragging: { index: number; moved: boolean } | null = null
  /** A spline draft's tangent handles, kept for hit-testing the same way: a
   *  press on either end drags that end, bending the curve at its pick. */
  private draftHandles: SplineHandle[] = []
  private handleDragging: { index: number; end: HandleEnd; moved: boolean } | null = null
  /** A pin or a handle is under the cursor: the plain left-drag is its, not
   *  the camera's. */
  private pinHover = false
  /** Detected edge chains. Geometry lives in image pixels; the group's scale
   *  is the px→mm map, so a recalibration is one scale write. */
  private edgeGroup = new THREE.Group()
  /** Fat lines like the curves, so they can be given a width at all — a
   *  WebGL LineSegments is one pixel whatever it asks for. Sized on their
   *  own rather than with the curves: they are what the curves were fitted
   *  to, and a hair under a heavy curve is how the two read apart. */
  private edgeSegments: LineSegments2 | null = null
  private edgeMaterial = new LineMaterial({
    color: 0x11b5a5,
    linewidth: EDGE_LINE_DEFAULT,
    transparent: true,
    opacity: 0.85,
    depthTest: false,
    worldUnits: false,
  })

  /** A click on the sheet, in document millimetres — with whether Alt was
   *  held (a raw, unsnapped pick in the 2D workspace) or Ctrl (the same in
   *  the sketch, as Fusion has it) and the scale of the moment, so the
   *  caller can turn "a few screen pixels" into document units. */
  onPick: ((p: Vec2, meta: { alt: boolean; shift?: boolean; ctrl?: boolean; unitsPerScreenPx: number }) => void) | null = null
  /** A dragged region (document units), while region mode is armed. */
  onRegion: ((min: Vec2, max: Vec2) => void) | null = null
  /** A selection box being dragged, while box selection is on: at every
   *  move, so what it would take can be lit, and null once it is let go or
   *  dropped. */
  onBoxDrag: ((box: SheetBox | null) => void) | null = null
  /** A selection box let go — what it takes is the owner's to work out. */
  onBoxSelect: ((box: SheetBox) => void) | null = null
  /** The cursor over the sheet (document units) or off it — for the loupe,
   *  and for a sketch tool's rubber band; `alt` and `ctrl` say whether the
   *  modifier is held — the 2D workspace's and the sketch's way,
   *  respectively, of asking for no snapping. */
  onHoverPoint: ((p: Vec2 | null, clientX: number, clientY: number, alt?: boolean, ctrl?: boolean) => void) | null = null
  /** A press on the bare sheet that the owner may take for a drag of its
   *  own — a sketch piece under the hand. Returning true starts the drag:
   *  every move then comes through onSheetDrag and the release through
   *  onSheetDragEnd, while a press let go where it landed is a plain click,
   *  reported through onPick. Returning false leaves the press to the
   *  navigator. */
  onSheetDown: ((p: Vec2, meta: { alt: boolean; ctrl: boolean; unitsPerScreenPx: number }) => boolean) | null = null
  onSheetDrag: ((p: Vec2, meta: { alt: boolean; ctrl: boolean; unitsPerScreenPx: number }) => void) | null = null
  onSheetDragEnd: ((meta: { alt: boolean; ctrl: boolean; unitsPerScreenPx: number }) => void) | null = null
  /** A draft pick being dragged to a new place on the sheet, by index. */
  onPickDrag: ((index: number, p: Vec2, meta: { alt: boolean; unitsPerScreenPx: number }) => void) | null = null
  /** A draft pin clicked without being dragged — the store decides what that
   *  means: the pick taken back, or a spline closed on its first point. */
  onPinClick: ((index: number) => void) | null = null
  /** One end of a spline draft's tangent handle dragged to a new spot. */
  onHandleDrag:
    | ((index: number, end: HandleEnd, p: Vec2, meta: { alt: boolean; unitsPerScreenPx: number }) => void)
    | null = null
  /** A handle clicked without being dragged — the tangent goes automatic. */
  onHandleReset: ((index: number) => void) | null = null
  /** A text note dragged to a new spot on the sheet (document units). */
  onNoteDrag: ((id: number, p: Vec2) => void) | null = null
  /** A text note clicked without being dragged — to open it for typing. */
  onNoteSelect: ((id: number) => void) | null = null
  /** The text typed into a dimension's label on the sheet — see
   *  setFlatDimensions' `edit`; the owner reads it as a number, or as
   *  whatever its numbers are written as. */
  onDimensionEdit: ((id: number, text: string) => void) | null = null
  /** A sketch dimension's number dragged to a sheet point; `begin` on the
   *  first step of the drag. */
  onDimensionMove: ((id: number, p: Vec2, begin: boolean) => void) | null = null
  /** The cursor onto a note's label, by the note's id, and off it (null) —
   *  for what the note stands for to be lit while it is pointed at. */
  onNoteHover: ((id: number | null) => void) | null = null
  /** The same for a dimension's number that can be typed into. */
  onDimensionHover: ((id: number | null) => void) | null = null
  /** The note and the dimension under the cursor — said off again when
   *  their labels are made anew under it, which no pointer event says. */
  private hoveredNote: number | null = null
  private hoveredDimension: number | null = null

  /** Left-drag selects a region (and a plain click picks a whole edge)
   *  instead of panning while an edge tool is collecting. */
  private regionMode = false
  private bandStart: { x: number; y: number } | null = null
  private bandDiv: HTMLDivElement | null = null
  /** Left-drag on the bare sheet draws a selection box instead of panning
   *  — see setBoxSelect — and the box in hand, if one is. */
  private boxSelect = false
  private box: { end: () => void } | null = null

  /** The view moved — a pan, a zoom, a framing, a resize: what is under the
   *  screen centre now, in document units, and the units per screen pixel.
   *  What a viewport laid under this one follows. */
  onViewChange: ((centre: Vec2, unitsPerScreenPx: number) => void) | null = null
  private viewKey = ''

  constructor(
    private container: HTMLDivElement,
    theme: ViewTheme,
    opts: {
      /** No stage of its own: a see-through canvas laid over another view. */
      transparent?: boolean
    } = {},
  ) {
    this.viewport = new OrthoViewport(container, {
      theme,
      transparent: opts.transparent,
      navTargets: () => (this.sheet.visible ? [this.sheet] : []),
      onClick: (x, y, e) => {
        const p = this.pick(x, y)
        if (p) {
          this.onPick?.(p, {
            alt: e?.altKey ?? false,
            shift: e?.shiftKey ?? false,
            ctrl: e?.ctrlKey ?? false,
            unitsPerScreenPx: this.unitsPerScreenPx(),
          })
        }
      },
      onPointerDown: (e) => {
        if (e.button !== 0 || !this.sheet.visible) return false
        // A handle end is the smaller target and drawn over the pins: it
        // gets first claim on a press.
        const handle = this.handleAt(e.clientX, e.clientY)
        if (handle) {
          this.beginHandleDrag(handle.index, handle.end, e)
          return true
        }
        const pin = this.pinAt(e.clientX, e.clientY)
        if (pin >= 0) {
          this.beginPinDrag(pin, e)
          return true
        }
        // Ctrl is the sketch's "no snapping" and has to be able to start a
        // drag; Shift and Meta are left to the navigator's chords.
        if (this.onSheetDown && !e.shiftKey && !e.metaKey) {
          const p = this.pick(e.clientX, e.clientY)
          if (p && this.onSheetDown(p, { alt: e.altKey, ctrl: e.ctrlKey, unitsPerScreenPx: this.unitsPerScreenPx() })) {
            this.beginSheetDrag(e)
            return true
          }
        }
        if (this.regionMode) {
          this.beginBand(e)
          return true
        }
        // A chord the user's scheme still gives the camera — Ctrl+left in
        // Tinkercad's — stays the camera's.
        if (this.boxSelect && !e.metaKey && !this.viewport.nav.navigates(e)) {
          this.beginBox(e)
          return true
        }
        return false
      },
      // A second finger is the navigator's: a box the first began is dropped.
      onMultiTouch: () => this.dropBox(),
      onTick: () => {
        // Zoom walked the grid onto a different rung of its spacing ladder,
        // or a pan carried the view off the patch a bare sheet's grid was
        // ruled over.
        if (this.gridFrame && this.gridStale()) this.rebuildGrid()
        if (this.sketchDims && Math.abs(this.unitsPerScreenPx() / this.sketchDims.px - 1) > 0.01) this.rebuildDimStrokes()
        // Fat lines are sized in screen pixels and need to know the canvas.
        const el = this.viewport.renderer.domElement
        const w = el.clientWidth || 1
        const h = el.clientHeight || 1
        if (this.lineResolution.x !== w || this.lineResolution.y !== h) {
          this.lineResolution.set(w, h)
          for (const m of this.lineMaterials.keys()) m.resolution.copy(this.lineResolution)
          this.edgeMaterial.resolution.copy(this.lineResolution)
          this.viewport.invalidate()
        }
        if (this.onViewChange) {
          const cam = this.viewport.camera
          const key = `${cam.position.x},${cam.position.y},${cam.zoom},${w},${h}`
          if (key !== this.viewKey) {
            this.viewKey = key
            const v = this.sheetView()
            this.onViewChange(v.centre, v.unitsPerScreenPx)
          }
        }
      },
    })
    this.container.addEventListener('pointermove', this.hoverMove)
    this.viewport.nav.setPlanar(true)

    // Unlit: the scan is a document, not a body — the lights must not shade it.
    this.material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })
    this.sheet = new THREE.Mesh(this.geometry, this.material)
    this.sheet.visible = false
    this.viewport.scene.add(this.sheet)
    this.viewport.scene.add(this.gridGroup)
    this.viewport.scene.add(this.calGroup)
    this.viewport.scene.add(this.countGroup)
    this.viewport.scene.add(this.noteGroup)
    this.viewport.scene.add(this.edgeGroup)
    this.viewport.scene.add(this.fillGroup)
    this.viewport.scene.add(this.elementGroup)
    this.viewport.scene.add(this.dotGroup)
    this.viewport.scene.add(this.dimensionGroup)
    this.viewport.scene.add(this.dimStrokeGroup)
    this.viewport.scene.add(this.draftGroup)
  }

  /** The measured dimensions on the sheet: a callout line with its value for
   *  a distance, two rays and a swept arc for an angle. A title of '' leaves
   *  the label the bare value. An item with `edit` is a number to type over:
   *  a click on its label opens a field there, and Enter (or leaving the
   *  field) hands the text typed to onDimensionEdit under the item's id;
   *  the field opens with `text` when given, else with the value.
   *  `style` is for a sheet whose stage is not paper — the sketch's, laid
   *  over the part: the colour of the callout lines and a class for the
   *  labels. */
  setFlatDimensions(
    items: readonly {
      title: string
      value: string
      segment?: [Vec2, Vec2]
      arc?: { vertex: Vec2; dirA: Vec2; dirB: Vec2 }
      edit?: { id: number; value: number; text?: string }
    }[],
    style: { color?: number; className?: string } = {},
  ): void {
    this.clearDimensions()
    const callout = style.color ?? 0x666e79
    for (const item of items) {
      if (item.segment) {
        this.addPolylines(this.dimensionGroup, this.dimensionCleanup, [item.segment], callout, 0.85, 0.16, 2.5)
        this.addDimLabel(
          [(item.segment[0][0] + item.segment[1][0]) / 2, (item.segment[0][1] + item.segment[1][1]) / 2],
          item.title,
          item.value,
          style.className,
          item.edit,
        )
      } else if (item.arc) {
        const R = this.sheetDiag() * 0.05
        const { vertex, dirA, dirB } = item.arc
        const rays: Vec2[][] = [
          [vertex, [vertex[0] + dirA[0] * R, vertex[1] + dirA[1] * R]],
          [vertex, [vertex[0] + dirB[0] * R, vertex[1] + dirB[1] * R]],
        ]
        // Sweep A onto B the short way round for the drawn arc.
        const a0 = Math.atan2(dirA[1], dirA[0])
        let sweep = Math.atan2(dirB[1], dirB[0]) - a0
        while (sweep > Math.PI) sweep -= 2 * Math.PI
        while (sweep < -Math.PI) sweep += 2 * Math.PI
        const steps = Math.max(8, Math.ceil(Math.abs(sweep) / 0.12))
        const arcPts: Vec2[] = []
        for (let i = 0; i <= steps; i++) {
          const a = a0 + (sweep * i) / steps
          arcPts.push([vertex[0] + Math.cos(a) * R * 0.72, vertex[1] + Math.sin(a) * R * 0.72])
        }
        rays.push(arcPts)
        this.addPolylines(this.dimensionGroup, this.dimensionCleanup, rays, callout, 0.85, 0.16, 2.5)
        const mid = a0 + sweep / 2
        this.addDimLabel(
          [vertex[0] + Math.cos(mid) * R * 0.95, vertex[1] + Math.sin(mid) * R * 0.95],
          item.title,
          item.value,
          style.className,
          item.edit,
        )
      }
    }
    this.viewport.invalidate()
  }

  private clearDimensions(): void {
    if (this.hoveredDimension !== null) {
      this.hoveredDimension = null
      this.onDimensionHover?.(null)
    }
    for (const dispose of this.dimensionCleanup) dispose()
    this.dimensionCleanup = []
    this.dimensionOpeners.clear()
    this.dimensionGroup.clear()
    this.sketchDims = null
    this.clearDimStrokes()
  }

  private clearDimStrokes(): void {
    for (const dispose of this.dimStrokeCleanup) dispose()
    this.dimStrokeCleanup = []
    this.dimStrokeGroup.clear()
  }

  /** A sketch's dimensions, drawn as a drawing carries them — extension
   *  lines, a dimension line with filled arrowheads, the number written
   *  along it (core/re/dimLayout). A click on a number opens it for typing
   *  (onDimensionEdit); a drag moves it (onDimensionMove). */
  setSketchDimensions(items: readonly SketchDimensionItem[], style: { color?: number; className?: string } = {}): void {
    this.clearDimensions()
    const px = this.unitsPerScreenPx()
    this.sketchDims = { items, color: style.color ?? 0x666e79, px }
    for (const item of items) {
      const s = dimStrokes(item.shape, px, dimTextPx(item.value))
      this.addDimLabel(s.text, '', item.value, style.className, item.edit, s.textAngle)
    }
    this.rebuildDimStrokes()
  }

  /** Open a sketch dimension's number for typing, as a click on it does —
   *  once its label is on the page, which the next frame sees to. */
  openDimension(id: number): void {
    let frames = 0
    const tryOpen = () => {
      // Asked again each frame: the labels may have been made anew since.
      const target = this.dimensionOpeners.get(id)
      if (!target) return
      if (target.div.isConnected) target.open()
      else if (++frames < 10) requestAnimationFrame(tryOpen)
    }
    tryOpen()
  }

  private rebuildDimStrokes(): void {
    this.clearDimStrokes()
    const dims = this.sketchDims
    if (!dims) return
    dims.px = this.unitsPerScreenPx()
    const lines: Vec2[][] = []
    const corners: number[] = []
    for (const item of dims.items) {
      const s = dimStrokes(item.shape, dims.px, dimTextPx(item.value))
      lines.push(...s.lines)
      for (const { tip, dir } of s.arrows) {
        const l = DIM_ARROW_PX.length * dims.px
        const w = DIM_ARROW_PX.half * dims.px
        const bx = tip[0] - dir[0] * l
        const by = tip[1] - dir[1] * l
        corners.push(tip[0], tip[1], 0.16, bx - dir[1] * w, by + dir[0] * w, 0.16, bx + dir[1] * w, by - dir[0] * w, 0.16)
      }
    }
    this.addPolylines(this.dimStrokeGroup, this.dimStrokeCleanup, lines, dims.color, 0.9, 0.16, 1.5)
    if (corners.length > 0) {
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.Float32BufferAttribute(corners, 3))
      const mat = new THREE.MeshBasicMaterial({ color: dims.color, side: THREE.DoubleSide, transparent: true, opacity: 0.9, depthTest: false })
      const heads = new THREE.Mesh(geo, mat)
      heads.renderOrder = 4
      this.dimStrokeGroup.add(heads)
      this.dimStrokeCleanup.push(() => {
        geo.dispose()
        mat.dispose()
      })
    }
    this.viewport.invalidate()
  }

  private addDimLabel(at: Vec2, title: string, value: string, className?: string, edit?: { id: number; value: number; text?: string }, turn?: number): void {
    const div = document.createElement('div')
    div.className = 'viewport-label distance-label' + (className ? ` ${className}` : '')
    if (title !== '') {
      const t = document.createElement('div')
      t.className = 'label-title'
      t.textContent = title
      div.append(t)
    }
    const v = document.createElement('div')
    v.className = 'label-value'
    v.textContent = value
    // Written along its dimension line. The label itself is placed by the
    // label renderer's transform, so the turn goes on the number inside.
    if (turn !== undefined && Math.abs(turn) > 1e-6) v.style.transform = `rotate(${(-turn * 180) / Math.PI}deg)`
    div.append(v)
    if (edit) {
      // The label layer takes no pointer events, so a label that is typed
      // into asks for them itself — and keeps them from the navigator under
      // it, which would take the press for a pan.
      div.classList.add('editable')
      div.dataset.test = `flat-dimension-${edit.id}`
      const stop = (e: Event) => e.stopPropagation()
      div.addEventListener('wheel', stop)
      div.addEventListener('pointerenter', () => {
        this.hoveredDimension = edit.id
        this.onDimensionHover?.(edit.id)
      })
      div.addEventListener('pointerleave', () => {
        if (this.hoveredDimension !== edit.id) return
        this.hoveredDimension = null
        this.onDimensionHover?.(null)
      })
      const open = () => {
        if (div.querySelector('input')) return
        const shown = edit.text ?? String(Math.round(edit.value * 1000) / 1000)
        const input = document.createElement('input')
        input.type = 'text'
        input.inputMode = 'decimal'
        input.spellcheck = false
        input.value = shown
        let done = false
        const close = (commit: boolean) => {
          if (done) return
          done = true
          const typed = input.value.trim()
          input.replaceWith(v)
          if (commit && typed !== '' && typed !== shown) this.onDimensionEdit?.(edit.id, typed)
        }
        input.addEventListener('keydown', (ev) => {
          ev.stopPropagation()
          if (ev.key === 'Enter') close(true)
          else if (ev.key === 'Escape') close(false)
        })
        input.addEventListener('blur', () => close(true))
        v.replaceWith(input)
        input.focus()
        input.select()
      }
      if (turn === undefined) {
        div.addEventListener('pointerdown', stop)
        div.addEventListener('pointerup', stop)
        div.addEventListener('click', (e) => {
          e.stopPropagation()
          open()
        })
      } else {
        // A sketch's number: a press that moves is a drag of the number, one
        // that does not is the click that opens it. The label is made again
        // under the hand at every step, so the drag listens on the document.
        div.addEventListener('click', stop)
        div.addEventListener('pointerdown', (e) => {
          e.stopPropagation()
          if (e.button !== 0 || e.target instanceof HTMLInputElement) return
          e.preventDefault()
          if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
          const start = { x: e.clientX, y: e.clientY }
          let moved = false
          const move = (ev: PointerEvent) => {
            if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 4) return
            const p = this.pick(ev.clientX, ev.clientY)
            if (!p) return
            this.onDimensionMove?.(edit.id, p, !moved)
            moved = true
          }
          const up = () => {
            document.removeEventListener('pointermove', move)
            document.removeEventListener('pointerup', up)
            document.removeEventListener('pointercancel', up)
            if (!moved) open()
          }
          document.addEventListener('pointermove', move)
          document.addEventListener('pointerup', up)
          document.addEventListener('pointercancel', up)
        })
        this.dimensionOpeners.set(edit.id, { div, open })
      }
    }
    const label = new CSS2DObject(div)
    label.position.set(at[0], at[1], 0.2)
    this.dimensionGroup.add(label)
    this.dimensionCleanup.push(() => div.remove())
  }

  /** Show a datum-aligned millimetre grid over the sheet — or none. The
   *  frame is in document units; spacing follows the zoom by itself. */
  setGrid(frame: { origin: Vec2; xDir: Vec2 } | null): void {
    this.gridFrame = frame
    this.rebuildGrid()
  }

  private rebuildGrid(): void {
    for (const dispose of this.gridCleanup) dispose()
    this.gridCleanup = []
    this.gridGroup.clear()
    this.gridSpacingDrawn = 0
    this.gridExtentDrawn = null
    const frame = this.gridFrame
    if (!frame || !this.sheet.visible) {
      this.viewport.invalidate()
      return
    }
    const s = gridSpacing(this.unitsPerScreenPx())
    this.gridSpacingDrawn = s

    // The corners of the ruled patch, in frame coordinates, bound what needs
    // lines.
    const extent = this.gridExtent()
    this.gridExtentDrawn = extent
    const { x0, y0, x1, y1 } = extent
    const [c, si] = frame.xDir
    const toFrame = (x: number, y: number): Vec2 => {
      const rx = x - frame.origin[0]
      const ry = y - frame.origin[1]
      return [rx * c + ry * si, -rx * si + ry * c]
    }
    const corners = [toFrame(x0, y0), toFrame(x1, y0), toFrame(x0, y1), toFrame(x1, y1)]
    const uMin = Math.min(...corners.map((p) => p[0]))
    const uMax = Math.max(...corners.map((p) => p[0]))
    const vMin = Math.min(...corners.map((p) => p[1]))
    const vMax = Math.max(...corners.map((p) => p[1]))
    const toDoc = (u: number, v: number): THREE.Vector3 =>
      new THREE.Vector3(
        frame.origin[0] + u * c - v * si,
        frame.origin[1] + u * si + v * c,
        0.03,
      )

    const minor: THREE.Vector3[] = []
    const axes: THREE.Vector3[] = []
    for (let u = Math.ceil(uMin / s) * s; u <= uMax; u += s) {
      ;(Math.abs(u) < s / 2 ? axes : minor).push(toDoc(u, vMin), toDoc(u, vMax))
    }
    for (let v = Math.ceil(vMin / s) * s; v <= vMax; v += s) {
      ;(Math.abs(v) < s / 2 ? axes : minor).push(toDoc(uMin, v), toDoc(uMax, v))
    }
    const addLines = (points: THREE.Vector3[], color: number, opacity: number) => {
      if (points.length === 0) return
      const geo = new THREE.BufferGeometry().setFromPoints(points)
      const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: false })
      const lines = new THREE.LineSegments(geo, mat)
      lines.renderOrder = 1
      this.gridGroup.add(lines)
      this.gridCleanup.push(() => {
        geo.dispose()
        mat.dispose()
      })
    }
    addLines(minor, 0x8891a0, 0.3)
    // The two axes of the frame itself, in the tool amber — the crop-style
    // emphasis that shows where zero runs.
    addLines(axes, 0xe8a33d, 0.85)
    this.viewport.invalidate()
  }

  /** What the grid is ruled over: the image, whose edges are where the sheet
   *  ends; or, on a bare sheet, which is not seen, the view with a margin of
   *  one screen each way — a grid that ended at the invisible sheet's edge
   *  would draw a tilted patch on the stage — so a pan is drawn ahead of and
   *  a further one redraws. */
  private gridExtent(): DocBox {
    if (this.texture) return this.bounds
    const v = this.visibleBox()
    const w = v.x1 - v.x0
    const h = v.y1 - v.y0
    return { x0: v.x0 - w, y0: v.y0 - h, x1: v.x1 + w, y1: v.y1 + h }
  }

  /** The part of the document plane on screen, as an axis-aligned box in
   *  document units — the four viewport corners unprojected; a rolled view's
   *  box is the rotated rectangle's bounding box. */
  private visibleBox(): DocBox {
    const cam = this.viewport.camera
    const box: DocBox = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }
    const corner = new THREE.Vector3()
    for (const [nx, ny] of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ]) {
      corner.set(nx, ny, 0).unproject(cam)
      box.x0 = Math.min(box.x0, corner.x)
      box.x1 = Math.max(box.x1, corner.x)
      box.y0 = Math.min(box.y0, corner.y)
      box.y1 = Math.max(box.y1, corner.y)
    }
    return box
  }

  /** Whether the grid on the stage no longer fits the view: the zoom is on
   *  another rung of the spacing ladder, or a bare sheet's ruled patch has
   *  been panned or zoomed out of. */
  private gridStale(): boolean {
    if (this.gridSpacingDrawn !== gridSpacing(this.unitsPerScreenPx())) return true
    if (this.texture || !this.gridExtentDrawn) return false
    const v = this.visibleBox()
    const d = this.gridExtentDrawn
    return v.x0 < d.x0 || v.y0 < d.y0 || v.x1 > d.x1 || v.y1 > d.y1
  }

  /** Arm or disarm region selection. Armed, a plain left-drag rubber-bands a
   *  box instead of panning — paint mode moves the navigator's plain-drag
   *  bindings out of the way, exactly as the 3D brush does, so Shift+drag
   *  and the middle button still pan. */
  setRegionMode(on: boolean): void {
    if (this.regionMode === on) return
    this.regionMode = on
    this.claimDrag()
    if (!on) this.dropBand()
  }

  /** The navigator steps aside from the plain left-drag while a region tool
   *  is armed or a pin is under the cursor — the same hand-off the 3D brush
   *  and the extend grips use. */
  private claimDrag(): void {
    // A selection box takes Shift+drag too, to add to the selection.
    this.viewport.nav.setPaintMode(this.regionMode || this.boxSelect || this.pinHover || this.dragHover, this.boxSelect)
  }

  /** Let a left-drag on the bare sheet draw a selection box, as a CAD
   *  sketcher's does, instead of panning — with Shift or Ctrl held, one
   *  that adds to the selection. The navigator lets go of the left button
   *  as it does for a region tool, so the right button still pans, and
   *  whatever the scheme gives the middle one. A press the owner takes
   *  (onSheetDown) is still the owner's, and a press let go where it
   *  landed is still a click, reported through onPick. */
  setBoxSelect(on: boolean): void {
    if (this.boxSelect === on) return
    this.boxSelect = on
    this.claimDrag()
    if (!on) this.dropBox()
  }

  /** Say whether the cursor is over something the owner would take a press
   *  on (see onSheetDown): the navigator lets the plain left-drag go while
   *  it is, and the hand shows it can grab. */
  setDragHover(on: boolean): void {
    if (this.dragHover === on) return
    this.dragHover = on
    this.claimDrag()
    if (!this.pinHover && !this.dragging && !this.handleDragging && !this.sheetDragging) {
      this.container.style.cursor = on ? 'grab' : this.baseCursor
    }
  }

  private setPinHover(on: boolean): void {
    if (this.pinHover === on) return
    this.pinHover = on
    this.claimDrag()
    this.container.style.cursor = on ? 'grab' : this.baseCursor
  }

  /** The cursor the sheet wears at rest — a crosshair for a drawing tool, a
   *  hand over something that can be dragged, nothing for the plain sheet.
   *  A pin under the hand or a drag in progress still says its own. */
  setCursor(css: string): void {
    if (this.baseCursor === css) return
    this.baseCursor = css
    if (!this.pinHover && !this.dragHover && !this.dragging && !this.handleDragging && !this.sheetDragging) {
      this.container.style.cursor = css
    }
  }

  /** The grid's spacing at the current zoom, document units — what a
   *  sketch snaps to. */
  gridStep(): number {
    return gridSpacing(this.unitsPerScreenPx())
  }

  /** A drag the owner asked for on the bare sheet — see onSheetDown. The
   *  same hand-off as a pin drag: the navigator never sees the press. */
  private beginSheetDrag(e: PointerEvent): void {
    this.sheetDragging = { moved: false }
    const start = { x: e.clientX, y: e.clientY }
    const move = (ev: PointerEvent) => {
      const d = this.sheetDragging
      if (!d) return
      if (!d.moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 3) return
      const p = this.pick(ev.clientX, ev.clientY)
      if (!p) return
      if (!d.moved) this.container.style.cursor = 'grabbing'
      d.moved = true
      this.onSheetDrag?.(p, { alt: ev.altKey, ctrl: ev.ctrlKey, unitsPerScreenPx: this.unitsPerScreenPx() })
    }
    const up = (ev: PointerEvent) => {
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', up)
      document.removeEventListener('pointercancel', up)
      const d = this.sheetDragging
      this.sheetDragging = null
      this.container.style.cursor = this.pinHover || this.dragHover ? 'grab' : this.baseCursor
      const meta = { alt: ev.altKey, shift: ev.shiftKey, ctrl: ev.ctrlKey, unitsPerScreenPx: this.unitsPerScreenPx() }
      if (d?.moved) this.onSheetDragEnd?.(meta)
      else {
        const p = this.pick(start.x, start.y)
        if (p) this.onPick?.(p, meta)
      }
    }
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', up)
    document.addEventListener('pointercancel', up)
    e.preventDefault()
  }

  private hoverMove = (e: PointerEvent): void => {
    // The hand over a pin or a handle says it can be taken hold of.
    if (!this.dragging && !this.handleDragging) {
      this.setPinHover(
        this.sheet.visible &&
          (this.pinAt(e.clientX, e.clientY) >= 0 || this.handleAt(e.clientX, e.clientY) !== null),
      )
    }
    if (!this.onHoverPoint) return
    const p = this.sheet.visible ? this.pick(e.clientX, e.clientY) : null
    this.onHoverPoint(p, e.clientX, e.clientY, e.altKey, e.ctrlKey)
  }

  /** Document spots on screen, in client pixels — for hit-testing the marks
   *  against the cursor. The marks themselves are DOM labels that take no
   *  pointer events, so the test is done against what they mark. */
  private screenOf(points: readonly Vec2[]): [number, number][] {
    const rect = this.container.getBoundingClientRect()
    const cam = this.viewport.camera
    const w = rect.width || 1
    const h = rect.height || 1
    const v = new THREE.Vector3()
    return points.map((p) => {
      v.set(p[0], p[1], 0).project(cam)
      return [rect.x + ((v.x + 1) / 2) * w, rect.y + ((1 - v.y) / 2) * h]
    })
  }

  /** Which draft pick sits under the cursor, within a hand-sized radius on
   *  screen — or -1. */
  private pinAt(clientX: number, clientY: number): number {
    if (this.draftPicks.length === 0) return -1
    let best = -1
    let bestD = 12
    this.screenOf(this.draftPicks).forEach(([sx, sy], i) => {
      const d = Math.hypot(sx - clientX, sy - clientY)
      if (d < bestD) {
        bestD = d
        best = i
      }
    })
    return best
  }

  /** Which handle end sits under the cursor — a smaller target than a pin,
   *  as it is a smaller mark — or null. */
  private handleAt(clientX: number, clientY: number): { index: number; end: HandleEnd } | null {
    if (this.draftHandles.length === 0) return null
    const ends = this.draftHandles.flatMap((hd) => [hd.a, hd.b])
    let best: { index: number; end: HandleEnd } | null = null
    let bestD = 9
    this.screenOf(ends).forEach(([sx, sy], i) => {
      const d = Math.hypot(sx - clientX, sy - clientY)
      if (d < bestD) {
        bestD = d
        best = { index: i >> 1, end: i % 2 === 0 ? 'a' : 'b' }
      }
    })
    return best
  }

  /** Drag a handle end: every move reports the new spot through
   *  onHandleDrag, and a press let go where it landed is a click on the
   *  handle, which frees the tangent. The same hand-off as a pin drag. */
  private beginHandleDrag(index: number, end: HandleEnd, e: PointerEvent): void {
    this.handleDragging = { index, end, moved: false }
    this.container.style.cursor = 'grabbing'
    const start = { x: e.clientX, y: e.clientY }
    const move = (ev: PointerEvent) => {
      const d = this.handleDragging
      if (!d) return
      if (!d.moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 3) return
      const p = this.pick(ev.clientX, ev.clientY)
      if (!p) return
      d.moved = true
      this.onHandleDrag?.(index, end, p, { alt: ev.altKey, unitsPerScreenPx: this.unitsPerScreenPx() })
    }
    const up = () => {
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', up)
      document.removeEventListener('pointercancel', up)
      const clicked = this.handleDragging !== null && !this.handleDragging.moved
      this.handleDragging = null
      this.container.style.cursor = this.pinHover ? 'grab' : this.baseCursor
      if (clicked) this.onHandleReset?.(index)
    }
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', up)
    document.addEventListener('pointercancel', up)
    e.preventDefault()
  }

  /** Drag a draft pick: every move reports the new spot through onPickDrag,
   *  and the release ends it. A press let go where it landed is a click on
   *  the pin, reported through onPinClick. The navigator never sees the
   *  press, so the sheet stays put under the drag. */
  private beginPinDrag(index: number, e: PointerEvent): void {
    this.dragging = { index, moved: false }
    this.container.style.cursor = 'grabbing'
    const start = { x: e.clientX, y: e.clientY }
    const move = (ev: PointerEvent) => {
      const d = this.dragging
      if (!d) return
      // A hand that has not really moved is still clicking.
      if (!d.moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 3) return
      const p = this.pick(ev.clientX, ev.clientY)
      if (!p) return
      d.moved = true
      this.onPickDrag?.(index, p, { alt: ev.altKey, unitsPerScreenPx: this.unitsPerScreenPx() })
    }
    const up = () => {
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', up)
      document.removeEventListener('pointercancel', up)
      const clicked = this.dragging !== null && !this.dragging.moved
      this.dragging = null
      this.container.style.cursor = this.pinHover ? 'grab' : this.baseCursor
      if (clicked) {
        this.onPinClick?.(index)
        // The pin under the hand may be gone; the next move re-checks.
        this.setPinHover(false)
      }
    }
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', up)
    document.addEventListener('pointercancel', up)
    e.preventDefault()
  }

  private beginBand(e: PointerEvent): void {
    this.bandStart = { x: e.clientX, y: e.clientY }
    const div = document.createElement('div')
    div.className = 'flat-band'
    this.container.appendChild(div)
    this.bandDiv = div
    const move = (ev: PointerEvent) => this.layoutBand(ev.clientX, ev.clientY)
    const up = (ev: PointerEvent) => {
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', up)
      this.finishBand(ev.clientX, ev.clientY, ev)
    }
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', up)
    this.layoutBand(e.clientX, e.clientY)
  }

  private layoutBand(x: number, y: number): void {
    if (!this.bandDiv || !this.bandStart) return
    const rect = this.container.getBoundingClientRect()
    const lo = { x: Math.min(this.bandStart.x, x) - rect.x, y: Math.min(this.bandStart.y, y) - rect.y }
    const hi = { x: Math.max(this.bandStart.x, x) - rect.x, y: Math.max(this.bandStart.y, y) - rect.y }
    this.bandDiv.style.left = `${lo.x}px`
    this.bandDiv.style.top = `${lo.y}px`
    this.bandDiv.style.width = `${hi.x - lo.x}px`
    this.bandDiv.style.height = `${hi.y - lo.y}px`
  }

  private finishBand(x: number, y: number, e: PointerEvent): void {
    const start = this.bandStart
    this.dropBand()
    if (!start) return
    // A twitch is not a region — it is a click, and an edge tool reads a
    // click as "this whole edge". The navigator swallowed the press, so the
    // click is reported from here.
    if (Math.abs(x - start.x) + Math.abs(y - start.y) < 6) {
      const p = this.pick(start.x, start.y)
      if (p) this.onPick?.(p, { alt: e.altKey, unitsPerScreenPx: this.unitsPerScreenPx() })
      return
    }
    const a = this.pick(start.x, start.y)
    const b = this.pick(x, y)
    if (!a || !b) return
    this.onRegion?.(
      [Math.min(a[0], b[0]), Math.min(a[1], b[1])],
      [Math.max(a[0], b[0]), Math.max(a[1], b[1])],
    )
  }

  private dropBand(): void {
    this.bandDiv?.remove()
    this.bandDiv = null
    this.bandStart = null
  }

  /** Draw a selection box from the press: rightward a window, drawn solid,
   *  leftward a crossing box, drawn dashed — read again at every move, so
   *  the box changes as the hand crosses back over where it started. Only
   *  the pointer that pressed moves it; a release within the click
   *  threshold is a click. */
  private beginBox(e: PointerEvent): void {
    this.dropBox()
    const id = e.pointerId
    const start = { x: e.clientX, y: e.clientY }
    const div = document.createElement('div')
    div.className = 'flat-band box'
    let moved = false
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return
      if (!moved && Math.abs(ev.clientX - start.x) + Math.abs(ev.clientY - start.y) <= 6) return
      if (!moved) this.container.appendChild(div)
      moved = true
      const box = this.sheetBox(start, ev)
      div.classList.toggle('window', !box?.crossing)
      div.classList.toggle('crossing', !!box?.crossing)
      this.layoutBox(div, start, ev.clientX, ev.clientY)
      if (box) this.onBoxDrag?.(box)
    }
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return
      const box = moved ? this.sheetBox(start, ev) : null
      this.dropBox()
      if (box) this.onBoxSelect?.(box)
      else if (!moved) {
        // The navigator never saw the press, so the click is said from here.
        const p = this.pick(start.x, start.y)
        if (p) this.onPick?.(p, { alt: ev.altKey, shift: ev.shiftKey, ctrl: ev.ctrlKey, unitsPerScreenPx: this.unitsPerScreenPx() })
      }
    }
    const cancel = (ev: PointerEvent) => {
      if (ev.pointerId === id) this.dropBox()
    }
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', up)
    document.addEventListener('pointercancel', cancel)
    this.box = {
      end: () => {
        document.removeEventListener('pointermove', move)
        document.removeEventListener('pointerup', up)
        document.removeEventListener('pointercancel', cancel)
        div.remove()
        if (moved) this.onBoxDrag?.(null)
      },
    }
    e.preventDefault()
  }

  /** The box from the press to the pointer, laid on the document plane —
   *  past the edge of an image too, which a box may well reach over. */
  private sheetBox(start: { x: number; y: number }, e: PointerEvent): SheetBox | null {
    const corners = [
      this.planeAt(start.x, start.y),
      this.planeAt(e.clientX, start.y),
      this.planeAt(e.clientX, e.clientY),
      this.planeAt(start.x, e.clientY),
    ]
    if (corners.some((c) => c === null)) return null
    return { corners: corners as SheetBox['corners'], crossing: e.clientX < start.x, additive: e.ctrlKey || e.shiftKey }
  }

  private layoutBox(div: HTMLDivElement, start: { x: number; y: number }, x: number, y: number): void {
    const rect = this.container.getBoundingClientRect()
    div.style.left = `${Math.min(start.x, x) - rect.x}px`
    div.style.top = `${Math.min(start.y, y) - rect.y}px`
    div.style.width = `${Math.abs(x - start.x)}px`
    div.style.height = `${Math.abs(y - start.y)}px`
  }

  private dropBox(): void {
    const box = this.box
    this.box = null
    box?.end()
  }

  /** What is under the screen centre, in document units, and the scale —
   *  the view as another viewport would follow it. The camera looks at the
   *  sheet face on with no turn or mirror when this is asked, so its
   *  position over the sheet is the point at the centre. */
  sheetView(): { centre: Vec2; unitsPerScreenPx: number } {
    const cam = this.viewport.camera
    return { centre: [cam.position.x, cam.position.y], unitsPerScreenPx: this.unitsPerScreenPx() }
  }

  /** Document units per screen pixel at the current zoom — what turns a snap
   *  radius the hand understands into one the sheet understands. */
  unitsPerScreenPx(): number {
    const cam = this.viewport.camera
    const h = this.viewport.renderer.domElement.clientHeight || 1
    return (cam.top - cam.bottom) / cam.zoom / h
  }

  /** The polyline a fit draws as: a segment, a full circle, an arc. A point
   *  draws as a cross sized off the sheet. */
  private fitPolyline(fit: FlatFit): Vec2[][] {
    if (fit.kind === 'line') {
      const [cx, cy] = fit.center
      const [dx, dy] = fit.dir
      const h = fit.length / 2
      return [
        [
          [cx - dx * h, cy - dy * h],
          [cx + dx * h, cy + dy * h],
        ],
      ]
    }
    if (fit.kind === 'circle' || fit.kind === 'arc') {
      const start = fit.kind === 'arc' ? fit.start : 0
      const sweep = fit.kind === 'arc' ? fit.sweep : 2 * Math.PI
      const steps = Math.max(16, Math.ceil((sweep / (2 * Math.PI)) * 96))
      const pts: Vec2[] = []
      for (let i = 0; i <= steps; i++) {
        const a = start + (sweep * i) / steps
        pts.push([fit.center[0] + fit.radius * Math.cos(a), fit.center[1] + fit.radius * Math.sin(a)])
      }
      return [pts]
    }
    if (fit.kind === 'spline') return [splinePolyline(fit)]
    // A cross for a point, sized off the sheet so it stays visible at the
    // overview and honest when zoomed in.
    const s = Math.max(this.sheetDiag() * 0.006, 1e-6)
    const [x, y] = fit.at
    return [
      [
        [x - s, y],
        [x + s, y],
      ],
      [
        [x, y - s],
        [x, y + s],
      ],
    ]
  }

  private sheetDiag(): number {
    return Math.hypot(this.bounds.x1 - this.bounds.x0, this.bounds.y1 - this.bounds.y0) || 1
  }

  /** Polylines as screen-space fat lines, `width` pixels wide at any zoom at
   *  the default setting — a fitted edge has to be findable over the scan it
   *  was fitted to. */
  private addPolylines(
    group: THREE.Group,
    cleanup: (() => void)[],
    polylines: Vec2[][],
    color: THREE.ColorRepresentation,
    opacity: number,
    z: number,
    width = SHEET_LINE_DEFAULT,
  ): void {
    const mat = new LineMaterial({
      color: new THREE.Color(color).getHex(),
      linewidth: width * this.lineScale,
      transparent: true,
      opacity,
      depthTest: false,
      worldUnits: false,
    })
    mat.resolution.copy(this.lineResolution)
    this.lineMaterials.set(mat, width)
    cleanup.push(() => {
      this.lineMaterials.delete(mat)
      mat.dispose()
    })
    for (const pts of polylines) {
      if (pts.length < 2) continue
      const geo = new LineGeometry()
      geo.setPositions(pts.flatMap((p) => [p[0], p[1], z]))
      const line = new Line2(geo, mat)
      line.computeLineDistances()
      line.renderOrder = 4
      group.add(line)
      cleanup.push(() => geo.dispose())
    }
  }

  private addLabel(
    group: THREE.Group,
    cleanup: (() => void)[],
    at: Vec2,
    title: string,
    value: string,
    color: string,
  ): void {
    // The same pin the 3D elements wear, tint and all, so the sheet's labels
    // follow the chassis the way the part's do.
    const label = pinLabel('element-label', title, value, color)
    label.position.set(at[0], at[1], 0.2)
    group.add(label)
    cleanup.push(() => label.element.remove())
  }

  /** Where a fit's label floats: beside the feature, not on top of it. */
  private labelSpot(fit: FlatFit): Vec2 {
    const lift = this.sheetDiag() * 0.01
    if (fit.kind === 'point') return [fit.at[0], fit.at[1] + lift]
    if (fit.kind === 'line') return [fit.center[0], fit.center[1] + lift]
    if (fit.kind === 'circle') {
      const d = fit.radius * 0.7071
      return [fit.center[0] + d, fit.center[1] + d]
    }
    if (fit.kind === 'spline') {
      const [x, y] = splineMidpoint(fit)
      return [x, y + lift]
    }
    const mid = fit.start + fit.sweep / 2
    return [
      fit.center[0] + fit.radius * Math.cos(mid),
      fit.center[1] + fit.radius * Math.sin(mid),
    ]
  }

  /** The measured elements, rebuilt wholesale when anything about them
   *  changes — same policy as the 3D overlays. */
  setFlatElements(
    items: readonly { fit: FlatFit; color: string; name: string; value: string; label?: boolean; width?: number }[],
  ): void {
    for (const dispose of this.elementCleanup) dispose()
    this.elementCleanup = []
    this.elementGroup.clear()
    for (const item of items) {
      this.addPolylines(this.elementGroup, this.elementCleanup, this.fitPolyline(item.fit), item.color, 0.95, 0.15, item.width)
      // A sketch's pieces carry no readings: they are drawn without a tag.
      if (item.label === false) continue
      this.addLabel(
        this.elementGroup,
        this.elementCleanup,
        this.labelSpot(item.fit),
        item.name,
        item.value,
        item.color,
      )
    }
    this.viewport.invalidate()
  }

  /** Translucent fills on the sheet — the closed regions of a sketch, so a
   *  profile that closes reads as a face and one that does not reads as
   *  lines. Polygons in document units, holes cut out. */
  setFlatFills(items: readonly { polygon: readonly Vec2[]; holes: readonly (readonly Vec2[])[]; color: string; opacity: number }[]): void {
    for (const dispose of this.fillCleanup) dispose()
    this.fillCleanup = []
    this.fillGroup.clear()
    for (const item of items) {
      if (item.polygon.length < 3) continue
      const shape = new THREE.Shape(item.polygon.map(([x, y]) => new THREE.Vector2(x, y)))
      for (const h of item.holes) {
        if (h.length >= 3) shape.holes.push(new THREE.Path(h.map(([x, y]) => new THREE.Vector2(x, y))))
      }
      const geo = new THREE.ShapeGeometry(shape)
      const mat = new THREE.MeshBasicMaterial({
        color: item.color,
        transparent: true,
        opacity: item.opacity,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
      })
      const mesh = new THREE.Mesh(geo, mat)
      // Above the sheet and the edge chains, under the pieces.
      mesh.position.z = 0.12
      mesh.renderOrder = 1
      this.fillGroup.add(mesh)
      this.fillCleanup.push(() => {
        geo.dispose()
        mat.dispose()
      })
    }
    this.viewport.invalidate()
  }

  /** Dots on the sheet, the same size at any zoom — the ends of a sketch's
   *  pieces, so it can be seen where one stops and the next begins. Drawn
   *  over the pieces; `size` is the diameter in pixels. */
  setFlatDots(items: readonly { at: Vec2; color: string; size: number }[]): void {
    for (const dispose of this.dotCleanup) dispose()
    this.dotCleanup = []
    this.dotGroup.clear()
    const bySize = new Map<number, typeof items[number][]>()
    for (const item of items) bySize.set(item.size, [...(bySize.get(item.size) ?? []), item])
    for (const [size, dots] of bySize) {
      const positions = new Float32Array(dots.length * 3)
      const colors = new Float32Array(dots.length * 3)
      const c = new THREE.Color()
      dots.forEach((d, i) => {
        positions.set([d.at[0], d.at[1], 0.18], i * 3)
        c.set(d.color)
        colors.set([c.r, c.g, c.b], i * 3)
      })
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
      const mat = new THREE.PointsMaterial({
        size: size * window.devicePixelRatio,
        sizeAttenuation: false,
        vertexColors: true,
        map: this.roundDot(),
        alphaTest: 0.5,
        transparent: true,
        depthTest: false,
      })
      const points = new THREE.Points(geo, mat)
      points.renderOrder = 5
      // The dots move with every drag; a bounding sphere a frame old must
      // not cull them.
      points.frustumCulled = false
      this.dotGroup.add(points)
      this.dotCleanup.push(() => {
        geo.dispose()
        mat.dispose()
      })
    }
    this.viewport.invalidate()
  }

  /** A filled disc, the sprite every dot is drawn with. */
  private roundDot(): THREE.Texture {
    if (this.dotTexture) return this.dotTexture
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 32
    const ctx = canvas.getContext('2d')
    if (ctx) {
      ctx.fillStyle = '#fff'
      ctx.beginPath()
      ctx.arc(16, 16, 15, 0, 2 * Math.PI)
      ctx.fill()
    }
    this.dotTexture = new THREE.CanvasTexture(canvas)
    return this.dotTexture
  }

  /** The draft on its way to an element: numbered pins on hand picks (which
   *  can be dragged), a dot cloud for region-collected points (thousands of
   *  pins would be thousands of DOM nodes), the pending fit drawn in the
   *  colour the element will have, and — for a spline — a tangent handle
   *  through every pick, its two ends draggable, in the tool amber. */
  setDraftMarks(
    picks: readonly Vec2[],
    fit: FlatFit | readonly FlatFit[] | null,
    cloud?: readonly Vec2[],
    color = '#8b95a3',
    handles: readonly SplineHandle[] = [],
  ): void {
    for (const dispose of this.draftCleanup) dispose()
    this.draftCleanup = []
    this.draftGroup.clear()
    this.draftPicks = picks.map((p) => [p[0], p[1]])
    this.draftHandles = handles.map((h) => ({ ...h, at: [...h.at], a: [...h.a], b: [...h.b] }))
    if (this.draftPicks.length === 0 && !this.dragging && !this.handleDragging) this.setPinHover(false)
    if (handles.length > 0) {
      this.addPolylines(
        this.draftGroup,
        this.draftCleanup,
        handles.map((h) => [h.b, h.a]),
        0xe8a33d,
        0.8,
        0.19,
        1.5,
      )
      for (const h of handles) {
        for (const end of [h.a, h.b]) {
          const div = document.createElement('div')
          div.className = 'spline-handle' + (h.fixed ? ' fixed' : '')
          div.dataset.test = 'flat-handle'
          const mark = new CSS2DObject(div)
          mark.position.set(end[0], end[1], 0.21)
          this.draftGroup.add(mark)
          this.draftCleanup.push(() => div.remove())
        }
      }
    }
    if (cloud && cloud.length > 0) {
      const positions = new Float32Array(cloud.length * 3)
      cloud.forEach((p, i) => {
        positions[i * 3] = p[0]
        positions[i * 3 + 1] = p[1]
        positions[i * 3 + 2] = 0.17
      })
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
      const mat = new THREE.PointsMaterial({
        color,
        size: 3,
        sizeAttenuation: false,
        transparent: true,
        opacity: 0.9,
        depthTest: false,
      })
      const points = new THREE.Points(geo, mat)
      points.renderOrder = 4
      this.draftGroup.add(points)
      this.draftCleanup.push(() => {
        geo.dispose()
        mat.dispose()
      })
    }
    picks.forEach((p, i) => {
      const div = document.createElement('div')
      div.className = 'pick-pin'
      div.textContent = String(i + 1)
      div.style.background = color
      const label = new CSS2DObject(div)
      label.position.set(p[0], p[1], 0.2)
      this.draftGroup.add(label)
      this.draftCleanup.push(() => div.remove())
    })
    // The exact spot each pin marks — the pin's badge sits beside it.
    if (picks.length > 0) {
      const s = Math.max(this.sheetDiag() * 0.004, 1e-6)
      this.addPolylines(
        this.draftGroup,
        this.draftCleanup,
        picks.flatMap(([x, y]) => [
          [
            [x - s, y],
            [x + s, y],
          ],
          [
            [x, y - s],
            [x, y + s],
          ],
        ]),
        color,
        0.95,
        0.19,
        2.5,
      )
    }
    // The ghost of what the picks are about to make — one shape, or the
    // several a rubber-banded rectangle is.
    const fits = fit === null ? [] : Array.isArray(fit) ? (fit as readonly FlatFit[]) : [fit as FlatFit]
    for (const f of fits) {
      this.addPolylines(this.draftGroup, this.draftCleanup, this.fitPolyline(f), color, 0.9, 0.18)
    }
    this.viewport.invalidate()
  }

  /** Show detected edge chains (image-pixel coordinates), or clear them with
   *  null. One instanced LineSegments2 holds every chain — tens of thousands
   *  of segments are one draw call. */
  setEdgeChains(chains: EdgeChains | null): void {
    if (this.edgeSegments) {
      this.edgeGroup.remove(this.edgeSegments)
      this.edgeSegments.geometry.dispose()
      this.edgeSegments = null
    }
    if (chains && chains.offsets.length > 1) {
      let segments = 0
      for (let c = 0; c + 1 < chains.offsets.length; c++) {
        segments += Math.max(0, chains.offsets[c + 1] - chains.offsets[c] - 1)
      }
      const positions = new Float32Array(segments * 6)
      let at = 0
      for (let c = 0; c + 1 < chains.offsets.length; c++) {
        for (let i = chains.offsets[c]; i + 1 < chains.offsets[c + 1]; i++) {
          positions[at++] = chains.points[i * 2]
          positions[at++] = chains.points[i * 2 + 1]
          positions[at++] = 0.05
          positions[at++] = chains.points[i * 2 + 2]
          positions[at++] = chains.points[i * 2 + 3]
          positions[at++] = 0.05
        }
      }
      const geometry = new LineSegmentsGeometry()
      geometry.setPositions(positions)
      this.edgeSegments = new LineSegments2(geometry, this.edgeMaterial)
      this.edgeSegments.renderOrder = 2
      this.edgeGroup.add(this.edgeSegments)
    }
    this.layoutEdges()
    this.viewport.invalidate()
  }

  /** Keep the edge overlay on the sheet's millimetres. */
  private layoutEdges(): void {
    this.edgeGroup.scale.set(this.mmPerPx.x, this.mmPerPx.y, 1)
    this.edgeGroup.updateMatrixWorld(true)
  }

  /** Draw the calibration picks (document mm) as numbered pins, joined by a
   *  line once there are two — the reference length being measured. */
  setCalibrationPicks(points: readonly Vec2[]): void {
    for (const dispose of this.calCleanup) dispose()
    this.calCleanup = []
    this.calGroup.clear()
    if (points.length >= 2) {
      const geo = new THREE.BufferGeometry().setFromPoints(
        points.map((p) => new THREE.Vector3(p[0], p[1], 0.1)),
      )
      const mat = new THREE.LineBasicMaterial({ color: 0xffb020, depthTest: false })
      const line = new THREE.Line(geo, mat)
      line.renderOrder = 3
      this.calGroup.add(line)
      this.calCleanup.push(() => {
        geo.dispose()
        mat.dispose()
      })
    }
    points.forEach((p, i) => {
      const div = document.createElement('div')
      div.className = 'pick-pin'
      div.textContent = String(i + 1)
      div.style.background = '#ffb020'
      const label = new CSS2DObject(div)
      label.position.set(p[0], p[1], 0.1)
      this.calGroup.add(label)
      this.calCleanup.push(() => div.remove())
    })
    this.viewport.invalidate()
  }

  /** The text notes (document units). Each is a DOM label that takes the
   *  pointer: a press and move drags it, reporting every new spot through
   *  onNoteDrag; a press released in place selects it. The navigator never
   *  sees the press — the label sits above the canvas — so the sheet stays
   *  put under the drag. */
  setNotes(items: readonly { id: number; text: string; at: Vec2; editing: boolean; className?: string; tip?: string }[]): void {
    if (this.hoveredNote !== null) {
      this.hoveredNote = null
      this.onNoteHover?.(null)
    }
    for (const dispose of this.noteCleanup) dispose()
    this.noteCleanup = []
    this.noteGroup.clear()
    for (const item of items) {
      const div = document.createElement('div')
      div.className = 'viewport-label note-label' + (item.editing ? ' editing' : '') + (item.className ? ` ${item.className}` : '')
      div.dataset.test = `flat-note-${item.id}`
      // A word shown beside the note the moment the cursor is over it (the
      // stylesheet draws `data-tip`): a glyph's name, which a title's delay
      // would make the hand wait for.
      if (item.tip) div.dataset.tip = item.tip
      div.textContent = item.text.trim() === '' ? 'Text' : item.text
      if (item.text.trim() === '') div.classList.add('empty')
      const down = (e: PointerEvent) => {
        if (e.button !== 0) return
        e.preventDefault()
        e.stopPropagation()
        let moved = false
        const start = { x: e.clientX, y: e.clientY }
        // The note keeps its place under the hand: the offset between the
        // grab and its anchor rides along, so it does not jump to the cursor.
        const grab = this.pick(e.clientX, e.clientY) ?? item.at
        const offset: Vec2 = [item.at[0] - grab[0], item.at[1] - grab[1]]
        div.classList.add('dragging')
        const move = (ev: PointerEvent) => {
          if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 3) return
          moved = true
          const p = this.pick(ev.clientX, ev.clientY)
          if (p) this.onNoteDrag?.(item.id, [p[0] + offset[0], p[1] + offset[1]])
        }
        const up = () => {
          document.removeEventListener('pointermove', move)
          document.removeEventListener('pointerup', up)
          document.removeEventListener('pointercancel', up)
          div.classList.remove('dragging')
          if (!moved) this.onNoteSelect?.(item.id)
        }
        document.addEventListener('pointermove', move)
        document.addEventListener('pointerup', up)
        document.addEventListener('pointercancel', up)
      }
      div.addEventListener('pointerdown', down)
      const enter = () => {
        this.hoveredNote = item.id
        this.onNoteHover?.(item.id)
      }
      const leave = () => {
        if (this.hoveredNote !== item.id) return
        this.hoveredNote = null
        this.onNoteHover?.(null)
      }
      div.addEventListener('pointerenter', enter)
      div.addEventListener('pointerleave', leave)
      const label = new CSS2DObject(div)
      // Anchored at its lower-left: the spot clicked is where the text begins.
      label.center.set(0, 1)
      label.position.set(item.at[0], item.at[1], 0.15)
      this.noteGroup.add(label)
      this.noteCleanup.push(() => {
        div.removeEventListener('pointerdown', down)
        div.removeEventListener('pointerenter', enter)
        div.removeEventListener('pointerleave', leave)
        div.remove()
      })
    }
    this.viewport.invalidate()
  }

  /** The tallies (document units): each pick wears its running number in the
   *  tally's colour, with a crosshair on the exact spot, and the last pick of
   *  a finished tally carries its name. The live one is drawn the same way. */
  setCounts(items: readonly { picks: readonly Vec2[]; color: string; name?: string }[]): void {
    for (const dispose of this.countCleanup) dispose()
    this.countCleanup = []
    this.countGroup.clear()
    const s = Math.max(this.sheetDiag() * 0.004, 1e-6)
    for (const item of items) {
      if (item.picks.length === 0) continue
      item.picks.forEach((p, i) => {
        const div = document.createElement('div')
        div.className = 'pick-pin'
        div.textContent = String(i + 1)
        div.style.background = item.color
        const label = new CSS2DObject(div)
        label.position.set(p[0], p[1], 0.12)
        this.countGroup.add(label)
        this.countCleanup.push(() => div.remove())
      })
      this.addPolylines(
        this.countGroup,
        this.countCleanup,
        item.picks.flatMap(([x, y]) => [
          [
            [x - s, y],
            [x + s, y],
          ],
          [
            [x, y - s],
            [x, y + s],
          ],
        ]),
        item.color,
        0.95,
        0.11,
        2.5,
      )
      if (item.name) {
        const last = item.picks[item.picks.length - 1]
        this.addLabel(
          this.countGroup,
          this.countCleanup,
          [last[0] + s * 2, last[1] - s * 6],
          item.name,
          String(item.picks.length),
          item.color,
        )
      }
    }
    this.viewport.invalidate()
  }

  /**
   * Show a freshly decoded image. The bitmap must have been created with
   * `imageOrientation: 'flipY'` — an ImageBitmap bypasses the usual GPU-side
   * flip, so the decode is where the image and the y-up document frame get
   * reconciled. Downscales for the GPU when the scan exceeds the largest
   * texture the driver takes; the sheet keeps its full-resolution size, so
   * coordinates lose nothing.
   */
  async setImage(bitmap: ImageBitmap, mmPerPx: PixelsPerMm): Promise<void> {
    this.imagePx = { width: bitmap.width, height: bitmap.height }
    this.mmPerPx = { ...mmPerPx }

    const max = this.viewport.renderer.capabilities.maxTextureSize
    let upload = bitmap
    if (bitmap.width > max || bitmap.height > max) {
      const s = Math.min(max / bitmap.width, max / bitmap.height)
      upload = await createImageBitmap(bitmap, {
        resizeWidth: Math.floor(bitmap.width * s),
        resizeHeight: Math.floor(bitmap.height * s),
        resizeQuality: 'high',
      })
    }

    this.texture?.dispose()
    const texture = new THREE.Texture(upload)
    texture.flipY = false
    texture.colorSpace = THREE.SRGBColorSpace
    texture.minFilter = THREE.LinearMipmapLinearFilter
    texture.anisotropy = Math.min(8, this.viewport.renderer.capabilities.getMaxAnisotropy())
    texture.needsUpdate = true
    this.texture = texture
    this.material.map = texture
    // The colour multiplies the image; white leaves it alone.
    this.material.color.set(0xffffff)
    this.material.colorWrite = true
    this.material.depthWrite = true
    this.material.needsUpdate = true

    this.sheet.visible = true
    this.bounds = this.imageBounds()
    this.layoutSheet()
    this.frame()
  }

  /**
   * A bare sheet with nothing on it but what is drawn over it — a section
   * through the 3D scan, whose edges arrive already in millimetres. The
   * bounds are the cut's, with room around it; the sheet is what a click
   * lands on, so it has to reach a little past the last edge. It is not
   * seen: a white card behind the cut would be a page the cut is not on, so
   * the plane is there to be clicked and framed and the stage shows through.
   */
  setBlankSheet(min: Vec2, max: Vec2): void {
    this.texture?.dispose()
    this.texture = null
    this.material.map = null
    // Drawn into neither colour nor depth — a raycast still lands on it.
    this.material.colorWrite = false
    this.material.depthWrite = false
    this.material.needsUpdate = true
    this.imagePx = { width: 0, height: 0 }
    this.mmPerPx = { x: 1, y: 1 }
    this.sheet.visible = true
    this.bounds = { x0: min[0], y0: min[1], x1: max[0], y1: max[1] }
    this.layoutSheet()
    this.frame()
  }

  /** The calibration changed: same pixels, different millimetres. A bare
   *  sheet has no pixels to re-lay; only its edge overlay reads the scale. */
  setScale(mmPerPx: PixelsPerMm): void {
    this.mmPerPx = { ...mmPerPx }
    if (!this.sheet.visible) return
    if (!this.texture) {
      this.layoutEdges()
      return
    }
    this.bounds = this.imageBounds()
    this.layoutSheet()
    this.frame()
  }

  /** The image's extent in document units: from the origin, its pixels at
   *  the scale in force. */
  private imageBounds(): { x0: number; y0: number; x1: number; y1: number } {
    return {
      x0: 0,
      y0: 0,
      x1: this.imagePx.width * this.mmPerPx.x,
      y1: this.imagePx.height * this.mmPerPx.y,
    }
  }

  /** Size the unit plane to the sheet's bounds and put it there. */
  private layoutSheet(): void {
    const { x0, y0, x1, y1 } = this.bounds
    this.sheet.scale.set(Math.max(x1 - x0, 1e-6), Math.max(y1 - y0, 1e-6), 1)
    this.sheet.position.set((x0 + x1) / 2, (y0 + y1) / 2, 0)
    this.sheet.updateMatrixWorld(true)
    this.layoutEdges()
    this.rebuildGrid()
    this.viewport.invalidate()
  }

  /** Frame the whole sheet, face on, turned and mirrored as asked — y up at
   *  no turns. */
  frame(): void {
    if (!this.sheet.visible) return
    const box = new THREE.Box3().setFromObject(this.sheet)
    this.viewport.frameCamera(box, null, { dir: this.screenDir(), up: this.screenUp() })
  }

  /** Show the sheet turned by whole quarter turns, counter-clockwise on
   *  screen, and fit it to the viewport again: a sheet that was framed
   *  landscape does not fit its own frame once it stands on end, and a turn
   *  is the moment to look at the whole of it anyway. */
  setTurns(turns: number): void {
    const t = ((Math.round(turns) % 4) + 4) % 4
    if (t === this.turns) return
    this.turns = t
    this.frame()
  }

  /** Show the sheet aligned to the part: its frame's +X to the right of the
   *  screen, +Y up — or, with null, as it was scanned. Unlike a quarter turn
   *  this rolls the view in place, keeping the zoom and what is under the
   *  screen centre: the alignment lands while the operator is looking at
   *  the very edge it was picked along, and the sheet turning square there
   *  is the feedback; a jump to a full-sheet framing would throw that away. */
  setAlignment(xDir: Vec2 | null): void {
    const same =
      xDir === null || this.alignDir === null
        ? xDir === this.alignDir
        : xDir[0] === this.alignDir[0] && xDir[1] === this.alignDir[1]
    if (same) return
    this.alignDir = xDir ? [xDir[0], xDir[1]] : null
    if (this.sheet.visible) this.viewport.rollTo(this.screenUp())
  }

  /** Show the sheet mirrored, or not: the camera goes round to the back of
   *  the sheet and looks at it from there, which is what a mirror is — the
   *  sheet's face is drawn on both sides, everything over it is drawn
   *  without a depth test, and the labels are DOM, so nothing else has to
   *  know. Like an alignment landing, the flip is in place: the same zoom,
   *  the same spot under the screen centre, the sheet swapping sides around
   *  it. */
  setMirror(on: boolean): void {
    if (on === this.mirror) return
    this.mirror = on
    if (this.sheet.visible) this.viewport.lookFrom(this.screenDir(), this.screenUp())
  }

  /** Which side of the sheet the camera is on: its face, or its back for a
   *  mirrored view. */
  private screenDir(): THREE.Vector3 {
    return new THREE.Vector3(0, 0, this.mirror ? -1 : 1)
  }

  /** The document direction that points up the screen: the alignment's +Y
   *  (+Y itself unaligned) — −Y on a mirrored sheet — then +X, −Y, −X of
   *  that as the sheet goes round counter-clockwise: what was to the right
   *  of the origin is above it after one turn. */
  private screenUp(): THREE.Vector3 {
    const [x, y] = poseAxes(sheetPose(this.alignDir, this.turns, this.mirror)).up
    return new THREE.Vector3(x, y, 0)
  }

  private pick(clientX: number, clientY: number): Vec2 | null {
    if (!this.sheet.visible) return null
    this.viewport.setPickRay(clientX, clientY)
    const hit = this.viewport.raycaster.intersectObject(this.sheet, false)[0]
    if (hit) return [hit.point.x, hit.point.y]
    // A blank sheet is a plane to draw on, not a page with an edge: the
    // card is sized round what is on it for the framing's sake, and a click
    // past it — a rectangle drawn wider than the slice — lands on the plane
    // all the same. An image's sheet does end where the image does.
    if (this.texture) return null
    return this.planeAt(clientX, clientY)
  }

  /** Where a client point falls on the document plane, sheet or no sheet. */
  private planeAt(clientX: number, clientY: number): Vec2 | null {
    this.viewport.setPickRay(clientX, clientY)
    const ray = this.viewport.raycaster.ray
    if (Math.abs(ray.direction.z) < 1e-12) return null
    const t = -ray.origin.z / ray.direction.z
    return [ray.origin.x + ray.direction.x * t, ray.origin.y + ray.direction.y * t]
  }

  /** Match the main viewport's buttons — minus orbiting, which planar mode
   *  turns into panning whatever the scheme says. */
  setNavScheme(scheme: ControlScheme): void {
    this.viewport.setNavScheme(scheme)
  }

  setViewTheme(theme: ViewTheme): void {
    this.viewport.setTheme(theme)
  }

  /** How heavy a fitted curve is drawn, in pixels (Settings → Lines). The
   *  callouts and pin marks drawn with the curves follow in proportion, and
   *  what is already on the sheet takes the new width without a rebuild. */
  setLineWidth(px: number): void {
    const scale = px / SHEET_LINE_DEFAULT
    if (scale === this.lineScale) return
    this.lineScale = scale
    for (const [m, nominal] of this.lineMaterials) m.linewidth = nominal * scale
    this.viewport.invalidate()
  }

  /** The colour of the edge chains — the sketch draws its slice in one
   *  that reads against the cut part under it. */
  setEdgeColor(color: THREE.ColorRepresentation, opacity = 0.85): void {
    this.edgeMaterial.color.set(color)
    this.edgeMaterial.opacity = opacity
    this.viewport.invalidate()
  }

  /** How heavy the edge chains are drawn, in pixels (Settings → Lines) —
   *  independent of the curves fitted to them. */
  setEdgeWidth(px: number): void {
    if (this.edgeMaterial.linewidth === px) return
    this.edgeMaterial.linewidth = px
    this.viewport.invalidate()
  }

  dispose(): void {
    this.container.removeEventListener('pointermove', this.hoverMove)
    this.container.style.cursor = ''
    this.dropBand()
    this.setGrid(null)
    this.setCalibrationPicks([])
    this.setFlatFills([])
    this.setFlatDots([])
    this.dotTexture?.dispose()
    this.setCounts([])
    this.setNotes([])
    this.setFlatElements([])
    this.setFlatDimensions([])
    this.setDraftMarks([], null)
    this.setEdgeChains(null)
    this.dropBox()
    this.edgeMaterial.dispose()
    this.texture?.dispose()
    this.material.dispose()
    this.geometry.dispose()
    this.viewport.dispose()
  }
}
