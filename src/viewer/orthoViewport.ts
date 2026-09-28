// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The chassis both orthographic viewports share: renderer and label renderer,
 * scene, camera and lights, the hand-driven navigation, render-on-demand, the
 * part-framing camera maths, and the click-versus-drag pointer test. The main
 * viewport (SceneManager) and the split picker's halves (PickScene) each
 * compose one of these and hang their own content off its scene.
 */
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js'
import { spreadLabels } from './labelSpread'
import type { LinkedView } from './cameraLink'
import type { ControlScheme } from './navSchemes'
import { OrthoNavigator } from './orthoNav'
import type { ViewTheme } from './viewThemes'

/** Breathing room around a framed part. One value for every viewport: the
 *  split picker used to frame at 1.1 while the main view sat at 1.08, which
 *  was drift, not intent. */
const FRAME_MARGIN = 1.08

/** The named camera poses: the six axis-aligned views and the three-quarter
 *  one, keyed the way PrusaSlicer keys them (0 iso, 1 top, 2 bottom, 3 front,
 *  4 rear, 5 left, 6 right). Z up throughout, the pose a part standing on the
 *  floor plane looks upright in — the same convention the datum stage is read
 *  in. Top and bottom cannot hold Z up, so they take Y: the top view has +Y at
 *  the top of the screen, and the bottom view is that view with the part
 *  turned over about X, which puts −Y there instead. */
export type StandardView = 'iso' | 'top' | 'bottom' | 'front' | 'rear' | 'left' | 'right'

export const STANDARD_VIEWS: Record<StandardView, { dir: THREE.Vector3; up: THREE.Vector3 }> = {
  /** Front-top-right: the pose the datum stage is framed in. */
  iso: { dir: new THREE.Vector3(0.72, -0.95, 0.55), up: new THREE.Vector3(0, 0, 1) },
  top: { dir: new THREE.Vector3(0, 0, 1), up: new THREE.Vector3(0, 1, 0) },
  bottom: { dir: new THREE.Vector3(0, 0, -1), up: new THREE.Vector3(0, -1, 0) },
  front: { dir: new THREE.Vector3(0, -1, 0), up: new THREE.Vector3(0, 0, 1) },
  rear: { dir: new THREE.Vector3(0, 1, 0), up: new THREE.Vector3(0, 0, 1) },
  left: { dir: new THREE.Vector3(-1, 0, 0), up: new THREE.Vector3(0, 0, 1) },
  right: { dir: new THREE.Vector3(1, 0, 0), up: new THREE.Vector3(0, 0, 1) },
}

export interface OrthoViewportOptions {
  /** Stage and lights — see viewThemes. One scheme across every viewport: two
   *  halves of a split view lit differently would read as two instruments. */
  theme: ViewTheme
  /** Meshes an orbit is allowed to pivot on, re-asked at every drag. */
  navTargets: () => THREE.Object3D[]
  /** A left press-and-release that stayed within the drag threshold — a click,
   *  not a rotation. The event rides along for owners that care about
   *  modifier keys; most ignore it. */
  onClick: (clientX: number, clientY: number, e?: PointerEvent) => void
  /** First look at every pointerdown, before the click machinery records it.
   *  Return true to take the event (a brush stroke, a grip grab). */
  onPointerDown?: (e: PointerEvent) => boolean
  /** A second finger has landed: whatever one-finger gesture was live is over,
   *  because the hand has moved on to navigating. */
  onMultiTouch?: () => void
  /** Runs every animation tick, rendered or not — this is where the owner
   *  drains its per-frame queues and decides whether to invalidate. */
  onTick?: () => void
  /** Runs after the scene render, before the labels — a corner gizmo drawn
   *  into the same canvas goes here. */
  onAfterRender?: (width: number, height: number) => void
  /** A see-through canvas with no stage of its own: what a viewport laid
   *  over another one is — the sketch sheet over the 3D view. */
  transparent?: boolean
}

