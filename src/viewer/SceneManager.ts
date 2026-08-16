// SPDX-License-Identifier: AGPL-3.0-only
import * as THREE from 'three'
import { OrthoViewport } from './orthoViewport'
import { AxisGizmo } from './axisGizmo'
import { RegionColors } from './regionColors'
import { SurfaceMarking, colorToRgb, type PaintBrush } from './marking'
import { ExtendGrips } from './extendGrips'
import { Overlays, type OverlayElement, type OverlayPair, type OverlayAngle, type ProbeMarker } from './overlays'
import type { ControlScheme } from './navSchemes'
import type { PickMarker } from './PickScene'
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh'
import type { ExtendSide } from '../core/elements/extend'
import type { FitData, Vec3 } from '../core/types'
import { rigidApplyToPoints, rigidRotateVectors, type Rigid } from '../core/deviation/rigid'
import { UNMEASURED_RGB } from '../core/field/colormap'

declare module 'three' {
  interface BufferGeometry {
    computeBoundsTree: typeof computeBoundsTree
    disposeBoundsTree: typeof disposeBoundsTree
  }
}

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree
THREE.Mesh.prototype.raycast = acceleratedRaycast

/** Chassis gray, matching --chassis-adjacent `.stage` in the stylesheet — the
 *  canvas has to sit in the instrument, not on top of it. */
const STAGE_BG = 0xdedcd6

/** Unmeasured scan surface: a machined-aluminium grey. Dark enough that a
 *  brightly lit face still reads as material against the pale stage, quiet
 *  enough to leave the element colours all the contrast. Shared with the
 *  deviation map, where it marks surface the search distance never matched —
 *  the same meaning, that nothing has been measured here. */
const BASE_COLOR: [number, number, number] = [
  UNMEASURED_RGB[0],
  UNMEASURED_RGB[1],
  UNMEASURED_RGB[2],
]

/** The reference part: a translucent blue ghost the scan reads through. Blue
 *  rather than another grey, because for most of its life it is overlaid on a
 *  grey scan of very nearly the same shape, and two greys in the same place
 *  read as one washed-out object rather than as two parts being compared. */
const NOMINAL_COLOR = 0x5c86bd

/** The inside of the surface, when back-face tinting is switched on: a dull
 *  rose that no element colour, no deviation band and no unmeasured grey can
 *  be mistaken for. What it marks is worth seeing — a hole in the scan, an
 *  inverted normal, or simply that you are looking at the far wall of the
 *  part through one. */
const BACKFACE_COLOR = 0x9c5b70

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
export type { OverlayElement, OverlayPair, OverlayAngle, ProbeMarker } from './overlays'
export type { MarkGesture, PaintBrush } from './marking'

/** Where a ray met the scan. The barycentric weights come along so a caller
 *  holding a per-vertex field — the deviation map — can read its value at the
 *  exact point clicked rather than at the nearest vertex. */
export interface PickHit {
  vertices: [number, number, number]
  weights: [number, number, number]
  point: Vec3
  /** Cursor position that produced the hit, so a readout can follow it. */
  clientX: number
  clientY: number
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
export class SceneManager {
  private viewport: OrthoViewport
  private gizmo: AxisGizmo
  /** Who owns each vertex's colour, and every tint layered over it. */
  private regions = new RegionColors(BASE_COLOR)
  private marking: SurfaceMarking
  private grips: ExtendGrips
  private overlays: Overlays
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
  private nominalMesh: THREE.Mesh | null = null
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
  private hoverEnabled = false
  private hoverWasHit = false
  /** While on, a click resolves to the element under the cursor (overlay
   *  shape or painted region) before falling back to a plain surface pick. */
  private elementPickEnabled = false

  /** Back-face tinting, shared by every material that opts in: a flag and a
   *  colour rather than two materials, so switching it is a uniform write
   *  instead of a shader recompile mid-session. */
  private backface = {
    uBackfaceTint: { value: 0 },
    uBackfaceColor: { value: new THREE.Color(BACKFACE_COLOR) },
  }

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
  private dragClaims = new Set<'paint' | 'handle'>()

  onPick: ((hit: PickHit) => void) | null = null
  onHover: ((hit: PickHit | null) => void) | null = null
  onElementPick: ((id: number) => void) | null = null
  /** How many vertices the brush has marked, reported when a stroke ends. */
  onPaintChange: ((count: number) => void) | null = null
  /** A grip being dragged: which side, and how many millimetres it has been
   *  pulled out (negative in) since the drag began. */
  onExtendDrag: ((side: ExtendSide, delta: number, phase: 'start' | 'move' | 'end') => void) | null =
    null

