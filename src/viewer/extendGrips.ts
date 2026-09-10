// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Grips for extending the element being made — one per end of a cylinder,
 * one per edge of a plane — and the gizmo a section plane wears: an arrow
 * that slides it, two rings that tilt it. Live only while a draft is open,
 * and always on top of
 * everything — a grip that could hide inside the part it belongs to would be a
 * grip that cannot be grabbed.
 */
import * as THREE from 'three'
import type { ExtendSide } from '../core/elements/extend'
import type { SectionFrame } from '../core/section/frame'
import type { FitData } from '../core/types'

/** What a grip moves: one side of an element being extended, or — on the
 *  gizmo a section plane wears — its offset along its normal (the arrow) or
 *  its tilt about one of its in-plane axes (the two rings). */
export type GripSide = ExtendSide | 'offset' | 'tiltU' | 'tiltV'

/** The gizmo's own sides, as against an element's. */
export function isSectionSide(side: GripSide | null): side is 'offset' | 'tiltU' | 'tiltV' {
  return side === 'offset' || side === 'tiltU' || side === 'tiltV'
}

/** One grip on an element being extended: where it sits, which way its side
 *  grows, and the mesh the cursor has to find to grab it. All in the part's own
 *  coordinates, like every other overlay. */
interface ExtendGrip {
  side: GripSide
  position: THREE.Vector3
  dir: THREE.Vector3
  mesh: THREE.Mesh
  material: THREE.MeshBasicMaterial
}

/** Everything the grips are allowed to touch outside themselves. */
export interface ExtendGripsContext {
  partGroup: THREE.Group
  raycaster: THREE.Raycaster
  /** The canvas — the grips own its cursor while one is lit or held. */
  canvas: HTMLElement
  setPickRay(clientX: number, clientY: number): void
  modelRadius(): number
  invalidate(): void
  /** Take the plain left-drag off the camera while a grip is under the cursor. */
  claimDrag(on: boolean): void
  /** Ask for a hover pass on the next frame (the cursor may have left the grip
   *  while it was held). */
  requestHover(): void
  /** A grip being dragged: which side, and how far it has come since the
   *  drag began — millimetres pulled out (negative in) for an arrow or a
   *  bar, degrees turned for a ring. */
  onExtendDrag(side: GripSide, delta: number, phase: 'start' | 'move' | 'end'): void
  /** The grip the user has hold of — lit under the cursor, or held in a drag
   *  after the cursor has wandered off it — or null for none. The ghost marks
   *  that side of itself, so a hand on a grip can see the edge it is moving. */
  onActiveSide(side: GripSide | null): void
}

export class ExtendGrips {
  private handleGroup = new THREE.Group()
  private handles: ExtendGrip[] = []
  /** The grip meshes alone, kept beside the grips: the hover test runs every
   *  frame the cursor moves, and mapping the list out afresh each time is a
   *  per-frame allocation for an array that only changes when the grips do. */
  private handleMeshes: THREE.Mesh[] = []
  private handleCleanup: (() => void)[] = []
  private handleColor = '#ffffff'
  /** What the grips are currently built for: the element being extended,
   *  and/or the section plane being offset. Kept so either can be changed
   *  without the other being forgotten. */
  private fit: FitData | null = null
  private plane: SectionFrame | null = null
  private hoveredHandle: GripSide | null = null
  /** What was last reported through onActiveSide, so it is only said when it
   *  changes. */
  private activeSide: GripSide | null = null
  private handleDrag: {
    side: GripSide
    /** Where the grip sat and which way it grows — or, for a ring, the pivot
     *  and the axis it turns about — in world coordinates, where the pointer
     *  ray is cast. */
    origin: THREE.Vector3
    dir: THREE.Vector3
    /** Where the drag started — a line parameter, or an angle about the
     *  ring's axis — so what is reported is how far it has come rather than
     *  where it is. */
    start: number
    /** A ring's angle basis in its plane, and the turn so far: angles come
     *  back modulo a full circle and are unwrapped step by step, so a hand
     *  that goes round past the seam is not thrown back. */
    ring: { b1: THREE.Vector3; b2: THREE.Vector3; last: number; turned: number } | null
  } | null = null
  /** Grip shapes: an arrow for an end that grows along an axis, a bar for an
   *  edge that grows across itself. Both unit-sized about their own middle. */
  private unitCone = new THREE.ConeGeometry(0.5, 1, 20)
  private unitBox = new THREE.BoxGeometry(1, 1, 1)
  /** A ring of unit radius, its tube a fixed share of it — thick enough to
   *  take hold of, thin enough to read as a line. */
  private unitRing = new THREE.TorusGeometry(1, 0.045, 10, 72)

