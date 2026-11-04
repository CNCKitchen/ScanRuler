// SPDX-License-Identifier: AGPL-3.0-only
// The Mesh Tools workspace in the 3D viewport: the scan reduced for CAD, the
// islands Remove islands would take, the rims Fill holes would close — a
// click on a hole's ring fills that hole — the cap a cut would close the
// part with, the solids Boolean and Trim to scan are offered, and the piece
// Trim to scan made. One layer of the SceneManager (src/viewer/sceneLayers.ts),
// first in line: the rings are drawn through the part, so picked through it,
// ahead of everything behind.

import * as THREE from 'three'
import type { SceneManager } from '../../../src/viewer/SceneManager'
import type { SceneLayer, SceneLayerHost } from '../../../src/viewer/sceneLayers'
import { rigidApplyToPoints } from '../../../src/core/deviation/rigid'
import { applyFinish, setSurfaceColor, type ViewTheme } from '../../../src/viewer/viewThemes'
import { patchWireframe, setSurfaceOpacity } from '../../../src/viewer/surfaceModes'
import { CAP_SLOT, CapSet, cutColor, type CapPart } from '../../../src/viewer/sliceCap'
import { clipTree } from '../../../src/viewer/clipTree'
import { paintField, type Colormap, type FieldScale } from '../../../src/core/field/colormap'
import type { Vec3 } from '../../../src/core/types'
import type { BridgeStrokeSample } from '../core/bridgeStroke'
import type { BridgeGuidance } from '../core/bridge'

/** The islands a removal would take: a warning orange, unlit, so it stands
 *  off the scan's grey under every scheme. */
const ISLAND_COLOR = 0xff5a1f
/** Across the ring each island is marked with, on screen, px: a speck a
 *  pixel across is still found by it with the whole part in view. */
const ISLAND_RING_PX = 26
/** How strongly a ring shows through the part, for an island behind it or
 *  inside it. */
const ISLAND_RING_THROUGH = 0.35
/** A rim Fill holes leaves open: a slate that reads as seen, not as a
 *  warning. */
const OPEN_RIM_COLOR = 0x6b7a90
/** The solid a boolean is set up with, in the colour of what it will do:
 *  red what is taken out, green what is added, blue what is kept of both —
 *  and the body Trim to scan cuts, in the teal its break is marked in. */
const BOOLEAN_COLORS = { subtract: 0xe5484d, add: 0x30a46c, intersect: 0x3b8cff, trim: 0x12a594 } as const
/** The piece's mating face: the break's teal, the rest of it the colour a
 *  model for CAD has. */
const PIECE_MATING_COLOR = 0x12a594
/** The solids on offer that are not in hand: a slate that reads as there to
 *  be taken, not as an operation. */
const SOLID_OFFER_COLOR = 0x8b95a3

type BooleanOpColor = keyof typeof BOOLEAN_COLORS

/** A solid on offer as drawn: see-through over the part, faintly through it,
 *  and its edges. */
interface DrawnSolid {
  key: string
  group: THREE.Group
  fill: THREE.Mesh
  through: THREE.Mesh
  edges: THREE.LineSegments
}

export class MeshScene {
  private host: SceneLayerHost
  /** The scan reduced for CAD — see setReducedMesh. */
  private reducedMesh: THREE.Mesh | null = null
  /** The piece Trim to scan made, and its mating face's gap to the part at
   *  each vertex — see setTrimmedPiece. */
  private piece: THREE.Mesh | null = null
  private pieceGap: Float32Array | null = null
  /** Its edges are the point of it, so its mesh mode is always on. */
  private reducedWire = { uWire: { value: 1 } }
  /** The islands Remove islands would take — see setIslands. */
  private islands: THREE.Group | null = null
  /** The rims Fill holes would close, and those it would leave — see
   *  setHoles. */
  private holes: THREE.Group | null = null
  /** The middle of each hole, where its ring is, and the ring under the
   *  cursor, drawn larger — a click on it fills that hole, see onHolePick. */
  private holeCentres: Float32Array | null = null
  private hoveredHole: number | null = null
  private holeHighlight: THREE.Points | null = null
  /** The cap a cut would close the part with, and the stretches of it that
   *  would stay open — see setCutCap. */
  private cutCap: THREE.Group | null = null
  private bridge: THREE.Group | null = null
  private bridgePoints: Vec3[] = []
  private bridgeLabels = new Map<number, THREE.CanvasTexture>()
  private bridgeDragCleanup: (() => void) | null = null
  onBridgeDrag: {
    start(): boolean
    move(index: number, point: Vec3): void
    end(): void
  } | null = null
  onBridgeDraw: {
    start(): boolean
    end(samples: BridgeStrokeSample[] | null): void
  } | null = null
  /** The solids Boolean can make one with the mesh, those in hand and the
   *  one under the cursor — see setBooleanSolids. */
  private booleanSolids: DrawnSolid[] = []
  private booleanChoice: { keys: readonly string[]; op: BooleanOpColor } = { keys: [], op: 'subtract' }
  private hoveredSolid: string | null = null
  private raycaster = new THREE.Raycaster()
  /** The sprite the rings are drawn with, made on first use. */
  private islandRing: THREE.Texture | null = null
  private removeLayer: () => void
  private scratch = new THREE.Vector3()
  /** The section view's planes while it cuts the part, whether what is
   *  drawn here was dressed for them, and the caps closing the reduced mesh
   *  and the piece — see dressSection. */
  private sectionPlanes: THREE.Plane[] | null = null
  private sectionDressed = false
  private caps = new CapSet()

