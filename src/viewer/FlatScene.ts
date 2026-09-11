// SPDX-License-Identifier: AGPL-3.0-only
import * as THREE from 'three'
import { Line2 } from 'three/addons/lines/Line2.js'
import { LineGeometry } from 'three/addons/lines/LineGeometry.js'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js'
import { gridSpacing } from '../core/flat/datum'
import type { EdgeChains } from '../core/flat/edges'
import { splineMidpoint, splinePolyline, type HandleEnd, type SplineHandle } from '../core/flat/spline'
import type { FlatFit, Vec2 } from '../core/flat/types'
import type { PixelsPerMm } from '../core/flat/image'
import { SHEET_LINE_DEFAULT } from './lineWidths'
import type { ControlScheme } from './navSchemes'
import { OrthoViewport } from './orthoViewport'
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
  /** Quarter turns the sheet is shown at, counter-clockwise on screen. The
   *  camera rolls; the sheet and everything drawn on it stay in document
   *  units, so a pick lands where it lands whichever way up it is looked at. */
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
  /** Measured elements and the draft being built, in document units. */
  private elementGroup = new THREE.Group()
  private elementCleanup: (() => void)[] = []
  private dimensionGroup = new THREE.Group()
  private dimensionCleanup: (() => void)[] = []
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
  private edgeSegments: THREE.LineSegments | null = null
  private edgeMaterial = new THREE.LineBasicMaterial({
    color: 0x11b5a5,
    transparent: true,
    opacity: 0.85,
    depthTest: false,
  })

  /** A click on the sheet, in document millimetres — with whether Alt was
   *  held (a raw, unsnapped pick) and the scale of the moment, so the caller
   *  can turn "a few screen pixels" into document units. */
  onPick: ((p: Vec2, meta: { alt: boolean; unitsPerScreenPx: number }) => void) | null = null
  /** A dragged region (document units), while region mode is armed. */
  onRegion: ((min: Vec2, max: Vec2) => void) | null = null
  /** The cursor over the sheet (document units) or off it — for the loupe. */
  onHoverPoint: ((p: Vec2 | null, clientX: number, clientY: number) => void) | null = null
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

  /** Left-drag selects a region (and a plain click picks a whole edge)
   *  instead of panning while an edge tool is collecting. */
  private regionMode = false
  private bandStart: { x: number; y: number } | null = null
  private bandDiv: HTMLDivElement | null = null

  constructor(private container: HTMLDivElement, theme: ViewTheme) {
    this.viewport = new OrthoViewport(container, {
      theme,
      navTargets: () => (this.sheet.visible ? [this.sheet] : []),
      onClick: (x, y, e) => {
        const p = this.pick(x, y)
        if (p) this.onPick?.(p, { alt: e?.altKey ?? false, unitsPerScreenPx: this.unitsPerScreenPx() })
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
        if (!this.regionMode) return false
        this.beginBand(e)
        return true
      },
      onTick: () => {
        // Zoom walked the grid onto a different rung of its spacing ladder.
        if (this.gridFrame && this.gridSpacingDrawn !== gridSpacing(this.unitsPerScreenPx())) {
          this.rebuildGrid()
        }
        // Fat lines are sized in screen pixels and need to know the canvas.
        const el = this.viewport.renderer.domElement
        const w = el.clientWidth || 1
        const h = el.clientHeight || 1
        if (this.lineResolution.x !== w || this.lineResolution.y !== h) {
          this.lineResolution.set(w, h)
          for (const m of this.lineMaterials.keys()) m.resolution.copy(this.lineResolution)
          this.viewport.invalidate()
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
    this.viewport.scene.add(this.elementGroup)
    this.viewport.scene.add(this.dimensionGroup)
    this.viewport.scene.add(this.draftGroup)
  }

  /** The measured dimensions on the sheet: a callout line with its value for
   *  a distance, two rays and a swept arc for an angle. */
  setFlatDimensions(
    items: readonly {
      title: string
      value: string
      segment?: [Vec2, Vec2]
      arc?: { vertex: Vec2; dirA: Vec2; dirB: Vec2 }
    }[],
  ): void {
    for (const dispose of this.dimensionCleanup) dispose()
    this.dimensionCleanup = []
    this.dimensionGroup.clear()
    const callout = 0x666e79
    for (const item of items) {
      if (item.segment) {
        this.addPolylines(this.dimensionGroup, this.dimensionCleanup, [item.segment], callout, 0.85, 0.16, 2.5)
        this.addDimLabel(
          [(item.segment[0][0] + item.segment[1][0]) / 2, (item.segment[0][1] + item.segment[1][1]) / 2],
          item.title,
          item.value,
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
        )
      }
    }
    this.viewport.invalidate()
  }

  private addDimLabel(at: Vec2, title: string, value: string): void {
    const div = document.createElement('div')
    div.className = 'viewport-label distance-label'
    const t = document.createElement('div')
    t.className = 'label-title'
    t.textContent = title
    div.append(t)
    const v = document.createElement('div')
    v.className = 'label-value'
    v.textContent = value
    div.append(v)
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
    const frame = this.gridFrame
    if (!frame || !this.sheet.visible) {
      this.viewport.invalidate()
      return
    }
    const s = gridSpacing(this.unitsPerScreenPx())
    this.gridSpacingDrawn = s

    // The sheet's corners in frame coordinates bound what needs lines.
    const { x0, y0, x1, y1 } = this.bounds
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
    this.viewport.nav.setPaintMode(this.regionMode || this.pinHover)
  }

  private setPinHover(on: boolean): void {
    if (this.pinHover === on) return
    this.pinHover = on
    this.claimDrag()
    this.container.style.cursor = on ? 'grab' : ''
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
    this.onHoverPoint(p, e.clientX, e.clientY)
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
      this.container.style.cursor = this.pinHover ? 'grab' : ''
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
      this.container.style.cursor = this.pinHover ? 'grab' : ''
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
    const div = document.createElement('div')
    div.className = 'viewport-label element-label'
    const t = document.createElement('div')
    t.className = 'label-title'
    t.textContent = title
    t.style.color = color
    div.append(t)
    if (value) {
      const v = document.createElement('div')
      v.className = 'label-value'
      v.textContent = value
      div.append(v)
    }
    const label = new CSS2DObject(div)
    label.position.set(at[0], at[1], 0.2)
    group.add(label)
    cleanup.push(() => div.remove())
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
    items: readonly { fit: FlatFit; color: string; name: string; value: string }[],
  ): void {
    for (const dispose of this.elementCleanup) dispose()
    this.elementCleanup = []
    this.elementGroup.clear()
    for (const item of items) {
      this.addPolylines(this.elementGroup, this.elementCleanup, this.fitPolyline(item.fit), item.color, 0.95, 0.15)
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

  /** The draft on its way to an element: numbered pins on hand picks (which
   *  can be dragged), a dot cloud for region-collected points (thousands of
   *  pins would be thousands of DOM nodes), the pending fit drawn in the
   *  colour the element will have, and — for a spline — a tangent handle
   *  through every pick, its two ends draggable, in the tool amber. */
  setDraftMarks(
    picks: readonly Vec2[],
    fit: FlatFit | null,
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
    if (fit) {
      this.addPolylines(this.draftGroup, this.draftCleanup, this.fitPolyline(fit), color, 0.9, 0.18)
    }
    this.viewport.invalidate()
  }

  /** Show detected edge chains (image-pixel coordinates), or clear them with
   *  null. One LineSegments holds every chain — tens of thousands of segments
   *  are one draw call. */
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
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
      this.edgeSegments = new THREE.LineSegments(geometry, this.edgeMaterial)
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
  setNotes(items: readonly { id: number; text: string; at: Vec2; editing: boolean }[]): void {
    for (const dispose of this.noteCleanup) dispose()
    this.noteCleanup = []
    this.noteGroup.clear()
    for (const item of items) {
      const div = document.createElement('div')
      div.className = 'viewport-label note-label' + (item.editing ? ' editing' : '')
      div.dataset.test = `flat-note-${item.id}`
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
      const label = new CSS2DObject(div)
      // Anchored at its lower-left: the spot clicked is where the text begins.
      label.center.set(0, 1)
      label.position.set(item.at[0], item.at[1], 0.15)
      this.noteGroup.add(label)
      this.noteCleanup.push(() => {
        div.removeEventListener('pointerdown', down)
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
   * lands on, so it has to reach a little past the last edge.
   */
  setBlankSheet(min: Vec2, max: Vec2): void {
    this.texture?.dispose()
    this.texture = null
    this.material.map = null
    this.material.color.set(0xf4f5f7)
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

  /** Frame the whole sheet, face on, turned as asked — y up at no turns. */
  frame(): void {
    if (!this.sheet.visible) return
    const box = new THREE.Box3().setFromObject(this.sheet)
    this.viewport.frameCamera(box, null, {
      dir: new THREE.Vector3(0, 0, 1),
      up: this.screenUp(),
    })
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

  /** The document direction that points up the screen at the current turn:
   *  +Y untouched, then +X, −Y, −X as the sheet goes round counter-clockwise
   *  — what was to the right of the origin is above it after one turn. */
  private screenUp(): THREE.Vector3 {
    const ups: [number, number][] = [
      [0, 1],
      [1, 0],
      [0, -1],
      [-1, 0],
    ]
    const [x, y] = ups[this.turns]
    return new THREE.Vector3(x, y, 0)
  }

  private pick(clientX: number, clientY: number): Vec2 | null {
    if (!this.sheet.visible) return null
    this.viewport.setPickRay(clientX, clientY)
    const hit = this.viewport.raycaster.intersectObject(this.sheet, false)[0]
    return hit ? [hit.point.x, hit.point.y] : null
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

  dispose(): void {
    this.container.removeEventListener('pointermove', this.hoverMove)
    this.container.style.cursor = ''
    this.dropBand()
    this.setGrid(null)
    this.setCalibrationPicks([])
    this.setCounts([])
    this.setNotes([])
    this.setFlatElements([])
    this.setFlatDimensions([])
    this.setDraftMarks([], null)
    this.setEdgeChains(null)
    this.edgeMaterial.dispose()
    this.texture?.dispose()
    this.material.dispose()
    this.geometry.dispose()
    this.viewport.dispose()
  }
}
