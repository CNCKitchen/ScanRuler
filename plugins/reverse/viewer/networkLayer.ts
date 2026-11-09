// SPDX-License-Identifier: AGPL-3.0-only
// The Patch network's layer in the 3D viewport (PN4): the network's curves
// drawn on the scan — each the smooth curve fitted to its trace, a crease
// dashed — its nodes as dots and the patches' corners as squares, the grips
// between them, why a region was refused; and the patch being placed, its
// sides along the scan and its area shaded, from its first corner on. A
// layer of the SceneManager (src/viewer/sceneLayers.ts) ahead of the grips,
// the sketches and the elements, so that while the network's box is open a
// click on the scan is the network's.
//
// Draw, patch first, as QuickSurface has it: each click is a corner — on
// the scan, on a node, on a curve (split there) or on a grip (made a node);
// the sides follow the scan between them, and a click back on the first
// corner, Enter, a double click or a click of the middle button closes the
// patch, which is filled at once — shaded where it will be until its fit
// lands. Enter with two corners makes the line between them alone;
// Backspace takes the last corner back, Esc lets the patch go. An edge of
// one patch only, dragged, is copied out to where it is let go, and the
// patch between the two filled: the next patch of a strip, its new corners
// put on nodes within NODE_PX.
//
// A patch made is edited where it lies: a node or a grip is dragged along
// the scan; an edge two patches share is bent, a grip put in where it was
// pressed and dragged — an outer edge's drag makes the next patch, so a
// grip is put in it with Shift-click and dragged — and the patches with a
// moved corner keep their seeds in their middles. (Shift-drag is the
// camera's while the layer has the plain drag.) A click on a patch picks it,
// Delete takes the picked one out with the edges no other patch has; Shift-
// click on a curve puts a grip in, Delete takes out what is under the
// cursor, C makes the curve under it a crease, the wheel over a curve sets
// its strip's span count. A drag's moves go to the store once a frame,
// however many the pointer sends. Fill: a click in a closed region fills
// it, on a patch picks it, with Ctrl empties it. The creases the scan
// suggests (PN12) are drawn dashed in their own colour until taken or
// dismissed; a click on one takes it as a crease curve.
//
// The traces here are the viewport's own, on its copy of the scan: the
// worker traces the same points again for the build, and gets the same
// paths (scanPath.ts).

import * as THREE from 'three'
import { Line2 } from 'three/addons/lines/Line2.js'
import { LineGeometry } from 'three/addons/lines/LineGeometry.js'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import type { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js'
import { ScanPaths } from '../../../src/core/geometry/scanPath'
import type { Vec3 } from '../../../src/core/types'
import { SECTION_LINE_DEFAULT } from '../../../src/viewer/lineWidths'
import { LineWidthRegistry } from '../../../src/viewer/lineWidthRegistry'
import { pinLabel } from '../../../src/viewer/pinLabel'
import { sparingRays } from '../../../src/viewer/bvh'
import { modHeld } from '../../../src/ui/platform'
import type { SceneManager } from '../../../src/viewer/SceneManager'
import type { SceneLayer, SceneLayerHost } from '../../../src/viewer/sceneLayers'
import { type NetworkReport, PATCH_GRID } from '../core/networkBody'
import { type CurveTrace, fitProvisional, sampleCurve, SPANS_MAX, SPANS_MIN, traceCurve } from '../core/networkCurve'
import { suggestCreases } from '../core/networkCreases'
import { seedInside } from '../core/networkSeed'
import {
  acceptCreases,
  addEdgeCurve,
  addPatch,
  addSeed,
  commitPlacing,
  cornerPoint,
  dropPlacing,
  insertGrip,
  moveCell,
  moveGrip,
  moveNode,
  placeCorner,
  recordDrag,
  removeCurve,
  removeGrip,
  removeNode,
  removeReportedPatch,
  removeSeed,
  resetCentre,
  setCellSeeds,
  setStripSpans,
  setSuggested,
  toggleCrease,
  unplaceCorner,
} from '../state/reNetworkDraft'
import type { FeatureDraft } from '../state/reStore'
import type { EdgeInfo } from '../core/build'
import { reSceneOf } from './reScene'
import type { NetworkData, PlacedCorner } from '../state/reTypes'

type Draft = Extract<FeatureDraft, { kind: 'network' }>

/** How near the cursor a node, a grip or a curve has to be to be under it,
 *  px. */
const NODE_PX = 10
const GRIP_PX = 8
const CURVE_PX = 8
/** How far a press on a node or a grip moves before it is a drag, px: the
 *  viewport's own slack between a click and a turn (orthoViewport). */
const DRAG_SLACK_PX = 6
/** Two clicks this close in time and place are a double click. */
const DOUBLE_MS = 400
const DOUBLE_PX = 6
/** The samples a curve is drawn with, per span of its fit. */
const DRAW_PER_SPAN = 8
const CURVE_COLOR = '#f2a516'
const LIT_COLOR = '#ffffff'
const REFUSED_COLOR = '#e5484d'
const PICKED_COLOR = '#4fb3ff'
const SUGGESTED_COLOR = '#b794f6'
/** A suggested crease's samples between two read for the cursor. */
const SUGGESTED_STRIDE = 4
/** How strongly the patch being placed is shaded. */
const PREVIEW_OPACITY = 0.22
/** The sides between placed corners kept traced, at most. */
const SIDE_CACHE = 64

/** What lies under the cursor. */
export type NetworkHit =
  | { kind: 'node'; id: number }
  /** A corner of the patch being placed that is no node yet. */
  | { kind: 'placed'; index: number }
  /** A split cell's centre, by the feature's cell. */
  | { kind: 'centre'; cell: number }
  /** A built body's edge (PN11): a curve along it. */
  | { kind: 'bodyEdge'; body: number; edge: EdgeInfo }
  /** A crease suggested (PN12), by its index among those offered. */
  | { kind: 'suggested'; index: number }
  | { kind: 'grip'; curve: number; index: number }
  | { kind: 'curve'; curve: number; run: number; at: Vec3 }
  /** A patch of the last build, under the cursor away from its edges. */
  | { kind: 'patch'; patch: number; at: Vec3 }
  | { kind: 'scan'; at: Vec3 }

interface DrawnCurve {
  key: string
  trace: CurveTrace
  /** The curve as drawn: its fit, sampled. */
  points: Float32Array
  line: Line2
  geo: LineGeometry
  mat: LineMaterial
  letGo: () => void
}

/** A patch about to be made of an edge dragged out: its corners — the
 *  edge's two nodes, then the copies — the new edge's grips, and its four
 *  sides along the scan, round it in order. */
interface Extension {
  corners: PlacedCorner[]
  vias: (Vec3[] | undefined)[]
  sides: Float32Array[]
}

/** A point texture: a disc, or a square for a corner. */
function markTexture(square: boolean): THREE.CanvasTexture {
  const size = 32
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const g = canvas.getContext('2d')!
  g.fillStyle = '#1d2026'
  if (square) g.fillRect(2, 2, size - 4, size - 4)
  else {
    g.beginPath()
    g.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2)
    g.fill()
  }
  g.fillStyle = '#ffffff'
  if (square) g.fillRect(7, 7, size - 14, size - 14)
  else {
    g.beginPath()
    g.arc(size / 2, size / 2, size / 2 - 7, 0, Math.PI * 2)
    g.fill()
  }
  const t = new THREE.CanvasTexture(canvas)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

const same = (a: Vec3, b: Vec3) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2]