  /** A click on a hole's ring — see setHoles — by its place in the list of
   *  middles the holes were marked with. */
  onHolePick: ((index: number) => void) | null = null
  /** A click on one of the solids Boolean is offered, by its key. */
  onSolidPick: ((key: string) => void) | null = null

  constructor(scene: SceneManager) {
    this.host = scene.layerHost()
    this.removeLayer = scene.addLayer(this.layer())
  }

  private layer(): SceneLayer {
    return {
      order: 10,
      pointerDown: (e) => this.onBridgeDraw ? this.startBridgeDraw(e) : this.startBridgeDrag(e),
      click: (x, y) => {
        const hole = this.holeAt(x, y)
        if (hole !== null) {
          this.onHolePick?.(hole)
          return true
        }
        if (!this.onSolidPick) return false
        const solid = this.solidAt(x, y)
        if (solid === null) return false
        this.onSolidPick(solid)
        return true
      },
      // A hole's ring lights under the cursor, a click on it filling that
      // hole alone — and a solid Boolean is offered, a click taking it. A
      // body only shown, from the parts list, is not there to be taken.
      hover: (at) => {
        if (this.onBridgeDraw) {
          this.host.claimDrag(at !== null || this.bridgeDragCleanup !== null)
          this.host.setCursor(at ? 'crosshair' : '')
          return at !== null
        }
        if (this.onBridgeDrag && this.bridgePoints.length) {
          const hit = at ? this.bridgePointAt(at.x, at.y) : null
          this.host.claimDrag(hit !== null || this.bridgeDragCleanup !== null)
          this.host.setCursor(this.bridgeDragCleanup ? 'grabbing' : hit !== null ? 'grab' : '')
          return hit !== null
        }
        if (this.holeCentres) {
          const hole = at ? this.holeAt(at.x, at.y) : null
          if (hole !== this.hoveredHole) {
            this.hoveredHole = hole
            this.showHoveredHole()
            this.host.setCursor(hole !== null ? 'pointer' : '')
          }
          return hole !== null
        }
        if (this.booleanSolids.length === 0 || !this.onSolidPick) return false
        const solid = at ? this.solidAt(at.x, at.y) : null
        if (solid !== this.hoveredSolid) {
          this.hoveredSolid = solid
          this.dressBooleanSolids()
          this.host.setCursor(solid !== null ? 'pointer' : '')
        }
        return solid !== null
      },
      themeChanged: (theme) => {
        for (const child of this.cutCap?.children ?? []) {
          if (child instanceof THREE.Mesh) this.dressCutCap(child.material as THREE.MeshStandardMaterial, theme)
        }
        if (this.reducedMesh) {
          const material = this.reducedMesh.material as THREE.MeshStandardMaterial
          material.color.setHex(theme.nominal)
          applyFinish(material, theme)
        }
        if (this.piece) {
          const [skins, mating] = this.piece.material as THREE.MeshStandardMaterial[]
          skins.color.setHex(theme.nominal)
          applyFinish(skins, theme)
          applyFinish(mating, theme)
        }
      },
      opacityChanged: (opacity) => {
        if (this.reducedMesh) setSurfaceOpacity(this.reducedMesh.material as THREE.MeshStandardMaterial, opacity)
      },
      // The section view cuts all that is drawn here, as it lies on the part;
      // a cut's own preview is the cut tool's, and stands in front of it.
      clippingChanged: (planes, section) => {
        this.sectionPlanes = section ? planes : null
        this.dressSection()
      },
      tick: (_width, height) => {
        this.dressSection()
        const camera = this.host.camera()
        const size = 24 * (camera.top - camera.bottom) / (camera.zoom * height)
        for (const child of this.bridge?.children ?? []) {
          if (child instanceof THREE.Sprite) {
            const factor = child.name.startsWith('Bridge warning') || child.name.startsWith('Bridge moved') ? 1.5 : child.name.startsWith('Bridge rim target') ? 0.4 : 1
            child.scale.set(size * factor, size * factor, 1)
          }
        }
      },
      // The reduced mesh was made in the scan's frame and stays in it: it
      // moves with the scan, and the deviation measured between them is a
      // distance no rigid move changes. So do the islands marked on it.
      partMoved: (m) => {
        for (const made of [this.reducedMesh, this.piece]) {
          if (!made) continue
          const geometry = made.geometry as THREE.BufferGeometry
          const at = geometry.getAttribute('position') as THREE.BufferAttribute
          rigidApplyToPoints(m, at.array as Float32Array)
          at.needsUpdate = true
          geometry.computeBoundingBox()
          geometry.computeBoundingSphere()
          geometry.disposeBoundsTree?.()
          geometry.computeBoundsTree()
        }
        const solids = new Set(this.booleanSolids.flatMap((d) => [d.fill.geometry, d.edges.geometry]))
        for (const geometry of [...this.islandGeometries(), ...solids]) {
          const at = geometry.getAttribute('position') as THREE.BufferAttribute
          rigidApplyToPoints(m, at.array as Float32Array)
          at.needsUpdate = true
          if (geometry.getAttribute('normal')) geometry.computeVertexNormals()
          geometry.computeBoundingSphere()
        }
      },
      // A reduction belongs to the scan it was made from, and so do the
      // islands, the rims and the cut marked on it, and a piece cut to it.
      scanReplaced: () => {
        this.cancelBridgeDrag()
        this.disposeReduced()
        this.disposePiece()
        this.disposeIslands()
        this.disposeHoles()
        this.disposeCutCap()
        this.setBridgePreview([], null)
        this.disposeBooleanSolids()
      },
      // An orbit pivots on the reduced mesh while it stands in for the scan,
      // and on the piece while it is shown.
      navTargets: () => [this.reducedMesh, this.piece].filter((m): m is THREE.Mesh => m?.visible === true),
      dispose: () => {
        this.cancelBridgeDrag()
        this.disposeReduced()
        this.disposePiece()
        this.disposeIslands()
        this.disposeHoles()
        this.disposeCutCap()
        this.setBridgePreview([], null)
        this.disposeBooleanSolids()
        this.caps.dispose()
        this.islandRing?.dispose()
        for (const texture of this.bridgeLabels.values()) texture.dispose()
        this.bridgeLabels.clear()
      },
    }
  }

