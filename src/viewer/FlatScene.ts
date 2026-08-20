// SPDX-License-Identifier: AGPL-3.0-only
import * as THREE from 'three'
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js'
import type { EdgeChains } from '../core/flat/edges'
import type { FlatFit, Vec2 } from '../core/flat/types'
import type { PixelsPerMm } from '../core/flat/image'
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
  /** The calibration tool's picks, drawn over the sheet. */
  private calGroup = new THREE.Group()
  private calCleanup: (() => void)[] = []
  /** Measured elements and the draft being built, in document units. */
  private elementGroup = new THREE.Group()
  private elementCleanup: (() => void)[] = []
  private draftGroup = new THREE.Group()
  private draftCleanup: (() => void)[] = []
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

  /** Left-drag selects a region instead of panning while an edge tool is
   *  collecting. */
  private regionMode = false
  private bandStart: { x: number; y: number } | null = null
  private bandDiv: HTMLDivElement | null = null

  constructor(private container: HTMLDivElement, theme: ViewTheme) {
    this.viewport = new OrthoViewport(container, {
      theme,
      navTargets: () => (this.imagePx.width ? [this.sheet] : []),
      onClick: (x, y, e) => {
        const p = this.pick(x, y)
        if (p) this.onPick?.(p, { alt: e?.altKey ?? false, unitsPerScreenPx: this.unitsPerScreenPx() })
      },
      onPointerDown: (e) => {
        if (!this.regionMode || e.button !== 0 || !this.sheet.visible) return false
        this.beginBand(e)
        return true
      },
    })
    this.container.addEventListener('pointermove', this.hoverMove)
    this.viewport.nav.setPlanar(true)

    // Unlit: the scan is a document, not a body — the lights must not shade it.
    this.material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })
    this.sheet = new THREE.Mesh(this.geometry, this.material)
    this.sheet.visible = false
    this.viewport.scene.add(this.sheet)
    this.viewport.scene.add(this.calGroup)
    this.viewport.scene.add(this.edgeGroup)
    this.viewport.scene.add(this.elementGroup)
    this.viewport.scene.add(this.draftGroup)
  }

  /** Arm or disarm region selection. Armed, a plain left-drag rubber-bands a
   *  box instead of panning — paint mode moves the navigator's plain-drag
   *  bindings out of the way, exactly as the 3D brush does, so Shift+drag
   *  and the middle button still pan. */
  setRegionMode(on: boolean): void {
    if (this.regionMode === on) return
    this.regionMode = on
    this.viewport.nav.setPaintMode(on)
    if (!on) this.dropBand()
  }

  private hoverMove = (e: PointerEvent): void => {
    if (!this.onHoverPoint) return
    const p = this.sheet.visible ? this.pick(e.clientX, e.clientY) : null
    this.onHoverPoint(p, e.clientX, e.clientY)
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
      this.finishBand(ev.clientX, ev.clientY)
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

  private finishBand(x: number, y: number): void {
    const start = this.bandStart
    this.dropBand()
    if (!start) return
    // A twitch is not a region.
    if (Math.abs(x - start.x) + Math.abs(y - start.y) < 6) return
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
    return Math.hypot(this.imagePx.width * this.mmPerPx.x, this.imagePx.height * this.mmPerPx.y) || 1
  }

  private addPolylines(
    group: THREE.Group,
    cleanup: (() => void)[],
    polylines: Vec2[][],
    color: THREE.ColorRepresentation,
    opacity: number,
    z: number,
  ): void {
    const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: false })
    cleanup.push(() => mat.dispose())
    for (const pts of polylines) {
      const geo = new THREE.BufferGeometry().setFromPoints(
        pts.map((p) => new THREE.Vector3(p[0], p[1], z)),
      )
      const line = new THREE.Line(geo, mat)
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

  /** The draft on its way to an element: numbered pins on hand picks, a dot
   *  cloud for region-collected points (thousands of pins would be thousands
   *  of DOM nodes), and the pending fit as a ghost. */
  setDraftMarks(picks: readonly Vec2[], fit: FlatFit | null, cloud?: readonly Vec2[]): void {
    for (const dispose of this.draftCleanup) dispose()
    this.draftCleanup = []
    this.draftGroup.clear()
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
        color: 0xffb020,
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
      div.style.background = '#8b95a3'
      const label = new CSS2DObject(div)
      label.position.set(p[0], p[1], 0.2)
      this.draftGroup.add(label)
      this.draftCleanup.push(() => div.remove())
    })
    if (fit) {
      this.addPolylines(this.draftGroup, this.draftCleanup, this.fitPolyline(fit), 0x8b95a3, 0.9, 0.18)
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
    this.material.needsUpdate = true

    this.sheet.visible = true
    this.layoutSheet()
    this.frame()
  }

  /** The calibration changed: same pixels, different millimetres. */
  setScale(mmPerPx: PixelsPerMm): void {
    this.mmPerPx = { ...mmPerPx }
    if (!this.imagePx.width) return
    this.layoutSheet()
    this.frame()
  }

  /** Size the unit plane to the document and put its bottom-left at the origin. */
  private layoutSheet(): void {
    const w = this.imagePx.width * this.mmPerPx.x
    const h = this.imagePx.height * this.mmPerPx.y
    this.sheet.scale.set(w, h, 1)
    this.sheet.position.set(w / 2, h / 2, 0)
    this.sheet.updateMatrixWorld(true)
    this.layoutEdges()
    this.viewport.invalidate()
  }

  /** Frame the whole sheet, face on, y up. */
  frame(): void {
    if (!this.imagePx.width) return
    const box = new THREE.Box3().setFromObject(this.sheet)
    this.viewport.frameCamera(box, null, {
      dir: new THREE.Vector3(0, 0, 1),
      up: new THREE.Vector3(0, 1, 0),
    })
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

  dispose(): void {
    this.container.removeEventListener('pointermove', this.hoverMove)
    this.dropBand()
    this.setCalibrationPicks([])
    this.setFlatElements([])
    this.setDraftMarks([], null)
    this.setEdgeChains(null)
    this.edgeMaterial.dispose()
    this.texture?.dispose()
    this.material.dispose()
    this.geometry.dispose()
    this.viewport.dispose()
  }
}