/** Several runs of points one after the other. */
function joined(parts: readonly ArrayLike<number>[]): Float32Array {
  const out = new Float32Array(parts.reduce((s, p) => s + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

export class NetworkLayer {
  private host: SceneLayerHost
  private scene: SceneManager
  private group = new THREE.Group()
  private fat = new LineWidthRegistry(SECTION_LINE_DEFAULT)
  private paths: ScanPaths | null = null
  private draft: Draft | null = null
  private report: NetworkReport | null = null
  /** Whether `report` is of the draft as it stands — see setDraft. */
  private reportCurrent = true
  private color = CURVE_COLOR
  private curves = new Map<number, DrawnCurve>()
  private dots: THREE.Points | null = null
  private squares: THREE.Points | null = null
  private grips: THREE.Points | null = null
  private dotTexture = markTexture(false)
  private squareTexture = markTexture(true)
  private extras: { object: THREE.Object3D; dispose: () => void }[] = []
  /** The patch being placed or dragged out: its sides, shading and corners. */
  private preview: { object: THREE.Object3D; dispose: () => void }[] = []
  /** The preview's materials, made once and kept: a material let go takes
   *  its shader program with it when no other holds one like it, and the
   *  next is compiled again — the dashed side back to the first corner was
   *  compiled anew at every move of the cursor. */
  private look: { line: LineMaterial; dash: LineMaterial; corner: THREE.PointsMaterial; shade: THREE.MeshBasicMaterial; letGo: () => void }
  /** Patches closed and not yet in a report: shaded where they will be, by
   *  how many cells the draft had with them, until the fit lands. */
  private waiting: { cells: number; since: NetworkReport | null; mesh: THREE.Mesh }[] = []
  /** The outline of the patch under the cursor. */
  private lit: { patch: number; line: Line2 } | null = null
  private sides = new Map<string, Float32Array>()
  private offered: { line: Line2; geo: LineGeometry; mat: LineMaterial; letGo: () => void }[] = []
  private hovered: NetworkHit | null = null
  private lastClick: { t: number; x: number; y: number } | null = null
  private dragging: { hit: NetworkHit; before: NetworkData } | null = null
  /** An edge being dragged out: the curve, where it was pressed, and where
   *  the cursor is on the scan now. */
  private extending: { curve: number; from: Vec3; to: Vec3 } | null = null
  private shiftDown = false
  /** Whether the plain left-drag is the layer's, not the camera's. */
  private claimed = false
  private removeLayer: () => void
  private stopWheel: () => void
  /** The bodies' colours, for a curve along a body's edge. */
  bodyColors = new Map<number, string>()
  /** Where an edit goes: the store's editNetwork. */
  onEdit: ((change: (d: Draft) => Draft) => void) | null = null

  constructor(scene: SceneManager) {
    this.scene = scene
    this.host = scene.layerHost()
    this.group.name = 'patch-network'
    this.host.partGroup.add(this.group)
    const line = this.material(LIT_COLOR, SECTION_LINE_DEFAULT + 1, false)
    const dash = this.material(LIT_COLOR, SECTION_LINE_DEFAULT + 1, true)
    this.look = {
      line: line.mat,
      dash: dash.mat,
      corner: new THREE.PointsMaterial({ size: 11, sizeAttenuation: false, map: this.squareTexture, transparent: true, depthTest: false, depthWrite: false, alphaTest: 0.2 }),
      shade: new THREE.MeshBasicMaterial({ color: new THREE.Color(this.color), transparent: true, opacity: PREVIEW_OPACITY, side: THREE.DoubleSide, depthTest: false, depthWrite: false }),
      letGo: () => (line.letGo(), dash.letGo()),
    }
    this.removeLayer = scene.addLayer(this.layer())
    const wheel = (e: WheelEvent) => this.wheel(e)
    this.host.canvas.addEventListener('wheel', wheel, { capture: true, passive: false })
    this.stopWheel = () => this.host.canvas.removeEventListener('wheel', wheel, { capture: true })
  }

  private layer(): SceneLayer {
    return {
      // Ahead of the grips (15), the sketches and the bodies: while the
      // network's box is open, a click on the scan is the network's.
      order: 14,
      covers: true,
      pointerDown: (e) => this.pointerDown(e),
      click: (x, y, additive) => this.click(x, y, additive),
      hover: (at, covered) => this.hover(at, covered),
      tick: (w, h) => {
        if (this.fat.setResolution(w, h)) this.host.invalidate()
      },
      lineWidthChanged: (px) => {
        if (this.fat.setLineWidth(px)) this.host.invalidate()
      },
      partMoved: () => {
        this.paths = null
        this.sides.clear()
        this.clearCurves()
      },
      scanReplaced: () => {
        this.paths = null
        this.sides.clear()
        this.clearCurves()
      },
      dispose: () => this.teardown(),
    }
  }

  /** The draft to draw, and the last build's report on it; null puts the
   *  layer away. `current`: the report is of the draft as it stands, not
   *  of one before a change whose build still runs. */
  setDraft(d: Draft | null, report: NetworkReport | null, color: string, current = true): void {
    const was = this.draft
    const reported = this.report
    this.draft = d
    this.report = report
    this.reportCurrent = current
    this.color = color
    if (!d) {
      this.clearAll()
      this.host.setCursor('')
      this.host.invalidate()
      return
    }
    if (!this.ensurePaths()) return
    this.settleWaiting(d, report)
    // The curves again only where the network changed; a corner placed
    // changes the patch being placed alone.
    if (!was || was.nodes !== d.nodes || was.curves !== d.curves || was.cells !== d.cells || was.picked !== d.picked || reported !== report) this.redraw()
    if (!was || was.suggested !== d.suggested) this.drawSuggested()
    this.drawPreview(this.hovered)
    this.host.invalidate()
  }

  /** The scan's creases found (PN12) and offered on the draft: how many.
   *  Over the viewport's own copy of the scan, on the main thread — a
   *  second or so on two million triangles. */
  suggest(): number {
    const paths = this.ensurePaths()
    if (!paths || !this.draft) return 0
    const found = suggestCreases(paths)
    const at = new Map(found.nodes.map((n) => [n.id, n.at]))
    const offered = found.curves.map((c) => ({ from: at.get(c.from)!, to: at.get(c.to)!, via: c.via, points: c.points, length: c.length, angle: c.angle }))
    this.edit((x) => setSuggested(x, offered))
    return offered.length
  }

  /** What is under the cursor now — for the keys. */
  hoveredHit(): NetworkHit | null {
    return this.hovered
  }

  /** The viewport's own copy of the scan, prepared for paths. */
  private ensurePaths(): ScanPaths | null {
    if (this.paths) return this.paths
    const positions = this.scene.scanPositions()
    const indices = this.scene.scanIndices()
    if (!positions || !indices) return null
    const paths = new ScanPaths(Float32Array.from(positions), indices)
    this.paths = paths
    // The search along the edges, where a side cannot be cut as a plane,
    // made ready while nothing is being dragged.
    setTimeout(() => {
      if (this.paths === paths) paths.prepareEdgeRoutes()
    }, 300)
    return paths
  }

  private nodeAt(id: number): Vec3 | null {
    return this.draft?.nodes.find((n) => n.id === id)?.at ?? null
  }

  // ---- drawing ------------------------------------------------------------

  private material(color: string, width: number, dashed: boolean): { mat: LineMaterial; letGo: () => void } {
    const mat = new LineMaterial({ color: new THREE.Color(color).getHex(), linewidth: width * this.fat.scale, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false, worldUnits: false, dashed, dashSize: 4, gapSize: 3, dashScale: 1 })
    if (dashed) mat.defines.USE_DASH = ''
    const letGo = this.fat.track(mat, width)
    return { mat, letGo }
  }

  private redraw(): void {
    const d = this.draft!
    const paths = this.paths!
    // The curves: traced and fitted where their points changed.
    const keep = new Set<number>()
    for (const c of d.curves) {
      const a = this.nodeAt(c.from)
      const b = this.nodeAt(c.to)
      if (!a || !b) continue
      keep.add(c.id)
      const key = JSON.stringify([a, c.via, b, c.crease === true])
      const had = this.curves.get(c.id)
      if (had && had.key === key) continue
      if (had) this.dropCurve(c.id)
      const trace = traceCurve(paths, [a, ...c.via, b])
      if (trace.points.length < 6) continue
      const fit = fitProvisional(trace, paths.edge)
      const points = Float32Array.from(sampleCurve(fit, fit.spans * DRAW_PER_SPAN + 1))
      const geo = new LineGeometry()
      geo.setPositions(points)
      const { mat, letGo } = this.material(c.along ? (this.bodyColors.get(c.along.body) ?? this.color) : this.color, SECTION_LINE_DEFAULT + 1, c.crease === true)
      const line = new Line2(geo, mat)
      line.computeLineDistances()
      line.renderOrder = 12
      line.userData.curve = c.id
      this.group.add(line)
      this.curves.set(c.id, { key, trace, points, line, geo, mat, letGo })
    }
    for (const id of [...this.curves.keys()]) if (!keep.has(id)) this.dropCurve(id)
    this.dressCurves()
    // The nodes, the corners of the patches, and the grips.
    const corners = new Set([...(this.report?.patches ?? []).flatMap((p) => p.corners), ...d.cells.flatMap((c) => c.corners ?? [])])
    this.setPoints('dots', d.nodes.filter((n) => !corners.has(n.id)).map((n) => n.at), this.dotTexture, 10)
    this.setPoints('squares', d.nodes.filter((n) => corners.has(n.id)).map((n) => n.at), this.squareTexture, 11)
    this.setPoints('grips', d.curves.flatMap((c) => c.via), this.dotTexture, 7)
    // The refusals by their seeds, the picked patch's outline.
    for (const e of this.extras) {
      this.group.remove(e.object)
      e.dispose()
    }
    this.extras = []
    const report = this.report
    // A split cell's spokes, thin, and its centre, a square to drag.
    for (const spoke of report?.spokes ?? []) {
      const geo = new LineGeometry()
      geo.setPositions(spoke.points)
      const { mat, letGo } = this.material(this.color, SECTION_LINE_DEFAULT, true)
      const line = new Line2(geo, mat)
      line.computeLineDistances()
      line.renderOrder = 12
      this.group.add(line)
      this.extras.push({ object: line, dispose: () => (letGo(), geo.dispose(), mat.dispose()) })
    }
    if (report && report.centres.length > 0) {
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.Float32BufferAttribute(report.centres.flatMap((c) => [...c.at]), 3))
      const mat = new THREE.PointsMaterial({ size: 11, sizeAttenuation: false, map: this.squareTexture, transparent: true, depthTest: false, depthWrite: false, alphaTest: 0.2 })
      const points = new THREE.Points(geo, mat)
      points.renderOrder = 14
      this.group.add(points)
      this.extras.push({ object: points, dispose: () => (geo.dispose(), mat.dispose()) })
    }
    d.cells.forEach((cell, i) => {
      const outcome = report?.cells[i]
      const refused = outcome && 'refused' in outcome ? outcome.refused : null
      if (refused) {
        const label = pinLabel('element-label', 'Not filled', refused, REFUSED_COLOR) as CSS2DObject
        label.position.set(...cell.seed)
        label.element.dataset.test = 'network-refusal'
        this.group.add(label)
        this.extras.push({ object: label, dispose: () => label.element.remove() })
      }
    })
    if (report && d.picked !== null && report.patches[d.picked]) {
      const geo = new LineGeometry()
      geo.setPositions(ringOf(report.patches[d.picked].grid))
      const { mat, letGo } = this.material(PICKED_COLOR, SECTION_LINE_DEFAULT + 2, false)
      const line = new Line2(geo, mat)
      line.renderOrder = 13
      this.group.add(line)
      this.extras.push({ object: line, dispose: () => (letGo(), geo.dispose(), mat.dispose()) })
    }
    this.drawLitPatch(true)
  }

  /** The patch under the cursor outlined, lit, while a click would pick it
   *  — drawn again for another patch, or `fresh` for a new report. */
  private drawLitPatch(fresh = false): void {
    const now = this.hovered?.kind === 'patch' && this.hovered.patch !== this.draft?.picked ? this.hovered.patch : null
    if (!fresh && (this.lit?.patch ?? null) === now) return
    if (this.lit) {
      this.group.remove(this.lit.line)
      this.lit.line.geometry.dispose()
      this.lit = null
    }
    const h = this.hovered
    const patch = h?.kind === 'patch' ? this.report?.patches[h.patch] : undefined
    if (!patch || h?.kind !== 'patch' || h.patch === this.draft?.picked) return
    const geo = new LineGeometry()
    geo.setPositions(ringOf(patch.grid))
    const line = new Line2(geo, this.look.line)
    line.renderOrder = 13
    this.group.add(line)
    this.lit = { patch: h.patch, line }
  }

  /** The creases offered, dashed in their colour; the one under the
   *  cursor lit. */
  private drawSuggested(): void {
    for (const o of this.offered) {
      this.group.remove(o.line)
      o.letGo()
      o.geo.dispose()
      o.mat.dispose()
    }
    this.offered = []
    for (const s of this.draft?.suggested ?? []) {
      const geo = new LineGeometry()
      geo.setPositions(s.points)
      const { mat, letGo } = this.material(SUGGESTED_COLOR, SECTION_LINE_DEFAULT + 1, true)
      const line = new Line2(geo, mat)
      line.computeLineDistances()
      line.renderOrder = 12
      this.group.add(line)
      this.offered.push({ line, geo, mat, letGo })
    }
    this.dressCurves()
  }

  private setPoints(which: 'dots' | 'squares' | 'grips', at: readonly Vec3[], map: THREE.Texture, size: number): void {
    const had = this[which]
    if (had) {
      this.group.remove(had)
      had.geometry.dispose()
      ;(had.material as THREE.Material).dispose()
      this[which] = null
    }
    if (at.length === 0) return
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(at.flatMap((p) => [...p]), 3))
    const mat = new THREE.PointsMaterial({ size, sizeAttenuation: false, map, transparent: true, depthTest: false, depthWrite: false, alphaTest: 0.2 })
    const points = new THREE.Points(geo, mat)
    points.renderOrder = 14
    this.group.add(points)
    this[which] = points
  }

  /** Each curve in its look: lit under the cursor, or while it is dragged
   *  out; a crease dashed. */
  private dressCurves(): void {
    const h = this.hovered
    const lit = this.extending ? this.extending.curve : h?.kind === 'curve' ? h.curve : h?.kind === 'grip' ? h.curve : null
    for (const [id, c] of this.curves) {
      const along = this.draft?.curves.find((x) => x.id === id)?.along
      c.mat.color.set(id === lit ? LIT_COLOR : along ? (this.bodyColors.get(along.body) ?? this.color) : this.color)
      c.mat.linewidth = (SECTION_LINE_DEFAULT + (id === lit ? 2 : 1)) * this.fat.scale
    }
    const offered = h?.kind === 'suggested' ? h.index : null
    this.offered.forEach((o, i) => {
      o.mat.color.set(i === offered ? LIT_COLOR : SUGGESTED_COLOR)
      o.mat.linewidth = (SECTION_LINE_DEFAULT + (i === offered ? 2 : 1)) * this.fat.scale
    })
  }

  /** The scan's path from one point to another, through grips: the ones
   *  between corners placed kept, the ones to the cursor made afresh. */
  private sideBetween(points: readonly Vec3[], keep: boolean): Float32Array | null {
    const key = JSON.stringify(points)
    const had = this.sides.get(key)
    if (had) return had
    const trace = traceCurve(this.paths!, points)
    if (trace.points.length < 6) return null
    if (keep) {
      if (this.sides.size >= SIDE_CACHE) this.sides.clear()
      this.sides.set(key, trace.points)
    }
    return trace.points
  }

  /** A closed loop through points, along the scan side by side. */
  private loopThrough(points: readonly Vec3[]): Float32Array | null {
    const parts: Float32Array[] = []
    for (let i = 0; i < points.length; i++) {
      const side = this.sideBetween([points[i], points[(i + 1) % points.length]], true)
      if (side) parts.push(side)
    }
    return parts.length > 0 ? joined(parts) : null
  }

  /** The patch being placed — its corners, its sides along the scan from
   *  corner to corner and on to the cursor, the side back to the first
   *  dashed — or the edge being dragged out, and its area shaded. */
  private drawPreview(hit: NetworkHit | null): void {
    this.clearPreview()
    const d = this.draft
    if (!d || !this.paths || d.tool !== 'draw') return
    const lines: { points: Float32Array; dashed: boolean }[] = []
    let corners: Vec3[] = []
    if (this.extending) {
      const q = this.extension()
      if (!q) return
      q.sides.forEach((s, i) => lines.push({ points: s, dashed: i === 0 }))
      corners = q.corners.map((c) => cornerPoint(d, c)).filter((p): p is Vec3 => p !== null)
    } else if (d.placing) {
      const placed = d.placing.corners.map((c) => cornerPoint(d, c)).filter((p): p is Vec3 => p !== null)
      if (placed.length === 0) return
      corners = placed
      const first = d.placing.corners[0]
      const closing = (hit?.kind === 'placed' && hit.index === 0) || (hit?.kind === 'node' && 'node' in first && first.node === hit.id)
      const cursor = hit && !closing ? this.hitPoint(hit) : null
      const points = cursor && !same(cursor, placed[placed.length - 1]) ? [...placed, cursor] : placed
      for (let i = 0; i + 1 < points.length; i++) {
        const side = this.sideBetween([points[i], points[i + 1]], i + 1 < placed.length)
        if (side) lines.push({ points: side, dashed: false })
      }
      if (points.length >= 3) {
        const back = this.sideBetween([points[points.length - 1], points[0]], false)
        if (back) lines.push({ points: back, dashed: !closing })
      }
    } else return
    for (const l of lines) {
      const geo = new LineGeometry()
      geo.setPositions(l.points)
      const line = new Line2(geo, l.dashed ? this.look.dash : this.look.line)
      if (l.dashed) line.computeLineDistances()
      line.renderOrder = 13
      this.group.add(line)
      this.preview.push({ object: line, dispose: () => geo.dispose() })
    }
    if (lines.length >= 3) {
      const mesh = this.shade(joined(lines.map((l) => l.points)))
      if (mesh) this.preview.push({ object: mesh, dispose: () => mesh.geometry.dispose() })
    }
    if (corners.length > 0) {
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.Float32BufferAttribute(corners.flatMap((p) => [...p]), 3))
      const points = new THREE.Points(geo, this.look.corner)
      points.renderOrder = 15
      this.group.add(points)
      this.preview.push({ object: points, dispose: () => geo.dispose() })
    }
  }

  /** A loop's area shaded: a fan from its middle, see-through, over the
   *  scan — what the patch will cover. Added to the layer; null for a loop
   *  of fewer than three points. */
  private shade(outline: Float32Array): THREE.Mesh | null {
    const m = outline.length / 3
    if (m < 3) return null
    const c: Vec3 = [0, 0, 0]
    for (let i = 0; i < m; i++) for (let k = 0; k < 3; k++) c[k] += outline[i * 3 + k] / m
    const positions = new Float32Array(3 + outline.length)
    positions.set(c, 0)
    positions.set(outline, 3)
    const index: number[] = []
    for (let i = 0; i < m; i++) index.push(0, 1 + i, 1 + ((i + 1) % m))
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geo.setIndex(index)
    this.look.shade.color.set(this.color)
    const mesh = new THREE.Mesh(geo, this.look.shade)
    mesh.renderOrder = 11
    this.group.add(mesh)
    return mesh
  }

  /** A patch just closed, shaded until a report has it (see waiting). */
  private wait(outline: Float32Array | null, cells: number): void {
    const mesh = outline ? this.shade(outline) : null
    if (mesh) this.waiting.push({ cells, since: this.report, mesh })
  }

  /** The patches waiting that a report since now has, or an undo took
   *  away. */
  private settleWaiting(d: Draft | null, report: NetworkReport | null): void {
    this.waiting = this.waiting.filter((w) => {
      if (d && d.cells.length >= w.cells && !(report && report !== w.since && report.cells.length >= w.cells)) return true
      this.group.remove(w.mesh)
      w.mesh.geometry.dispose()
      return false
    })
  }

  private clearPreview(): void {
    for (const p of this.preview) {
      this.group.remove(p.object)
      p.dispose()
    }
    this.preview = []
  }

  private hitPoint(hit: NetworkHit): Vec3 | null {
    if (hit.kind === 'bodyEdge' || hit.kind === 'suggested') return null
    if (hit.kind === 'node') return this.nodeAt(hit.id)
    if (hit.kind === 'placed') {
      const c = this.draft?.placing?.corners[hit.index]
      return c && this.draft ? cornerPoint(this.draft, c) : null
    }
    if (hit.kind === 'centre') return this.report?.centres.find((c) => c.cell === hit.cell)?.at ?? null
    if (hit.kind === 'grip') return this.draft?.curves.find((c) => c.id === hit.curve)?.via[hit.index] ?? null
    return hit.at
  }

  // ---- placing a patch ---------------------------------------------------------

  /** A corner of the patch for what was clicked. */
  private cornerOf(hit: NetworkHit): PlacedCorner | null {
    if (hit.kind === 'node') return { node: hit.id }
    if (hit.kind === 'grip') {
      const at = this.draft?.curves.find((c) => c.id === hit.curve)?.via[hit.index]
      return at ? { curve: hit.curve, grip: hit.index, at: [...at] as Vec3 } : null
    }
    if (hit.kind === 'curve') return { curve: hit.curve, at: hit.at }
    if (hit.kind === 'scan') return { at: hit.at }
    return null
  }

  /** The patch being placed closed and made, filled in its middle. */
  private closePlacing(): void {
    const d = this.draft
    if (!d?.placing || !this.paths) return
    const corners = d.placing.corners.map((c) => cornerPoint(d, c)).filter((p): p is Vec3 => p !== null)
    if (corners.length < 3) return
    const loop = this.loopThrough(corners)
    const seed = loop ? seedInside(this.paths, loop) : null
    this.edit((x) => this.waitFor(loop, x, commitPlacing(x, { closed: true, seed })))
  }

  /** An edit that may have made a patch: if it did, its outline shaded
   *  until its fit lands. */
  private waitFor(outline: Float32Array | null, before: Draft, after: Draft): Draft {
    if (after.cells.length > before.cells.length) this.wait(outline, after.cells.length)
    return after
  }

  /** The corners placed made a line from the first to the last. */
  private finishOpen(): void {
    this.edit((x) => commitPlacing(x, { closed: false, seed: null }))
  }

  /** The patch being placed finished — Enter, a double click, the middle
   *  button (the workspace's confirm, keyboard.ts): closed with three
   *  corners or more, a line with two, let go with one. */
  finishPlacing(): void {
    const count = this.draft?.placing?.corners.length ?? 0
    if (count >= 3) this.closePlacing()
    else if (count === 2) this.finishOpen()
    else if (count === 1) this.edit(dropPlacing)
  }

  /** A patch of the last report deleted, with the edges no other patch
   *  has; false where there is none. */
  private deletePatch(patch: number | null): boolean {
    const report = this.report
    // A report of the draft before a change still building numbers its
    // patches as they were: deleting by it takes the wrong one (issue 34).
    if (patch === null || !this.reportCurrent || !report?.patches[patch]) return false
    this.edit((x) => removeReportedPatch(x, report, patch))
    this.hovered = null
    return true
  }

  /** The curves two patches share, by the last build. */
  private sharedCurves(): Set<number> {
    const count = new Map<number, number>()
    for (const p of this.report?.patches ?? []) for (const side of p.sides) for (const id of side) count.set(id, (count.get(id) ?? 0) + 1)
    return new Set([...count].filter(([, n]) => n >= 2).map(([id]) => id))
  }

  /** The patch the edge being dragged out makes: the edge copied by how far
   *  the cursor moved on the scan, each copied end on a node within
   *  NODE_PX of it, its grips copied too. */
  private extension(): Extension | null {
    const e = this.extending
    const d = this.draft
    const paths = this.paths
    if (!e || !d || !paths) return null
    const c = d.curves.find((x) => x.id === e.curve)
    const a = c ? this.nodeAt(c.from) : null
    const b = c ? this.nodeAt(c.to) : null
    if (!c || !a || !b) return null
    const off: Vec3 = [e.to[0] - e.from[0], e.to[1] - e.from[1], e.to[2] - e.from[2]]
    const moved = (p: Vec3): Vec3 => {
      const q: Vec3 = [p[0] + off[0], p[1] + off[1], p[2] + off[2]]
      return paths.closestInside(q)?.point ?? q
    }
    const screen = this.projector()
    const copy = (p: Vec3): PlacedCorner => {
      const q = moved(p)
      const s = screen(q)
      let best: { id: number; dist: number } | null = null
      for (const n of d.nodes) {
        if (n.id === c.from || n.id === c.to) continue
        const t = screen(n.at)
        const dist = Math.hypot(t.x - s.x, t.y - s.y)
        if (dist <= NODE_PX && (!best || dist < best.dist)) best = { id: n.id, dist }
      }
      return best ? { node: best.id } : { at: q }
    }
    const bNew = copy(b)
    const aNew = copy(a)
    const pb = cornerPoint(d, bNew)!
    const pa = cornerPoint(d, aNew)!
    const via = c.via.map(moved).reverse()
    const own = this.curves.get(c.id)?.trace.points ?? this.sideBetween([a, ...c.via, b], false)
    const sides = [own, this.sideBetween([b, pb], false), this.sideBetween([pb, ...via, pa], false), this.sideBetween([pa, a], false)]
    if (sides.some((s) => !s)) return null
    return { corners: [{ node: c.from }, { node: c.to }, bNew, aNew], vias: [undefined, undefined, via, undefined], sides: sides as Float32Array[] }
  }

  /** New seeds for the patches placed by their corners with one of these
   *  among them: each in its middle again. */
  private seedsAfterMove(d: NetworkData, nodes: ReadonlySet<number>): { index: number; seed: Vec3 }[] {
    const paths = this.paths
    if (!paths || nodes.size === 0) return []
    const at = new Map(d.nodes.map((n) => [n.id, n.at]))
    const out: { index: number; seed: Vec3 }[] = []
    d.cells.forEach((cell, index) => {
      if (!cell.corners || !cell.corners.some((id) => nodes.has(id))) return
      const corners = cell.corners.map((id) => at.get(id)).filter((p): p is Vec3 => p !== undefined)
      if (corners.length < 3) return
      const loop = this.loopThrough(corners)
      const seed = loop ? seedInside(paths, loop) : null
      if (seed) out.push({ index, seed })
    })
    return out
  }

  // ---- picking --------------------------------------------------------------

  /** Where points of the part are drawn, in client pixels: the camera, the
   *  part's place and the canvas read once — a pick projects every point of
   *  every curve's trace, thousands of them, and a canvas's box read for
   *  each was most of it. */
  private projector(): (p: ArrayLike<number>, i?: number) => { x: number; y: number } {
    const camera = this.host.camera()
    const e = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(this.host.partGroup.matrixWorld).elements
    const r = this.host.canvasRect()
    return (p, i = 0) => {
      const x = p[i], y = p[i + 1], z = p[i + 2]
      const w = e[3] * x + e[7] * y + e[11] * z + e[15]
      const nx = (e[0] * x + e[4] * y + e[8] * z + e[12]) / w
      const ny = (e[1] * x + e[5] * y + e[9] * z + e[13]) / w
      return { x: r.left + ((nx + 1) / 2) * r.width, y: r.top + ((1 - ny) / 2) * r.height }
    }
  }

  /** What is under a client point: a node or a corner placed, a grip, a
   *  centre, a curve, a crease offered, a body's edge, a patch, the scan. */
  hitAt(x: number, y: number): NetworkHit | null {
    const d = this.draft
    if (!d) return null
    const screen = this.projector()
    let best: NetworkHit | null = null
    let bestD = NODE_PX
    for (const n of d.nodes) {
      const s = screen(n.at)
      const dist = Math.hypot(s.x - x, s.y - y)
      if (dist <= bestD) [bestD, best] = [dist, { kind: 'node', id: n.id }]
    }
    d.placing?.corners.forEach((c, index) => {
      if ('node' in c) return
      const s = screen(c.at)
      const dist = Math.hypot(s.x - x, s.y - y)
      if (dist <= bestD) [bestD, best] = [dist, { kind: 'placed', index }]
    })
    if (best) return best
    bestD = GRIP_PX
    for (const c of d.curves) {
      c.via.forEach((p, index) => {
        const s = screen(p)
        const dist = Math.hypot(s.x - x, s.y - y)
        if (dist <= bestD) [bestD, best] = [dist, { kind: 'grip', curve: c.id, index }]
      })
    }
    if (best) return best
    for (const c of this.report?.centres ?? []) {
      const sc = screen(c.at)
      const dist = Math.hypot(sc.x - x, sc.y - y)
      if (dist <= bestD) [bestD, best] = [dist, { kind: 'centre', cell: c.cell }]
    }
    if (best) return best
    // A curve: the nearest of its trace's points, on the scan, and the run
    // between grips it is on.
    bestD = CURVE_PX
    for (const [id, c] of this.curves) {
      const t = c.trace
      const n = t.points.length / 3
      for (let i = 0; i < n; i++) {
        const s = screen(t.points, i * 3)
        const dist = Math.hypot(s.x - x, s.y - y)
        if (dist > bestD) continue
        bestD = dist
        let run = 0
        while (run + 1 < t.grips.length && t.grips[run + 1] <= i) run++
        best = { kind: 'curve', curve: id, run: Math.min(run, Math.max(0, t.grips.length - 2)), at: [t.points[i * 3], t.points[i * 3 + 1], t.points[i * 3 + 2]] }
      }
    }
    if (best) return best
    // A crease offered, while no patch is being placed: taken on a click.
    // Its samples are half an edge apart — tens of thousands over a scan's
    // creases — so it is read by the chords between every fourth.
    if (d.tool === 'draw' && !d.placing) {
      ;(d.suggested ?? []).forEach((s, index) => {
        const last = s.points.length / 3 - 1
        let a = screen(s.points, 0)
        for (let i = 0; i < last; ) {
          i = Math.min(i + SUGGESTED_STRIDE, last)
          const b = screen(s.points, i * 3)
          const dist = segmentDistance(x, y, a, b)
          if (dist <= bestD) [bestD, best] = [dist, { kind: 'suggested', index }]
          a = b
        }
      })
    }
    if (best) return best
    // A body's edge, while no patch is being placed: a curve along it.
    if (d.tool === 'draw' && !d.placing) {
      const item = reSceneOf(this.scene).bodyItemAt(x, y)
      if (item?.kind === 'edge') return { kind: 'bodyEdge', body: item.hit.bodyId, edge: item.hit.edge }
    }
    const scan = this.host.pickScan(x, y)
    if (!scan) return null
    // A patch, away from its edges: picked by a click while none is being
    // placed — a corner there would lie on a patch made already.
    if (d.tool === 'draw' && !d.placing && this.report) {
      const patch = patchUnder(this.report, scan.point)
      if (patch !== null) return { kind: 'patch', patch, at: scan.point }
    }
    return { kind: 'scan', at: scan.point }
  }

  private hover(at: { x: number; y: number } | null, covered: boolean): boolean {
    if (!this.draft || this.dragging) return this.dragging !== null
    const hit = at && !covered ? this.hitAt(at.x, at.y) : null
    const changed = JSON.stringify(hit) !== JSON.stringify(this.hovered)
    this.hovered = hit
    // Over what a press drags — a corner, a point, a centre, an edge, to
    // bend it or drag it out — the left-drag is the layer's, not the
    // camera's.
    const drags = hit !== null && (hit.kind === 'node' || hit.kind === 'grip' || hit.kind === 'centre' || hit.kind === 'curve')
    this.claim(this.draft.tool === 'draw' && !this.draft.placing && drags)
    if (changed) {
      this.dressCurves()
      this.drawLitPatch()
      if (this.draft.placing) this.drawPreview(hit)
      const lit = hit && hit.kind !== 'scan'
      this.host.setCursor(this.draft.tool === 'draw' ? (drags && !this.draft.placing ? 'move' : lit ? 'pointer' : 'crosshair') : 'cell')
      this.host.invalidate()
    }
    return hit !== null && hit.kind !== 'scan'
  }

  private edit(change: (d: Draft) => Draft): void {
    this.onEdit?.(change)
  }

  /** The plain left-drag taken from the camera, or given back. */
  private claim(on: boolean): void {
    if (on === this.claimed) return
    this.claimed = on
    this.host.claimDrag(on)
  }

  private click(x: number, y: number, additive: boolean): boolean {
    const d = this.draft
    if (!d) return false
    const hit = this.hitAt(x, y)
    if (!hit) return false
    const now = performance.now()
    const double = this.lastClick !== null && now - this.lastClick.t < DOUBLE_MS && Math.hypot(x - this.lastClick.x, y - this.lastClick.y) < DOUBLE_PX
    this.lastClick = { t: now, x, y }
    if (hit.kind === 'suggested') {
      this.edit((x2) => acceptCreases(x2, [hit.index]))
      this.hovered = null
      return true
    }
    if (hit.kind === 'centre') return true
    if (hit.kind === 'bodyEdge') {
      // The face beside the edge the curve's patch meets: the first of its
      // two, until the box says otherwise.
      const face = hit.edge.faces.map((h) => reSceneOf(this.scene).bodyPicks.faceOf(hit.body, h)).find((f) => f !== null) ?? null
      this.edit((x2) => addEdgeCurve(x2, hit.body, hit.edge.fingerprint, hit.edge.ends, face ? face.fingerprint : null))
      return true
    }
    if (d.tool === 'fill') {
      if (hit.kind !== 'scan' && hit.kind !== 'curve' && hit.kind !== 'patch') return true
      this.fillClick(hit.at, additive)
      return true
    }
    const placing = d.placing
    if (!placing) {
      if (hit.kind === 'patch') {
        this.edit((x2) => ({ ...x2, picked: x2.picked === hit.patch ? null : hit.patch }))
        return true
      }
      if (hit.kind === 'curve' && this.shiftDown) {
        this.edit((x2) => insertGrip(x2, hit.curve, hit.run, hit.at))
        return true
      }
      const corner = this.cornerOf(hit)
      if (corner) this.edit((x2) => placeCorner(x2, corner))
      return true
    }
    const count = placing.corners.length
    // A double click closes the patch at the corner its first click put
    // down; with two corners, it makes the line between them.
    if (double) {
      if (count >= 2) this.finishPlacing()
      return true
    }
    const first = placing.corners[0]
    if (count >= 3 && ((hit.kind === 'placed' && hit.index === 0) || (hit.kind === 'node' && 'node' in first && first.node === hit.id))) {
      this.closePlacing()
      return true
    }
    if (hit.kind === 'placed') return true
    if (hit.kind === 'node' && placing.corners.some((c) => 'node' in c && c.node === hit.id)) return true
    const corner = this.cornerOf(hit)
    if (corner) this.edit((x2) => placeCorner(x2, corner))
    return true
  }

  /** A click in Fill: on a patch, pick it (Ctrl: empty it); elsewhere,
   *  fill the region. */
  private fillClick(at: Vec3, empty: boolean): void {
    const report = this.report
    const patch = report ? patchUnder(report, at) : null
    if (patch !== null && report) {
      const seed = report.cells.findIndex((c) => 'patches' in c && c.patches.includes(patch))
      if (empty && seed >= 0) this.edit((x) => removeSeed(x, seed))
      else this.edit((x) => ({ ...x, picked: x.picked === patch ? null : patch }))
      return
    }
    if (!empty) this.edit((x) => addSeed(x, at))
  }

  private pointerDown(e: PointerEvent): boolean {
    // The click that follows a press is told Ctrl, not Shift: kept here.
    this.shiftDown = e.shiftKey
    const d = this.draft
    if (!d || d.tool !== 'draw' || d.placing || e.button !== 0) return false
    const pressed = this.hitAt(e.clientX, e.clientY)
    if (!pressed) return false
    if (pressed.kind !== 'node' && pressed.kind !== 'grip' && pressed.kind !== 'centre' && pressed.kind !== 'curve') return false
    // Shift on an edge is the click's — a grip put in — or the camera's.
    if (pressed.kind === 'curve' && e.shiftKey) return false
    // An edge of one patch, or of none, is dragged out into the next; one
    // two patches share is bent, a grip put in where it was pressed.
    const bend = pressed.kind === 'curve' && this.sharedCurves().has(pressed.curve)
    const before: NetworkData = { nodes: d.nodes, curves: d.curves, cells: d.cells, spans: d.spans, fit: d.fit }
    let hit: NetworkHit = pressed
    this.dragging = { hit, before }
    let moved = false
    const from = { x: e.clientX, y: e.clientY }
    // The moves taken once a frame: the pointer sends more than are drawn,
    // and each goes through the store and the box.
    let latest: PointerEvent | null = null
    let frame = 0
    const step = () => {
      frame = 0
      const ev = latest
      latest = null
      if (!ev) return
      // A frame's test, like the hover: while the scan's tree is still on
      // its way it meets nothing, and what is dragged stays where it was —
      // see bvh.ts sparingRays.
      const on = sparingRays(() => this.host.pickScan(ev.clientX, ev.clientY))
      if (!on) return
      const at = on.point
      const h = hit
      if (h.kind === 'curve' && bend) {
        // The grip the bend drags, put in where the edge was pressed — no
        // step of its own: the drag's one undo takes it back too.
        const index = Math.max(0, Math.min(this.draft?.curves.find((c) => c.id === h.curve)?.via.length ?? 0, h.run))
        this.edit((x) => moveGrip(insertGrip(x, h.curve, index, h.at, false), h.curve, index, at, false))
        hit = { kind: 'grip', curve: h.curve, index }
        this.dragging = { hit, before }
      } else if (h.kind === 'node') this.edit((x) => moveNode(x, h.id, at, false))
      else if (h.kind === 'centre') this.edit((x) => moveCell(x, h.cell, 'centre', at, false))
      else if (h.kind === 'grip') this.edit((x) => moveGrip(x, h.curve, h.index, at, false))
      else if (h.kind === 'curve') {
        this.extending = { curve: h.curve, from: h.at, to: at }
        this.dressCurves()
        this.drawPreview(null)
        this.host.invalidate()
      }
    }
    const move = (ev: PointerEvent) => {
      // A drag once past the viewport's own click slack.
      if (!moved && Math.abs(ev.clientX - from.x) + Math.abs(ev.clientY - from.y) <= DRAG_SLACK_PX) return
      moved = true
      latest = ev
      if (!frame) frame = requestAnimationFrame(step)
    }
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      // The last move, if no frame took it yet.
      if (frame) {
        cancelAnimationFrame(frame)
        step()
      }
      this.dragging = null
      const h = hit
      if (h.kind === 'curve') {
        const q = moved ? this.extension() : null
        this.extending = null
        this.dressCurves()
        if (q && this.paths) {
          const outline = joined(q.sides)
          const seed = seedInside(this.paths, outline)
          this.edit((x) => this.waitFor(outline, x, addPatch(x, q.corners, { closed: true, seed, vias: q.vias })))
        } else if (!moved) this.click(ev.clientX, ev.clientY, modHeld(ev))
        this.drawPreview(null)
        this.host.invalidate()
        return
      }
      if (moved) {
        // The patches with the node — or the grip's curve's ends — among
        // their corners keep their seeds in their middles.
        const curve = h.kind === 'grip' ? this.draft?.curves.find((c) => c.id === h.curve) : undefined
        const touched = new Set(h.kind === 'node' ? [h.id] : curve ? [curve.from, curve.to] : [])
        this.edit((x) => {
          const r = recordDrag(x, before)
          return setCellSeeds(r, this.seedsAfterMove(r, touched))
        })
      }
      // The press was taken, so the viewport makes no click of it: one that
      // never moved is a click on what it pressed — a corner there.
      else this.click(ev.clientX, ev.clientY, modHeld(ev))
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return true
  }

  /** The wheel over a curve: its strip's span count, one up or down. */
  private wheel(e: WheelEvent): void {
    const d = this.draft
    const h = this.hovered
    if (!d || !h || (h.kind !== 'curve' && h.kind !== 'grip')) return
    const strip = this.report?.strips.find((s) => s.curves.includes(h.curve))
    if (!strip) return
    e.preventDefault()
    e.stopImmediatePropagation()
    const next = Math.max(SPANS_MIN, Math.min(SPANS_MAX, strip.spans + (e.deltaY < 0 ? 1 : -1)))
    if (next !== strip.spans) this.edit((x) => setStripSpans(x, strip.curves, next))
  }

  /** A key with the network's box open: true when it was the network's. */
  key(e: KeyboardEvent): boolean {
    const d = this.draft
    if (!d) return false
    const h = this.hovered
    if (d.placing) {
      if (e.key === 'Escape') this.edit(dropPlacing)
      else if (e.key === 'Enter') this.finishPlacing()
      else if (e.key === 'Backspace') this.edit(unplaceCorner)
      else if (e.key !== 'Delete') return false
      return true
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      // What is under the cursor — or, away from the network's points and
      // edges, the patch picked, else the patch under the cursor.
      if (h?.kind === 'grip') this.edit((x) => removeGrip(x, h.curve, h.index))
      else if (h?.kind === 'node') this.edit((x) => removeNode(x, h.id))
      else if (h?.kind === 'curve') this.edit((x) => removeCurve(x, h.curve))
      else if (h?.kind === 'centre') this.edit((x) => resetCentre(x, h.cell))
      else if (d.picked !== null) return this.deletePatch(d.picked)
      else if (h?.kind === 'patch') return this.deletePatch(h.patch)
      else return false
      this.hovered = null
      return true
    }
    if (e.key === 'Escape' && d.picked !== null) {
      this.edit((x) => ({ ...x, picked: null }))
      return true
    }
    if (e.key.toLowerCase() === 'c' && !e.ctrlKey && !e.metaKey && h && (h.kind === 'curve' || h.kind === 'grip')) {
      this.edit((x) => toggleCrease(x, h.curve))
      return true
    }
    return false
  }

  // ---- letting go ------------------------------------------------------------

  private dropCurve(id: number): void {
    const c = this.curves.get(id)
    if (!c) return
    this.group.remove(c.line)
    c.letGo()
    c.geo.dispose()
    c.mat.dispose()
    this.curves.delete(id)
  }

  private clearCurves(): void {
    for (const id of [...this.curves.keys()]) this.dropCurve(id)
  }

  private clearAll(): void {
    this.clearCurves()
    for (const which of ['dots', 'squares', 'grips'] as const) this.setPoints(which, [], this.dotTexture, 1)
    for (const e of this.extras) {
      this.group.remove(e.object)
      e.dispose()
    }
    this.extras = []
    for (const o of this.offered) {
      this.group.remove(o.line)
      o.letGo()
      o.geo.dispose()
      o.mat.dispose()
    }
    this.offered = []
    this.hovered = null
    this.extending = null
    this.claim(false)
    this.clearPreview()
    this.settleWaiting(null, null)
    this.drawLitPatch()
  }

  private teardown(): void {
    this.clearAll()
    this.stopWheel()
    this.host.partGroup.remove(this.group)
    this.dotTexture.dispose()
    this.squareTexture.dispose()
    this.look.letGo()
    for (const m of [this.look.line, this.look.dash, this.look.corner, this.look.shade]) m.dispose()
  }

  dispose(): void {
    this.removeLayer()
  }
}