export class OrthoViewport {
  readonly renderer: THREE.WebGLRenderer
  readonly labelRenderer: CSS2DRenderer
  readonly scene = new THREE.Scene()
  readonly camera: THREE.OrthographicCamera
  /** Only the target and the per-frame lookAt: rotation, pan and zoom are all
   *  driven by hand from the active control scheme, because which button does
   *  what is not OrbitControls' to decide. */
  readonly controls: OrbitControls
  /** Orbit / pan / zoom, bound to whichever CAD tool's buttons the user picked. */
  readonly nav: OrthoNavigator
  /** The three lights, kept so the colour scheme can be swapped without
   *  rebuilding the scene: sky-and-bounce, flat fill, and the key that rides
   *  on the camera. */
  readonly keyLight: THREE.DirectionalLight
  private hemiLight: THREE.HemisphereLight
  private ambientLight: THREE.AmbientLight
  readonly raycaster = new THREE.Raycaster()
  /** Sphere enclosing everything drawn, handed to the navigator by reference so
   *  re-framing a new model just writes to it. */
  readonly clipSphere = { center: new THREE.Vector3(), radius: 1 }
  /** Skips rendering entirely while the viewport is hidden (behind the
   *  split-screen picker); everything loaded stays loaded. */
  paused = false
  /** Half-extents of the model on the screen plane at the framing camera
   *  orientation; the frustum is rebuilt from these on every resize so the
   *  user's zoom survives. */
  private fitExtent = { halfW: 1, halfH: 1 }
  private resizeObserver: ResizeObserver
  private rafId = 0
  private pointerDown: { x: number; y: number } | null = null
  /** Fingers down on the canvas, and whether this touch has been more than one
   *  of them at any point. A tap picks, but the moment a second finger lands
   *  the whole touch belongs to the navigator: a pinch that happens to start
   *  and end within the drag threshold must not also fit a sphere. */
  private touchIds = new Set<number>()
  private multiTouch = false
  /** Render-on-demand: the rAF loop keeps ticking (the early-out is nearly
   *  free) but the scene is only drawn on frames something marked. A missed
   *  mark shows as a stale image, so every path that could change what is on
   *  screen calls invalidate — an extra repaint costs nothing. */
  private needsRender = true
  /** A turn of the camera under way — see animateLook. */
  private flight: {
    start: number
    ms: number
    q0: THREE.Quaternion
    q1: THREE.Quaternion
    t0: THREE.Vector3
    t1: THREE.Vector3
    zoom0: number
    zoom1: number
    dist: number
  } | null = null

  invalidate = (): void => {
    this.needsRender = true
  }

  constructor(private container: HTMLDivElement, private opts: OrthoViewportOptions) {
    // A stencil buffer, for the cap that closes a part cut open at a plane
    // — three.js leaves it out unless asked.
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', alpha: Boolean(opts.transparent), stencil: true })
    if (opts.transparent) this.renderer.setClearColor(0x000000, 0)
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.container.appendChild(this.renderer.domElement)

    this.labelRenderer = new CSS2DRenderer()
    const labelDom = this.labelRenderer.domElement
    labelDom.style.position = 'absolute'
    labelDom.style.top = '0'
    labelDom.style.left = '0'
    labelDom.style.pointerEvents = 'none'
    this.container.appendChild(labelDom)

    // Parallel projection: metrology views should not foreshorten, and equal
    // features must read the same size wherever they sit in the frame.
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 4000)
    this.camera.position.set(0, 0, 100)

    this.hemiLight = new THREE.HemisphereLight(0xffffff, 0xffffff, 1)
    this.ambientLight = new THREE.AmbientLight(0xffffff, 1)
    this.keyLight = new THREE.DirectionalLight(0xffffff, 1)
    this.scene.add(this.hemiLight)
    this.scene.add(this.ambientLight)
    this.scene.add(this.keyLight)
    this.scene.add(this.keyLight.target)
    this.setTheme(opts.theme)

    // OrbitControls owns the target and the per-frame lookAt, nothing else:
    // its own rotate/pan/zoom are off because the control scheme decides which
    // buttons do what, and because orbiting has to happen about the point
    // under the cursor rather than about a fixed target. No polar clamping
    // either — the free orbit rotates about the camera's own axes and carries
    // `up` with it, so it never lands on a pole.
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableRotate = false
    this.controls.enableZoom = false
    this.controls.enablePan = false

    this.nav = new OrthoNavigator(
      this.camera,
      this.controls,
      this.renderer.domElement,
      opts.navTargets,
      this.clipSphere,
    )
    this.scene.add(this.nav.pivotMarker)
    // The navigator says when a gesture changed the view; the controls'
    // 'change' event is the safety net behind it, fired by update() whenever
    // the camera turns out to have moved since the last frame.
    this.nav.onChange = this.invalidate
    this.controls.addEventListener('change', this.invalidate)

