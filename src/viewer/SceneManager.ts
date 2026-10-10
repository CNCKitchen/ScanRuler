// SPDX-License-Identifier: AGPL-3.0-only
import * as THREE from 'three'
import type { LinkedView } from './cameraLink'
import { OrthoViewport, STANDARD_VIEWS, type StandardView } from './orthoViewport'
import { AxisGizmo, type GizmoAxis } from './axisGizmo'
import { DatumStage } from './datumStage'
import { RegionColors } from './regionColors'
import { SurfaceMarking, colorToRgb, type PaintBrush } from './marking'
import { ExtendGrips, isPluginSide, isSectionSide, type GripSide, type PluginGrip } from './extendGrips'
import { liftPoint } from '../core/section/lift'
import { LAYER_ORDER, type SceneLayer, type SceneLayerHost } from './sceneLayers'
import {
  Overlays,
  type OverlayElement,
  type OverlayPair,
  type OverlayAngle,
  type OverlayTag,
  type ProbeMarker,
} from './overlays'
import { SectionOverlay, type SectionOverlayItem } from './sections'
import type { SectionFrame, WorldAxis } from '../core/section/frame'
import type { SectionCut } from '../core/section/slice'
import type { ControlScheme } from './navSchemes'
import type { PickMarker } from './PickScene'
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh'
import type { FitData, Vec3 } from '../core/types'
import { rigidApplyToPoints, rigidRotateVectors, type Rigid } from '../core/deviation/rigid'
import { deflectionFactor, deflectionStartPhase } from '../core/deviation/deflection'
import { applyFinish, DEFAULT_THEME, setSurfaceColor, type ViewTheme } from './viewThemes'
import {
  backfaceUniforms,
  BACKFACE_GLSL_FRAGMENT,
  BACKFACE_GLSL_PREAMBLE,
} from './backfaceTint'
import {
  surfaceUniform,
  TINT_GLSL_FRAGMENT,
  TINT_GLSL_PREAMBLE,
  TINT_GLSL_VERTEX,
  TINT_GLSL_VERTEX_BODY,
  type SurfaceUniform,
} from './regionTint'
import {
  paintUniform,
  setPaintUniform,
  PAINT_GLSL_FRAGMENT,
  PAINT_GLSL_PREAMBLE,
  PAINT_GLSL_VERTEX,
  PAINT_GLSL_VERTEX_BODY,
  type PaintUniform,
} from './paintTint'
import {
  DEFLECT_GLSL_VERTEX,
  DEFLECT_GLSL_VERTEX_BODY,
  DEFLECTION_PERIOD_MS,
  type DeflectionUniform,
} from './deflection'
import {
  patchWireframe,
  SEE_THROUGH_OPACITY,
  setSurfaceOpacity,
  spliceWireframe,
  wireUniforms,
} from './surfaceModes'

declare module 'three' {
  interface BufferGeometry {
    computeBoundsTree: typeof computeBoundsTree
    disposeBoundsTree: typeof disposeBoundsTree
  }
}

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree
THREE.Mesh.prototype.raycast = acceleratedRaycast

/** Dominant direction of the vertex cloud (power iteration on the
 *  covariance of a subsample) — used to frame elongated parts broadside. */
function principalAxis(positions: Float32Array): THREE.Vector3 {
  const n = positions.length / 3
  const step = Math.max(1, Math.floor(n / 50_000))
  let mx = 0, my = 0, mz = 0, m = 0
  for (let v = 0; v < n; v += step) {
    mx += positions[v * 3]
    my += positions[v * 3 + 1]
    mz += positions[v * 3 + 2]
    m++
  }
  mx /= m; my /= m; mz /= m
  let cxx = 0, cxy = 0, cxz = 0, cyy = 0, cyz = 0, czz = 0
  for (let v = 0; v < n; v += step) {
    const x = positions[v * 3] - mx
    const y = positions[v * 3 + 1] - my
    const z = positions[v * 3 + 2] - mz
    cxx += x * x; cxy += x * y; cxz += x * z
    cyy += y * y; cyz += y * z; czz += z * z
  }
  const a = new THREE.Vector3(1, 1, 1).normalize()
  for (let i = 0; i < 50; i++) {
    a.set(
      cxx * a.x + cxy * a.y + cxz * a.z,
      cxy * a.x + cyy * a.y + cyz * a.z,
      cxz * a.x + cyz * a.y + czz * a.z,
    )
    const len = a.length()
    if (len < 1e-20) return new THREE.Vector3(1, 0, 0)
    a.divideScalar(len)
  }
  return a
}

/** The overlay data and the marking brush are defined beside the modules that
 *  draw them; consumers keep importing everything from here. */
export type { OverlayElement, OverlayPair, OverlayAngle, OverlayTag, ProbeMarker } from './overlays'
export type { MarkGesture, PaintBrush } from './marking'
export type { GripSide, PluginGrip } from './extendGrips'
export type { SectionOverlayItem } from './sections'

/** Where a ray met the scan. The barycentric weights come along so a caller
 *  holding a per-vertex field — the deviation map — can read its value at the
 *  exact point clicked rather than at the nearest vertex. */
export interface PickHit {
  vertices: [number, number, number]
  weights: [number, number, number]
  point: Vec3
  /** Which way the scanned surface faces at the hit (unit vector, scan
   *  coordinates) — what tells an alignment which side of a picked face is
   *  outside. */
  normal: Vec3
  /** Cursor position that produced the hit, so a readout can follow it. */
  clientX: number
  clientY: number
  /** Ctrl was held for the click — a pick that takes away instead of
   *  adding, where a pick can do both. */
  ctrlKey: boolean
}

/** A point picked on the scan while setting up an alignment — the same marker
 *  the split picker's scenes place, so it is defined once, in PickScene. */
export type { PickMarker }

/** Owns the Three.js scene: mesh display, BVH picking, per-vertex region
 *  tinting, the fitted-sphere / distance-line overlays, and the translucent
 *  preview of a fit the user has not confirmed yet.
 *
 *  A coordinator these days: the viewport chassis, the vertex-colour
 *  compositor, the marking gestures, the extend grips, the overlay drawing
 *  and the axis gizmo each live in their own module, and this class wires
 *  them to each other and keeps the public face the app talks to. */
/** The view the datum stage is read from: front-top-right with Z up — the
 *  pose a part standing on the floor plane looks upright in, and the same
 *  pose the iso key turns to. */
const STAGE_VIEW = STANDARD_VIEWS.iso

/** How see-through the reference's ghost is while it is being fitted. */
const GHOST_OPACITY = 0.5

/** The scan's marking, as another viewport needs it: the compositor that owns
 *  the mask, the attribute it is stored in, and the tint. See markingChannel. */
export interface MarkingChannel {
  regions: RegionColors
  paintAttr: () => THREE.BufferAttribute | null
  setPaintColor: (rgb: [number, number, number]) => void
  /** The scan's own vertex behind a render index — see graphVertex. */
  graphVertex: (v: number) => number
}

/** A mesh laid out for the scan's place in the viewport: its geometry, the
 *  channels painted on it, their compositor, and how it is framed — the
 *  scan's, or an edited copy's. See SceneManager.showEdited. */
interface SlotLayout {
  geometry: THREE.BufferGeometry
  colorAttr: THREE.BufferAttribute
  tintAttr: THREE.BufferAttribute
  paintAttr: THREE.BufferAttribute
  scanVertices: number
  copyOf: Uint32Array
  regions: RegionColors
  modelRadius: number
  axis: THREE.Vector3
}

export class SceneManager {
  private viewport: OrthoViewport
  private gizmo: AxisGizmo
  /** The div the canvas lives in, kept so the corner the gizmo takes can be
   *  published to CSS — see drawGizmo. */
  private container!: HTMLDivElement
  /** Last gizmo corner published, so the style is written when it changes
   *  rather than on every frame. */
  private gizmoCorner = 0
  /** The target coordinate frame, shown while an alignment is being set up. */
  private stage: DatumStage
  /** Stage, lights and surface colours — see viewThemes. Held here as well as
   *  in the viewport because a scan or a reference loaded later has to be
   *  dressed in whatever scheme is current. */
  private theme: ViewTheme = DEFAULT_THEME
  /** Who owns each vertex's colour, and every tint layered over it. */
  private regions = new RegionColors(DEFAULT_THEME.surface)
  private marking: SurfaceMarking
  private grips: ExtendGrips
  private overlays: Overlays
  private sections: SectionOverlay
  /**
   * Everything that lives in the scan's own coordinates: the scan itself, the
   * fitted elements, the pending preview and any pinned readings.
   *
   * The alignment is carried here, on the group, because the reference is the
   * datum — a nominal part is the thing a measurement is *against*, so it does
   * not move. Moving the scan means moving everything measured on it too, and
   * a group is what keeps a fitted sphere on the ball it was fitted to.
   */
  private partGroup = new THREE.Group()
  /** The two things that can move the scan's group: the best fit onto a
   *  reference, and the live preview of a datum alignment still being set up.
   *  Held apart so either can be lifted without disturbing the other. */
  private alignMatrix = new THREE.Matrix4()
  private previewMatrix = new THREE.Matrix4()
  private mesh: THREE.Mesh | null = null
  private colorAttr: THREE.BufferAttribute | null = null
  /** Which vertices wear a tint of their own, one byte per vertex beside the
   *  colours: thresholded in the scan's shader so a region's border falls on
   *  triangle edges instead of fading across the ring around it — see
   *  regionTint.ts. Moves with the colour attribute, never alone. */
  private tintAttr: THREE.BufferAttribute | null = null
  /** The hand-marking's own channel: one byte per vertex, thresholded in the
   *  scan's shader so exactly the fully marked triangles wear the tint. Kept
   *  out of the colour attribute on purpose — vertex colours are interpolated,
   *  and an interpolated marking has a blurred border. */
  private paintAttr: THREE.BufferAttribute | null = null
  /** The scan's own vertex count. The render arrays may run on past it with
   *  the copies its sharp edges were split into for shading (see
   *  core/geometry/crease.ts); `copyOf` names the vertex behind each. Every
   *  region, field and marking is keyed by the scan's own vertices, so a
   *  render index is put through graphVertex before it means anything. */
  private scanVertices = 0
  private copyOf: Uint32Array = new Uint32Array(0)
  /** The attribute versions the copies were last brought level with — see
   *  syncCopies. */
  private synced = { color: -1, tint: -1, paint: -1 }
  /** An edited copy of the scan, laid out to take the scan's place — see
   *  setEditedMesh — or, while it is shown there, the scan's own layout,
   *  waiting. Null with no edited copy. */
  private other: SlotLayout | null = null
  private editedShown = false
  private nominalMesh: THREE.Mesh | null = null
  /** The plane the part is cut open at, and the clip plane it makes in
   *  world coordinates — see setSlicePlane. */
  private slice: SectionFrame | null = null
  private slicePlanes: THREE.Plane[] | null = null
  private sliceCapColor: number | null = null
  /** Whether the cut is closed with a cap — see setSliceCapped. */
  private sliceCapped = true
  /** A 2D sheet laid over this view, which it follows: the sheet's frame,
   *  what lies under its screen centre and its scale — see followSheet. The
   *  size the follow was last applied at, so a viewport shown again after
   *  being put away catches up. */
  private sheetFollow: { frame: SectionFrame; centre: readonly [number, number]; unitsPerPx: number } | null = null
  private followedSize = { w: 0, h: 0 }
  /** The cap that closes the part where it is cut open — see applySlice. */
  private cap: { back: THREE.Mesh; front: THREE.Mesh; sheet: THREE.Mesh; dispose: () => void } | null = null
  private capGeometry = new THREE.PlaneGeometry(1, 1)
  /** Elements lit because something being built refers to them, and
   *  elements lit because a picker's option is hovered — two reasons, one
   *  look; the overlays hear the union. */
  private highlightedElements: readonly number[] = []
  private hintedElements: readonly number[] = []
  /** What the plugins draw and pick in this viewport — see sceneLayers.ts. */
  private layers: SceneLayer[] = []
  /** Long axis of the scan, kept so the camera can be re-framed later without
   *  walking the vertices again. */
  private scanAxis = new THREE.Vector3(1, 0, 0)
  private modelRadius = 1
  /** What frameCamera last enclosed, kept so an alignment preview can bound
   *  "the framed scene plus the moved scan" absolutely each call instead of
   *  ratcheting clipSphere up and never back down. */
  private framedClip = { center: new THREE.Vector3(), radius: 1 }
  /** Last cursor position, and whether it has been raycast yet. Hover testing
   *  happens once per frame rather than once per pointermove: a mouse can emit
   *  hundreds of moves a second and only the latest one is on screen. */
  private hoverAt: { x: number; y: number } | null = null
  private hoverDirty = false
  /** Hover put out for a drag that is moving the view — see updateHover. */
  private hoverHeld = false
  private hoverEnabled = false
  private hoverWasHit = false
  /** While on, a click resolves to the element under the cursor (overlay
   *  shape or painted region) before falling back to a plain surface pick. */
  private elementPickEnabled = false
  /** The only elements a click may resolve to, or null for any. The others
   *  are not there for the pick: a click on one goes through it to the scan
   *  beneath — a point slot of a construction that asks for a point takes a
   *  point element, and a click anywhere else on the part a new one. */
  private elementPickOnly: ReadonlySet<number> | null = null
  /** Whether the element under the cursor lights while element picking is
   *  on — for a pick that asks for an element, or a click that selects one —
   *  and which one is lit. The Measure workspace's pickers say what is
   *  pickable by other means and leave this off. */
  private elementHoverLights = false
  private hoveredElement: number | null = null
  /** Whether each layer was covered under the cursor at the last hover —
   *  where a first arrow-key step starts from (cycleUnderCursor). */
  private hoverCovered = new WeakMap<SceneLayer, boolean>()

