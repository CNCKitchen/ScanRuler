// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Surface marking: the brush, the window and the lasso, and the footprint and
 * rubber band drawn for them.
 *
 * The marking itself — which vertices are covered, what colour they wear — is
 * the compositor's (see regionColors); this module owns the gestures that lay
 * it down. It talks to the rest of the viewport only through the context it is
 * handed: the mesh and its colour attribute, the pick ray, the part group's
 * frame, and the drag claim on the camera.
 */
import * as THREE from 'three'
import { INTERSECTED, NOT_INTERSECTED } from 'three-mesh-bvh'
import type { RegionColors } from './regionColors'

/** How a marking gesture takes surface: dragged over it with a round brush,
 *  swept with a rectangular window, or ringed with a freehand lasso. The last
 *  two are screen-space and take everything they enclose in one go, which is
 *  what makes excluding a whole riser or a run of spray practical. */
export type MarkGesture = 'brush' | 'window' | 'lasso'

/** The surface marking: a fit is measured on exactly what it covers, instead
 *  of on a region grown from a click or on the whole scan. */
export interface PaintBrush {
  /** Tint of the marked surface — the colour the pending element will get. */
  color: string
  /** Width of the brush on the surface, in the scan's own units (mm). */
  diameter: number
  /** Left-drag rubs the marking out instead of laying it down. Right-drag
   *  always rubs out, and Alt inverts whichever way the switch is set. */
  erase: boolean
  /** Which gesture marks. Defaults to the brush.
   *
   *  Explicitly null means armed but idle: the marking stays on the part and
   *  keeps its tint, no gesture takes or gives back surface, and the camera
   *  keeps both plain drags. That is the state both marking sessions — a
   *  hand-marked element and the local fine fit — open in and return to
   *  between markings; a tool that quietly held the mouse buttons hostage for
   *  as long as its panel was open would be a trap. */
  gesture?: MarkGesture | null
  /** Take triangles facing away from the camera as well. Off by default,
   *  because a window dragged over a closed part would otherwise mark the far
   *  wall along with the near one — and on a scan the far wall is usually the
   *  one you cannot see to judge. */
  backfaces?: boolean
}

/** A window or lasso being dragged: where it started, the outline so far, and
 *  which way it will go — decided when the button went down, so that letting
 *  go of Alt half way through does not turn a rub-out into a marking. */
interface Marquee {
  gesture: 'window' | 'lasso'
  erase: boolean
  /** Container-local pixels, the same frame the outline is drawn in. */
  points: { x: number; y: number }[]
  /** Where the container sat when the drag began, so client coordinates can be
   *  converted without asking the layout engine on every move. */
  origin: { left: number; top: number }
}

/** The brush footprint, drawn on the surface under the cursor: what a stroke
 *  would take, before it takes it. Erasing shows in the ring's own colour, so
 *  the mode is visible where the user is looking rather than only in the
 *  panel. */
const BRUSH_ERASE_COLOR = 0x26282a

/** A colour string as the compositor's byte triple. */
export function colorToRgb(color: string): [number, number, number] {
  const c = new THREE.Color(color)
  return [Math.round(c.r * 255), Math.round(c.g * 255), Math.round(c.b * 255)]
}

/** The four corners of the window, from the two the user dragged between. */
function rectanglePoints(
  a: { x: number; y: number },
  b: { x: number; y: number },
): { x: number; y: number }[] {
  return [
    { x: a.x, y: a.y },
    { x: b.x, y: a.y },
    { x: b.x, y: b.y },
    { x: a.x, y: b.y },
  ]
}

/** Point-in-polygon by crossing number, with the outline's bounding box in
 *  front of it. The box rejects the great majority of a part's triangles for
 *  four comparisons, which matters when the test runs once per triangle of a
 *  million-triangle scan. A lasso that crosses itself is filled by the
 *  odd-even rule — the same thing every drawing program does with one. */