  constructor(container: HTMLDivElement) {
    this.viewport = new OrthoViewport(container, {
      background: STAGE_BG,
      keyLightIntensity: 1.6,
      // An orbit pivots on whichever part is actually on screen: in the
      // deviation workspace the scan can be hidden behind the reference, or
      // the other way round, and turning about a surface nobody can see reads
      // as a glitch.
      navTargets: () => {
        const targets: THREE.Object3D[] = []
        if (this.mesh?.visible) targets.push(this.mesh)
        if (this.nominalMesh?.visible) targets.push(this.nominalMesh)
        return targets
      },
      onPointerDown: (e) => this.handlePointerDown(e),
      onClick: (x, y) => this.handleClick(x, y),
      // The stroke and hover queues are what decide whether this frame has
      // anything new to show at all.
      onTick: () => {
        this.marking.drainStroke()
        this.updateHover()
      },
      onAfterRender: (w, h) =>
        this.gizmo.render(this.viewport.renderer, this.camera, this.controls.target, w, h),
    })
    this.gizmo = new AxisGizmo()

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
      colorAttr: () => this.colorAttr,
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

  /** Swap the pointer-button control scheme (dropdown in the status strip). */
  setNavScheme(scheme: ControlScheme): void {
    this.viewport.setNavScheme(scheme)
  }

  /** With the brush armed, a plain press starts a stroke or a marquee; a grip
   *  under the cursor takes the plain left-drag — the navigator has stepped
   *  aside for both. While a marking gesture is live the grips never get a
   *  look-in: that one asked first. */
  private handlePointerDown(e: PointerEvent): boolean {
    if (this.marking.pointerGesture() !== null) return this.marking.handlePointerDown(e)
    return this.grips.handlePointerDown(e)
  }

  /** A click that survived the drag threshold: an element when element picking
   *  is on and one is under the cursor, a surface pick otherwise. */
  private handleClick(x: number, y: number): void {
    if (this.elementPickEnabled) {
      const id = this.elementAt(x, y)
      if (id !== null) {
        this.onElementPick?.(id)
        return
      }
    }
    const hit = this.pick(x, y)
    if (hit) this.onPick?.(hit)
  }

  /** One pointer test per frame, and only when the answer could have changed:
   *  the hover readout when a map is showing, the brush footprint when the
   *  brush is armed. A mouse can emit hundreds of moves a second and only the
   *  last of them is on screen. */
  private updateHover(): void {
    if (!this.hoverDirty) return
    this.hoverDirty = false
    if (this.marking.armed()) this.marking.updateBrushRing(this.hoverAt)
    // Grips resolve after the footprint, and never light while a marking
    // gesture is armed — both plain drags are the brush's then.
    this.grips.updateHover(this.hoverAt, this.marking.gestureArmed())
    if (!this.hoverEnabled) return
    const at = this.hoverAt
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
   *  build) — callers should show a status message and yield a frame first. */
  setMesh(positions: Float32Array, indices: Uint32Array, normals: Float32Array): void {
    this.disposeMesh()
    this.setPreview(null)

    const vertexCount = positions.length / 3
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
    const colors = new Uint8Array(vertexCount * 3)
    for (let i = 0; i < vertexCount; i++) {
      colors[i * 3] = BASE_COLOR[0]
      colors[i * 3 + 1] = BASE_COLOR[1]
      colors[i * 3 + 2] = BASE_COLOR[2]
    }
    this.colorAttr = new THREE.BufferAttribute(colors, 3, true)
    geometry.setAttribute('color', this.colorAttr)
    geometry.setIndex(new THREE.BufferAttribute(indices, 1))
    geometry.computeBoundingBox()
    geometry.computeBoundingSphere()

    // Scans have holes; double-sided rendering keeps interior surfaces
    // visible instead of culling them to black.
    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.62,
      metalness: 0.05,
      side: THREE.DoubleSide,
    })
    this.tintBackfaces(material)
    this.mesh = new THREE.Mesh(geometry, material)
    this.partGroup.add(this.mesh)
    // A new scan is not aligned to anything yet, and nothing is being
    // previewed on it.
    this.previewMatrix.identity()
    this.setAlignment(null)
    this.regions.attach(colors)

    this.modelRadius = Math.max(
      geometry.boundingBox!.min.distanceTo(geometry.boundingBox!.max) / 2,
      1e-4,
    )
    this.scanAxis = principalAxis(positions)
    this.frameCamera(geometry.boundingBox!, this.scanAxis)
    geometry.computeBoundsTree()
  }