  /** Back-face tinting, shared by every material of this view that opts in.
   *  The split view's reference half keeps a pair of its own and is driven
   *  from the same switch — see backfaceTint.ts. */
  private backface = backfaceUniforms(DEFAULT_THEME.backface)

  /** The marking's tint, as a uniform: recolouring what is marked is one write
   *  here rather than a pass over the mask — see paintTint.ts. */
  private uPaintColor: PaintUniform = paintUniform()

  /** The bare surface colour the shader paints under a region's border, kept
   *  in step with the scheme — see regionTint.ts. */
  private uSurfaceColor: SurfaceUniform = surfaceUniform(DEFAULT_THEME)

  /** The mesh mode's switch, shared by the scan and the reference: the
   *  triangle edges, drawn in the surface shader — see surfaceModes.ts. */
  private wire = wireUniforms()

  /** The map played as motion — see deflection.ts. Each scan vertex's offset
   *  off the ideal surface, with the geometry it was laid on: the loop plays
   *  only while that geometry is the one on screen. Null at rest. */
  private deflection: { vectors: Float32Array; geometry: THREE.BufferGeometry } | null = null
  /** How many times the deviation is exaggerated at the top of the loop. */
  private deflectScale = 1
  /** When the loop began, in performance.now() time. */
  private deflectStart = 0
  private uDeflect: DeflectionUniform = { value: 0 }
  /** See-through surfaces, so what is inside the scan — the reference, the
   *  fitted elements, the pinned readings — shows. Held here as well as on
   *  the materials because a part loaded later has to be dressed the same. */
  private translucent = false
  private scanGhost = false
  /** Whether the reference is a ghost or a solid part — see setNominalGhost.
   *  A ghost until the workspace says otherwise, which is how it starts. */
  private nominalGhost = true

  /** Scratch for picking, which runs every frame the cursor moves: the
   *  barycentric corners and difference vectors, and (in D) the hit point
   *  carried into the part's frame. */
  private scratchA = new THREE.Vector3()
  private scratchB = new THREE.Vector3()
  private scratchC = new THREE.Vector3()
  private scratchD = new THREE.Vector3()
  private scratchE = new THREE.Vector3()

  /** Who currently owns the plain left-drag. The brush and the grips both need
   *  it and must not fight over handing it back — the navigator is told once,
   *  from whether anyone is holding it at all. */
  private dragClaims = new Set<'paint' | 'handle' | 'gizmo'>()

  onPick: ((hit: PickHit) => void) | null = null
  onHover: ((hit: PickHit | null) => void) | null = null
  /** A click on an element while element picking is on — with where the
   *  click was, for a chip bar to stand by. */
  onElementPick: ((id: number, clientX: number, clientY: number) => void) | null = null
  /** A click on one of the coordinate planes offered to a section. */
  onWorldPlanePick: ((axis: WorldAxis) => void) | null = null
  /** How many vertices the brush has marked, reported when a stroke ends. */
  onPaintChange: ((count: number) => void) | null = null
  /** A grip being dragged: which side, and how many millimetres it has been
   *  pulled out (negative in) since the drag began — or, for a section plane's
   *  grip, how far along its normal it has been moved. */
  onExtendDrag: ((side: GripSide, delta: number, phase: 'start' | 'move' | 'end') => void) | null =
    null
  /** The text typed into the field on a plugin's grip and entered, or the
   *  field closed with Escape — see setGripField. */
  onGripFieldCommit: ((side: GripSide, text: string) => void) | null = null
  onGripFieldClose: (() => void) | null = null

  constructor(container: HTMLDivElement) {
    this.viewport = new OrthoViewport(container, {
      theme: this.theme,
      // An orbit pivots on whichever part is actually on screen: in the
      // deviation workspace the scan can be hidden behind the reference, or
      // the other way round, and turning about a surface nobody can see reads
      // as a glitch. Whatever a plugin shows in the scan's place counts too.
      navTargets: () => {
        const targets: THREE.Object3D[] = []
        if (this.mesh?.visible) targets.push(this.mesh)
        if (this.nominalMesh?.visible) targets.push(this.nominalMesh)
        for (const layer of this.layers) targets.push(...(layer.navTargets?.() ?? []))
        return targets
      },
      onPointerDown: (e) => this.handlePointerDown(e),
      // A pan or a pinch beginning under a live brush stroke: the stroke keeps
      // what it took and ends there, rather than being dragged across the part
      // by a hand that has started navigating.
      onMultiTouch: () => this.marking.endGesture(),
      onClick: (x, y, e) => this.handleClick(x, y, e?.ctrlKey ?? false),
      // The stroke and hover queues are what decide whether this frame has
      // anything new to show at all.
      onTick: () => {
        this.marking.drainStroke()
        this.updateHover()
        // Anything held at a fixed size on screen — the picked-point markers —
        // has to be re-scaled when the zoom changes. A no-op on the frames it
        // has not.
        this.overlays.setPixelScale(this.viewport.worldPerPixel())
        // Pins on the far side of the part go away as it turns, if asked to;
        // a no-op unless the view moved.
        this.overlays.updateProbeOcclusion()
        // The section curves are fat lines sized in pixels and need the canvas.
        const el = this.viewport.renderer.domElement
        this.sections.setResolution(el.clientWidth || 1, el.clientHeight || 1)
        for (const layer of this.layers) layer.tick?.(el.clientWidth || 1, el.clientHeight || 1)
        // A viewport that follows a sheet re-reads its scale when its own
        // size changes — shown again after being put away, or the window
        // resized — since the scale is millimetres per pixel.
        if (this.sheetFollow && (el.clientWidth !== this.followedSize.w || el.clientHeight !== this.followedSize.h)) {
          this.applyFollow(0)
        }
        this.stepDeflection()
        // Last, after everything above that may have written a vertex
        // attribute, and before the frame that uploads it.
        this.syncCopies()
      },
      onAfterRender: (w, h) => this.drawGizmo(w, h),
    })
    this.container = container
    this.gizmo = new AxisGizmo()
    this.stage = new DatumStage(this.scene)
    // A material may carry a clip plane of its own — the slice through the
    // part at a sketch plane. Nothing is clipped until one is set.
    this.viewport.renderer.localClippingEnabled = true

    this.partGroup.matrixAutoUpdate = false
    this.scene.add(this.partGroup)

    this.marking = new SurfaceMarking({
      container,
      camera: this.camera,
      partGroup: this.partGroup,
      raycaster: this.raycaster,
      regions: this.regions,
      setPickRay: (x, y) => this.setPickRay(x, y),
      mesh: () => this.mesh,
      paintAttr: () => this.paintAttr,
      graphVertex: this.graphVertex,
      setPaintColor: (rgb) => {
        setPaintUniform(this.uPaintColor, rgb)
        this.invalidate()
      },
      invalidate: this.invalidate,
      claimDrag: (on) => this.claimDrag('paint', on),
      requestHover: () => {
        this.hoverDirty = true
      },
      onPaintChange: (count) => this.onPaintChange?.(count),
    })
    this.overlays = new Overlays({
      partGroup: this.partGroup,
      modelRadius: () => this.modelRadius,
      invalidate: this.invalidate,
      camera: this.camera,
      raycaster: this.raycaster,
      // Only the scan stands between the camera and a pin: the pins are
      // readings on the scan, and the reference is a translucent ghost a pin
      // shows through. A hidden scan hides nothing.
      occluder: () => (this.mesh?.visible ? this.mesh : null),
    })
    this.sections = new SectionOverlay({
      partGroup: this.partGroup,
      modelRadius: () => this.modelRadius,
      modelCenter: () => this.modelCenter(),
      invalidate: this.invalidate,
    })
    this.grips = new ExtendGrips({
      partGroup: this.partGroup,
      raycaster: this.raycaster,
      canvas: this.viewport.renderer.domElement,
      setPickRay: (x, y) => this.setPickRay(x, y),
      modelRadius: () => this.modelRadius,
      invalidate: this.invalidate,
      claimDrag: (on) => this.claimDrag('handle', on),
      requestHover: () => {
        this.hoverDirty = true
      },
      onExtendDrag: (side, delta, phase) => this.onExtendDrag?.(side, delta, phase),
      // Only an element's ghost has ends to mark; a section plane's gizmo
      // stands on a sheet that is its own mark, and a plugin's grips are on
      // something of its own.
      onActiveSide: (side) =>
        this.overlays.setPreviewActiveSide(isSectionSide(side) || isPluginSide(side) ? null : side),
      onFieldCommit: (side, value) => this.onGripFieldCommit?.(side, value),
      onFieldClose: () => this.onGripFieldClose?.(),
    })
    this.viewport.renderer.domElement.addEventListener('pointermove', (e) => {
      this.hoverAt = { x: e.clientX, y: e.clientY }
      this.hoverDirty = true
    })
    this.viewport.renderer.domElement.addEventListener('pointerleave', () => {
      this.hoverAt = null
      this.hoverDirty = true
    })
  }

  // The chassis pieces the methods below keep reaching for — one instance
  // each, owned by the viewport.
  private get camera(): THREE.OrthographicCamera {
    return this.viewport.camera
  }
  private get controls() {
    return this.viewport.controls
  }
  private get scene(): THREE.Scene {
    return this.viewport.scene
  }
  private get raycaster(): THREE.Raycaster {
    return this.viewport.raycaster
  }
  private get clipSphere() {
    return this.viewport.clipSphere
  }
  private invalidate = (): void => {
    this.viewport.invalidate()
  }

  /** Swap the pointer-button control scheme (dropdown in the settings dialog). */
  setNavScheme(scheme: ControlScheme): void {
    this.viewport.setNavScheme(scheme)
  }

  /**
   * Swap the colour scheme (dropdown in the settings dialog): stage, lights, the
   * finish the parts are seen under, and the colours of everything that is not
   * itself a reading.
   *
   * Element tints, the deviation ramp and the unmeasured grey of a map are left
   * exactly where they are. They are what has been measured, and a measurement
   * that changed colour with the lighting would be worth nothing.
   */
  setViewTheme(theme: ViewTheme): void {
    this.theme = theme
    this.viewport.setTheme(theme)
    this.marking.setTheme(theme)
    this.overlays.setTheme(theme)
    this.backface.uBackfaceColor.value.setHex(theme.backface)
    setSurfaceColor(this.uSurfaceColor.value, theme)
    if (this.regions.setBaseColor(theme.surface)) this.surfaceRepainted()
    // The layout waiting out of sight is flagged when it comes back.
    this.other?.regions.setBaseColor(theme.surface)
    if (this.mesh) applyFinish(this.mesh.material as THREE.MeshStandardMaterial, theme)
    // The cap wears the surface colour of the scheme.
    if (this.cap) this.applySlice()
    if (this.nominalMesh) {
      const material = this.nominalMesh.material as THREE.MeshStandardMaterial
      material.color.setHex(theme.nominal)
      applyFinish(material, theme)
    }
    for (const layer of this.layers) layer.themeChanged?.(theme)
    this.invalidate()
  }

  /** This viewport as the scan half of the deviation split view (cameraLink.ts).
   *  The pose travels in world coordinates, which are the reference's — the fit
   *  carries the scan into them, so one camera between the halves is what puts a
   *  feature and its counterpart in the same place on both screens. */
  viewLink(): LinkedView {
    return this.viewport.viewLink()
  }

  /** With the brush armed, a plain press starts a stroke or a marquee; a grip
   *  under the cursor takes the plain left-drag — the navigator has stepped
   *  aside for both. While a marking gesture is live the grips never get a
   *  look-in: that one asked first. */
  private handlePointerDown(e: PointerEvent): boolean {
    // The gizmo corner is a button before it is anything else: tested here
    // rather than read off the hover, because a finger has no hover.
    if (e.button === 0 && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      const axis = this.gizmoAt(e.clientX, e.clientY)
      if (axis !== null) {
        this.viewAlong(axis)
        return true
      }
    }
    if (this.marking.pointerGesture() !== null) return this.marking.handlePointerDown(e)
    if (this.grips.handlePointerDown(e)) return true
    for (const layer of this.sortedLayers()) if (layer.pointerDown?.(e)) return true
    return false
  }

  /** The gizmo arrow under a client point, if any. */
  private gizmoAt(clientX: number, clientY: number): GizmoAxis | null {
    const rect = this.viewport.renderer.domElement.getBoundingClientRect()
    return this.gizmo.hitTest(clientX - rect.left, clientY - rect.top)
  }

  /** Look down a gizmo arrow: the view from the positive end of that axis,
   *  or, when the camera is already there, from the negative end — so a
   *  second click on the same arrow turns the part over. */
  viewAlong(axis: GizmoAxis): void {
    const [near, far]: [StandardView, StandardView] =
      axis === 'x' ? ['right', 'left'] : axis === 'y' ? ['rear', 'front'] : ['top', 'bottom']
    const dir = new THREE.Vector3().subVectors(this.camera.position, this.controls.target).normalize()
    const there = dir.dot(STANDARD_VIEWS[near].dir) > 0.999
    this.viewFrom(there ? far : near)
  }