    const rc = this.raycaster as THREE.Raycaster & { firstHitOnly?: boolean }
    rc.firstHitOnly = true

    this.renderer.domElement.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch') {
        this.touchIds.add(e.pointerId)
        if (this.touchIds.size > 1 && !this.multiTouch) {
          this.multiTouch = true
          this.pointerDown = null
          this.opts.onMultiTouch?.()
        }
      }
      // A hand on the canvas takes the camera back from a turn under way.
      this.flight = null
      // Two fingers are the navigator's, whole: no pick, no stroke, no grip
      // comes out of the second one landing or of anything after it.
      if (this.multiTouch) return
      if (this.opts.onPointerDown?.(e)) return
      if (e.button !== 0) return
      this.pointerDown = { x: e.clientX, y: e.clientY }
    })
    this.renderer.domElement.addEventListener('pointerup', (e) => {
      const down = this.pointerDown
      const wasMulti = this.multiTouch
      this.pointerDown = null
      this.endTouch(e)
      if (!down || e.button !== 0 || wasMulti) return
      // A drag is a rotation, not a pick.
      if (Math.abs(e.clientX - down.x) + Math.abs(e.clientY - down.y) > 6) return
      this.opts.onClick(e.clientX, e.clientY, e)
    })
    // A cancelled pointer never reports up; without this the canvas would stay
    // convinced a finger was still down on it.
    this.renderer.domElement.addEventListener('pointercancel', (e) => {
      this.pointerDown = null
      this.endTouch(e)
    })

    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(this.container)
    this.resize()

    this.renderer.domElement.addEventListener('wheel', () => {
      this.flight = null
    })

    const animate = (): void => {
      this.rafId = requestAnimationFrame(animate)
      if (this.paused) return
      // These run every tick, rendered or not: a turn under way moves the
      // camera a step, the clip planes track the camera (and let the
      // navigator drop its cached canvas rect), update() is what notices
      // camera motion and fires 'change', and the owner's tick is what
      // decides whether this frame has anything new to show at all.
      this.stepFlight()
      this.nav.updateClipPlanes()
      this.controls.update()
      this.opts.onTick?.()
      if (!this.needsRender) return
      this.needsRender = false
      const w = this.container.clientWidth || 1
      const h = this.container.clientHeight || 1
      this.keyLight.position.copy(this.camera.position)
      this.keyLight.target.position.copy(this.controls.target)
      this.renderer.setViewport(0, 0, w, h)
      this.renderer.render(this.scene, this.camera)
      this.opts.onAfterRender?.(w, h)
      this.labelRenderer.render(this.scene, this.camera)
      spreadLabels(this.labelRenderer.domElement)
    }
    // Scheduled, not run inline: the owner composing this viewport is still
    // mid-constructor here, and its tick hooks reach for modules it has not
    // built yet. The first frame is one rAF away either way.
    this.rafId = requestAnimationFrame(animate)
  }

  /** A finger leaving the glass. The multi-touch latch only lifts once the last
   *  one has gone, so releasing a pinch one finger at a time cannot let the
   *  straggler's release through as a tap. */
  private endTouch(e: PointerEvent): void {
    if (e.pointerType !== 'touch') return
    this.touchIds.delete(e.pointerId)
    if (this.touchIds.size === 0) this.multiTouch = false
  }

  /** Swap the pointer-button control scheme (dropdown in the settings dialog). */
  setNavScheme(scheme: ControlScheme): void {
    this.nav.setScheme(scheme)
    this.invalidate()
  }

  /** Swap the colour scheme: the stage behind the parts and the lights on them.
   *  What the parts are made of is their owner's — see applyFinish. */
  setTheme(theme: ViewTheme): void {
    this.scene.background = this.opts.transparent ? null : new THREE.Color(theme.stage)
    const { sky, ground, hemisphere, ambient, key } = theme.lights
    this.hemiLight.color.setHex(sky)
    this.hemiLight.groundColor.setHex(ground)
    this.hemiLight.intensity = hemisphere
    this.ambientLight.intensity = ambient
    this.keyLight.intensity = key
    this.invalidate()
  }

  /** Aim the shared raycaster through the cursor. */
  setPickRay(clientX: number, clientY: number): void {
    this.nav.setPickRay(this.raycaster, clientX, clientY)
  }

  /** How many millimetres one pixel of the canvas spans at the current zoom.
   *  What anything that has to keep its size on *screen* rather than on the
   *  part — a picked-point marker — is scaled by. Parallel projection, so the
   *  figure is the same everywhere in the frame and at every depth. */
  worldPerPixel(): number {
    const h = this.container.clientHeight || 1
    return (this.camera.top - this.camera.bottom) / this.camera.zoom / h
  }

  /**
   * Point the camera at the bounding-box centre, then size the frustum to the
   * box's actual on-screen extents.
   *
   * With an axis given, the view direction is the three-quarter-ish one that
   * is still perpendicular to the part's long axis — an end-on view would hide
   * most of an elongated part. The split picker passes null and keeps the
   * plain three-quarter view: its parts sit in arbitrary poses and each half
   * is about to be turned by hand anyway. Either way a rolled camera makes
   * orbiting feel inverted, so screen-up stays world-up.
   *
   * A `view` overrides both choices at once: the datum stage frames its
   * coordinate corner from the front-top-right with Z up, the way the target
   * frame is meant to be read, and that intent beats the part's long axis.
   */
  frameCamera(
    box: THREE.Box3,
    axis: THREE.Vector3 | null,
    view?: { dir: THREE.Vector3; up: THREE.Vector3 },
  ): void {
    const center = box.getCenter(new THREE.Vector3())
    const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1e-3)

    const dir = view ? view.dir.clone().normalize() : new THREE.Vector3(0.62, 0.42, 1).normalize()
    if (axis && !view) {
      dir.addScaledVector(axis, -dir.dot(axis))
      if (dir.lengthSq() < 1e-6) dir.set(-axis.y, axis.x, 0)
      if (dir.lengthSq() < 1e-6) dir.set(1, 0, 0)
      dir.normalize()
    }

    if (view) this.camera.up.copy(view.up)
    else this.camera.up.set(0, 1, 0)
    this.controls.target.copy(center)
    const dist = radius * 4 + 1
    this.camera.position.copy(center).addScaledVector(dir, dist)
    this.camera.zoom = 1
    // The clip planes are re-derived per frame from here, because orbiting
    // about the cursor moves the camera off any distance fixed now.
    this.clipSphere.center.copy(center)
    this.clipSphere.radius = radius
    this.camera.lookAt(center)
    this.camera.updateMatrixWorld(true)

    // Screen-plane half-extents of the eight box corners. Orthographic x/y are
    // independent of depth, so this frames the part exactly.
    const toCamera = new THREE.Matrix4().copy(this.camera.matrixWorld).invert()
    const corner = new THREE.Vector3()
    let halfW = 1e-3
    let halfH = 1e-3
    for (let i = 0; i < 8; i++) {
      corner
        .set(
          i & 1 ? box.max.x : box.min.x,
          i & 2 ? box.max.y : box.min.y,
          i & 4 ? box.max.z : box.min.z,
        )
        .applyMatrix4(toCamera)
      halfW = Math.max(halfW, Math.abs(corner.x))
      halfH = Math.max(halfH, Math.abs(corner.y))
    }
    this.fitExtent = { halfW: halfW * FRAME_MARGIN, halfH: halfH * FRAME_MARGIN }
    this.applyFrustum()
    this.controls.update()
    this.invalidate()
  }

  /**
   * Fit the part back on screen without turning it.
   *
   * The way out of a lost model: orbiting about the cursor and zooming into a
   * corner can leave the part off the frame entirely, and re-framing it from
   * the standard three-quarter view would answer that by throwing away the
   * viewpoint the user was working from. So the camera keeps the direction it
   * is looking from and its up vector, and only the centre and the zoom are
   * taken back — which is what every CAD tool's zoom-to-fit does.
   */
  fitCamera(box: THREE.Box3): void {
    const dir = new THREE.Vector3().subVectors(this.camera.position, this.controls.target)
    // Nothing to preserve if the camera has somehow ended up on its own target;
    // the default three-quarter direction is as good an answer as any.
    if (dir.lengthSq() < 1e-12) dir.set(0.62, 0.42, 1)
    this.frameCamera(box, null, { dir, up: this.camera.up.clone() })
  }

  /**
   * Turn the camera to one of the standard views, about whatever sits at the
   * centre of the screen.
   *
   * Only the orientation changes: the zoom stays, and so does what is under
   * the screen centre, so the part keeps its size and its place and merely
   * shows another face — the way the number keys work in PrusaSlicer. A part
   * that has been zoomed into is a part the user is looking at closely, and
   * re-framing on every turn would keep throwing that away; fit-to-view is
   * one key away when the whole part is wanted.
   *
   * The pivot is the surface under the screen centre when the part is there,
   * as the free orbit pivots on the surface under the cursor; a turn about a
   * point floating off the surface would swing the feature being looked at
   * across the screen. With empty stage at the centre the pivot is that
   * screen point at the depth of the model's centre — the same thing the
   * orbit target is, brought level with the part so the turn stays close.
   */
  viewFrom(view: StandardView): void {
    const { dir, up } = STANDARD_VIEWS[view]
    this.lookFrom(dir, up)
  }

  /**
   * Turn the camera to look from `dir` (the direction from the target to the
   * camera) with `up` up the screen, about whatever sits at the centre of
   * the screen — what the standard views do, for any pose: the 2D sheet is
   * mirrored by looking at it from behind this way, in place.
   */
  lookFrom(dir: THREE.Vector3, up: THREE.Vector3): void {
    const rect = this.renderer.domElement.getBoundingClientRect()
    const pivot = this.nav.surfaceAt(rect.left + rect.width / 2, rect.top + rect.height / 2)
    if (!pivot) {
      const axis = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion)
      const depth = new THREE.Vector3()
        .subVectors(this.clipSphere.center, this.camera.position)
        .dot(axis)
      this.controls.target.copy(this.camera.position).addScaledVector(axis, depth)
    } else {
      this.controls.target.copy(pivot)
    }
    // Where along the new axis the camera sits makes no difference to a
    // parallel projection; the clip planes are re-derived from the model each
    // frame. The framing distance is as good a place as any.
    const dist = this.clipSphere.radius * 4 + 1
    this.camera.up.copy(up)
    this.camera.position.copy(this.controls.target).addScaledVector(dir.clone().normalize(), dist)
    this.camera.lookAt(this.controls.target)
    this.camera.updateMatrixWorld(true)
    this.controls.update()
    this.invalidate()
  }

  /** The pose a look is asked for: the direction from the target to the
   *  camera, what is up the screen, what the screen centre is on, and the
   *  zoom — or the zoom as it is. */
  private poseOf(dir: THREE.Vector3, up: THREE.Vector3, target: THREE.Vector3, zoom?: number) {
    const dist = this.clipSphere.radius * 4 + 1
    const eye = target.clone().addScaledVector(dir.clone().normalize(), dist)
    const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(eye, target, up))
    return { q, target: target.clone(), zoom: zoom ?? this.camera.zoom, dist }
  }

  /**
   * Turn the camera over `ms` milliseconds to look from `dir` (target to
   * camera) with `up` up the screen, at `target`, at `zoom` — the way CAD
   * turns to a sketch plane: the part swings round under the eye rather
   * than jumping, so it is plain where the plane sits on it and which way
   * the sheet reads. A press or a wheel on the canvas cuts the turn short
   * where it is; `ms` of 0 lands at once. A turn already under way is
   * restarted from where it has got to.
   */
  animateLook(dir: THREE.Vector3, up: THREE.Vector3, target: THREE.Vector3, ms = 500, zoom?: number): void {
    const goal = this.poseOf(dir, up, target, zoom)
    this.flight = {
      start: performance.now(),
      ms,
      q0: this.camera.quaternion.clone(),
      q1: goal.q,
      t0: this.controls.target.clone(),
      t1: goal.target,
      zoom0: this.camera.zoom,
      zoom1: goal.zoom,
      dist: goal.dist,
    }
    this.stepFlight()
  }

  /**
   * Look from `dir` with `up`, at `target`, at `zoom`, now — or, while a
   * turn is under way, make that where the turn lands, without restarting
   * it: what a view that follows another one calls on every change of it.
   */
  retarget(dir: THREE.Vector3, up: THREE.Vector3, target: THREE.Vector3, zoom?: number): void {
    const goal = this.poseOf(dir, up, target, zoom)
    const f = this.flight
    if (f) {
      f.q1 = goal.q
      f.t1 = goal.target
      f.zoom1 = goal.zoom
      f.dist = goal.dist
      return
    }
    this.applyPose(goal.q, goal.target, goal.zoom, goal.dist)
  }

  /** Whether a turn is under way. */
  turning(): boolean {
    return this.flight !== null
  }

  private applyPose(q: THREE.Quaternion, target: THREE.Vector3, zoom: number, dist: number): void {
    // The controls re-aim the camera at its target from `up` every frame,
    // so the pose is written as a position and an up that re-aim to it.
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(q)
    this.camera.up.copy(new THREE.Vector3(0, 1, 0).applyQuaternion(q))
    this.controls.target.copy(target)
    this.camera.position.copy(target).addScaledVector(forward, -dist)
    this.camera.lookAt(target)
    if (this.camera.zoom !== zoom) {
      this.camera.zoom = zoom
      this.camera.updateProjectionMatrix()
    }
    this.camera.updateMatrixWorld(true)
    this.invalidate()
  }

  private stepFlight(): void {
    const f = this.flight
    if (!f) return
    const k = f.ms > 0 ? Math.min(1, (performance.now() - f.start) / f.ms) : 1
    // Eased both ends: a turn that starts and stops dead reads as a jump
    // with frames in it.
    const s = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2
    const q = f.q0.clone().slerp(f.q1, s)
    const target = f.t0.clone().lerp(f.t1, s)
    // The zoom eases on a log scale: a zoom is a ratio, and halving reads
    // as far as doubling.
    const zoom = Math.exp(Math.log(f.zoom0) * (1 - s) + Math.log(f.zoom1) * s)
    if (k >= 1) this.flight = null
    this.applyPose(q, target, zoom, f.dist)
  }

  /**
   * Roll the view about its own axis to a new screen-up: the same direction
   * looked from, the same zoom, the same spot under the screen centre — only
   * which way is up changes. The 2D sheet rolls this way when an alignment
   * lands, so the part turns square under the eye instead of jumping back
   * to a full-sheet framing the way a quarter turn does.
   */
  rollTo(up: THREE.Vector3): void {
    this.camera.up.copy(up)
    this.camera.lookAt(this.controls.target)
    this.camera.updateMatrixWorld(true)
    this.controls.update()
    this.invalidate()
  }

  /** Adopt another viewport's framing extents. What makes two halves of a split
   *  view read at one scale: same extents and same pixel size means the same
   *  millimetres per pixel, so a feature is the same size in both. */
  setExtents(halfW: number, halfH: number): void {
    this.fitExtent = { halfW, halfH }
    this.applyFrustum()
    this.invalidate()
  }

  /** This viewport as one half of a linked pair — see cameraLink.ts. */
  viewLink(): LinkedView {
    return {
      camera: this.camera,
      target: this.controls.target,
      extents: () => this.fitExtent,
      setExtents: (halfW, halfH) => this.setExtents(halfW, halfH),
      invalidate: this.invalidate,
    }
  }

  /** Rebuild the orthographic frustum for the current viewport aspect,
   *  leaving camera.zoom (the user's zoom) alone. */
  private applyFrustum(): void {
    const aspect = (this.container.clientWidth || 1) / (this.container.clientHeight || 1)
    const { halfW, halfH } = this.fitExtent
    const h = Math.max(halfH, halfW / aspect)
    this.camera.top = h
    this.camera.bottom = -h
    this.camera.right = h * aspect
    this.camera.left = -h * aspect
    this.camera.updateProjectionMatrix()
  }

  resize(): void {
    const w = this.container.clientWidth || 1
    const h = this.container.clientHeight || 1
    this.renderer.setSize(w, h)
    this.labelRenderer.setSize(w, h)
    this.applyFrustum()
    this.invalidate()
  }

  dispose(): void {
    cancelAnimationFrame(this.rafId)
    this.resizeObserver.disconnect()
    // The navigator listens on the document so drags can leave the canvas;
    // nothing else takes those down with the container.
    this.nav.dispose()
    this.controls.dispose()
    this.renderer.dispose()
    // Only what this viewport put there. Emptying the container instead would
    // also take out whatever React had rendered into it — the fit-to-view
    // button — and React, having not been told, would never put it back. Which
    // is exactly what happens on every mount under StrictMode, where the first
    // effect is torn down again immediately.
    this.renderer.domElement.remove()
    this.labelRenderer.domElement.remove()
  }
}