  constructor(private ctx: ExtendGripsContext) {
    ctx.partGroup.add(this.handleGroup)
    // A grip dragged off the edge of the viewport keeps pulling, and one
    // released outside it — or taken back by the system mid-drag — still lets
    // go rather than staying stuck to the pointer.
    document.addEventListener('pointermove', this.onHandleMove)
    document.addEventListener('pointerup', this.onHandleUp)
    document.addEventListener('pointercancel', this.onHandleUp)
  }

  /**
   * Put grips on the element being made, or take them away with null.
   *
   * The fit handed in is the one being *drawn* — already carrying whatever it
   * has been extended by — so the grips sit on the ends and edges the user can
   * see, and follow them as the numbers change. Anything else (a sphere, a
   * point, a line) has no size to give and gets none.
   */
  setHandles(fit: FitData | null, color: string): void {
    this.fit = fit
    this.handleColor = color
    this.rebuild()
  }

  /** Put the gizmo on a section plane — an arrow along its normal whose drag
   *  is the offset, and a ring about each in-plane axis whose drag tilts the
   *  plane about it — or take it away with null. */
  setPlaneHandles(frame: SectionFrame | null, color: string): void {
    this.plane = frame
    this.handleColor = color
    this.rebuild()
  }

  private rebuild(): void {
    for (const fn of this.handleCleanup) fn()
    this.handleCleanup = []
    this.handleGroup.clear()
    this.handles = []
    this.handleMeshes = []
    this.ctx.invalidate()
    if (this.hoveredHandle !== null && this.handleDrag === null) this.setHoveredHandle(null)

    if (this.plane) {
      // Bigger than an element's grips: the gizmo stands alone on a bare
      // sheet and is the one thing there is to take hold of.
      const size = Math.max(this.ctx.modelRadius() * 0.05, 1e-5)
      const origin = new THREE.Vector3(...this.plane.origin)
      this.addGrip('offset', origin, new THREE.Vector3(...this.plane.normal).normalize(), size)
      // A ring about each in-plane axis, both through the arrow: dragging a
      // ring carries the arrow's tip round it, so a hand on one sees where
      // the normal is going. Wider than the arrow, so neither hides it.
      const radius = Math.max(this.ctx.modelRadius() * 0.13, 1e-5)
      this.addRing('tiltU', origin, new THREE.Vector3(...this.plane.basisU).normalize(), radius)
      this.addRing('tiltV', origin, new THREE.Vector3(...this.plane.basisV).normalize(), radius)
    }

    const fit = this.fit
    if (!fit) return

    // Drawn on top of everything, so a grip on the far side of the element is
    // still grabbable. The floor keeps a grip on a tiny feature from vanishing
    // on a large part.
    const size = Math.max(this.ctx.modelRadius() * 0.03, 1e-5)

    if (fit.kind === 'cylinder') {
      const axis = new THREE.Vector3(...fit.axis).normalize()
      const length = Math.max(fit.length, 1e-5)
      const centre = new THREE.Vector3(...fit.center)
      // An arrow off each end, sized to the tube it belongs to rather than to
      // the part: on a bore in a large casting a grip scaled to the whole scan
      // would be bigger than the hole, and on a long shaft it would be a speck.
      const arrow = Math.max(
        Math.min(Math.max(fit.radius, 1e-5) * 0.8, length * 0.3),
        this.ctx.modelRadius() * 0.02,
      )
      const half = length / 2
      this.addGrip('start', centre.clone().addScaledVector(axis, -half), axis.clone().negate(), arrow)
      this.addGrip('end', centre.clone().addScaledVector(axis, half), axis.clone(), arrow)
      return
    }

    if (fit.kind === 'plane') {
      const u = new THREE.Vector3(...fit.basisU).normalize()
      const v = new THREE.Vector3(...fit.basisV).normalize()
      const eu = Math.max(fit.extentU, 1e-5)
      const ev = Math.max(fit.extentV, 1e-5)
      const centre = new THREE.Vector3(...fit.center)
      // A bar lying along each edge: the grip is the edge, which is the thing
      // being dragged. Half the edge long, so all four stay clear of the
      // corners even on a patch that is much longer than it is wide, and never
      // thicker than a fair share of the patch it belongs to.
      const bar = (along: THREE.Vector3, span: number) => ({ along, span })
      const thick = Math.max(Math.min(size, Math.min(eu, ev) * 0.6), this.ctx.modelRadius() * 0.008)
      this.addGrip('uMin', centre.clone().addScaledVector(u, -eu), u.clone().negate(), thick, bar(v, ev))
      this.addGrip('uMax', centre.clone().addScaledVector(u, eu), u.clone(), thick, bar(v, ev))
      this.addGrip('vMin', centre.clone().addScaledVector(v, -ev), v.clone().negate(), thick, bar(u, eu))
      this.addGrip('vMax', centre.clone().addScaledVector(v, ev), v.clone(), thick, bar(u, eu))
    }
  }