  /** The layers in their order — see sceneLayers.ts. */
  private sortedLayers(): SceneLayer[] {
    return [...this.layers].sort((a, b) => a.order - b.order)
  }

  /** What a click is offered to, in order: the layers' picks, and the
   *  viewport's own — a measured element while element picking is on, then
   *  a coordinate plane on offer. An element comes before a plane: the planes
   *  are drawn through the part and would otherwise take every click on
   *  whatever lies behind them. */
  private clickSteps(): ((x: number, y: number, additive: boolean) => boolean)[] {
    const steps: { order: number; click: (x: number, y: number, additive: boolean) => boolean }[] = [
      {
        order: LAYER_ORDER.elements,
        click: (x, y) => {
          if (!this.elementPickEnabled) return false
          const id = this.elementAt(x, y)
          if (id === null) return false
          this.onElementPick?.(id, x, y)
          return true
        },
      },
      {
        order: LAYER_ORDER.worldPlanes,
        click: (x, y) => {
          const plane = this.worldPlaneAt(x, y)
          if (plane === null) return false
          this.onWorldPlanePick?.(plane)
          return true
        },
      },
      ...this.layers.flatMap((layer) => (layer.click ? [{ order: layer.order, click: layer.click }] : [])),
    ]
    return steps.sort((a, b) => a.order - b.order).map((step) => step.click)
  }

  /** A click that survived the drag threshold: whatever of the layers' and
   *  the viewport's own takes it, else a surface pick. */
  private handleClick(x: number, y: number, ctrlKey = false): void {
    // What the arrow keys stepped to under the cursor takes the click first.
    const stepped = this.cyclingLayer({ x, y })
    if (stepped?.click?.(x, y, ctrlKey)) return
    for (const click of this.clickSteps()) if (click(x, y, ctrlKey)) return
    // Nothing selectable was there: the scan, or empty space.
    if (!ctrlKey) for (const layer of this.layers) layer.clickedAway?.(x, y)
    const hit = this.pick(x, y)
    if (hit) this.onPick?.({ ...hit, ctrlKey })
  }

  /** What lights under the cursor, in order: the layers' and the viewport's
   *  own — the grips, which never light while a marking gesture is armed
   *  (both plain drags are the brush's then), and a measured element on
   *  offer. */
  private hoverSteps(): { covers: boolean; layer?: SceneLayer; hover: (at: { x: number; y: number } | null, covered: boolean) => boolean }[] {
    const steps: { order: number; covers: boolean; layer?: SceneLayer; hover: (at: { x: number; y: number } | null, covered: boolean) => boolean }[] = [
      {
        order: LAYER_ORDER.grips,
        covers: true,
        hover: (at, covered) => {
          this.grips.updateHover(covered ? null : at, this.marking.gestureArmed())
          return this.grips.isHovered()
        },
      },
      { order: LAYER_ORDER.elements, covers: false, hover: (at, covered) => this.hoverElement(covered ? null : at) },
      ...this.layers.flatMap((layer) => (layer.hover ? [{ order: layer.order, covers: Boolean(layer.covers), layer, hover: layer.hover }] : [])),
    ]
    return steps.sort((a, b) => a.order - b.order)
  }

  /** The layer holding a step the arrow keys took under the cursor at
   *  `at`, if one does — see SceneLayer.cycling. */
  private cyclingLayer(at: { x: number; y: number } | null): SceneLayer | null {
    return this.layers.find((layer) => layer.cycling?.(at)) ?? null
  }

  /**
   * The arrow keys over the part: step to the next of what lies under the
   * cursor — the face behind the one in front, the edge behind a body, a
   * body behind another — or back, as CAD's "select other" does. The
   * layers are asked in their order; the first that has more than one thing
   * there takes the step. True when one did.
   */
  cycleUnderCursor(step: 1 | -1): boolean {
    const at = this.hoverAt
    if (!at) return false
    // A measured element before the layer would take the click: the
    // layer's first is then a step behind it, not the start.
    const element = this.elementPickEnabled && this.elementAt(at.x, at.y) !== null
    const layers = [...this.layers].sort((a, b) => a.order - b.order)
    for (const layer of layers) {
      if (!layer.cycle) continue
      const behind = (this.hoverCovered.get(layer) ?? false) || (element && LAYER_ORDER.elements < layer.order)
      if (layer.cycle(at, step, behind)) {
        this.hoverDirty = true
        this.invalidate()
        return true
      }
    }
    return false
  }

  /** An element on offer lights under the cursor the way a sketch region
   *  does, so the part says what a click would take. */
  private hoverElement(at: { x: number; y: number } | null): boolean {
    if (this.elementHoverLights) {
      const id = at && this.elementPickEnabled ? this.elementAt(at.x, at.y) : null
      if (id !== this.hoveredElement) {
        this.hoveredElement = id
        this.applyElementHighlight()
        this.viewport.renderer.domElement.style.cursor = id !== null ? 'pointer' : ''
      }
    } else if (this.hoveredElement !== null) {
      this.hoveredElement = null
      this.applyElementHighlight()
    }
    return false
  }

  /** One pointer test per frame, and only when the answer could have changed:
   *  the hover readout when a map is showing, the brush footprint when the
   *  brush is armed. A mouse can emit hundreds of moves a second and only the
   *  last of them is on screen.
   *
   *  None while a drag turns, pans or zooms the view: what was lit goes out
   *  at its first move, and the cursor is tested again where the drag ends.
   *  Lit along the way, a face or an edge would flicker past under a cursor
   *  that is steering the camera, not pointing at anything — and the test,
   *  several rays a frame over everything pickable, would be paid on every
   *  frame of the turn. */
  private updateHover(): void {
    if (this.viewport.navigating()) {
      if (!this.hoverHeld) {
        this.hoverHeld = true
        this.hoverUnder(null)
      }
      return
    }
    if (this.hoverHeld) {
      this.hoverHeld = false
      this.hoverDirty = true
    }
    if (!this.hoverDirty) return
    this.hoverDirty = false
    this.hoverUnder(this.hoverAt)
  }

  /** Light what is under a client point — or, with null, nothing. */
  private hoverUnder(at: { x: number; y: number } | null): void {
    // The gizmo's arrows light under the cursor and take the plain left-drag
    // off the camera while one is under it, the way the grips do: a press on
    // an arrow is a click on a button, not the start of an orbit.
    const axis = at ? this.gizmoAt(at.x, at.y) : null
    if (this.gizmo.setHovered(axis)) {
      this.viewport.renderer.domElement.style.cursor = axis !== null ? 'pointer' : ''
      this.claimDrag('gizmo', axis !== null)
      this.invalidate()
    }
    // A coordinate plane on offer lights under the cursor the way an element
    // does — except under the gizmo corner, which is a button first, and
    // where an element is: that one would take the click.
    const plane = at && axis === null ? this.worldPlaneUnder(at.x, at.y) : null
    if (this.sections.setHoveredWorldPlane(plane)) {
      this.viewport.renderer.domElement.style.cursor = plane !== null ? 'pointer' : ''
    }
    if (this.marking.armed()) this.marking.updateBrushRing(at)
    // Then everything that lights under the cursor, in order: what lights
    // covers what comes after it where it says so — a grip, or a sketch
    // region, over what lies behind — and nothing lights under the gizmo
    // corner, which is a button first.
    let covered = axis !== null
    // A step the arrow keys took lights alone: every other layer is covered.
    const stepped = this.cyclingLayer(at)
    for (const step of this.hoverSteps()) {
      const under = stepped ? step.layer !== stepped : covered
      if (step.layer) this.hoverCovered.set(step.layer, under)
      if (step.hover(at, under) && step.covers) covered = true
    }
    if (!this.hoverEnabled) return
    const hit = at ? this.pick(at.x, at.y) : null
    // Silence is worth reporting once, not every frame the cursor spends off
    // the part.
    if (!hit && !this.hoverWasHit) return
    this.hoverWasHit = hit !== null
    this.onHover?.(hit)
  }

  setHoverEnabled(enabled: boolean): void {
    if (this.hoverEnabled === enabled) return
    this.hoverEnabled = enabled
    this.hoverDirty = true
    this.invalidate()
    if (!enabled && this.hoverWasHit) {
      this.hoverWasHit = false
      this.onHover?.(null)
    }
  }

  /** Replace the displayed mesh. Synchronous and heavy (includes the BVH
   *  build) — callers should show a status message and yield a frame first.
   *  `copyOf` names the scan vertex behind each render vertex past the
   *  scan's own — the copies its sharp edges were split into for shading. */
  setMesh(
    positions: Float32Array,
    indices: Uint32Array,
    normals: Float32Array,
    wireSlots?: Uint8Array,
    copyOf: Uint32Array = new Uint32Array(0),
  ): void {
    this.prepareMesh(positions, indices, normals, wireSlots, copyOf).commit()
  }