function polygonTester(outline: { x: number; y: number }[]): (x: number, y: number) => boolean {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of outline) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x)
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y)
  }
  const n = outline.length
  return (x, y) => {
    if (x < minX || x > maxX || y < minY || y > maxY) return false
    let inside = false
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const yi = outline[i].y
      const yj = outline[j].y
      if (yi > y === yj > y) continue
      const xi = outline[i].x
      if (x < ((outline[j].x - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
    }
    return inside
  }
}

/** A triangle's raw (unnormalised) normal from its winding — the one edge
 *  cross product both the facing test and the brush's face check run on. */
function rawFaceNormal(
  pos: Float32Array,
  a: number,
  b: number,
  c: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2]
  const ux = pos[b * 3] - ax, uy = pos[b * 3 + 1] - ay, uz = pos[b * 3 + 2] - az
  const vx = pos[c * 3] - ax, vy = pos[c * 3 + 1] - ay, vz = pos[c * 3 + 2] - az
  return out.set(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx)
}

/** Scratch for the facing test, which runs once per triangle of the scan and
 *  must not allocate. */
const facingScratch = new THREE.Vector3()

/** Whether a triangle's front side is the one being looked at, from its
 *  winding and the view direction in the same (part-local) frame. */
function facesCamera(
  pos: Float32Array,
  a: number,
  b: number,
  c: number,
  view: THREE.Vector3,
): boolean {
  return rawFaceNormal(pos, a, b, c, facingScratch).dot(view) < 0
}

/** Everything the marking is allowed to touch outside itself. */
export interface MarkingContext {
  container: HTMLDivElement
  camera: THREE.OrthographicCamera
  partGroup: THREE.Group
  raycaster: THREE.Raycaster
  regions: RegionColors
  setPickRay(clientX: number, clientY: number): void
  mesh(): THREE.Mesh | null
  colorAttr(): THREE.BufferAttribute | null
  invalidate(): void
  /** Take the plain drags off the camera while a gesture is live. */
  claimDrag(on: boolean): void
  /** Ask for a hover pass on the next frame (the footprint follows settings
   *  even if the cursor never moves again). */
  requestHover(): void
  /** How many vertices the marking covers, reported when a gesture ends. */
  onPaintChange(count: number): void
}

export class SurfaceMarking {
  private paint: PaintBrush | null = null
  private painting = false
  private paintLast: { x: number; y: number } | null = null
  /** The opening dab of a touch stroke, held back until the finger proves it
   *  meant to mark — see handlePointerDown. */
  private pendingDab: { x: number; y: number; erase: boolean } | null = null
  /** Pointer positions a stroke has covered since the last frame. Dabs are
   *  laid from here once per frame rather than per pointermove: a gaming mouse
   *  reports up to a thousand moves a second, each dab is a raycast plus a BVH
   *  sweep, and nothing between two frames is ever seen anyway. */
  private strokeQueue: { x: number; y: number; erase: boolean }[] = []
  private paintSphere = new THREE.Sphere()
  /** Scratch for the per-triangle brush test, which runs thousands of times
   *  per stroke and must not allocate. */
  private scratchA = new THREE.Vector3()
  private scratchB = new THREE.Vector3()
  private scratchC = new THREE.Vector3()
  /** Scratch carrying a hit point into the part's frame. Separate from the
   *  trio above so a dab can hold its centre while the brush test churns
   *  through those. */
  private scratchD = new THREE.Vector3()
  /** Whether the brush would rub out right now — from the switch, from Alt, or
   *  from the right button being the one that is down. Drives the ring colour. */
  private paintErasing = false
  /** Footprint of the brush on the surface: a ring the size of a stroke, laid
   *  flat on the face under the cursor. Rides in the part's group, so it stays
   *  put on the scan whatever the alignment does. */
  private brushRing: THREE.LineLoop
  private brushRingMaterial: THREE.LineBasicMaterial
  /** The window or lasso in flight, and the outline drawn for it. An SVG over
   *  the canvas rather than a line in the scene: the gesture is a screen-space
   *  one, and a rubber band that swung about with the part would be unusable. */
  private marquee: Marquee | null = null
  private marqueeSvg: SVGSVGElement
  private marqueeShape: SVGPolygonElement