  /** One grip: an arrow on an axis, or a bar along an edge when the side it
   *  belongs to has an edge to lie on. */
  private addGrip(
    side: GripSide,
    position: THREE.Vector3,
    dir: THREE.Vector3,
    size: number,
    edge?: { along: THREE.Vector3; span: number },
  ): void {
    const material = new THREE.MeshBasicMaterial({
      // A rebuild in the middle of a drag must not put the lit grip out.
      color: side === this.hoveredHandle ? 0xffffff : this.handleColor,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
    const mesh = new THREE.Mesh(edge ? this.unitBox : this.unitCone, material)
    if (edge) {
      // The bar lies in the plane, along the edge, and reaches a little past it
      // on the outside so the shape it will grow into is legible.
      mesh.quaternion.setFromRotationMatrix(
        new THREE.Matrix4().makeBasis(edge.along, dir, edge.along.clone().cross(dir).normalize()),
      )
      mesh.scale.set(Math.max(edge.span, size), size * 0.42, size * 0.42)
      mesh.position.copy(position)
    } else {
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir)
      mesh.scale.setScalar(size)
      // Base on the end face, tip pointing the way the drag will take it.
      mesh.position.copy(position).addScaledVector(dir, size / 2)
    }
    mesh.renderOrder = 6
    mesh.userData.extendSide = side
    this.handleGroup.add(mesh)
    this.handles.push({ side, position: position.clone(), dir: dir.clone(), mesh, material })
    this.handleMeshes.push(mesh)
    this.handleCleanup.push(() => material.dispose())
  }

  /** One ring: a torus about `about` through `centre`, whose drag turns the
   *  plane about that axis — which is what its `dir` records. */
  private addRing(side: GripSide, centre: THREE.Vector3, about: THREE.Vector3, radius: number): void {
    const material = new THREE.MeshBasicMaterial({
      color: side === this.hoveredHandle ? 0xffffff : this.handleColor,
      transparent: true,
      opacity: 0.85,
      depthTest: false,
      depthWrite: false,
    })
    const mesh = new THREE.Mesh(this.unitRing, material)
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), about)
    mesh.scale.setScalar(radius)
    mesh.position.copy(centre)
    mesh.renderOrder = 6
    mesh.userData.extendSide = side
    this.handleGroup.add(mesh)
    this.handles.push({ side, position: centre.clone(), dir: about.clone(), mesh, material })
    this.handleMeshes.push(mesh)
    this.handleCleanup.push(() => material.dispose())
  }

  /** The grip under the cursor, if the cursor is on one. Grips are tested
   *  before anything else and ignore what is in front of them: they are drawn
   *  on top, so they have to be grabbable on top. */
  private handleAt(clientX: number, clientY: number): ExtendGrip | null {
    if (this.handles.length === 0) return null
    this.ctx.setPickRay(clientX, clientY)
    // Grips are built and moved between frames; the ray has to meet them where
    // they are now, not where the last render left them.
    this.handleGroup.updateWorldMatrix(true, true)
    const hits = this.ctx.raycaster.intersectObjects(this.handleMeshes, false)
    if (hits.length === 0) return null
    const side = hits[0].object.userData.extendSide as GripSide
    return this.handles.find((h) => h.side === side) ?? null
  }

  /** Resolve the grip under the cursor, once per frame from the hover pass.
   *  Only when nothing is being marked: while a marking gesture is armed both
   *  plain drags are the brush's, so a grip that lit up would be one the user
   *  could not grab. A grip that has gone away is still worth resolving — that
   *  is where a lit one hands the drag back after the draft it belonged to was
   *  closed under it. */
  updateHover(at: { x: number; y: number } | null, marking: boolean): void {
    if (this.handleDrag !== null) return
    if (this.handles.length === 0 && this.hoveredHandle === null) return
    this.setHoveredHandle(marking || !at ? null : (this.handleAt(at.x, at.y)?.side ?? null))
  }

  /** Light the grip under the cursor and say so with the pointer, and take the
   *  plain left-drag off the camera for as long as one is under it. */
  private setHoveredHandle(side: GripSide | null): void {
    if (this.hoveredHandle === side) return
    this.hoveredHandle = side
    this.ctx.invalidate()
    for (const h of this.handles) h.material.color.set(h.side === side ? 0xffffff : this.handleColor)
    this.ctx.claimDrag(side !== null)
    this.ctx.canvas.style.cursor = side !== null ? 'grab' : ''
    this.syncActiveSide()
  }

  /** The side in hand is the one being dragged while a drag is on — the hover
   *  is frozen for its duration — and the lit one otherwise. */
  private syncActiveSide(): void {
    const side = this.handleDrag?.side ?? this.hoveredHandle
    if (side === this.activeSide) return
    this.activeSide = side
    this.ctx.onActiveSide(side)
  }

  /** A grip under the cursor takes the plain left-drag — the navigator has
   *  already stepped aside for it, the same way it does for the brush.
   *  Returns whether the event was taken. */
  handlePointerDown(e: PointerEvent): boolean {
    if (this.hoveredHandle === null) return false
    if (e.button !== 0 || e.shiftKey || e.ctrlKey || e.metaKey) return false
    const grip = this.handles.find((h) => h.side === this.hoveredHandle)
    if (!grip) return false
    this.beginHandleDrag(grip, e.clientX, e.clientY)
    return true
  }

  private beginHandleDrag(grip: ExtendGrip, clientX: number, clientY: number): void {
    const world = this.gripLine(grip)
    if (grip.side === 'tiltU' || grip.side === 'tiltV') {
      // Any two perpendiculars of the axis do for reading angles — only
      // differences are reported — as long as (b1, b2, axis) is right-handed,
      // so the angle grows with the turn it is asking for.
      const b1 = perpendicularTo(world.dir)
      const b2 = world.dir.clone().cross(b1).normalize()
      const a = this.angleAround(world.origin, world.dir, b1, b2, clientX, clientY)
      if (a === null) return
      this.handleDrag = {
        side: grip.side,
        origin: world.origin,
        dir: world.dir,
        start: a,
        ring: { b1, b2, last: a, turned: 0 },
      }
    } else {
      const t = this.paramAlong(world.origin, world.dir, clientX, clientY)
      if (t === null) return
      this.handleDrag = { side: grip.side, origin: world.origin, dir: world.dir, start: t, ring: null }
    }
    this.ctx.canvas.style.cursor = 'grabbing'
    this.syncActiveSide()
    this.ctx.onExtendDrag(grip.side, 0, 'start')
  }

  /** A grip's line in world space — the part can be sitting under an alignment,
   *  and the pointer ray is cast in world coordinates. */
  private gripLine(grip: ExtendGrip): { origin: THREE.Vector3; dir: THREE.Vector3 } {
    this.ctx.partGroup.updateWorldMatrix(true, false)
    const origin = grip.position.clone().applyMatrix4(this.ctx.partGroup.matrixWorld)
    const dir = grip.dir
      .clone()
      .transformDirection(this.ctx.partGroup.matrixWorld)
      .normalize()
    return { origin, dir }
  }

  /**
   * Where the cursor is along a line, in millimetres from its origin: the point
   * on the line closest to the ray under the pointer.
   *
   * Null when the two are within a few degrees of parallel — looking straight
   * down the axis being dragged, the answer runs off to infinity and the grip
   * would jump. Holding still is the honest response.
   */
  private paramAlong(
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    clientX: number,
    clientY: number,
  ): number | null {
    this.ctx.setPickRay(clientX, clientY)
    const ray = this.ctx.raycaster.ray
    const b = dir.dot(ray.direction)
    const denom = 1 - b * b
    if (Math.abs(denom) < 1e-3) return null
    const w = origin.clone().sub(ray.origin)
    return (b * w.dot(ray.direction) - w.dot(dir)) / denom
  }

  /**
   * Where the cursor is around an axis, in radians: the pointer ray meets the
   * plane through the pivot square to the axis, and that point's angle about
   * the pivot is read in the (b1, b2) basis — growing with a right-handed
   * turn about the axis, the sense the plane is turned in.
   *
   * Null when the ray runs nearly in that plane — the ring is seen edge on,
   * and a hair of pointer travel would swing the plane wildly. Holding still
   * is the honest response, as it is for an arrow seen end on.
   */
  private angleAround(
    pivot: THREE.Vector3,
    axis: THREE.Vector3,
    b1: THREE.Vector3,
    b2: THREE.Vector3,
    clientX: number,
    clientY: number,
  ): number | null {
    this.ctx.setPickRay(clientX, clientY)
    const ray = this.ctx.raycaster.ray
    const denom = ray.direction.dot(axis)
    if (Math.abs(denom) < 0.1) return null
    const t = pivot.clone().sub(ray.origin).dot(axis) / denom
    const w = ray.origin.clone().addScaledVector(ray.direction, t).sub(pivot)
    if (w.lengthSq() < 1e-12) return null
    return Math.atan2(w.dot(b2), w.dot(b1))
  }

  private onHandleMove = (e: PointerEvent): void => {
    const drag = this.handleDrag
    if (!drag) return
    if (drag.ring) {
      const a = this.angleAround(drag.origin, drag.dir, drag.ring.b1, drag.ring.b2, e.clientX, e.clientY)
      if (a === null) return
      // The step since the last reading, taken the short way round.
      let step = a - drag.ring.last
      if (step > Math.PI) step -= 2 * Math.PI
      else if (step < -Math.PI) step += 2 * Math.PI
      drag.ring.last = a
      drag.ring.turned += step
      this.ctx.onExtendDrag(drag.side, (drag.ring.turned * 180) / Math.PI, 'move')
      return
    }
    const t = this.paramAlong(drag.origin, drag.dir, e.clientX, e.clientY)
    if (t === null) return
    this.ctx.onExtendDrag(drag.side, t - drag.start, 'move')
  }

  private onHandleUp = (): void => {
    const drag = this.handleDrag
    if (!drag) return
    this.handleDrag = null
    this.ctx.canvas.style.cursor = this.hoveredHandle !== null ? 'grab' : ''
    this.syncActiveSide()
    this.ctx.onExtendDrag(drag.side, 0, 'end')
    // The cursor may have left the grip while it was held; settle the hover
    // from where it actually is now.
    this.ctx.requestHover()
  }

  dispose(): void {
    document.removeEventListener('pointermove', this.onHandleMove)
    document.removeEventListener('pointerup', this.onHandleUp)
    document.removeEventListener('pointercancel', this.onHandleUp)
    this.plane = null
    this.setHandles(null, '#ffffff')
    this.unitCone.dispose()
    this.unitBox.dispose()
    this.unitRing.dispose()
  }
}

/** Some unit vector square to `v`: the cross with whichever axis `v` leans
 *  least along, so it is never degenerate. */
function perpendicularTo(v: THREE.Vector3): THREE.Vector3 {
  const ax = Math.abs(v.x)
  const ay = Math.abs(v.y)
  const az = Math.abs(v.z)
  const helper =
    ax <= ay && ax <= az
      ? new THREE.Vector3(1, 0, 0)
      : ay <= az
        ? new THREE.Vector3(0, 1, 0)
        : new THREE.Vector3(0, 0, 1)
  return helper.cross(v).normalize()
}