/** How far a screen point is from the segment a–b, px. */
function segmentDistance(x: number, y: number, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const l2 = dx * dx + dy * dy
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / l2)) : 0
  return Math.hypot(a.x + t * dx - x, a.y + t * dy - y)
}

/** The patch a point of the scan lies on, by the report's samples of
 *  each: of the patches whose sampled surface has the point over one of its
 *  triangles — inside its rim, not beside it — the nearest, if no further
 *  off it than a tenth of its size; or null. */
export function patchUnder(report: NetworkReport, at: Vec3): number | null {
  const n = PATCH_GRID
  let best: number | null = null
  let bestD = Infinity
  report.patches.forEach((p, i) => {
    const g = p.grid
    const lo = [Infinity, Infinity, Infinity]
    const hi = [-Infinity, -Infinity, -Infinity]
    for (let k = 0; k < g.length; k++) {
      lo[k % 3] = Math.min(lo[k % 3], g[k])
      hi[k % 3] = Math.max(hi[k % 3], g[k])
    }
    const reach = 0.1 * Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2])
    if ([0, 1, 2].some((k) => at[k] < lo[k] - reach || at[k] > hi[k] + reach)) return
    const corner = (r: number, c: number): Vec3 => [g[(r * n + c) * 3], g[(r * n + c) * 3 + 1], g[(r * n + c) * 3 + 2]]
    for (let r = 0; r + 1 < n; r++) {
      for (let c = 0; c + 1 < n; c++) {
        for (const [a, b, e] of [[corner(r, c), corner(r + 1, c), corner(r + 1, c + 1)], [corner(r, c), corner(r + 1, c + 1), corner(r, c + 1)]]) {
          const off = overTriangle(at, a, b, e)
          if (off !== null && off <= reach && off < bestD) [bestD, best] = [off, i]
        }
      }
    }
  })
  return best
}