  /** Allocate and index a replacement before releasing the current mesh. */
  prepareMesh(
    positions: Float32Array,
    indices: Uint32Array,
    normals: Float32Array,
    wireSlots?: Uint8Array,
    copyOf: Uint32Array = new Uint32Array(0),
  ): { commit(): void; dispose(): void } {
    const geometry = new THREE.BufferGeometry()
    const { colors, paint, tint } = this.layOutScan(
      geometry,
      positions,
      indices,
      normals,
      wireSlots,
      copyOf,
      null,
      false,
    )
    try { geometry.computeBoundsTree() } catch (e) { geometry.dispose(); throw e }
    const axis = principalAxis(positions)

    // Scans have holes; double-sided rendering keeps interior surfaces
    // visible instead of culling them to black.
    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
    })
    applyFinish(material, this.theme)
    this.patchScanShader(material)
    setSurfaceOpacity(material, this.scanOpacity())
    const mesh = new THREE.Mesh(geometry, material)
    let owned = true
    return {
      dispose: () => {
        if (!owned) return
        owned = false
        geometry.disposeBoundsTree?.()
        geometry.dispose()
        material.dispose()
      },
      commit: () => {
        if (!owned) throw new Error('The prepared scan has already been used.')
        owned = false
        this.disposeMesh()
        this.setPreview(null)
        this.mesh = mesh
        this.adoptScanLayout(geometry, copyOf)
        this.partGroup.add(this.mesh)
        this.applySlice()
        // A new scan is not aligned to anything yet, and nothing is being
        // previewed on it.
        this.previewMatrix.identity()
        this.setAlignment(null)
        this.regions.attach(colors, paint, tint, this.scanVertices)

        this.modelRadius = Math.max(
          geometry.boundingBox!.min.distanceTo(geometry.boundingBox!.max) / 2,
          1e-4,
        )
        this.scanAxis = axis
        this.frameCamera(geometry.boundingBox!, this.scanAxis)
      },
    }
  }

  /**
   * Fill a geometry with the scan's arrays and fresh colour, tint and paint
   * buffers, sized to the render vertex count. `keep` is the previous
   * buffers when the same scan is being laid out again: their first
   * `scanVertices` entries — the scan's own vertices — are carried over, and
   * the copies take theirs from them on the next tick.
   */
  private layOutScan(
    geometry: THREE.BufferGeometry,
    positions: Float32Array,
    indices: Uint32Array,
    normals: Float32Array,
    wireSlots: Uint8Array | undefined,
    copyOf: Uint32Array,
    keep: { colors: Uint8Array; paint: Uint8Array; tint: Uint8Array } | null,
    adopt = true,
  ): { colors: Uint8Array; paint: Uint8Array; tint: Uint8Array } {
    const vertexCount = positions.length / 3
    const own = vertexCount - copyOf.length
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
    const colors = new Uint8Array(vertexCount * 3)
    if (keep) colors.set(keep.colors.subarray(0, own * 3))
    else {
      const base = this.theme.surface
      for (let i = 0; i < vertexCount; i++) {
        colors[i * 3] = base[0]
        colors[i * 3 + 1] = base[1]
        colors[i * 3 + 2] = base[2]
      }
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3, true))
    const tint = new Uint8Array(vertexCount)
    if (keep) tint.set(keep.tint.subarray(0, own))
    geometry.setAttribute('tint', new THREE.BufferAttribute(tint, 1))
    const paint = new Uint8Array(vertexCount)
    if (keep) paint.set(keep.paint.subarray(0, own))
    geometry.setAttribute('paint', new THREE.BufferAttribute(paint, 1))
    // The corner slots the mesh mode draws the edges from. Without them the
    // shader sees one slot everywhere and draws no edges, and nothing else
    // minds.
    if (wireSlots) geometry.setAttribute('wireSlot', new THREE.BufferAttribute(wireSlots, 1))
    else geometry.deleteAttribute('wireSlot')
    geometry.setIndex(new THREE.BufferAttribute(indices, 1))
    geometry.computeBoundingBox()
    geometry.computeBoundingSphere()
    if (adopt) this.adoptScanLayout(geometry, copyOf)
    return { colors, paint, tint }
  }

  private adoptScanLayout(geometry: THREE.BufferGeometry, copyOf: Uint32Array): void {
    this.colorAttr = geometry.getAttribute('color') as THREE.BufferAttribute
    this.tintAttr = geometry.getAttribute('tint') as THREE.BufferAttribute
    this.paintAttr = geometry.getAttribute('paint') as THREE.BufferAttribute
    this.scanVertices = geometry.getAttribute('position').count - copyOf.length
    this.copyOf = copyOf
    // Whatever the copies held is gone with the old arrays; the first tick
    // fills them from their vertices.
    this.synced = { color: -1, tint: -1, paint: -1 }
  }

  /**
   * The same scan, laid out again with its sharp edges split differently —
   * the shading setting changed under it. The mesh, its material and the
   * geometry object stay, so every view sharing the geometry (the split
   * view, the point picker) sees the new arrays on its next frame; only the
   * GPU buffers are let go — dispose() is just that event, and the renderer
   * uploads afresh. Ownership, the deviation map and the marking are keyed
   * by the scan's own vertices and carry straight across.
   */
  resplitScan(
    positions: Float32Array,
    indices: Uint32Array,
    normals: Float32Array,
    wireSlots: Uint8Array | undefined,
    copyOf: Uint32Array,
  ): void {
    // Laid out on the scan: the copy, if it is showing, steps aside for it.
    const shown = this.editedShown
    if (shown) this.swapSlots()
    try {
      this.resplitShown(positions, indices, normals, wireSlots, copyOf)
    } finally {
      if (shown) this.swapSlots()
    }
  }

  /** The edited copy's render geometry laid out again — its sharp edges
   *  split as the setting now says — as resplitScan lays out the scan's,
   *  whether the copy is on screen or waiting. Nothing without a copy. */
  resplitEdited(
    positions: Float32Array,
    indices: Uint32Array,
    normals: Float32Array,
    wireSlots: Uint8Array | undefined,
    copyOf: Uint32Array,
  ): void {
    const shown = this.editedShown
    if (!shown && !this.other) return
    if (!shown) this.swapSlots()
    try {
      this.resplitShown(positions, indices, normals, wireSlots, copyOf)
    } finally {
      if (!shown) this.swapSlots()
    }
  }

  private resplitShown(
    positions: Float32Array,
    indices: Uint32Array,
    normals: Float32Array,
    wireSlots: Uint8Array | undefined,
    copyOf: Uint32Array,
  ): void {
    if (!this.mesh || !this.colorAttr || !this.tintAttr || !this.paintAttr) return
    const geometry = this.mesh.geometry as THREE.BufferGeometry
    const keep = {
      colors: this.colorAttr.array as Uint8Array,
      tint: this.tintAttr.array as Uint8Array,
      paint: this.paintAttr.array as Uint8Array,
    }
    geometry.disposeBoundsTree?.()
    geometry.dispose()
    const { colors, paint, tint } = this.layOutScan(
      geometry,
      positions,
      indices,
      normals,
      wireSlots,
      copyOf,
      keep,
    )
    this.regions.rebind(colors, paint, tint, this.scanVertices)
    // The offsets are the scan's own, laid out again over the new copies.
    this.layOutDeflection()
    geometry.computeBoundsTree()
    this.invalidate()
  }

  /** How many vertices the scan itself has — the render arrays may carry
   *  shading copies past this many; see core/geometry/crease.ts. */
  scanVertexCount(): number {
    return this.editedShown && this.other ? this.other.scanVertices : this.scanVertices
  }

  /** The scan's own vertex behind a render index: a corner split for sharp
   *  shading names a copy, and every region, field and marking is keyed by
   *  the vertex it was cut from. */
  private graphVertex = (v: number): number =>
    v < this.scanVertices ? v : this.copyOf[v - this.scanVertices]

  /**
   * Bring the shading copies level with their vertices. Colour, tint and
   * paint are written per scan vertex by everything that paints the surface
   * — none of which knows about the copies — so the copies take their values
   * here, once per frame that changed an attribute (its version moves when
   * a writer flags it), before the renderer uploads it.
   */
  private syncCopies(): void {
    const copies = this.copyOf.length
    if (copies === 0) return
    const n = this.scanVertices
    const c = this.copyOf
    const level = (attr: THREE.BufferAttribute | null, key: keyof typeof this.synced, size: 1 | 3) => {
      if (!attr || attr.version === this.synced[key]) return
      const a = attr.array as Uint8Array
      if (size === 1) {
        for (let k = 0; k < copies; k++) a[n + k] = a[c[k]]
      } else {
        for (let k = 0; k < copies; k++) {
          const d = (n + k) * 3, s = c[k] * 3
          a[d] = a[s]
          a[d + 1] = a[s + 1]
          a[d + 2] = a[s + 2]
        }
      }
      this.synced[key] = attr.version
    }
    level(this.colorAttr, 'color', 3)
    level(this.tintAttr, 'tint', 1)
    level(this.paintAttr, 'paint', 1)
  }

  /**
   * The scan material's shader amendments: the sharp border of the element
   * tints (see regionTint.ts), the hand-marking's tint (see paintTint.ts),
   * back-face flagging (see backfaceTint.ts), the mesh mode's edges (see
   * surfaceModes.ts) and the map played as motion (see deflection.ts).
   * Folded into one patch here because a material has a single
   * onBeforeCompile.
   *
   * Back faces are flagged in the shader rather than by drawing the mesh a
   * second time with the faces flipped, because the second pass would have to
   * be the same million triangles again — and because a front-face-only main
   * pass would take the inside of the part out of reach of the raycaster,
   * which is what picking, hovering and the brush all run on. The order the
   * lines run in is the order the layers stack: the region border is cut
   * first, the flag goes over it — a tinted back face is a warning, not a
   * surface — and the marking has the last word. A gesture that reaches
   * through the part marks the far side of the wall as well, and marking
   * that hid under the flag would be marking the user cannot see.
   */
  private patchScanShader(material: THREE.Material): void {
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uBackfaceTint = this.backface.uBackfaceTint
      shader.uniforms.uBackfaceColor = this.backface.uBackfaceColor
      shader.uniforms.uPaintColor = this.uPaintColor
      shader.uniforms.uSurfaceColor = this.uSurfaceColor
      shader.uniforms.uDeflect = this.uDeflect
      shader.vertexShader =
        TINT_GLSL_VERTEX +
        PAINT_GLSL_VERTEX +
        DEFLECT_GLSL_VERTEX +
        shader.vertexShader
          .replace(
            '#include <color_vertex>',
            `#include <color_vertex>
          ${TINT_GLSL_VERTEX_BODY}
          ${PAINT_GLSL_VERTEX_BODY}`,
          )
          .replace('#include <begin_vertex>', `#include <begin_vertex>\n\t${DEFLECT_GLSL_VERTEX_BODY}`)
      shader.fragmentShader =
        BACKFACE_GLSL_PREAMBLE +
        PAINT_GLSL_PREAMBLE +
        TINT_GLSL_PREAMBLE +
        shader.fragmentShader.replace(
          '#include <color_fragment>',
          `#include <color_fragment>
          ${TINT_GLSL_FRAGMENT}
          ${BACKFACE_GLSL_FRAGMENT}
          ${PAINT_GLSL_FRAGMENT}`,
        )
      spliceWireframe(shader, this.wire)
    }
  }

  /** The compositor moved colours: the colour buffer and the tint mask that
   *  goes with it both need uploading — see regionColors. */
  private surfaceRepainted(): void {
    if (this.colorAttr) this.colorAttr.needsUpdate = true
    if (this.tintAttr) this.tintAttr.needsUpdate = true
  }

  /**
   * See through the parts: the scan and the reference go translucent, so the
   * reference sitting inside the scan, the fitted elements and the pinned
   * readings show instead of being hidden by whatever surface is in front of
   * them. Picking is untouched — a click still lands on the nearest surface,
   * which is the one the cursor is visibly over.
   */
  setTranslucent(on: boolean): void {
    if (this.translucent === on) return
    this.translucent = on
    if (this.mesh) {
      setSurfaceOpacity(this.mesh.material as THREE.MeshStandardMaterial, this.scanOpacity())
    }
    if (this.nominalMesh) {
      setSurfaceOpacity(
        this.nominalMesh.material as THREE.MeshStandardMaterial,
        this.nominalOpacity(),
      )
    }
    for (const layer of this.layers) layer.opacityChanged?.(this.scanOpacity())
    this.invalidate()
  }

  /** Draw the triangle edges on the scan and the reference — see
   *  surfaceModes.ts. A uniform write, like the back-face flag. */
  setWireframe(on: boolean): void {
    this.wire.uWire.value = on ? 1 : 0
    this.invalidate()
  }

  private scanOpacity(): number {
    return this.translucent || this.scanGhost ? SEE_THROUGH_OPACITY : 1
  }

  /** The scan as a see-through reference over something modelled on it:
   *  what is being designed is what is solid, the scan a veil over it that
   *  says where the part still stands proud or shy. Picking is untouched. */
  setScanGhost(on: boolean): void {
    if (this.scanGhost === on) return
    this.scanGhost = on
    if (this.mesh) setSurfaceOpacity(this.mesh.material as THREE.MeshStandardMaterial, this.scanOpacity())
    for (const layer of this.layers) layer.opacityChanged?.(this.scanOpacity())
    this.invalidate()
  }

  /** The ghost is see-through in its own right; the see-through mode only
   *  changes what a solid reference looks like. */
  private nominalOpacity(): number {
    if (this.nominalGhost) return GHOST_OPACITY
    return this.translucent ? SEE_THROUGH_OPACITY : 1
  }

  /** Show which way the surface faces: the far side of every triangle gets a
   *  colour of its own, so holes and flipped normals stop reading as part. */
  setBackfaceTint(on: boolean): void {
    this.backface.uBackfaceTint.value = on ? 1 : 0
    this.invalidate()
  }

  /** The gizmo, plus the one thing about it the DOM needs to know: how tall a
   *  corner it is taking, so the fit-to-view button can sit exactly above it
   *  at every viewport size. A custom property rather than a React state,
   *  because this is decided per rendered frame and nothing else depends on
   *  it. */
  private drawGizmo(w: number, h: number): void {
    const size = this.gizmo.render(this.viewport.renderer, this.camera, this.controls.target, w, h)
    if (size === this.gizmoCorner) return
    this.gizmoCorner = size
    this.container.style.setProperty('--gizmo-size', `${Math.round(size)}px`)
  }

  /**
   * Bring everything on screen back into the frame, from wherever the camera
   * has wandered to.
   *
   * Only what is actually being shown counts: with the scan switched off it is
   * the reference that has to be fitted, and fitting the pair of them would
   * leave the one you are looking at small and off to one side. The datum
   * stage counts too while it is out, because an alignment being set up is read
   * against it.
   */
  fitToView(): void {
    const box = new THREE.Box3()
    const moved = this.movedScanBox()
    if (moved && this.mesh?.visible) box.union(moved)
    if (this.nominalMesh?.visible && this.nominalMesh.geometry.boundingBox) {
      box.union(this.nominalMesh.geometry.boundingBox)
    }
    if (this.stage.active()) {
      const e = this.stage.extent()
      box.union(new THREE.Box3(new THREE.Vector3(-e, -e, -e), new THREE.Vector3(e, e, e)))
    }
    // No scan: what a layer stands in its place is the part, as frameAll
    // has it.
    if (!this.mesh) {
      this.partGroup.updateMatrixWorld(true)
      for (const layer of this.layers) {
        const b = layer.frameBox?.()
        if (b) box.union(b.clone().applyMatrix4(this.partGroup.matrixWorld))
      }
    }
    // Nothing visible to fit — a hidden scan with no reference beside it. The
    // part is still loaded, so fit that rather than doing nothing at all.
    if (box.isEmpty() && moved) box.union(moved)
    if (box.isEmpty()) return
    this.viewport.fitCamera(box)
    this.framedClip.center.copy(this.clipSphere.center)
    this.framedClip.radius = this.clipSphere.radius
  }

  /** Turn to one of the standard views — top, front, iso and so on — about
   *  the point the camera is looking at, keeping the zoom. */
  viewFrom(view: StandardView): void {
    this.viewport.viewFrom(view)
  }

  /** The canvas's size on screen, in CSS pixels. */
  viewSize(): { width: number; height: number } {
    const el = this.viewport.renderer.domElement
    return { width: el.clientWidth || 1, height: el.clientHeight || 1 }
  }

  /** The view as it stands as the bytes of a PNG, `width` × `height` pixels
   *  — the canvas's own size by default. See OrthoViewport.capture. */
  async capture(width?: number, height?: number): Promise<Uint8Array> {
    const size = this.viewSize()
    const blob = await this.viewport.capture(Math.round(width ?? size.width), Math.round(height ?? size.height))
    return new Uint8Array(await blob.arrayBuffer())
  }

  /**
   * Follow a 2D sheet laid over this viewport: look at the sheet's plane
   * face on, from the side its normal points to with its V up the screen,
   * with the sheet point under the sheet's screen centre under this one and
   * the sheet's millimetres per pixel as this view's — so a line drawn on
   * the sheet lies exactly on the part beneath it. With `ms` the camera
   * swings there from wherever it was, the way CAD turns to a sketch plane,
   * so it is plain where the plane sits; with 0 it is there at once, or —
   * during a swing — the swing lands there instead.
   */
  followSheet(frame: SectionFrame, centre: readonly [number, number], unitsPerPx: number, ms = 0): void {
    this.sheetFollow = { frame, centre, unitsPerPx }
    this.applyFollow(ms)
  }

  /** The sheet's frame changed under the follow — Align turned it: swing
   *  round to the new frame with the sheet's view as it is. */
  reframeSheet(frame: SectionFrame, ms = 400): void {
    if (!this.sheetFollow) return
    this.sheetFollow = { ...this.sheetFollow, frame }
    this.applyFollow(ms)
  }

  /** The sheet put away: the camera is the operator's again. */
  stopFollowingSheet(): void {
    this.sheetFollow = null
  }

  private applyFollow(ms: number): void {
    const f = this.sheetFollow
    if (!f) return
    const el = this.viewport.renderer.domElement
    const w = el.clientWidth
    const h = el.clientHeight
    // Put away: nothing to size by until it is shown again — the tick
    // applies it then.
    if (!w || !h) return
    this.followedSize = { w, h }
    this.partGroup.updateMatrixWorld(true)
    const m = this.partGroup.matrixWorld
    const n = new THREE.Vector3(...f.frame.normal).transformDirection(m)
    const v = new THREE.Vector3(...f.frame.basisV).transformDirection(m)
    const target = new THREE.Vector3(...liftPoint(f.frame, f.centre)).applyMatrix4(m)
    // Millimetres per pixel is (top − bottom) / zoom / height.
    const cam = this.camera
    const zoom = (cam.top - cam.bottom) / (h * f.unitsPerPx)
    if (ms > 0) this.viewport.animateLook(n, v, target, ms, zoom)
    else this.viewport.retarget(n, v, target, zoom)
  }

  /** Whether the camera is still swinging round — see followSheet. */
  turning(): boolean {
    return this.viewport.turning()
  }

  /** Whether the part is cut open — see setSlicePlane. A plane that misses
   *  the part cuts nothing, so this can be false with a plane set. */
  sliced(): boolean {
    return this.slicePlanes !== null
  }

  /**
   * Cut the part open at a plane, taking away the half on the side its
   * normal points to — the side the camera faces it from, so the slice is
   * the face in view; null puts the part back together. Nothing is cut where
   * the plane misses the part: a plane beside it would take all or none.
   * The scan is cut, and so is whatever a plugin's layer cuts with it; the
   * elements and the sections are drawn whole, being lines on the part.
   */
  setSlicePlane(frame: SectionFrame | null): void {
    this.slice = frame
    this.applySlice()
  }

  /** The colour the cut face is filled with, flat and unlit — for a face
   *  something is drawn over: a lit cap seen face on comes out near white,
   *  which no line reads against. Null for the surface's own colour, lit. */
  setSliceCapColor(color: number | null): void {
    if (this.sliceCapColor === color) return
    this.sliceCapColor = color
    if (this.slice) this.applySlice()
  }

  /** Whether the part is closed where it is cut open — on by default; off
   *  for a cut whose cap is drawn by something else, or left open. */
  setSliceCapped(on: boolean): void {
    if (this.sliceCapped === on) return
    this.sliceCapped = on
    if (this.slice) this.applySlice()
  }

  private applySlice(): void {
    const frame = this.slice
    let planes: THREE.Plane[] | null = null
    if (frame && this.mesh) {
      this.partGroup.updateMatrixWorld(true)
      const m = this.partGroup.matrixWorld
      const n = new THREE.Vector3(...frame.normal).transformDirection(m)
      const o = new THREE.Vector3(...frame.origin).applyMatrix4(m)
      // Kept: what lies behind the plane, seen from its normal's side.
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n.negate(), o)
      const box = this.movedScanBox()
      if (box && box.intersectsPlane(plane)) planes = [plane]
    }
    this.slicePlanes = planes
    const dress = (mesh: THREE.Mesh | null) => {
      if (!mesh) return
      const material = mesh.material as THREE.Material
      material.clippingPlanes = planes
      material.needsUpdate = true
    }
    dress(this.mesh)
    for (const layer of this.layers) layer.clippingChanged?.(planes)
    this.clearCap()
    if (planes && this.mesh && this.sliceCapped) this.buildCap(planes[0])
    this.invalidate()
  }

  /**
   * Close the part where the slice cut it open, so the section reads as a
   * solid and not as a shell looked into: the standard stencil cap. The
   * scan's back faces on the kept side count the stencil up and its front
   * faces count it down, so inside the solid — where the eye has passed
   * through one more back face than front — the count is not zero; a
   * sheet on the cut plane is drawn where it is not, in the surface's
   * colour, and writes depth, so the shell's inside behind it stays hidden.
   */
  private buildCap(plane: THREE.Plane): void {
    const geometry = this.mesh!.geometry
    const stencilMaterial = (side: THREE.Side, op: THREE.StencilOp) => {
      const m = new THREE.MeshBasicMaterial({ side, depthWrite: false, depthTest: false, colorWrite: false })
      m.stencilWrite = true
      m.stencilFunc = THREE.AlwaysStencilFunc
      m.stencilFail = op
      m.stencilZFail = op
      m.stencilZPass = op
      m.clippingPlanes = [plane]
      return m
    }
    const back = new THREE.Mesh(geometry, stencilMaterial(THREE.BackSide, THREE.IncrementWrapStencilOp))
    const front = new THREE.Mesh(geometry, stencilMaterial(THREE.FrontSide, THREE.DecrementWrapStencilOp))
    back.renderOrder = -3
    front.renderOrder = -3
    this.partGroup.add(back, front)

    let material: THREE.MeshStandardMaterial | THREE.MeshBasicMaterial
    if (this.sliceCapColor !== null) material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, color: this.sliceCapColor })
    else {
      material = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide })
      setSurfaceColor(material.color, this.theme)
      // A shade under the surface: a cut face is not the skin of the part.
      material.color.multiplyScalar(0.82)
      applyFinish(material, this.theme)
    }
    material.stencilWrite = true
    material.stencilRef = 0
    material.stencilFunc = THREE.NotEqualStencilFunc
    material.stencilFail = THREE.ReplaceStencilOp
    material.stencilZFail = THREE.ReplaceStencilOp
    material.stencilZPass = THREE.ReplaceStencilOp
    const sheet = new THREE.Mesh(this.capGeometry, material)
    // On the cut plane, centred where the part's centre falls on it, wide
    // enough to cross the whole part — the same sheet a plane hint draws.
    this.partGroup.updateMatrixWorld(true)
    const m = this.partGroup.matrixWorld
    const centre = plane.projectPoint(new THREE.Vector3(...this.modelCenter()).applyMatrix4(m), new THREE.Vector3())
    const half = this.modelRadius * 1.3
    sheet.position.copy(centre)
    sheet.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), plane.normal)
    sheet.scale.set(2 * half, 2 * half, 1)
    sheet.renderOrder = -2
    sheet.onAfterRender = () => this.viewport.renderer.clearStencil()
    this.scene.add(sheet)
    this.cap = {
      back,
      front,
      sheet,
      dispose: () => {
        back.material.dispose()
        front.material.dispose()
        material.dispose()
      },
    }
  }

  private clearCap(): void {
    if (!this.cap) return
    this.partGroup.remove(this.cap.back, this.cap.front)
    this.scene.remove(this.cap.sheet)
    this.cap.dispose()
    this.cap = null
  }

  /** Frame the part broadside, and remember what was framed so the alignment
   *  preview can bound its clip range absolutely. */
  private frameCamera(
    box: THREE.Box3,
    axis: THREE.Vector3 | null,
    view?: { dir: THREE.Vector3; up: THREE.Vector3 },
  ): void {
    this.viewport.frameCamera(box, axis, view)
    this.framedClip.center.copy(this.clipSphere.center)
    this.framedClip.radius = this.clipSphere.radius
  }

  /** The scan's bounding box in world coordinates — wherever the alignment
   *  preview currently holds the part. Null with no scan loaded. */
  private movedScanBox(): THREE.Box3 | null {
    const geometry = this.mesh?.geometry as THREE.BufferGeometry | undefined
    if (!geometry?.boundingBox) return null
    this.partGroup.updateMatrixWorld(true)
    return geometry.boundingBox.clone().applyMatrix4(this.partGroup.matrixWorld)
  }

  /**
   * Show or hide the datum stage — the coordinate planes and origin axes an
   * alignment is aimed at. Turning it on frames the camera front-top-right,
   * Z up, around both the stage and wherever the part currently sits, so the
   * target frame and the part are on screen together; while it stays on, the
   * camera is the operator's.
   */
  setDatumStage(on: boolean): void {
    if (on === this.stage.active()) return
    this.stage.set(on ? this.modelRadius : null)
    if (on) {
      const e = this.stage.extent()
      const box = new THREE.Box3(
        new THREE.Vector3(-e, -e, -e),
        new THREE.Vector3(e, e, e),
      )
      const moved = this.movedScanBox()
      if (moved) box.union(moved)
      this.frameCamera(box, null, STAGE_VIEW)
    }
    this.invalidate()
  }

  /** Frame the part the way the datum stage was read — front-top-right, Z up —
   *  after an alignment has been applied, so the pose just chosen is the pose
   *  on screen. */
  frameAligned(): void {
    const moved = this.movedScanBox()
    if (moved) this.frameCamera(moved, null, STAGE_VIEW)
  }

  private setPickRay(clientX: number, clientY: number): void {
    this.viewport.setPickRay(clientX, clientY)
  }

  private pick(clientX: number, clientY: number): PickHit | null {
    // Raycasting ignores visibility, so gate by hand — a hidden scan must not
    // swallow clicks meant for whatever is shown in its place.
    if (!this.mesh?.visible) return null
    this.setPickRay(clientX, clientY)
    const hits = this.raycaster.intersectObject(this.mesh, false)
    const hit = hits[0]
    if (!hit || hit.faceIndex === undefined || hit.faceIndex === null) return null
    const index = (this.mesh.geometry as THREE.BufferGeometry).getIndex()!
    const f = hit.faceIndex * 3
    // The corners as drawn, which may be shading copies; what goes back is
    // the scan's own vertices behind them, at the same places.
    const corners: [number, number, number] = [
      index.getX(f),
      index.getX(f + 1),
      index.getX(f + 2),
    ]
    const vertices: [number, number, number] = [
      this.graphVertex(corners[0]),
      this.graphVertex(corners[1]),
      this.graphVertex(corners[2]),
    ]
    // hit.point is in world space, which is the *reference's* frame once the
    // scan has been aligned. Everything a caller does with it — pinning a
    // reading, reading a per-vertex field — belongs to the scan, so hand back
    // scan coordinates. Scratch, not a clone: this runs every frame while the
    // hover readout is on.
    this.partGroup.updateWorldMatrix(true, false)
    const local = this.partGroup.worldToLocal(this.scratchD.copy(hit.point))
    const weights = this.barycentric(corners, local)
    // The surface direction at the hit, interpolated the same way the fields
    // are read — off the corners as drawn, so on a split edge it is the
    // face's own side. The normal attribute lives in scan coordinates, like
    // the point handed back. Scratch registers are free again after
    // barycentric().
    const normalAttr = (this.mesh.geometry as THREE.BufferGeometry).getAttribute(
      'normal',
    ) as THREE.BufferAttribute
    const n = this.scratchA.set(0, 0, 0)
    for (let i = 0; i < 3; i++) {
      n.addScaledVector(this.scratchB.fromBufferAttribute(normalAttr, corners[i]), weights[i])
    }
    if (n.lengthSq() < 1e-12) n.set(0, 0, 1)
    n.normalize()
    return {
      vertices,
      weights,
      point: [local.x, local.y, local.z],
      normal: [n.x, n.y, n.z],
      clientX,
      clientY,
      ctrlKey: false,
    }
  }

  /** Where a hit sits inside its triangle, as the three corner weights, so a
   *  per-vertex field can be read at the point rather than at a corner.
   *  Runs on scratch vectors (p itself is left alone): it is on the per-frame
   *  hover path and must not allocate. */
  private barycentric(
    vertices: [number, number, number],
    p: THREE.Vector3,
  ): [number, number, number] {
    const pos = (this.mesh!.geometry as THREE.BufferGeometry).getAttribute(
      'position',
    ) as THREE.BufferAttribute
    const a = this.scratchA.fromBufferAttribute(pos, vertices[0])
    const v0 = this.scratchB.fromBufferAttribute(pos, vertices[1]).sub(a)
    const v1 = this.scratchC.fromBufferAttribute(pos, vertices[2]).sub(a)
    const v2 = this.scratchE.copy(p).sub(a)
    const d00 = v0.dot(v0)
    const d01 = v0.dot(v1)
    const d11 = v1.dot(v1)
    const d20 = v2.dot(v0)
    const d21 = v2.dot(v1)
    const denom = d00 * d11 - d01 * d01
    // A degenerate sliver has no interior to interpolate over; fall back to one
    // corner rather than dividing by nothing.
    if (Math.abs(denom) < 1e-20) return [1, 0, 0]
    const v = (d11 * d20 - d01 * d21) / denom
    const w = (d00 * d21 - d01 * d20) / denom
    return [1 - v - w, v, w]
  }

  setElementPickEnabled(enabled: boolean): void {
    this.elementPickEnabled = enabled
    this.hoverDirty = true
  }

  /** Narrow element picking to the given elements (null: any) — see
   *  elementPickOnly. */
  setElementPickOnly(ids: ReadonlySet<number> | null): void {
    this.elementPickOnly = ids
    this.hoverDirty = true
  }

  /** Whether the element under the cursor lights while element picking is
   *  on. */
  setElementHoverLights(on: boolean): void {
    if (this.elementHoverLights === on) return
    this.elementHoverLights = on
    this.hoverDirty = true
    this.invalidate()
  }

  /** The selection, the picker's hint and the hover, lit together. */
  private applyElementHighlight(): void {
    this.overlays.setHighlightedElements([
      ...this.highlightedElements,
      ...this.hintedElements,
      ...(this.hoveredElement !== null ? [this.hoveredElement] : []),
    ])
  }

  // ---- the surface brush ---------------------------------------------------

  /** Arm the brush, change what it does, or (with null) put it away. */
  setPaintBrush(brush: PaintBrush | null): void {
    this.marking.setPaintBrush(brush)
  }

  /** The vertices marked so far, as the fitter wants them. */
  paintedVertices(): Uint32Array {
    return this.regions.paintedVertices()
  }

  /** Put a marking back on the part — the surface an element was measured on,
   *  when that element is re-opened for editing. */
  setPaintedVertices(vertices: Uint32Array, colorHex: string): void {
    this.marking.setPaintedVertices(vertices, colorHex)
  }

  /** Rub out the whole marking and hand the surface back to whatever was
   *  underneath it. */
  clearPaint(): void {
    this.marking.clearPaint()
  }

  /** Turn the marking inside out — what was bare is marked, what was marked
   *  is bare. Reported through onPaintChange, like a gesture. */
  invertPaint(): void {
    this.marking.invertPaint()
  }

  /** How far along the pick ray the scan is met, or null off it. */
  private scanDistanceAt(clientX: number, clientY: number): number | null {
    if (!this.mesh?.visible) return null
    this.setPickRay(clientX, clientY)
    const hits = this.raycaster.intersectObject(this.mesh, false)
    return hits[0]?.distance ?? null
  }

  /** The element under the cursor: the nearest hit among the overlay shapes
   *  and the scan, where a scan hit counts as the element whose painted
   *  region it landed on. Null over bare scan or empty space. */
  private elementAt(clientX: number, clientY: number): number | null {
    this.setPickRay(clientX, clientY)
    const targets = this.overlays.pickTargets()
    if (this.mesh?.visible) targets.push(this.mesh)
    const hits = this.raycaster.intersectObjects(targets, false)
    const only = this.elementPickOnly
    const offered = (id: unknown): id is number => typeof id === 'number' && (!only || only.has(id))
    for (const hit of hits) {
      if (hit.object !== this.mesh) {
        const id = hit.object.userData.elementId
        if (offered(id)) return id
        continue
      }
      // On the scan the element is the owner of the nearest triangle corner.
      // Bare scan ends the search: it occludes whatever is behind it.
      if (hit.faceIndex === undefined || hit.faceIndex === null || !this.regions.ready) return null
      const index = (this.mesh.geometry as THREE.BufferGeometry).getIndex()!
      const f = hit.faceIndex * 3
      const vertices: [number, number, number] = [
        this.graphVertex(index.getX(f)),
        this.graphVertex(index.getX(f + 1)),
        this.graphVertex(index.getX(f + 2)),
      ]
      this.partGroup.updateWorldMatrix(true, false)
      const weights = this.barycentric(
        vertices,
        this.partGroup.worldToLocal(this.scratchD.copy(hit.point)),
      )
      const nearest = weights.indexOf(Math.max(...weights))
      const owner = this.regions.visibleOwnerAt(vertices[nearest])
      if (owner !== null && offered(owner)) return owner
      // Bare scan occludes what is behind it — but not the element lying *on*
      // it. A fitted plane's shell is the scan's own face to within the fit,
      // the ray meets the two at the same distance, and which sorts first is
      // the floating point's say: half the fitted faces of a part could not
      // be clicked. A shell within the scan's scatter behind the hit is on
      // the surface, not inside the part.
      const slack = Math.max(0.05, this.modelRadius * 2e-3)
      for (const next of hits) {
        if (next.object === this.mesh || next.distance > hit.distance + slack) continue
        const id = next.object.userData.elementId
        if (offered(id)) return id
      }
      return null
    }
    return null
  }

  /** Make the given elements read as selected: their translucent shells get
   *  denser, glow in their own colour, and wear a white stroke. */
  setHighlightedElements(ids: readonly number[]): void {
    this.highlightedElements = ids
    this.applyElementHighlight()
  }

  /** Light elements a picker is pointing at — the option under the cursor
   *  in a plane or axis list — without disturbing the selection. */
  setHintedElements(ids: readonly number[]): void {
    this.hintedElements = ids
    this.applyElementHighlight()
  }

  /** Pin readings to the part, each titled with the map it came off. */
  setProbes(probes: ProbeMarker[]): void {
    this.overlays.setProbes(probes)
  }

  /** Put away the pins whose spot the camera cannot see — the far side of the
   *  part, or behind a feature of it — or show every pin through the part. */
  setProbeOcclusion(hideOccluded: boolean): void {
    this.overlays.setProbeOcclusion(hideOccluded)
  }

  /** Mark the points picked for an alignment slot on the part, labelled with
   *  what they are for. */
  setPickMarkers(markers: PickMarker[]): void {
    this.overlays.setPickMarkers(markers)
  }

  applyRegion(elementId: number, colorHex: string, region: Uint32Array): void {
    const regions = this.scanRegions()
    if (!this.mesh || !regions.ready) return
    this.invalidate()
    if (regions.applyRegion(elementId, colorToRgb(colorHex), region)) this.scanRepainted()
  }

  clearElement(elementId: number): void {
    const regions = this.scanRegions()
    if (!this.mesh || !regions.ready) return
    this.invalidate()
    if (regions.clearElement(elementId)) this.scanRepainted()
  }

  clearAllRegions(): void {
    const regions = this.scanRegions()
    if (!this.mesh || !regions.ready) return
    this.invalidate()
    if (regions.clearAllRegions()) this.scanRepainted()
  }

  /** Tint the surfaces a pending fit is using, in the colour the element will
   *  get once it is created. Unlike applyRegion this takes no ownership, so
   *  lifting the preview restores whatever was underneath. */
  setPreviewRegion(region: Uint32Array | null, colorHex?: string): void {
    if (!this.scanRegions().setPreviewRegion(region, colorHex ? colorToRgb(colorHex) : undefined)) return
    this.scanRepainted()
    this.invalidate()
  }

  /** Translucent ghost of the element a pending fit produced. */
  setPreview(fit: FitData | null): void {
    this.overlays.setPreview(fit)
  }

  /** Put grips on the element being made, or take them away with null. The
   *  ghost's own end marks wear the same colour as the grips on them. */
  setExtendHandles(fit: FitData | null, color: string): void {
    this.overlays.setPreviewColor(color)
    this.grips.setHandles(fit, color)
  }

  /** The finished sections, drawn on the part in their colours. */
  setSections(items: readonly SectionOverlayItem[], visible: boolean): void {
    this.sections.setSections(items, visible)
  }

  /** How heavy the section cuts are drawn, in pixels (Settings → Lines). */
  setSectionLineWidth(px: number): void {
    this.sections.setLineWidth(px)
    for (const layer of this.layers) layer.lineWidthChanged?.(px)
  }

  // ---- a plugin's grips -------------------------------------------------------

  /** The grips a plugin puts on something of its own being set up — see
   *  PluginGrip. Empty takes them away. */
  setFeatureGrips(grips: readonly PluginGrip[], color: string): void {
    this.grips.setFeatureGrips(grips, color)
  }

  /** A number field on a plugin's grip: the grip's value while it is
   *  dragged, and a field to type into once the hand lets go — Enter
   *  commits through onGripFieldCommit, Escape closes through
   *  onGripFieldClose. Null takes it away. */
  setGripField(field: { side: GripSide; value: number; unit: string; text?: string } | null): void {
    this.grips.setField(field)
  }

  /** Show or put away the name tags and readouts on the part — every label
   *  the CSS2D renderer draws into this viewport — leaving the bodies, the
   *  cuts and the callout lines where they are. A class on the container,
   *  which the stylesheet reads: the label renderer clears each label's
   *  inline display on every frame it is visible, so a rule from outside is
   *  the one thing it cannot undo. */
  setLabelsVisible(on: boolean): void {
    this.container.classList.toggle('nolabels', !on)
  }

  /** The section being made: its plane through the part and the cut it
   *  produces, with the gizmo that slides and tilts the plane. Null frame
   *  takes all three away. */
  setSectionPreview(frame: SectionFrame | null, cut: SectionCut | null, color: string): void {
    this.sections.setPreview(frame, cut, color)
    this.grips.setPlaneHandles(frame, color)
  }

  /** The coordinate planes offered to a section that has nothing to cut
   *  across yet, through `centre`; null takes them away. */
  setWorldPlanes(centre: Vec3 | null): void {
    this.sections.setWorldPlanes(centre)
    // The cursor may be over a plane that has just gone, or one that has
    // just arrived under it.
    this.hoverDirty = true
  }

  /** The coordinate plane under a client point, if one is on offer there.
   *  The planes are drawn through the part, so whatever of the part is
   *  behind one does not hide it. */
  private worldPlaneAt(clientX: number, clientY: number): WorldAxis | null {
    if (!this.sections.hasWorldPlanes()) return null
    this.setPickRay(clientX, clientY)
    return this.sections.worldPlaneHit(this.raycaster)
  }

  /** The coordinate plane a click at a client point would take: the one
   *  under it, unless an element is there too — see handleClick. */
  private worldPlaneUnder(clientX: number, clientY: number): WorldAxis | null {
    if (!this.sections.hasWorldPlanes()) return null
    if (this.elementPickEnabled && this.elementAt(clientX, clientY) !== null) return null
    return this.worldPlaneAt(clientX, clientY)
  }

  /** Take the plain left-drag away from the camera, or give it back, for one
   *  reason among several. The navigator only ever hears the total. */
  private claimDrag(reason: 'paint' | 'handle' | 'gizmo', on: boolean): void {
    const had = this.dragClaims.size > 0
    if (on) this.dragClaims.add(reason)
    else this.dragClaims.delete(reason)
    const has = this.dragClaims.size > 0
    if (had !== has) this.viewport.nav.setPaintMode(has)
  }

  updateOverlays(
    elements: OverlayElement[],
    pairs: OverlayPair[],
    angles: OverlayAngle[],
    tags: OverlayTag[],
    visible: boolean,
  ): void {
    this.overlays.updateOverlays(elements, pairs, angles, tags, visible)
  }

  setPaused(paused: boolean): void {
    this.viewport.paused = paused
    if (!paused) this.viewport.resize()
  }

  /** The scan's geometry, BVH and all. Handed to the split-screen picker so it
   *  can draw and raycast the same 1.4-million-triangle mesh without a second
   *  copy or a second tree — three.js keeps per-renderer GPU state, so one
   *  geometry can safely appear in two canvases. */
  scanGeometry(): THREE.BufferGeometry | null {
    if (this.editedShown && this.other) return this.other.geometry
    return (this.mesh?.geometry as THREE.BufferGeometry) ?? null
  }

  /**
   * The scan's one marking, for a second viewport to lay down as well.
   *
   * There is only ever one — the mask is a channel of the mesh, and the mesh is
   * shared with the split-screen picker (see scanGeometry) — so the picker
   * marks *this* marking rather than keeping a rival copy: same mask, same
   * count, same answer to paintedVertices, whichever canvas the gesture landed
   * on. Only the gestures themselves are per viewport, because they belong to a
   * camera and a container.
   */
  markingChannel(): MarkingChannel {
    return {
      regions: this.regions,
      paintAttr: () => this.paintAttr,
      graphVertex: this.graphVertex,
      setPaintColor: (rgb) => {
        setPaintUniform(this.uPaintColor, rgb)
        this.invalidate()
      },
    }
  }

  /** Half the scan's bounding-box diagonal — the scale hand-made elements
   *  (coordinate planes, picked points) are drawn at. */
  modelSize(): number {
    return this.modelRadius
  }

  /** Where each of a fit's seed triangles sits on the scan, in scan
   *  coordinates. A seed is a triangle rather than a point, so the middle of it
   *  is as close as the record gets to the spot that was clicked — near enough
   *  to mark it on the part when the element is re-opened, which is what an
   *  element's picks are worth remembering for. */
  pickPointsOf(picks: readonly [number, number, number][]): Vec3[] {
    const geometry = this.mesh?.geometry as THREE.BufferGeometry | undefined
    const position = geometry?.getAttribute('position') as THREE.BufferAttribute | undefined
    if (!position) return []
    const out: Vec3[] = []
    for (const [a, b, c] of picks) {
      if (a >= position.count || b >= position.count || c >= position.count) continue
      const p = this.scratchA.fromBufferAttribute(position, a)
      p.add(this.scratchB.fromBufferAttribute(position, b))
      p.add(this.scratchB.fromBufferAttribute(position, c))
      p.divideScalar(3)
      out.push([p.x, p.y, p.z])
    }
    return out
  }

  /** Centre of the scan's bounding box, in scan coordinates — the point a
   *  first alignment centres on the origin. */
  modelCenter(): Vec3 {
    const box = this.scanGeometry()?.boundingBox
    if (!box) return [0, 0, 0]
    const c = box.getCenter(this.scratchA)
    return [c.x, c.y, c.z]
  }

  nominalGeometry(): THREE.BufferGeometry | null {
    return (this.nominalMesh?.geometry as THREE.BufferGeometry) ?? null
  }

  /** Load the reference part. It never moves: a nominal is the datum a
   *  measurement is taken against, so the alignment is applied to the scan and
   *  the world ends up in the reference's coordinates. */
  setNominal(
    positions: Float32Array,
    indices: Uint32Array,
    normals: Float32Array,
    wireSlots?: Uint8Array,
  ): void {
    this.prepareNominal(positions, indices, normals, wireSlots).commit()
  }

  prepareNominal(
    positions: Float32Array,
    indices: Uint32Array,
    normals: Float32Array,
    wireSlots?: Uint8Array,
  ): { commit(): void; dispose(): void } {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
    if (wireSlots) geometry.setAttribute('wireSlot', new THREE.BufferAttribute(wireSlots, 1))
    geometry.setIndex(new THREE.BufferAttribute(indices, 1))
    geometry.computeBoundingBox()
    geometry.computeBoundingSphere()
    try { geometry.computeBoundsTree() } catch (e) { geometry.dispose(); throw e }

    const material = new THREE.MeshStandardMaterial({
      color: this.theme.nominal,
      side: THREE.DoubleSide,
    })
    applyFinish(material, this.theme)
    patchWireframe(material, this.wire)
    setSurfaceOpacity(material, this.nominalOpacity())
    const mesh = new THREE.Mesh(geometry, material)
    let owned = true
    return {
      dispose: () => {
        if (!owned) return
        owned = false
        geometry.disposeBoundsTree?.()
        geometry.dispose()
        material.dispose()
      },
      commit: () => {
        if (!owned) throw new Error('The prepared reference has already been used.')
        owned = false
        this.disposeNominal()
        this.nominalMesh = mesh
        this.nominalMesh.visible = false
        this.nominalMesh.renderOrder = 1
        this.scene.add(this.nominalMesh)
        this.invalidate()
      },
    }
  }

  clearScan(): void {
    this.disposeMesh()
    this.setPreview(null)
    this.setAlignment(null)
    this.invalidate()
  }

  clearNominal(): void {
    this.disposeNominal()
    this.invalidate()
  }

  /** Bake a datum alignment into the scan's vertices. Vertex order is
   *  untouched, so painted regions, element ownership and the deviation field
   *  all stay valid; only the coordinates (and the BVH built over them)
   *  change. Heavy — the BVH is rebuilt synchronously. */
  applyTransform(m: Rigid): void {
    if (!this.mesh) return
    const geometry = this.mesh.geometry as THREE.BufferGeometry
    const positions = geometry.getAttribute('position') as THREE.BufferAttribute
    const normals = geometry.getAttribute('normal') as THREE.BufferAttribute
    rigidApplyToPoints(m, positions.array as Float32Array)
    rigidRotateVectors(m, normals.array as Float32Array)
    positions.needsUpdate = true
    normals.needsUpdate = true
    geometry.computeBoundingBox()
    geometry.computeBoundingSphere()
    geometry.disposeBoundsTree?.()
    geometry.computeBoundsTree()
    // The edited copy — or the scan, while the copy is shown — is in the same
    // frame, and moves with it.
    if (this.other) {
      const g = this.other.geometry
      rigidApplyToPoints(m, g.getAttribute('position').array as Float32Array)
      rigidRotateVectors(m, g.getAttribute('normal').array as Float32Array)
      g.getAttribute('position').needsUpdate = true
      g.getAttribute('normal').needsUpdate = true
      g.computeBoundingBox()
      g.computeBoundingSphere()
      g.disposeBoundsTree?.()
      g.computeBoundsTree()
      const a = this.other.axis
      const r = m.r
      this.other.axis = new THREE.Vector3(
        r[0] * a.x + r[1] * a.y + r[2] * a.z,
        r[3] * a.x + r[4] * a.y + r[5] * a.z,
        r[6] * a.x + r[7] * a.y + r[8] * a.z,
      ).normalize()
    }
    // So does whatever the layers keep in the scan's frame.
    for (const layer of this.layers) layer.partMoved?.(m)
    // Keep framing the part broadside: its long axis moved with it.
    const a = this.scanAxis
    const r = m.r
    this.scanAxis = new THREE.Vector3(
      r[0] * a.x + r[1] * a.y + r[2] * a.z,
      r[3] * a.x + r[4] * a.y + r[5] * a.z,
      r[6] * a.x + r[7] * a.y + r[8] * a.z,
    ).normalize()
    this.frameCamera(geometry.boundingBox!, this.scanAxis)
  }

  /** Column-major 4×4 carrying the scan into the reference's frame, or null
   *  for an unaligned scan sitting in its own. */
  setAlignment(columnMajor: number[] | null): void {
    if (columnMajor) this.alignMatrix.fromArray(columnMajor)
    else this.alignMatrix.identity()
    this.updatePartMatrix()
  }

  /**
   * Show a datum alignment before it is baked: the scan, and everything
   * measured on it, swings onto the axes the draft would put it on. Pass null
   * to put it back.
   *
   * Nothing about the geometry changes — this is a matrix on the group, so it
   * costs a matrix write rather than a pass over a million vertices and a BVH
   * rebuild, and can therefore follow every pick and every axis change. Scan
   * coordinates are unaffected: picking already reads hits back through the
   * group's matrix, so points clicked on the previewed part land where they
   * would have landed on the part sitting still.
   *
   * The camera stays where the operator put it. A preview that re-framed as
   * well would take their zoom away on every pick, and the part is only being
   * tried on for size here — applying the alignment is what re-frames.
   */
  setAlignPreview(columnMajor: number[] | null): void {
    // Filling one slot re-runs this with the pose unchanged; there is nothing
    // to do then, and the scan is the largest thing in the scene.
    const next = columnMajor ? new THREE.Matrix4().fromArray(columnMajor) : new THREE.Matrix4()
    if (next.equals(this.previewMatrix)) return
    this.previewMatrix.copy(next)
    this.updatePartMatrix()

    const geometry = this.mesh?.geometry as THREE.BufferGeometry | undefined
    if (!geometry?.boundingSphere) return
    // The preview turns the part about the picked feature and drops that
    // feature onto the global zero plane, so the clip planes — which follow the
    // scan, not the camera — have to be re-centred on where it now sits, or the
    // far side of a large rotation is sliced off.
    const moved = geometry.boundingSphere.clone().applyMatrix4(this.partGroup.matrix)
    // The smallest sphere holding both the framed scene and the moved scan,
    // written absolutely: clearing the preview or a smaller rotation must
    // shrink the clip range back, not leave it where the largest swing put it.
    const base = this.framedClip
    const d = moved.center.distanceTo(base.center)
    if (moved.radius >= d + base.radius) {
      this.clipSphere.center.copy(moved.center)
      this.clipSphere.radius = moved.radius
    } else if (base.radius >= d + moved.radius) {
      this.clipSphere.center.copy(base.center)
      this.clipSphere.radius = base.radius
    } else {
      const radius = (d + base.radius + moved.radius) / 2
      this.clipSphere.center
        .copy(moved.center)
        .sub(base.center)
        .normalize()
        .multiplyScalar(radius - base.radius)
        .add(base.center)
      this.clipSphere.radius = radius
    }
  }

  private updatePartMatrix(): void {
    this.partGroup.matrix.multiplyMatrices(this.alignMatrix, this.previewMatrix)
    this.partGroup.matrixWorldNeedsUpdate = true
    this.partGroup.updateMatrixWorld(true)
    // The slice is a world plane through a part that just moved.
    if (this.slice) this.applySlice()
    this.invalidate()
  }

  setNominalVisible(visible: boolean): void {
    if (this.nominalMesh) this.nominalMesh.visible = visible
    this.invalidate()
  }

  setScanVisible(visible: boolean): void {
    if (this.mesh) this.mesh.visible = visible
    this.invalidate()
  }

  /** Whether the scan is drawn — false with none loaded. */
  scanShown(): boolean {
    return Boolean(this.mesh?.visible)
  }

  /** Whether the reference part is drawn — false with none loaded. */
  nominalShown(): boolean {
    return Boolean(this.nominalMesh?.visible)
  }

  /** The finished sections, and the element overlays, shown or put away as
   *  a whole — what a picture of the part on its own asks for. The
   *  workspace sets them again as it has them on its next update. */
  sectionsShown(): boolean {
    return this.sections.shown()
  }

  setSectionsShown(on: boolean): void {
    this.sections.setShown(on)
    this.invalidate()
  }

  elementsShown(): boolean {
    return this.overlays.shown()
  }

  setElementsShown(on: boolean): void {
    this.overlays.setShown(on)
    this.invalidate()
  }

  labelsShown(): boolean {
    return !this.container.classList.contains('nolabels')
  }

  /** Frame a box, in the frame the part is measured in now — a place on the
   *  part looked at closely, as fitToView frames the whole of it. */
  fitBox(min: Vec3, max: Vec3): void {
    const box = new THREE.Box3(new THREE.Vector3(...min), new THREE.Vector3(...max))
    if (box.isEmpty()) return
    this.viewport.fitCamera(box)
    this.framedClip.center.copy(this.clipSphere.center)
    this.framedClip.radius = this.clipSphere.radius
    this.invalidate()
  }

  /**
   * An edited copy of the scan — its render arrays, laid out as a scan's
   * are, in the scan's frame — or null to throw it away. It waits beside the
   * scan until showEdited puts it in the scan's place; a copy replaced while
   * it is shown stays shown.
   */
  setEditedMesh(
    mesh: {
      positions: Float32Array
      indices: Uint32Array
      normals: Float32Array
      wireSlots?: Uint8Array
      copyOf: Uint32Array
    } | null,
  ): void {
    const shown = this.editedShown
    if (shown) this.swapSlots()
    if (this.other) {
      this.other.geometry.disposeBoundsTree?.()
      this.other.geometry.dispose()
      this.other.regions.detach()
      this.other = null
    }
    if (mesh && this.mesh) {
      const geometry = new THREE.BufferGeometry()
      const { colors, paint, tint } = this.layOutScan(
        geometry,
        mesh.positions,
        mesh.indices,
        mesh.normals,
        mesh.wireSlots,
        mesh.copyOf,
        null,
        false,
      )
      geometry.computeBoundsTree()
      const own = mesh.positions.length / 3 - mesh.copyOf.length
      const regions = new RegionColors(this.theme.surface)
      regions.attach(colors, paint, tint, own)
      this.other = {
        geometry,
        colorAttr: geometry.getAttribute('color') as THREE.BufferAttribute,
        tintAttr: geometry.getAttribute('tint') as THREE.BufferAttribute,
        paintAttr: geometry.getAttribute('paint') as THREE.BufferAttribute,
        scanVertices: own,
        copyOf: mesh.copyOf,
        regions,
        modelRadius: Math.max(geometry.boundingBox!.min.distanceTo(geometry.boundingBox!.max) / 2, 1e-4),
        axis: principalAxis(mesh.positions),
      }
      if (shown) this.swapSlots()
    }
    this.invalidate()
  }

  /** Show the edited copy in the scan's place, or the scan again.
   *  Everything that works on the surface on screen works on the copy while
   *  it is shown: the marking, a map painted on it, picking, the slice. The
   *  scan keeps its element tints and its maps out of sight, and has them
   *  back as it was. */
  showEdited(on: boolean): void {
    if (on === this.editedShown || (on && !this.other)) return
    this.swapSlots()
  }

  /** Whether the edited copy is what is on screen in the scan's place. */
  showingEdited(): boolean {
    return this.editedShown
  }

  /** Trade the layout on screen for the one waiting — see showEdited. The
   *  mesh object, its material and everything set on them stay; only the
   *  geometry and the channels painted on it change hands. The compositor
   *  keeps its identity, since the marking holds it, and trades its state. */
  private swapSlots(): void {
    const next = this.other
    const mesh = this.mesh
    if (!next || !mesh || !this.colorAttr || !this.tintAttr || !this.paintAttr) return
    this.marking.meshDisposed()
    this.regions.exchange(next.regions)
    const waiting: SlotLayout = {
      geometry: mesh.geometry as THREE.BufferGeometry,
      colorAttr: this.colorAttr,
      tintAttr: this.tintAttr,
      paintAttr: this.paintAttr,
      scanVertices: this.scanVertices,
      copyOf: this.copyOf,
      regions: next.regions,
      modelRadius: this.modelRadius,
      axis: this.scanAxis,
    }
    mesh.geometry = next.geometry
    this.colorAttr = next.colorAttr
    this.tintAttr = next.tintAttr
    this.paintAttr = next.paintAttr
    this.scanVertices = next.scanVertices
    this.copyOf = next.copyOf
    this.modelRadius = next.modelRadius
    this.scanAxis = next.axis
    this.synced = { color: -1, tint: -1, paint: -1 }
    // Painted while it waited: uploaded afresh.
    this.colorAttr.needsUpdate = true
    this.tintAttr.needsUpdate = true
    this.paintAttr.needsUpdate = true
    this.other = waiting
    this.editedShown = !this.editedShown
    // The slice's cap is cut from the geometry on screen.
    this.applySlice()
    this.hoverDirty = true
    this.invalidate()
  }

  /** The compositor holding the scan's own colouring — its element tints, a
   *  fit's preview — wherever the scan is: on screen, or waiting while the
   *  edited copy is shown. */
  private scanRegions(): RegionColors {
    return this.editedShown && this.other ? this.other.regions : this.regions
  }

  /** The scan's colouring changed: uploaded now if it is on screen, or when
   *  it comes back. */
  private scanRepainted(): void {
    if (!this.editedShown) this.surfaceRepainted()
  }

  /**
   * The scan's geometry replaced by another version of the same scan — an
   * edit of it, or the one before an edit, on undo. The mesh, its material
   * and everything set on them stay: whether it is shown, how it is shaded,
   * the slice through it, the pose its group holds, the camera. The
   * colouring starts over bare, because regions, fields and marks are all
   * keyed by vertex number and the numbers are the new geometry's: whoever
   * changed the scan paints them on again. What the layers made of the old
   * scan goes.
   */
  replaceScan(
    positions: Float32Array,
    indices: Uint32Array,
    normals: Float32Array,
    wireSlots: Uint8Array | undefined,
    copyOf: Uint32Array,
  ): void {
    if (!this.mesh) return
    // A copy of the scan that went is not a copy of this one.
    this.setEditedMesh(null)
    const geometry = this.mesh.geometry as THREE.BufferGeometry
    this.marking.meshDisposed()
    // Keyed by vertex number, like the colouring: whoever moves this scan
    // lays them on again.
    this.dropDeflection()
    for (const layer of this.layers) layer.scanReplaced?.()
    geometry.disposeBoundsTree?.()
    geometry.dispose()
    const { colors, paint, tint } = this.layOutScan(geometry, positions, indices, normals, wireSlots, copyOf, null)
    this.regions.attach(colors, paint, tint, this.scanVertices)
    geometry.computeBoundsTree()
    this.modelRadius = Math.max(geometry.boundingBox!.min.distanceTo(geometry.boundingBox!.max) / 2, 1e-4)
    this.scanAxis = principalAxis(positions)
    // The cap is cut from the geometry.
    this.applySlice()
    this.invalidate()
  }

  /**
   * Whether the reference is a ghost or a solid part.
   *
   * A ghost is right while it is being fitted, where the scan has to be
   * readable through it. It is useless for confirming that the right file was
   * loaded, though: once aligned it lies inside a scan of nearly the same
   * shape, fails the depth test almost everywhere, and simply cannot be seen.
   * Solid — writing depth, fully opaque — is what makes it a part you can look
   * at.
   */
  setNominalGhost(ghost: boolean): void {
    this.nominalGhost = ghost
    if (!this.nominalMesh) return
    setSurfaceOpacity(this.nominalMesh.material as THREE.MeshStandardMaterial, this.nominalOpacity())
    this.invalidate()
  }

  /** Frame the camera so that both models are on screen, wherever the
   *  reference happens to sit before anything has been fitted. */
  frameAll(): void {
    const box = new THREE.Box3()
    this.partGroup.updateMatrixWorld(true)
    if (this.mesh) {
      const g = this.mesh.geometry as THREE.BufferGeometry
      if (g.boundingBox) box.union(g.boundingBox.clone().applyMatrix4(this.partGroup.matrixWorld))
    } else {
      // No scan: what a layer stands in its place is the part.
      for (const layer of this.layers) {
        const b = layer.frameBox?.()
        if (b) box.union(b.clone().applyMatrix4(this.partGroup.matrixWorld))
      }
    }
    if (this.nominalMesh) {
      const g = this.nominalMesh.geometry as THREE.BufferGeometry
      if (g.boundingBox) box.union(g.boundingBox)
    }
    if (box.isEmpty()) return
    // A scan is framed across its long axis; anything else on a blank stage
    // from the standard three-quarter view, with room round it to work into.
    if (this.mesh || this.nominalMesh) this.frameCamera(box, this.scanAxis)
    else this.frameCamera(box.clone().expandByScalar(box.min.distanceTo(box.max) * 0.3), null)
  }

  /** Paint the scan from a measured map — deviation, wall thickness — or pass
   *  null to hand the surface back to the element colours. */
  setFieldColors(colors: Uint8Array | null): void {
    const painted = this.regions.setFieldColors(colors)
    this.invalidate()
    if (!painted) return
    this.surfaceRepainted()
  }

  /**
   * Play a map as motion, or pass null to put the scan back at rest as
   * measured. `vectors` is each scan vertex's offset off the ideal surface,
   * three floats per vertex — see core/deviation/deflection.ts — for the
   * surface on screen now; a buffer that runs on past the scan's vertices
   * (a map measured over the shading copies too) is read for those only.
   *
   * A new map, or the same one with the search distance moved, carries on
   * from wherever the loop is. A loop that is starting starts from the scan
   * as it is on screen.
   */
  setDeflection(vectors: Float32Array | null): void {
    const geometry = this.mesh?.geometry as THREE.BufferGeometry | undefined
    const fits = vectors !== null && geometry !== undefined && this.scanVertices > 0 &&
      vectors.length >= this.scanVertices * 3
    const running = fits && this.deflection?.geometry === geometry
    if (!running) this.dropDeflection()
    if (fits) {
      this.deflection = { vectors, geometry }
      this.layOutDeflection()
      if (!running) {
        this.deflectStart = performance.now() - deflectionStartPhase(this.deflectScale) * DEFLECTION_PERIOD_MS
      }
      // Bounded by the scan at rest, and the loop carries it past that.
      this.mesh!.frustumCulled = false
    }
    this.invalidate()
  }

  /** How many times the deviation is exaggerated at the top of the loop. */
  setDeflectionScale(scale: number): void {
    if (!(scale > 0) || scale === this.deflectScale) return
    this.deflectScale = scale
    this.invalidate()
  }

  /** Lay the offsets on the geometry they belong to, if it is on screen. The
   *  copies sharp edges were split into take their vertex's: moved apart,
   *  the two sides of a sharp edge would open a crack along it. */
  private layOutDeflection(): void {
    const d = this.deflection
    if (!d || d.geometry !== this.mesh?.geometry) return
    const count = d.geometry.getAttribute('position').count
    const own = this.scanVertices
    let attr = d.geometry.getAttribute('deflect') as THREE.BufferAttribute | undefined
    if (attr && attr.count !== count) {
      this.releaseDeflect(d.geometry)
      attr = undefined
    }
    if (!attr) {
      attr = new THREE.BufferAttribute(new Float32Array(count * 3), 3)
      d.geometry.setAttribute('deflect', attr)
    }
    const a = attr.array as Float32Array
    a.set(d.vectors.subarray(0, own * 3))
    const c = this.copyOf
    for (let k = 0; k < c.length; k++) {
      const dst = (own + k) * 3, src = c[k] * 3
      a[dst] = a[src]
      a[dst + 1] = a[src + 1]
      a[dst + 2] = a[src + 2]
    }
    attr.needsUpdate = true
  }

  /** Back at rest, with the offsets taken off the geometry they were laid on. */
  private dropDeflection(): void {
    const d = this.deflection
    this.deflection = null
    this.uDeflect.value = 0
    if (this.mesh) this.mesh.frustumCulled = true
    if (d) this.releaseDeflect(d.geometry)
  }

  /** Take the offsets' attribute off a geometry, GPU buffer and all. three.js
   *  lets an attribute's buffer go only when its geometry is disposed, so it
   *  is: the rest of the scan is uploaded again on the next frame it is
   *  drawn — once, the price of not keeping a buffer the size of the
   *  positions for a loop nobody is playing. */
  private releaseDeflect(geometry: THREE.BufferGeometry): void {
    if (!geometry.getAttribute('deflect')) return
    geometry.dispose()
    geometry.deleteAttribute('deflect')
  }

  /** Where the loop is this frame. Playing, it draws every frame — that is
   *  what it is for; at rest it costs a comparison. */
  private stepDeflection(): void {
    const d = this.deflection
    const playing = d !== null && this.mesh !== null && this.mesh.visible && d.geometry === this.mesh.geometry
    if (!playing) {
      // Off the geometry on screen, the attribute is not there to be read
      // and the shader must not add anything at all.
      if (this.uDeflect.value !== 0) {
        this.uDeflect.value = 0
        this.invalidate()
      }
      return
    }
    const phase = (performance.now() - this.deflectStart) / DEFLECTION_PERIOD_MS
    this.uDeflect.value = deflectionFactor(phase, this.deflectScale) - 1
    this.invalidate()
  }

  /** Paint a reading on some of the scan's vertices, leaving the rest as
   *  they are, or pass null to lift it. See regionColors.setSparseField. */
  setSparseField(subset: Uint32Array | null, rgb: Uint8Array | null): void {
    if (!this.scanRegions().setSparseField(subset, rgb)) return
    this.scanRepainted()
    this.invalidate()
  }

  /** The scan's own vertices, as the viewport holds them — every datum
   *  alignment baked in — without the shading copies past them. A view
   *  into the live buffer: copy before handing it anywhere. */
  scanPositions(): Float32Array | null {
    const g = this.scanGeometry()
    if (!g) return null
    const a = g.getAttribute('position') as THREE.BufferAttribute | undefined
    if (!a) return null
    return (a.array as Float32Array).subarray(0, this.scanVertexCount() * 3)
  }

  /** The scan's triangles over its own vertices — a shading copy folded
   *  back to the vertex it was cut from — a fresh array, for a worker that
   *  wants the scan as a surface. */
  scanIndices(): Uint32Array | null {
    const g = this.scanGeometry()
    const index = g?.getIndex()
    if (!g || !index) return null
    const src = index.array as Uint32Array
    const out = new Uint32Array(src.length)
    const own = this.scanVertexCount()
    const copyOf = this.editedShown && this.other ? this.other.copyOf : this.copyOf
    for (let i = 0; i < src.length; i++) out[i] = src[i] < own ? src[i] : copyOf[src[i] - own]
    return out
  }

  /** The colour the scan wears at one of its vertices, for the development
   *  hook and the end-to-end checks. */
  scanColorAt(v: number): [number, number, number] | null {
    const a = this.editedShown && this.other ? this.other.colorAttr : this.colorAttr
    if (!a || v < 0 || v >= this.scanVertexCount()) return null
    const c = a.array as Uint8Array
    return [c[v * 3], c[v * 3 + 1], c[v * 3 + 2]]
  }

  /** Switch the surface tint of the given elements off (and everyone else's
   *  back on). Cheap enough to run on every visibility toggle. */
  setHiddenRegions(ids: readonly number[]): void {
    if (!this.scanRegions().setHiddenRegions(ids)) return
    this.scanRepainted()
    this.invalidate()
  }

  private disposeNominal(): void {
    if (!this.nominalMesh) return
    const geometry = this.nominalMesh.geometry as THREE.BufferGeometry
    geometry.disposeBoundsTree?.()
    geometry.dispose()
    ;(this.nominalMesh.material as THREE.Material).dispose()
    this.scene.remove(this.nominalMesh)
    this.nominalMesh = null
  }

  private disposeMesh(): void {
    this.setEditedMesh(null)
    this.regions.detach()
    this.marking.meshDisposed()
    this.dropDeflection()
    // What the layers made of the scan goes with it.
    for (const layer of this.layers) layer.scanReplaced?.()
    if (!this.mesh) return
    const geometry = this.mesh.geometry as THREE.BufferGeometry
    geometry.disposeBoundsTree?.()
    geometry.dispose()
    ;(this.mesh.material as THREE.Material).dispose()
    this.partGroup.remove(this.mesh)
    this.mesh = null
    this.colorAttr = null
    this.tintAttr = null
    this.paintAttr = null
    this.scanVertices = 0
    this.copyOf = new Uint32Array(0)
  }

  dispose(): void {
    for (const layer of [...this.layers]) layer.dispose()
    this.layers = []
    this.marking.dispose()
    this.grips.dispose()
    this.overlays.dispose()
    this.sections.dispose()
    this.stage.dispose()
    this.gizmo.dispose()
    this.disposeNominal()
    this.disposeMesh()
    this.viewport.dispose()
  }

  // ---- the plugins' layers -----------------------------------------------------

  /** Add a plugin's layer — see sceneLayers.ts. The returned function takes
   *  it away again, disposing it. */
  addLayer(layer: SceneLayer): () => void {
    this.layers.push(layer)
    this.hoverDirty = true
    this.invalidate()
    return () => {
      const i = this.layers.indexOf(layer)
      if (i < 0) return
      this.layers.splice(i, 1)
      layer.dispose()
      this.invalidate()
    }
  }

  /** What a layer is lent of this viewport. */
  layerHost(): SceneLayerHost {
    return {
      scene: this.scene,
      partGroup: this.partGroup,
      raycaster: this.raycaster,
      canvas: this.viewport.renderer.domElement,
      container: this.container,
      camera: () => this.camera,
      setPickRay: (x, y) => this.setPickRay(x, y),
      invalidate: this.invalidate,
      requestHover: () => {
        this.hoverDirty = true
      },
      setCursor: (cursor) => {
        this.viewport.renderer.domElement.style.cursor = cursor
      },
      theme: () => this.theme,
      modelRadius: () => this.modelRadius,
      modelCenter: () => this.modelCenter(),
      hasScan: () => this.mesh !== null,
      pickScan: (x, y) => this.pick(x, y),
      scanDistanceAt: (x, y) => this.scanDistanceAt(x, y),
      clipPlanes: () => this.slicePlanes,
      scanOpacity: () => this.scanOpacity(),
      click: (x, y, additive) => this.handleClick(x, y, additive),
      sizeStage: (radius, frame) => this.sizeStage(radius, frame),
      framedSphere: () => new THREE.Sphere(this.framedClip.center.clone(), this.framedClip.radius),
    }
  }

  /** With no scan, a layer's size stands in for the part's — what overlays
   *  and elements are drawn at — and, given a box, the camera frames it. A
   *  scan loaded later sizes the stage to itself. */
  private sizeStage(radius: number, frame?: THREE.Box3): void {
    if (this.mesh) return
    this.modelRadius = radius
    if (frame) this.frameCamera(frame, null)
    this.invalidate()
  }
}