  /**
   * Make a material paint its back faces in the flag colour when back-face
   * tinting is on.
   *
   * Done in the shader rather than by drawing the mesh a second time with the
   * faces flipped, because the second pass would have to be the same million
   * triangles again — and because a front-face-only main pass would take the
   * inside of the part out of reach of the raycaster, which is what picking,
   * hovering and the brush all run on.
   */
  private tintBackfaces(material: THREE.Material): void {
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uBackfaceTint = this.backface.uBackfaceTint
      shader.uniforms.uBackfaceColor = this.backface.uBackfaceColor
      shader.fragmentShader =
        'uniform float uBackfaceTint;\nuniform vec3 uBackfaceColor;\n' +
        shader.fragmentShader.replace(
          '#include <color_fragment>',
          `#include <color_fragment>
          if ( uBackfaceTint > 0.5 && ! gl_FrontFacing ) diffuseColor.rgb = uBackfaceColor;`,
        )
    }
  }

  /** Show which way the surface faces: the far side of every triangle gets a
   *  colour of its own, so holes and flipped normals stop reading as part. */
  setBackfaceTint(on: boolean): void {
    this.backface.uBackfaceTint.value = on ? 1 : 0
    this.invalidate()
  }

  /** Frame the part broadside, and remember what was framed so the alignment
   *  preview can bound its clip range absolutely. */
  private frameCamera(box: THREE.Box3, axis: THREE.Vector3): void {
    this.viewport.frameCamera(box, axis)
    this.framedClip.center.copy(this.clipSphere.center)
    this.framedClip.radius = this.clipSphere.radius
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
    const vertices: [number, number, number] = [
      index.getX(f),
      index.getX(f + 1),
      index.getX(f + 2),
    ]
    // hit.point is in world space, which is the *reference's* frame once the
    // scan has been aligned. Everything a caller does with it — pinning a
    // reading, reading a per-vertex field — belongs to the scan, so hand back
    // scan coordinates. Scratch, not a clone: this runs every frame while the
    // hover readout is on.
    this.partGroup.updateWorldMatrix(true, false)
    const local = this.partGroup.worldToLocal(this.scratchD.copy(hit.point))
    return {
      vertices,
      weights: this.barycentric(vertices, local),
      point: [local.x, local.y, local.z],
      clientX,
      clientY,
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

  /** The element under the cursor: the nearest hit among the overlay shapes
   *  and the scan, where a scan hit counts as the element whose painted
   *  region it landed on. Null over bare scan or empty space. */
  private elementAt(clientX: number, clientY: number): number | null {
    this.setPickRay(clientX, clientY)
    const targets = this.overlays.pickTargets()
    if (this.mesh?.visible) targets.push(this.mesh)
    const hits = this.raycaster.intersectObjects(targets, false)
    for (const hit of hits) {
      if (hit.object !== this.mesh) {
        const id = hit.object.userData.elementId
        if (typeof id === 'number') return id
        continue
      }
      // On the scan the element is the owner of the nearest triangle corner.
      // Bare scan ends the search: it occludes whatever is behind it.
      if (hit.faceIndex === undefined || hit.faceIndex === null || !this.regions.ready) return null
      const index = (this.mesh.geometry as THREE.BufferGeometry).getIndex()!
      const f = hit.faceIndex * 3
      const vertices: [number, number, number] = [
        index.getX(f),
        index.getX(f + 1),
        index.getX(f + 2),
      ]
      this.partGroup.updateWorldMatrix(true, false)
      const weights = this.barycentric(
        vertices,
        this.partGroup.worldToLocal(this.scratchD.copy(hit.point)),
      )
      const nearest = weights.indexOf(Math.max(...weights))
      return this.regions.visibleOwnerAt(vertices[nearest])
    }
    return null
  }

  /** Make the given elements read as selected: their translucent shells get
   *  denser, glow in their own colour, and wear a white stroke. */
  setHighlightedElements(ids: readonly number[]): void {
    this.overlays.setHighlightedElements(ids)
  }

  /** Pin deviation readings to the part. */
  setProbes(probes: ProbeMarker[]): void {
    this.overlays.setProbes(probes)
  }

  /** Mark the points picked for an alignment slot on the part, labelled with
   *  what they are for. */
  setPickMarkers(markers: PickMarker[]): void {
    this.overlays.setPickMarkers(markers)
  }

  applyRegion(elementId: number, colorHex: string, region: Uint32Array): void {
    if (!this.colorAttr || !this.regions.ready) return
    this.invalidate()
    if (this.regions.applyRegion(elementId, colorToRgb(colorHex), region))
      this.colorAttr.needsUpdate = true
  }

  clearElement(elementId: number): void {
    if (!this.colorAttr || !this.regions.ready) return
    this.invalidate()
    if (this.regions.clearElement(elementId)) this.colorAttr.needsUpdate = true
  }

  clearAllRegions(): void {
    if (!this.colorAttr || !this.regions.ready) return
    this.invalidate()
    if (this.regions.clearAllRegions()) this.colorAttr.needsUpdate = true
  }

  /** Tint the surfaces a pending fit is using, in the colour the element will
   *  get once it is created. Unlike applyRegion this takes no ownership, so
   *  lifting the preview restores whatever was underneath. */
  setPreviewRegion(region: Uint32Array | null, colorHex?: string): void {
    if (!this.regions.setPreviewRegion(region, colorHex ? colorToRgb(colorHex) : undefined)) return
    this.colorAttr!.needsUpdate = true
    this.invalidate()
  }

  /** Translucent ghost of the element a pending fit produced. */
  setPreview(fit: FitData | null): void {
    this.overlays.setPreview(fit)
  }

  /** Put grips on the element being made, or take them away with null. */
  setExtendHandles(fit: FitData | null, color: string): void {
    this.grips.setHandles(fit, color)
  }

  /** Take the plain left-drag away from the camera, or give it back, for one
   *  reason among several. The navigator only ever hears the total. */
  private claimDrag(reason: 'paint' | 'handle', on: boolean): void {
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
    visible: boolean,
  ): void {
    this.overlays.updateOverlays(elements, pairs, angles, visible)
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
    return (this.mesh?.geometry as THREE.BufferGeometry) ?? null
  }

  /** Half the scan's bounding-box diagonal — the scale hand-made elements
   *  (coordinate planes, picked points) are drawn at. */
  modelSize(): number {
    return this.modelRadius
  }

  nominalGeometry(): THREE.BufferGeometry | null {
    return (this.nominalMesh?.geometry as THREE.BufferGeometry) ?? null
  }

  /** Load the reference part. It never moves: a nominal is the datum a
   *  measurement is taken against, so the alignment is applied to the scan and
   *  the world ends up in the reference's coordinates. */
  setNominal(positions: Float32Array, indices: Uint32Array, normals: Float32Array): void {
    this.disposeNominal()
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
    geometry.setIndex(new THREE.BufferAttribute(indices, 1))
    geometry.computeBoundingBox()
    geometry.computeBoundingSphere()
    geometry.computeBoundsTree()

    const material = new THREE.MeshStandardMaterial({
      color: NOMINAL_COLOR,
      roughness: 0.55,
      metalness: 0.05,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.5,
      // Without this the ghost writes depth and punches holes in the scan
      // behind it, which reads as missing scan data rather than as a ghost.
      depthWrite: false,
    })
    this.nominalMesh = new THREE.Mesh(geometry, material)
    this.nominalMesh.visible = false
    this.nominalMesh.renderOrder = 1
    this.scene.add(this.nominalMesh)
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
    if (!this.nominalMesh) return
    const material = this.nominalMesh.material as THREE.MeshStandardMaterial
    material.transparent = ghost
    material.opacity = ghost ? 0.5 : 1
    material.depthWrite = !ghost
    material.needsUpdate = true
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
    }
    if (this.nominalMesh) {
      const g = this.nominalMesh.geometry as THREE.BufferGeometry
      if (g.boundingBox) box.union(g.boundingBox)
    }
    if (!box.isEmpty()) this.frameCamera(box, this.scanAxis)
  }

  /** Paint the scan from a measured map — deviation, wall thickness — or pass
   *  null to hand the surface back to the element colours. */
  setFieldColors(colors: Uint8Array | null): void {
    const painted = this.regions.setFieldColors(colors)
    this.invalidate()
    if (!painted) return
    this.colorAttr!.needsUpdate = true
  }

  /** Switch the surface tint of the given elements off (and everyone else's
   *  back on). Cheap enough to run on every visibility toggle. */
  setHiddenRegions(ids: readonly number[]): void {
    if (!this.regions.setHiddenRegions(ids)) return
    this.colorAttr!.needsUpdate = true
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
    this.regions.detach()
    this.marking.meshDisposed()
    if (!this.mesh) return
    const geometry = this.mesh.geometry as THREE.BufferGeometry
    geometry.disposeBoundsTree?.()
    geometry.dispose()
    ;(this.mesh.material as THREE.Material).dispose()
    this.partGroup.remove(this.mesh)
    this.mesh = null
    this.colorAttr = null
  }

  dispose(): void {
    this.marking.dispose()
    this.grips.dispose()
    this.overlays.dispose()
    this.gizmo.dispose()
    this.disposeNominal()
    this.disposeMesh()
    this.viewport.dispose()
  }
}