  /** What is drawn here cut by the section view — and the reduced mesh and
   *  the piece, the parts among it, closed where they are closed. Walked
   *  every frame while it cuts, as what is drawn comes and goes with the
   *  tools; once more when it stops, to take the clip off. */
  private dressSection(): void {
    const planes = this.sectionPlanes
    if (!planes && !this.sectionDressed) return
    this.sectionDressed = planes !== null
    const roots = [this.reducedMesh, this.piece, this.islands, this.holes, this.holeHighlight, this.cutCap, ...this.booleanSolids.map((d) => d.group)]
    for (const root of roots) if (root) clipTree(root, planes)
    const parts: CapPart[] = []
    // The reduced mesh stands in for the scan, and is cut in its colour.
    if (this.reducedMesh?.visible) parts.push({ mesh: this.reducedMesh, slot: CAP_SLOT.layers, color: cutColor(CAP_SLOT.scan) })
    if (this.piece?.visible) parts.push({ mesh: this.piece, slot: CAP_SLOT.layers + 1, color: cutColor(CAP_SLOT.layers) })
    this.caps.update(planes, parts, this.host.theme())
  }

  /** Take the layer out of the viewport. */
  dispose(): void {
    this.removeLayer()
  }

  /**
   * The scan reduced for CAD, or null to take it away. Drawn in the scan's
   * frame — it rides the scan's group, so a best-fit pose or an alignment
   * preview carries it along with the scan it was made from — with every
   * triangle edge on and each facet flat-shaded: the triangles are what is
   * being judged here, and a smooth shading would hide the very facets that
   * will be flat faces in CAD. Coloured like the reference part, the other
   * mesh in this tool that stands for CAD. Hidden until asked for.
   */
  setReducedMesh(mesh: { positions: Float32Array; indices: Uint32Array; wireSlots: Uint8Array } | null): void {
    this.disposeReduced()
    if (mesh) {
      const theme = this.host.theme()
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3))
      geometry.setAttribute('wireSlot', new THREE.BufferAttribute(mesh.wireSlots, 1))
      geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1))
      geometry.computeBoundingBox()
      geometry.computeBoundingSphere()
      // An orbit is pivoted on it — see navTargets — and a limit of half a
      // million triangles is a lot to raycast without a tree.
      geometry.computeBoundsTree()
      const material = new THREE.MeshStandardMaterial({
        color: theme.nominal,
        flatShading: true,
        side: THREE.DoubleSide,
      })
      applyFinish(material, theme)
      patchWireframe(material, this.reducedWire)
      setSurfaceOpacity(material, this.host.scanOpacity())
      this.reducedMesh = new THREE.Mesh(geometry, material)
      this.reducedMesh.visible = false
      this.host.partGroup.add(this.reducedMesh)
    }
    this.host.invalidate()
  }

  setReducedVisible(visible: boolean): void {
    if (this.reducedMesh) this.reducedMesh.visible = visible
    this.host.invalidate()
  }

  /** The reduced mesh as it now stands — every datum alignment made since it
   *  was reduced baked in, like the scan's — for the export. */
  reducedGeometry(): THREE.BufferGeometry | null {
    return (this.reducedMesh?.geometry as THREE.BufferGeometry) ?? null
  }

  /**
   * The piece Trim to scan made, or null to take it away: in the scan's
   * frame like the reduced mesh, moving with it, each facet flat-shaded as a
   * model for CAD is — its skins the body's, in the colour a reference part
   * has, and its mating face, the triangles `mating` marks, in the break's
   * teal. Hidden until asked for.
   */
  setTrimmedPiece(piece: { positions: Float32Array; indices: Uint32Array; mating: Uint8Array; gap: Float32Array } | null): void {
    this.disposePiece()
    if (piece) {
      this.pieceGap = piece.gap
      const theme = this.host.theme()
      // The skins' triangles first, then the mating face's, a material each.
      let skins = 0
      for (const m of piece.mating) if (!m) skins += 3
      const order = new Uint32Array(piece.indices.length)
      let onSkin = 0
      let onMating = skins
      for (let t = 0; t < piece.mating.length; t++) {
        const at = piece.mating[t] ? onMating : onSkin
        order.set(piece.indices.subarray(t * 3, t * 3 + 3), at)
        if (piece.mating[t]) onMating += 3
        else onSkin += 3
      }
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(piece.positions, 3))
      geometry.setIndex(new THREE.BufferAttribute(order, 1))
      geometry.addGroup(0, skins, 0)
      geometry.addGroup(skins, order.length - skins, 1)
      geometry.computeBoundingBox()
      geometry.computeBoundingSphere()
      geometry.computeBoundsTree()
      const dress = (color: number) => {
        const material = new THREE.MeshStandardMaterial({ color, flatShading: true, side: THREE.DoubleSide })
        applyFinish(material, theme)
        return material
      }
      this.piece = new THREE.Mesh(geometry, [dress(theme.nominal), dress(PIECE_MATING_COLOR)])
      this.piece.visible = false
      this.host.partGroup.add(this.piece)
    }
    this.host.invalidate()
  }

  setTrimmedVisible(visible: boolean): void {
    if (this.piece) this.piece.visible = visible
    this.host.invalidate()
  }

  /** The piece's mating face coloured by its gap to the part, through
   *  `scale` and `map` as every map is painted — grey where it was not read,
   *  past the break's rim — or, with null, in the break's teal again. */
  setTrimmedGap(paint: { scale: FieldScale; map: Colormap } | null): void {
    const piece = this.piece
    if (!piece || !this.pieceGap) return
    const mating = (piece.material as THREE.MeshStandardMaterial[])[1]
    const geometry = piece.geometry as THREE.BufferGeometry
    if (paint) {
      const rgb = new Uint8Array(this.pieceGap.length * 3)
      paintField(this.pieceGap, paint.scale, paint.map, rgb)
      geometry.setAttribute('color', new THREE.BufferAttribute(rgb, 3, true))
      mating.vertexColors = true
      mating.color.setHex(0xffffff)
    } else {
      mating.vertexColors = false
      mating.color.setHex(PIECE_MATING_COLOR)
    }
    mating.needsUpdate = true
    this.host.invalidate()
  }

  /** The piece as it now stands — every datum alignment made since it was
   *  cut baked in, like the scan's — for the export. */
  trimmedGeometry(): THREE.BufferGeometry | null {
    return (this.piece?.geometry as THREE.BufferGeometry) ?? null
  }

  private disposePiece(): void {
    this.pieceGap = null
    if (!this.piece) return
    const geometry = this.piece.geometry as THREE.BufferGeometry
    geometry.disposeBoundsTree?.()
    geometry.dispose()
    for (const material of this.piece.material as THREE.Material[]) material.dispose()
    this.host.partGroup.remove(this.piece)
    this.piece = null
  }

  private disposeReduced(): void {
    if (!this.reducedMesh) return
    const geometry = this.reducedMesh.geometry as THREE.BufferGeometry
    geometry.disposeBoundsTree?.()
    geometry.dispose()
    ;(this.reducedMesh.material as THREE.Material).dispose()
    this.host.partGroup.remove(this.reducedMesh)
    this.reducedMesh = null
  }

  /**
   * Mark the scan's islands on it — their triangles, nine floats apiece, and
   * the middle of each island, three floats apiece, in scan coordinates — or
   * take the marks away with nulls. Each island is tinted where it lies and
   * ringed besides, the ring a fixed size on screen: islands are specks, and
   * a speck tinted is still a speck at any zoom that shows the whole part.
   * The ring shows faintly through the part as well, so an island behind it
   * or inside it is marked too — the removal takes those just the same.
   */
  setIslands(triangles: Float32Array | null, centres: Float32Array | null): void {
    this.disposeIslands()
    if (triangles && triangles.length >= 9 && centres && centres.length >= 3) {
      const fill = new THREE.BufferGeometry()
      fill.setAttribute('position', new THREE.BufferAttribute(triangles, 3))
      const middles = new THREE.BufferGeometry()
      middles.setAttribute('position', new THREE.BufferAttribute(centres, 3))
      const ring = (through: boolean) => {
        const points = new THREE.Points(
          middles,
          new THREE.PointsMaterial({
            color: ISLAND_COLOR,
            map: this.islandRingTexture(),
            size: ISLAND_RING_PX,
            sizeAttenuation: false,
            transparent: true,
            depthWrite: false,
            depthTest: !through,
            opacity: through ? ISLAND_RING_THROUGH : 1,
          }),
        )
        // Over the bodies, which draw over the scan.
        points.renderOrder = 4
        return points
      }
      const group = new THREE.Group()
      group.add(
        new THREE.Mesh(
          fill,
          // Drawn over the scan triangles it coincides with.
          new THREE.MeshBasicMaterial({
            color: ISLAND_COLOR,
            side: THREE.DoubleSide,
            polygonOffset: true,
            polygonOffsetFactor: -2,
            polygonOffsetUnits: -2,
          }),
        ),
        ring(true),
        ring(false),
      )
      this.islands = group
      this.host.partGroup.add(group)
    }
    this.host.invalidate()
  }

  /** The islands' geometries on show, each once — the two ring passes
   *  share theirs. */
  private islandGeometries(): Set<THREE.BufferGeometry> {
    const children = (this.islands?.children ?? []) as (THREE.Mesh | THREE.Points)[]
    return new Set(children.map((child) => child.geometry))
  }

  /** A ring, drawn white to take the island colour, on a dark rim that holds
   *  it off a light background and a dark one alike. */
  private islandRingTexture(): THREE.Texture {
    if (this.islandRing) return this.islandRing
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 64
    const ctx = canvas.getContext('2d')
    if (ctx) {
      ctx.beginPath()
      ctx.arc(32, 32, 25, 0, 2 * Math.PI)
      ctx.lineWidth = 10
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)'
      ctx.stroke()
      ctx.lineWidth = 5.5
      ctx.strokeStyle = '#fff'
      ctx.stroke()
    }
    this.islandRing = new THREE.CanvasTexture(canvas)
    return this.islandRing
  }

  private disposeIslands(): void {
    if (!this.islands) return
    for (const geometry of this.islandGeometries()) geometry.dispose()
    for (const child of this.islands.children as (THREE.Mesh | THREE.Points)[]) (child.material as THREE.Material).dispose()
    this.host.partGroup.remove(this.islands)
    this.islands = null
  }

  /**
   * Mark the scan's rims on it for Fill holes — the holes to fill as line
   * segments, six floats an edge, with the middle of each, and the rims left
   * open the same way, in scan coordinates — or take the marks away with
   * nulls. A hole is drawn in the islands' orange and ringed as an island
   * is, because most holes are specks too: a pinhole a scanner left is found
   * by its ring at any zoom. A rim left open — a border as large as the part,
   * or a hole past the size — is drawn faint and unringed, to say it was
   * seen and is not being filled. A click on a ring is reported through
   * onHolePick, the ring under the cursor drawn larger.
   */
  setHoles(holes: Float32Array | null, centres: Float32Array | null, open: Float32Array | null): void {
    this.disposeHoles()
    this.holeCentres = holes && holes.length >= 6 && centres && centres.length >= 3 ? centres : null
    this.host.requestHover()
    const group = new THREE.Group()
    const lines = (segments: Float32Array, color: number, opacity: number, through: boolean) => {
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(segments, 3))
      const line = new THREE.LineSegments(
        geometry,
        new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity, depthTest: !through, depthWrite: false }),
      )
      line.renderOrder = 4
      return line
    }
    if (open && open.length >= 6) group.add(lines(open, OPEN_RIM_COLOR, 0.7, false))
    if (holes && holes.length >= 6) {
      group.add(lines(holes, ISLAND_COLOR, 1, false), lines(holes, ISLAND_COLOR, ISLAND_RING_THROUGH, true))
      if (centres && centres.length >= 3) {
        const middles = new THREE.BufferGeometry()
        middles.setAttribute('position', new THREE.BufferAttribute(centres, 3))
        for (const through of [true, false]) {
          const points = new THREE.Points(
            middles,
            new THREE.PointsMaterial({
              color: ISLAND_COLOR,
              map: this.islandRingTexture(),
              size: ISLAND_RING_PX,
              sizeAttenuation: false,
              transparent: true,
              depthWrite: false,
              depthTest: !through,
              opacity: through ? ISLAND_RING_THROUGH : 1,
            }),
          )
          points.renderOrder = 4
          group.add(points)
        }
        // The ring under the cursor, over the rest and larger.
        const lit = new THREE.BufferGeometry()
        lit.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3))
        this.holeHighlight = new THREE.Points(
          lit,
          new THREE.PointsMaterial({
            color: ISLAND_COLOR,
            map: this.islandRingTexture(),
            size: ISLAND_RING_PX * 1.5,
            sizeAttenuation: false,
            transparent: true,
            depthWrite: false,
            depthTest: false,
          }),
        )
        this.holeHighlight.renderOrder = 5
        this.holeHighlight.visible = false
        group.add(this.holeHighlight)
      }
    }
    if (group.children.length > 0) {
      this.holes = group
      this.host.partGroup.add(group)
    }
    this.host.invalidate()
  }

  /** The hole whose ring is under a client point, if any: the nearest ring on
   *  screen within a little more than its radius. Rings are drawn through
   *  the part, so a ring behind it is picked as well as one in front. */
  private holeAt(clientX: number, clientY: number): number | null {
    const centres = this.holeCentres
    if (!centres) return null
    const rect = this.host.canvas.getBoundingClientRect()
    const x = clientX - rect.left
    const y = clientY - rect.top
    this.host.partGroup.updateMatrixWorld(true)
    const m = this.host.partGroup.matrixWorld
    const camera = this.host.camera()
    const p = this.scratch
    const reach = ISLAND_RING_PX / 2 + 4
    let best: number | null = null
    let bestD = reach * reach
    for (let i = 0; i < centres.length / 3; i++) {
      p.set(centres[i * 3], centres[i * 3 + 1], centres[i * 3 + 2]).applyMatrix4(m).project(camera)
      const dx = ((p.x + 1) / 2) * rect.width - x
      const dy = ((1 - p.y) / 2) * rect.height - y
      const d = dx * dx + dy * dy
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    return best
  }

  private showHoveredHole(): void {
    const lit = this.holeHighlight
    const centres = this.holeCentres
    if (!lit || !centres) return
    const i = this.hoveredHole
    lit.visible = i !== null
    if (i !== null) {
      const at = lit.geometry.getAttribute('position') as THREE.BufferAttribute
      at.setXYZ(0, centres[i * 3], centres[i * 3 + 1], centres[i * 3 + 2])
      at.needsUpdate = true
      lit.geometry.computeBoundingSphere()
    }
    this.host.invalidate()
  }

  private disposeHoles(): void {
    this.holeCentres = null
    this.holeHighlight = null
    if (this.hoveredHole !== null) {
      this.hoveredHole = null
      this.host.setCursor('')
    }
    if (!this.holes) return
    const children = this.holes.children as (THREE.LineSegments | THREE.Points)[]
    for (const geometry of new Set(children.map((child) => child.geometry))) geometry.dispose()
    for (const child of children) (child.material as THREE.Material).dispose()
    this.host.partGroup.remove(this.holes)
    this.holes = null
  }

  /**
   * The cap a cut would close the part with — nine floats a triangle, from
   * the worker's own cut (core/cut cutPreview) — and the stretches of the cut
   * it would leave open, six floats an edge, in scan coordinates; nulls take
   * them away. Drawn with the slice's own stencil cap turned off
   * (setSliceCapped): that one is only right on a closed scan, and through an
   * open one it closes whatever the eye looks through. This one is the
   * cut's, exactly, open where the cut will be open.
   */
  setCutCap(cap: Float32Array | null, open: Float32Array | null): void {
    this.disposeCutCap()
    const group = new THREE.Group()
    if (cap && cap.length >= 9) {
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(cap, 3))
      geometry.computeVertexNormals()
      const material = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide })
      this.dressCutCap(material, this.host.theme())
      group.add(new THREE.Mesh(geometry, material))
    }
    if (open && open.length >= 6) {
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(open, 3))
      const line = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: OPEN_RIM_COLOR, depthWrite: false }))
      line.renderOrder = 4
      group.add(line)
    }
    if (group.children.length > 0) {
      this.cutCap = group
      this.host.partGroup.add(group)
    }
    this.host.invalidate()
  }

  /** The cut face in the surface's colour, a shade under it — a cut face is
   *  not the skin of the part — as the slice's cap has it. */
  private dressCutCap(material: THREE.MeshStandardMaterial, theme: ViewTheme): void {
    setSurfaceColor(material.color, theme)
    material.color.multiplyScalar(0.82)
    applyFinish(material, theme)
    material.needsUpdate = true
  }

  /**
   * The solids Boolean is offered, an empty list to take them away: in the
   * scan's frame, see-through over the part and faintly through it as well,
   * with their edges, so a cylinder pushed down a bore is in view all the
   * way to its end. Those in hand wear the colour of what the boolean will
   * do with them, the others a plain slate; a click puts one in hand or
   * takes it out again (see onSolidPick). The bodies the parts list shows
   * are drawn the same, all slate, and none to be clicked.
   */
  setBooleanSolids(solids: readonly { key: string; name: string; positions: Float32Array; indices: Uint32Array }[], chosen: readonly string[], op: BooleanOpColor): void {
    this.disposeBooleanSolids()
    for (const solid of solids) {
      if (solid.indices.length < 3) continue
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(solid.positions, 3))
      geometry.setIndex(new THREE.BufferAttribute(solid.indices, 1))
      geometry.computeVertexNormals()
      geometry.computeBoundingSphere()
      const pass = (through: boolean) => {
        const m = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ transparent: true, depthWrite: false, depthTest: !through, side: THREE.DoubleSide }))
        m.renderOrder = through ? 5 : 3
        m.userData.key = solid.key
        return m
      }
      const fill = pass(false)
      const through = pass(true)
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 30), new THREE.LineBasicMaterial({ transparent: true, depthTest: false }))
      edges.renderOrder = 6
      const group = new THREE.Group()
      group.add(fill, through, edges)
      this.host.partGroup.add(group)
      this.booleanSolids.push({ key: solid.key, group, fill, through, edges })
    }
    this.booleanChoice = { keys: chosen, op }
    this.dressBooleanSolids()
  }

  /** The solids in hand and the operation, from the panel or a click. */
  setBooleanChoice(chosen: readonly string[], op: BooleanOpColor): void {
    this.booleanChoice = { keys: chosen, op }
    this.dressBooleanSolids()
  }

  /** Each solid in its colour: those in hand the operation's, strongest;
   *  one under the cursor the operation's too, lighter — in hand or out of
   *  it, a click changes it; the rest slate. */
  private dressBooleanSolids(): void {
    const { keys, op } = this.booleanChoice
    for (const d of this.booleanSolids) {
      const hovered = d.key === this.hoveredSolid
      const chosen = keys.includes(d.key) && !hovered
      const lit = chosen || hovered
      const color = lit ? BOOLEAN_COLORS[op] : SOLID_OFFER_COLOR
      const dress = (m: THREE.MeshStandardMaterial | THREE.LineBasicMaterial, opacity: number) => {
        m.color.setHex(color)
        m.opacity = opacity
      }
      dress(d.fill.material as THREE.MeshStandardMaterial, chosen ? 0.45 : lit ? 0.32 : 0.22)
      dress(d.through.material as THREE.MeshStandardMaterial, chosen ? 0.16 : lit ? 0.12 : 0.06)
      dress(d.edges.material as THREE.LineBasicMaterial, chosen ? 0.85 : lit ? 0.75 : 0.4)
    }
    this.host.invalidate()
  }

  /** The solid under a client point, if any — the nearest along the ray.
   *  The solids are drawn through the part, so one inside it is taken as
   *  well as one in front. */
  private solidAt(clientX: number, clientY: number): string | null {
    if (this.booleanSolids.length === 0) return null
    const rect = this.host.canvas.getBoundingClientRect()
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1)
    this.host.partGroup.updateMatrixWorld(true)
    this.raycaster.setFromCamera(ndc, this.host.camera())
    const hits = this.raycaster.intersectObjects(this.booleanSolids.map((d) => d.fill), false)
    return hits.length > 0 ? (hits[0].object.userData.key as string) : null
  }

  private disposeBooleanSolids(): void {
    for (const d of this.booleanSolids) {
      d.fill.geometry.dispose()
      d.edges.geometry.dispose()
      for (const m of [d.fill, d.through, d.edges]) (m.material as THREE.Material).dispose()
      this.host.partGroup.remove(d.group)
    }
    this.booleanSolids = []
    if (this.hoveredSolid !== null) {
      this.hoveredSolid = null
      this.host.setCursor('')
    }
    this.host.invalidate()
  }

  setBridgePreview(points: Vec3[], triangles: Float32Array | null, guidance: BridgeGuidance | null = null, moved: number[] = []): void {
    this.bridgePoints = points
    if (this.bridge) {
      this.bridge.traverse((child) => {
        if (child instanceof THREE.Mesh || child instanceof THREE.Points || child instanceof THREE.Line || child instanceof THREE.Sprite) {
          if (!(child instanceof THREE.Sprite)) child.geometry.dispose()
          ;(child.material as THREE.Material).dispose()
        }
      })
      this.host.partGroup.remove(this.bridge)
      this.bridge = null
    }
    if (points.length || triangles) {
      const group = new THREE.Group()
      points.forEach((point, index) => {
        let map = this.bridgeLabels.get(index)
        if (!map) {
          const canvas = document.createElement('canvas')
          canvas.width = canvas.height = 64
          const ctx = canvas.getContext('2d')
          if (!ctx) throw new Error('Cannot draw numbered bridge points: a canvas context is unavailable.')
          ctx.fillStyle = '#ff5a1f'
          ctx.beginPath()
          ctx.arc(32, 32, 29, 0, Math.PI * 2)
          ctx.fill()
          ctx.strokeStyle = '#ffffff'
          ctx.lineWidth = 3
          ctx.stroke()
          ctx.fillStyle = '#111111'
          ctx.font = 'bold 36px sans-serif'
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillText(String(index + 1), 32, 34)
          map = new THREE.CanvasTexture(canvas)
          this.bridgeLabels.set(index, map)
        }
        const label = new THREE.Sprite(new THREE.SpriteMaterial({ map, depthTest: false, depthWrite: false }))
        label.position.set(...point)
        label.renderOrder = 8
        label.name = `Bridge point ${index + 1}`
        group.add(label)
        if (guidance?.points.includes(index) || moved.includes(index)) {
          const invalid = guidance?.points.includes(index)
          const warning = label.clone()
          warning.material = label.material.clone()
          warning.material.map = this.islandRingTexture()
          warning.material.color.setHex(invalid ? 0xffdd00 : 0x30e46c)
          warning.name = `Bridge ${invalid ? 'warning' : 'moved'} point ${index + 1}`
          warning.scale.setScalar(1.5)
          group.add(warning)
          label.renderOrder = 10
          warning.renderOrder = 9
        }
      })
      for (const target of guidance?.targets ?? []) {
        const from = new THREE.Vector3(...points[target.index])
        const to = new THREE.Vector3(...target.point)
        const length = from.distanceTo(to)
        if (length < 1e-8) continue
        const arrow = new THREE.ArrowHelper(to.clone().sub(from).normalize(), from, length, 0xffdd00, Math.min(length / 4, this.host.modelRadius() / 50))
        arrow.name = `Bridge guidance arrow ${target.index + 1}`
        arrow.traverse((object) => {
          if (object instanceof THREE.Line || object instanceof THREE.Mesh) {
            object.geometry = object.geometry.clone()
            const material = object.material as THREE.Material
            material.depthTest = false
            material.depthWrite = false
            object.renderOrder = 9
          }
        })
        group.add(arrow)
        const diamond = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0xffdd00, depthTest: false, depthWrite: false }))
        diamond.material.rotation = Math.PI / 4
        diamond.position.copy(to)
        diamond.name = `Bridge rim target ${target.index + 1}`
        diamond.renderOrder = 9
        group.add(diamond)
      }
      if (triangles) {
        const geometry = new THREE.BufferGeometry()
        geometry.setAttribute('position', new THREE.BufferAttribute(triangles, 3))
        geometry.computeVertexNormals()
        group.add(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: 0x12a594, side: THREE.DoubleSide, transparent: true, opacity: 0.7, depthWrite: false })))
      }
      this.bridge = group
      this.host.partGroup.add(group)
    }
    this.host.invalidate()
    this.host.requestHover()
  }

  private bridgePointAt(x: number, y: number): number | null {
    if (!this.onBridgeDrag) return null
    const rect = this.host.canvas.getBoundingClientRect()
    this.host.partGroup.updateMatrixWorld(true)
    let best: number | null = null, distance = 16
    this.bridgePoints.forEach((point, index) => {
      const p = new THREE.Vector3(...point).applyMatrix4(this.host.partGroup.matrixWorld).project(this.host.camera())
      if (p.z < -1 || p.z > 1) return
      const d = Math.hypot(rect.left + (p.x + 1) * rect.width / 2 - x, rect.top + (1 - p.y) * rect.height / 2 - y)
      if (d < distance) { best = index; distance = d }
    })
    return best
  }

  cancelBridgeDrag(): void {
    this.bridgeDragCleanup?.()
    this.host.claimDrag(false)
    this.host.setCursor('')
  }

  private startBridgeDrag(e: PointerEvent): boolean {
    if (e.button !== 0 || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || this.bridgeDragCleanup) return false
    const index = this.bridgePointAt(e.clientX, e.clientY)
    const handlers = this.onBridgeDrag
    if (index === null || !handlers || !handlers.start()) return false
    const original: Vec3 = [...this.bridgePoints[index]]
    this.host.claimDrag(true)
    this.host.setCursor('grabbing')
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return
      const hit = this.host.pickScan(ev.clientX, ev.clientY)
      if (hit) handlers.move(index, hit.point)
    }
    this.captureBridgePointer(e, move, (cancelled) => {
      if (cancelled) handlers.move(index, original)
      handlers.end()
    })
    return true
  }

  private startBridgeDraw(e: PointerEvent): boolean {
    if (e.button !== 0 || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || this.bridgeDragCleanup) return false
    const handlers = this.onBridgeDraw
    if (!handlers || !handlers.start()) return false
    this.host.claimDrag(true)
    const overlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    overlay.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:1000'
    const line = document.createElementNS(overlay.namespaceURI, 'polyline')
    line.setAttribute('fill', 'none')
    line.setAttribute('stroke', '#ff5a1f')
    line.setAttribute('stroke-width', '3')
    overlay.appendChild(line)
    this.host.container.appendChild(overlay)
    const samples: BridgeStrokeSample[] = [{ distance: 0, point: this.host.pickScan(e.clientX, e.clientY)?.point ?? null }]
    let last = { x: e.clientX, y: e.clientY }, distance = 0
    const path = [`${last.x},${last.y}`]
    const move = (ev: PointerEvent) => {
      const length = Math.hypot(ev.clientX - last.x, ev.clientY - last.y)
      if (!length || samples.length >= 4096) return
      const steps = Math.ceil(length / 2)
      for (let i = 1; i <= steps && samples.length < 4096; i++) {
        const x = last.x + (ev.clientX - last.x) * i / steps
        const y = last.y + (ev.clientY - last.y) * i / steps
        const rect = this.host.canvas.getBoundingClientRect()
        const inside = x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
        samples.push({ distance: distance + length * i / steps, point: inside ? this.host.pickScan(x, y)?.point ?? null : null })
      }
      distance += length
      last = { x: ev.clientX, y: ev.clientY }
      path.push(`${last.x},${last.y}`)
      line.setAttribute('points', path.join(' '))
    }
    this.captureBridgePointer(e, move, (cancelled) => handlers.end(cancelled ? null : samples), () => overlay.remove())
    return true
  }

  private captureBridgePointer(e: PointerEvent, onMove: (ev: PointerEvent) => void, onEnd: (cancelled: boolean) => void, cleanup?: () => void): void {
    const canvas = this.host.canvas
    const move = (ev: PointerEvent) => {
      if (ev.pointerId === e.pointerId) onMove(ev)
    }
    const finish = (cancelled: boolean) => {
      this.cancelBridgeDrag()
      onEnd(cancelled)
      this.host.requestHover()
    }
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return
      move(ev)
      finish(false)
    }
    const cancel = (ev: PointerEvent) => {
      if (ev.pointerId === e.pointerId) finish(true)
    }
    const key = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopImmediatePropagation(); finish(true) }
    }
    this.bridgeDragCleanup = () => {
      this.bridgeDragCleanup = null
      cleanup?.()
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('keydown', key, true)
      canvas.removeEventListener('lostpointercapture', cancel)
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('keydown', key, true)
    canvas.addEventListener('lostpointercapture', cancel)
    canvas.setPointerCapture(e.pointerId)
  }

  private disposeCutCap(): void {
    if (!this.cutCap) return
    for (const child of this.cutCap.children as (THREE.Mesh | THREE.LineSegments)[]) {
      child.geometry.dispose()
      ;(child.material as THREE.Material).dispose()
    }
    this.host.partGroup.remove(this.cutCap)
    this.cutCap = null
  }
}

const scenes = new WeakMap<SceneManager, MeshScene>()

/** The workspace's part of a viewport — made on first use, one per viewport;
 *  none before there is a viewport. */
export function meshSceneOf(scene: SceneManager): MeshScene
export function meshSceneOf(scene: SceneManager | null): MeshScene | null
export function meshSceneOf(scene: SceneManager | null): MeshScene | null {
  if (!scene) return null
  let mesh = scenes.get(scene)
  if (!mesh) {
    mesh = new MeshScene(scene)
    scenes.set(scene, mesh)
  }
  return mesh
}