  constructor(private ctx: MarkingContext) {
    const NS = 'http://www.w3.org/2000/svg'
    this.marqueeSvg = document.createElementNS(NS, 'svg')
    this.marqueeSvg.setAttribute('class', 'marquee')
    this.marqueeShape = document.createElementNS(NS, 'polygon')
    this.marqueeSvg.append(this.marqueeShape)
    this.marqueeSvg.style.display = 'none'
    ctx.container.appendChild(this.marqueeSvg)

    // Unit circle in XY, turned to lie on whatever face it is over. Drawn over
    // the part rather than into it: a ring that lost the depth test against
    // the very surface it is lying on would flicker with every wobble of the
    // scan.
    const ringPoints: THREE.Vector3[] = []
    for (let i = 0; i < 96; i++) {
      const a = (i / 96) * Math.PI * 2
      ringPoints.push(new THREE.Vector3(Math.cos(a), Math.sin(a), 0))
    }
    this.brushRingMaterial = new THREE.LineBasicMaterial({
      color: 0xffffff,
      depthTest: false,
      transparent: true,
      opacity: 0.95,
    })
    this.brushRing = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(ringPoints),
      this.brushRingMaterial,
    )
    this.brushRing.renderOrder = 5
    this.brushRing.visible = false
    ctx.partGroup.add(this.brushRing)