/** How far p is off the triangle abc's plane, where it lies over the
 *  triangle — its foot inside it — or null. */
function overTriangle(p: Vec3, a: Vec3, b: Vec3, c: Vec3): number | null {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
  const w = [p[0] - a[0], p[1] - a[1], p[2] - a[2]]
  const uu = u[0] * u[0] + u[1] * u[1] + u[2] * u[2]
  const uv = u[0] * v[0] + u[1] * v[1] + u[2] * v[2]
  const vv = v[0] * v[0] + v[1] * v[1] + v[2] * v[2]
  const wu = w[0] * u[0] + w[1] * u[1] + w[2] * u[2]
  const wv = w[0] * v[0] + w[1] * v[1] + w[2] * v[2]
  const det = uu * vv - uv * uv
  if (!(det > 0)) return null
  const s = (vv * wu - uv * wv) / det
  const t = (uu * wv - uv * wu) / det
  if (s < 0 || t < 0 || s + t > 1) return null
  const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
  return Math.abs(w[0] * n[0] + w[1] * n[1] + w[2] * n[2]) / Math.sqrt(det)
}

/** A patch's sampled grid round its rim, as a closed polyline. */
function ringOf(g: Float32Array): number[] {
  const n = PATCH_GRID
  const ring: number[] = []
  const at = (i: number, j: number) => ring.push(g[(i * n + j) * 3], g[(i * n + j) * 3 + 1], g[(i * n + j) * 3 + 2])
  for (let i = 0; i < n; i++) at(i, 0)
  for (let j = 1; j < n; j++) at(n - 1, j)
  for (let i = n - 2; i >= 0; i--) at(i, n - 1)
  for (let j = n - 2; j >= 0; j--) at(0, j)
  return ring
}

const layers = new WeakMap<SceneManager, NetworkLayer>()

/** The viewport's network layer — made on first use, one per viewport. */
export function networkLayerOf(scene: SceneManager): NetworkLayer {
  let layer = layers.get(scene)
  if (!layer) {
    layer = new NetworkLayer(scene)
    layers.set(scene, layer)
  }
  return layer
}

/** The layer of a viewport, if one was made. */
export function networkLayerIf(scene: SceneManager | null): NetworkLayer | null {
  return scene ? (layers.get(scene) ?? null) : null
}