    // A stroke that runs off the edge of the viewport keeps painting, and one
    // released outside it still ends — same reasoning as the navigator's. A
    // cancelled pointer (a finger the system takes back) ends it too, or the
    // brush would keep laying marking down after the hand has left.
    document.addEventListener('pointermove', this.onPaintMove)
    document.addEventListener('pointerup', this.onPaintUp)
    document.addEventListener('pointercancel', this.onPaintUp)
  }

  /** Whether the brush is armed at all — footprint updates hang off this. */
  armed(): boolean {
    return this.paint !== null
  }

  /** Whether a gesture is armed, never mind the scan's visibility — this is
   *  what decides whether a grip may light up under the cursor. */
  gestureArmed(): boolean {
    return this.paint !== null && this.gestureOf(this.paint) !== null
  }

  /** The gesture a pointerdown would start. Nothing is marked on a scan that
   *  is switched off: a gesture over a hidden part would take surface the user
   *  cannot see to judge, and the window and lasso do not raycast, so nothing
   *  else would stop them. */
  pointerGesture(): MarkGesture | null {
    return this.paint && this.ctx.mesh()?.visible ? this.gestureOf(this.paint) : null
  }

  /**
   * A pointerdown while a gesture is live. With the brush armed, a plain drag
   * is a stroke: left lays the marking down, right takes it away — the
   * navigator has stepped both of those bindings aside for exactly this.
   * Anything with a modifier still belongs to the camera. Returns whether the
   * event was taken.
   */
  handlePointerDown(e: PointerEvent): boolean {
    const gesture = this.pointerGesture()
    if (!gesture) return false
    if ((e.button !== 0 && e.button !== 2) || e.shiftKey || e.ctrlKey || e.metaKey) return false
    const erase = this.eraseFor(e.button === 2, e.altKey)
    this.painting = true
    if (gesture === 'brush') {
      this.paintLast = null
      // A finger that has just landed cannot yet say whether it is a stroke or
      // the first half of a pinch, so its opening dab waits: it lands on the
      // first move, or on the release if the tap never moved, and a second
      // finger arriving before either calls the whole gesture off with nothing
      // marked. A mouse has no such ambiguity and dabs at once.
      if (e.pointerType === 'touch') this.pendingDab = { x: e.clientX, y: e.clientY, erase }
      else this.stroke(e.clientX, e.clientY, erase)
    } else {
      this.beginMarquee(gesture, erase, e.clientX, e.clientY)
    }
    return true
  }

  /** Land the held-back opening dab of a touch stroke, if there is one. */
  private flushPendingDab(): void {
    if (!this.pendingDab) return
    this.strokeQueue.push(this.pendingDab)
    this.pendingDab = null
  }

  /**
   * Arm the brush, change what it does, or (with null) put it away.
   *
   * Re-arming keeps whatever is already marked: the panel calls this on every
   * change of radius or of the erase switch, and a stroke the user has already
   * laid down must survive reaching for the slider.
   */
  setPaintBrush(brush: PaintBrush | null): void {
    const wasOn = this.paint !== null
    this.paint = brush
    // Only a live gesture takes the plain drags away from the camera. Idle —
    // and that is the state both marking sessions open in — the camera keeps
    // everything it normally has.
    const gesture = brush && this.gestureOf(brush)
    this.ctx.claimDrag(gesture !== null)
    if (!brush) {
      this.painting = false
      this.paintLast = null
      this.pendingDab = null
      this.strokeQueue.length = 0
      this.paintErasing = false
      this.brushRing.visible = false
      this.endMarquee()
      this.clearPaint()
      return
    }
    // Switching gesture mid-session leaves the marking alone but takes the
    // footprint of the old one off the part, and abandons anything in flight.
    if (gesture !== 'brush') this.brushRing.visible = false
    if (gesture === null) {
      this.painting = false
      this.paintLast = null
      this.strokeQueue.length = 0
      this.endMarquee()
    }
    // The footprint follows the settings even if the cursor never moves again.
    this.ctx.requestHover()
    this.paintErasing = brush.erase
    this.updateRingColor()
    const changed = this.ctx.regions.setPaintColor(colorToRgb(brush.color))
    const recolour = wasOn && changed
    this.ctx.regions.ensurePaintMask()
    const attr = this.ctx.colorAttr()
    if (recolour && this.ctx.regions.paintCount > 0 && attr) {
      this.ctx.regions.applyPaint()
      attr.needsUpdate = true
    }
    this.ctx.invalidate()
  }

  /** Which gesture a marker is set to, with the brush standing in for a caller
   *  that never said. Null is a deliberate idle, not an omission. */
  private gestureOf(brush: PaintBrush): MarkGesture | null {
    return brush.gesture === undefined ? 'brush' : brush.gesture
  }

  /**
   * Put a marking back on the part — the surface an element was measured on,
   * when that element is re-opened for editing.
   *
   * Called before the brush itself is armed (the panel does that on its next
   * render), so it sets up the mask and the colour the same way arming would;
   * setPaintBrush then finds both in place and leaves them alone.
   */
  setPaintedVertices(vertices: Uint32Array, colorHex: string): void {
    if (!this.ctx.mesh()) return
    this.ctx.regions.setPaintColor(colorToRgb(colorHex))
    if (!this.ctx.regions.setPaintedVertices(vertices)) return
    const attr = this.ctx.colorAttr()
    if (!attr) return
    attr.needsUpdate = true
    this.ctx.invalidate()
  }

  /** Rub out the whole marking and hand the surface back to whatever was
   *  underneath it. */
  clearPaint(): void {
    if (!this.ctx.regions.clearPaint()) return
    const attr = this.ctx.colorAttr()
    if (attr) attr.needsUpdate = true
    this.ctx.invalidate()
  }

  /** One dab per few pixels along the segment the pointer covered, so a fast
   *  drag paints a stroke rather than a dotted line. */
  private stroke(x: number, y: number, erase: boolean): void {
    const last = this.paintLast
    const steps = last
      ? Math.min(24, Math.max(1, Math.round(Math.hypot(x - last.x, y - last.y) / 5)))
      : 1
    for (let i = 1; i <= steps; i++) {
      const t = i / steps
      this.dab(last ? last.x + (x - last.x) * t : x, last ? last.y + (y - last.y) * t : y, erase)
    }
    this.paintLast = { x, y }
    const attr = this.ctx.colorAttr()
    if (attr) attr.needsUpdate = true
    this.ctx.invalidate()
  }

  /**
   * Mark (or unmark) every triangle the brush touches, by marking its corners.
   *
   * Triangles rather than corners on their own, because a triangle is what the
   * user sees change colour: a vertex-only rule on a coarse mesh paints a wide
   * patch — the tint is interpolated across each triangle — while handing the
   * fit the two or three corners that happened to fall inside the brush. What
   * is marked has to be what is measured.
   *
   * A ball around the hit point would also reach straight through a thin wall
   * and mark the far side, which is invisible from here and would quietly
   * corrupt the fit — so a triangle has to face roughly the way the surface
   * under the cursor does. That same test keeps a stroke near an edge from
   * spilling onto the face around the corner.
   */
  private dab(clientX: number, clientY: number, erase: boolean): void {
    const mesh = this.ctx.mesh()
    const brush = this.paint
    if (!mesh || !brush || !this.ctx.colorAttr()) return
    this.ctx.regions.ensurePaintMask()

    this.ctx.setPickRay(clientX, clientY)
    const hit = this.ctx.raycaster.intersectObject(mesh, false)[0]
    if (!hit || hit.faceIndex === undefined || hit.faceIndex === null) return

    const geometry = mesh.geometry as THREE.BufferGeometry
    const bvh = geometry.boundsTree
    const index = geometry.getIndex()
    if (!bvh || !index) return
    const idx = index.array as ArrayLike<number>
    const pos = (geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array

    // The hit arrives in world space, which is the reference's frame once the
    // scan has been aligned; everything below is in the scan's own. scratchD
    // holds the centre across the sweep — the trio below is the sweep's.
    this.ctx.partGroup.updateWorldMatrix(true, false)
    const centre = this.ctx.partGroup.worldToLocal(this.scratchD.copy(hit.point))
    const f = hit.faceIndex * 3
    const face = this.faceNormal(pos, idx[f], idx[f + 1], idx[f + 2])
    if (!face) return

    const radius = Math.max(brush.diameter / 2, 1e-6)
    this.paintSphere.center.copy(centre)
    this.paintSphere.radius = radius
    const sphere = this.paintSphere
    const regions = this.ctx.regions
    const near = this.scratchA
    const edge1 = this.scratchB
    const edge2 = this.scratchC
    // With back faces allowed the brush marks straight through: the test that
    // keeps a stroke on the face under the cursor is the same one that keeps
    // it off the far wall, so switching it off does both.
    const anyFacing = brush.backfaces === true

    bvh.shapecast({
      intersectsBounds: (box) => (sphere.intersectsBox(box) ? INTERSECTED : NOT_INTERSECTED),
      intersectsTriangle: (tri, triIndex) => {
        // The box the BVH pruned by is not the triangle: check the triangle
        // itself before taking it.
        tri.closestPointToPoint(centre, near)
        if (near.distanceToSquared(centre) > radius * radius) return false
        // Same winding convention as the face under the cursor, so the two
        // normals can be compared at all.
        if (!anyFacing) {
          edge1.subVectors(tri.b, tri.a)
          edge2.subVectors(tri.c, tri.a)
          edge1.cross(edge2)
          if (edge1.dot(face) <= 0) return false
        }
        const f = triIndex * 3
        regions.markVertex(idx[f], erase)
        regions.markVertex(idx[f + 1], erase)
        regions.markVertex(idx[f + 2], erase)
        return false
      },
    })
  }

  /** A triangle's unit normal, or null for a degenerate sliver that has no
   *  direction to compare anything against. */
  private faceNormal(
    pos: Float32Array,
    a: number,
    b: number,
    c: number,
  ): THREE.Vector3 | null {
    const n = rawFaceNormal(pos, a, b, c, new THREE.Vector3())
    if (n.lengthSq() < 1e-24) return null
    return n.normalize()
  }

  // ---- window and lasso ----------------------------------------------------

  private beginMarquee(
    gesture: 'window' | 'lasso',
    erase: boolean,
    clientX: number,
    clientY: number,
  ): void {
    const box = this.ctx.container.getBoundingClientRect()
    const origin = { left: box.left, top: box.top }
    this.marquee = {
      gesture,
      erase,
      origin,
      points: [{ x: clientX - origin.left, y: clientY - origin.top }],
    }
    this.marqueeShape.setAttribute('class', erase ? 'erase' : '')
    this.marqueeSvg.style.display = ''
    this.drawMarquee()
  }

  private extendMarquee(clientX: number, clientY: number): void {
    const m = this.marquee
    if (!m) return
    const p = { x: clientX - m.origin.left, y: clientY - m.origin.top }
    if (m.gesture === 'window') {
      // A window is its two corners and nothing else, however the cursor got
      // from one to the other.
      m.points[1] = p
    } else {
      // Thinning the trail keeps the point-in-polygon test — which runs once
      // per vertex of the scan — from carrying a thousand edges for a gesture
      // a hundred would describe.
      const last = m.points[m.points.length - 1]
      if (Math.hypot(p.x - last.x, p.y - last.y) < 4) return
      m.points.push(p)
    }
    this.drawMarquee()
  }

  private drawMarquee(): void {
    const m = this.marquee
    if (!m) return
    const outline =
      m.gesture === 'window' ? rectanglePoints(m.points[0], m.points[1] ?? m.points[0]) : m.points
    this.marqueeShape.setAttribute('points', outline.map((p) => `${p.x},${p.y}`).join(' '))
  }

  private endMarquee(): void {
    this.marquee = null
    this.marqueeSvg.style.display = 'none'
  }

  /**
   * Take every triangle the outline encloses.
   *
   * A triangle counts when its centre falls inside — the resolution of a scan
   * is far finer than anything drawn by hand, so where exactly the boundary
   * cuts a single triangle is below the noise of the gesture itself.
   *
   * There is no depth buffer in this: what stops a window from marking the
   * whole part front to back is the facing test, which is how every CAD
   * selection does it and is why "include back faces" is a switch the user
   * holds. On an open scan seen through a hole, surface behind the cursor
   * *facing this way* is marked too — which is the honest answer, since from
   * this side of the part there is nothing to tell it apart from the near
   * wall.
   */
  private markMarquee(outline: { x: number; y: number }[], erase: boolean): void {
    const mesh = this.ctx.mesh()
    const marker = this.paint
    if (!mesh || !marker || !this.ctx.colorAttr() || outline.length < 3) return
    const geometry = mesh.geometry as THREE.BufferGeometry
    const index = geometry.getIndex()
    if (!index) return
    const pos = (geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array
    const idx = index.array as ArrayLike<number>
    const vertexCount = pos.length / 3
    this.ctx.regions.ensurePaintMask()

    const w = this.ctx.container.clientWidth || 1
    const h = this.ctx.container.clientHeight || 1
    this.ctx.partGroup.updateWorldMatrix(true, false)
    this.ctx.camera.updateMatrixWorld()
    const toClip = new THREE.Matrix4()
      .multiplyMatrices(this.ctx.camera.projectionMatrix, this.ctx.camera.matrixWorldInverse)
      .multiply(this.ctx.partGroup.matrixWorld)

    // Every vertex projected once, rather than three times per triangle: at a
    // million triangles that is the difference between a gesture that lands
    // and one that stalls the frame. The projection is affine (parallel
    // camera), so a triangle's centre on screen is the mean of its corners'.
    const sx = new Float32Array(vertexCount)
    const sy = new Float32Array(vertexCount)
    const clipped = new Uint8Array(vertexCount)
    const p = new THREE.Vector3()
    for (let v = 0; v < vertexCount; v++) {
      p.set(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]).applyMatrix4(toClip)
      sx[v] = ((p.x + 1) / 2) * w
      sy[v] = ((1 - p.y) / 2) * h
      // Outside the depth range is behind a clipping plane, so it is not on
      // screen and must not be marked from here.
      clipped[v] = p.z < -1 || p.z > 1 ? 1 : 0
    }

    // The view direction in the part's own coordinates, so the facing test is
    // a dot product against the triangle's own normal with no per-triangle
    // matrix work.
    const viewLocal = new THREE.Vector3(0, 0, -1)
      .applyQuaternion(this.ctx.camera.quaternion)
      .applyMatrix3(new THREE.Matrix3().setFromMatrix4(this.ctx.partGroup.matrixWorld).invert())
    const anyFacing = marker.backfaces === true

    const test = polygonTester(outline)
    const regions = this.ctx.regions
    const before = regions.paintCount
    for (let f = 0; f < idx.length; f += 3) {
      const a = idx[f], b = idx[f + 1], c = idx[f + 2]
      if (clipped[a] || clipped[b] || clipped[c]) continue
      if (!test((sx[a] + sx[b] + sx[c]) / 3, (sy[a] + sy[b] + sy[c]) / 3)) continue
      if (!anyFacing && !facesCamera(pos, a, b, c, viewLocal)) continue
      regions.markVertex(a, erase)
      regions.markVertex(b, erase)
      regions.markVertex(c, erase)
    }
    if (regions.paintCount !== before) {
      this.ctx.colorAttr()!.needsUpdate = true
      this.ctx.invalidate()
    }
  }

  /** Whether the brush takes marking away rather than laying it down: the
   *  right button always does, the switch says what the left one does, and Alt
   *  turns whichever of those applies around. */
  private eraseFor(rightButton: boolean, alt: boolean): boolean {
    if (!this.paint) return false
    return rightButton ? !alt : this.paint.erase !== alt
  }

  private onPaintMove = (e: PointerEvent): void => {
    if (!this.paint || this.gestureOf(this.paint) === null) return
    if (this.marquee) {
      this.extendMarquee(e.clientX, e.clientY)
      return
    }
    const erasing = this.eraseFor((e.buttons & 2) !== 0, e.altKey)
    if (erasing !== this.paintErasing) {
      this.paintErasing = erasing
      this.updateRingColor()
    }
    if (!this.painting) return
    // Buffered, not painted here: pointermove can outrun the display several
    // times over, and each dab is a raycast plus a BVH sweep. The rAF loop
    // drains the buffer once per frame — the same coalescing the hover path
    // gets.
    this.flushPendingDab()
    this.strokeQueue.push({ x: e.clientX, y: e.clientY, erase: erasing })
  }

  /** Land the dabs for every position a stroke buffered since the last frame.
   *  Positions that have not covered a dab's worth of ground are folded into
   *  the segment their successor draws — the stroke stays continuous, the work
   *  stays proportional to distance covered rather than to the mouse's report
   *  rate. The last position is always dabbed: it is where the cursor is, and
   *  where the stroke must end. */
  drainStroke(): void {
    const queue = this.strokeQueue
    if (queue.length === 0) return
    this.strokeQueue = []
    for (let i = 0; i < queue.length; i++) {
      const p = queue[i]
      const last = this.paintLast
      if (i < queue.length - 1 && last && Math.hypot(p.x - last.x, p.y - last.y) < 4) continue
      this.stroke(p.x, p.y, p.erase)
    }
  }

  private onPaintUp = (e: PointerEvent): void => {
    if (!this.painting || (e.button !== 0 && e.button !== 2)) return
    this.endStroke()
  }

  /**
   * Abandon the live gesture: a second finger has landed, so the hand is
   * navigating and never meant to mark at all.
   *
   * Dropped rather than finished — the opening dab is still being held, the
   * marquee is thrown away instead of committed, and anything the finger did
   * manage to lay down in the moment before its partner arrived stays, because
   * marking has no undo finer than the rub-out brush.
   */
  endGesture(): void {
    this.pendingDab = null
    if (!this.painting) return
    this.strokeQueue.length = 0
    this.painting = false
    this.paintLast = null
    this.endMarquee()
    this.ctx.onPaintChange(this.ctx.regions.paintCount)
  }

  private endStroke(): void {
    // A tap that never moved still marks: its dab has been waiting for exactly
    // this. A short fast stroke can likewise end with its tail still buffered
    // for the next frame — land both now, or the mark stops short of where the
    // gesture got to.
    this.flushPendingDab()
    this.drainStroke()
    this.painting = false
    this.paintLast = null
    const m = this.marquee
    if (m) {
      // A window needs its second corner and a lasso needs enough of a loop to
      // enclose anything; either way an accidental click marks nothing rather
      // than sweeping the whole part.
      const outline =
        m.gesture === 'window'
          ? m.points.length > 1
            ? rectanglePoints(m.points[0], m.points[1])
            : []
          : m.points
      this.endMarquee()
      if (outline.length >= 3) this.markMarquee(outline, m.erase)
    }
    // One report per gesture: the fit behind it is worth running when the user
    // lifts the button, not sixty times a second while they draw.
    this.ctx.onPaintChange(this.ctx.regions.paintCount)
  }

  /**
   * Lay the brush footprint on the surface under the cursor.
   *
   * The ring is flat and the scan is not, so it is a reading of where a stroke
   * would land rather than a tracing of it — the same bargain every CAD brush
   * cursor makes, and at a brush width that is small against the feature being
   * marked the difference does not show.
   */
  updateBrushRing(at: { x: number; y: number } | null): void {
    // Runs at most once per frame, and only because the cursor (or the brush's
    // settings) moved — either way the ring is worth redrawing, even when the
    // change is just the ring going away.
    this.ctx.invalidate()
    const mesh = this.ctx.mesh()
    if (!this.paint || this.gestureOf(this.paint) !== 'brush' || !at || !mesh?.visible) {
      this.brushRing.visible = false
      return
    }
    this.ctx.setPickRay(at.x, at.y)
    const hit = this.ctx.raycaster.intersectObject(mesh, false)[0]
    if (!hit || hit.faceIndex === undefined || hit.faceIndex === null) {
      this.brushRing.visible = false
      return
    }
    const geometry = mesh.geometry as THREE.BufferGeometry
    const index = geometry.getIndex()
    if (!index) {
      this.brushRing.visible = false
      return
    }
    const pos = (geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array
    const f = hit.faceIndex * 3
    const normal = this.faceNormal(pos, index.getX(f), index.getX(f + 1), index.getX(f + 2))
    if (!normal) {
      this.brushRing.visible = false
      return
    }
    this.ctx.partGroup.updateWorldMatrix(true, false)
    const centre = this.ctx.partGroup.worldToLocal(this.scratchD.copy(hit.point))
    this.brushRing.position.copy(centre)
    this.brushRing.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal)
    this.brushRing.scale.setScalar(Math.max(this.paint.diameter / 2, 1e-6))
    this.brushRing.visible = true
  }

  private updateRingColor(): void {
    if (!this.paint) return
    this.brushRingMaterial.color.set(this.paintErasing ? BRUSH_ERASE_COLOR : this.paint.color)
    this.ctx.invalidate()
  }

  /** Abandon whatever gesture is in flight — the mesh it was marking is gone.
   *  The mask itself is the compositor's to drop. */
  meshDisposed(): void {
    this.painting = false
    this.paintLast = null
    this.strokeQueue.length = 0
    this.endMarquee()
  }

  dispose(): void {
    document.removeEventListener('pointermove', this.onPaintMove)
    document.removeEventListener('pointerup', this.onPaintUp)
    document.removeEventListener('pointercancel', this.onPaintUp)
    this.brushRing.geometry.dispose()
    this.brushRingMaterial.dispose()
    this.marqueeSvg.remove()
  }
}
