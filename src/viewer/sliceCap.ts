// SPDX-License-Identifier: AGPL-3.0-only
// The cap that closes a part where a cut opens it — see
// SceneManager.setSlicePlane and setSectionView.

import * as THREE from 'three'
import { closedShells, type ClosedShells } from '../core/geometry/closedShells'
import { CAPPED_TRIANGLES } from './clipRaycast'
import { hatch } from './hatch'
import { applyFinish, setSurfaceColor, type ViewTheme } from './viewThemes'

/** The colours the section view fills a cut face with: matte tones well
 *  apart from the surfaces' — the CAD convention, a cut face reads as cut
 *  material — a different one for each part, so where two parts are cut
 *  their faces read as two. See CAP_SLOT for whose is whose. No red: red
 *  on a part says something is wrong there. Filled flat: a cut face is one
 *  plane, which lighting adds nothing to, and lit it turns near white seen
 *  face on. */
export const CUT_COLORS: readonly number[] = [
  0xbe7b4d, // clay
  0x5b8db8, // steel blue
  0x7aa25c, // moss
  0x5566b0, // indigo
  0x8d6fc0, // violet
  0xc9a83c, // ochre
  0x4fb3a5, // teal
  0xb0699e, // magenta
]

/** Each cap's place in the draw order: the scan's first, the reference's
 *  next, and a layer's parts from `layers` on — see SliceCap. */
export const CAP_SLOT = { scan: 0, reference: 1, layers: 2 } as const

/** The cut colour of the part in a slot. */
export function cutColor(slot: number): number {
  return CUT_COLORS[slot % CUT_COLORS.length]
}

/** Before everything else in the scene: the stencil is clean then, and a
 *  cap's sheet is in the depth buffer before the part's inside behind it. */
const FIRST_CAP_ORDER = -1000

/** Which of a part's triangles lie in closed shells — the only ones a cap
 *  can close — and, when that is some of them but not all, their index. */
export interface ClosedPart {
  /** 1 for each triangle of a closed shell. */
  closed: Uint8Array
  /** How many there are, of how many. */
  count: number
  total: number
  /** The closed triangles' corners, when not every triangle is closed. */
  index: Uint32Array | null
}

/** Kept by the attribute that says how the triangles are made — the index,
 *  or the positions of a soup — which is replaced whenever they are, and
 *  outlives a rigid move of the vertices, which closes nothing and opens
 *  nothing. */
const closedCache = new WeakMap<object, ClosedPart>()

/** The closed shells of a part's geometry — see core/geometry/closedShells.
 *  Found here, on the main thread, only when nothing primed them (see
 *  primeClosedPart). */
export function closedPartOf(geometry: THREE.BufferGeometry): ClosedPart {
  const index = geometry.getIndex()
  const position = geometry.getAttribute('position')
  const key = index ?? position
  const known = closedCache.get(key)
  if (known) return known
  const part = partOf(closedShells(position.array as Float32Array, index ? index.array : null), index)
  closedCache.set(key, part)
  return part
}

/**
 * Keep closed shells found elsewhere as this geometry's — the mesh worker's,
 * a flag for each vertex (see closedVertices) — so the first cut of a part
 * loaded does not search it on the main thread. A triangle is read off its
 * first corner, through the index as it stands now. A part's tree from the
 * worker is indirect and leaves the index alone (see bvh.ts treeOffThread),
 * but one built here as a part is laid out again — a resplit, an edit —
 * reorders its triangles; neither ever moves a vertex. False,
 * and nothing kept, when the count of flags is not this geometry's count
 * of vertices. That alone does not prove the flags are this geometry's —
 * a replacement can have as many — so the caller also checks that the
 * part and its index are the ones the flags were asked for.
 */
export function primeClosedPart(geometry: THREE.BufferGeometry, vertices: Uint8Array): boolean {
  const index = geometry.getIndex()
  const position = geometry.getAttribute('position')
  if (vertices.length !== position.count) return false
  const key = index ?? position
  if (closedCache.has(key)) return true
  const total = Math.floor((index ? index.count : position.count) / 3)
  const closed = new Uint8Array(total)
  let count = 0
  for (let t = 0; t < total; t++) {
    if (vertices[index ? index.getX(3 * t) : 3 * t] !== 1) continue
    closed[t] = 1
    count++
  }
  closedCache.set(key, partOf({ closed, count }, index))
  return true
}

/** The closed shells of a part with the index of their corners, when they
 *  are not all of it. */
function partOf(shells: ClosedShells, index: THREE.BufferAttribute | null): ClosedPart {
  const total = shells.closed.length
  let subset: Uint32Array | null = null
  if (shells.count > 0 && shells.count < total) {
    subset = new Uint32Array(shells.count * 3)
    let k = 0
    for (let t = 0; t < total; t++) {
      if (shells.closed[t] !== 1) continue
      for (let c = 0; c < 3; c++) subset[k++] = index ? index.getX(3 * t + c) : 3 * t + c
    }
  }
  return { closed: shells.closed, count: shells.count, total, index: subset }
}

export interface SliceCapOptions {
  /** Its place in the draw order — see CAP_SLOT. */
  slot: number
  /** The fill: a colour, lit like the surfaces or — `flat` — unlit (a lit
   *  cap seen face on comes out near white, which neither reads as cut
   *  material nor has a line read against it); null for a shade under the
   *  theme's surface, lit. */
  color: number | null
  flat?: boolean
  theme: ViewTheme
  /** The closed shells, when the cap is to close those alone and leave the
   *  part's open shells open; without, the whole part is counted. */
  closed?: ClosedPart
  /** Drawn over the caps before it where they meet, rather than fighting
   *  them for the pixels: a part lying inside others, whose cut face lies
   *  on theirs. */
  over?: boolean
  /** Hatched (see hatch.ts), to be told from the plain caps round it. */
  hatch?: boolean
}

/**
 * A part closed where a cut opens it, so the section reads as a solid and
 * not as a shell looked into: the standard stencil cap. The part's back
 * faces on the kept side count the stencil up and its front faces count it
 * down, so inside the solid — where the eye has passed through one more
 * back face than front — the count is not zero; a sheet on the cut plane is
 * drawn where it is not, and writes depth, so the shell's inside behind it
 * stays hidden.
 *
 * It hangs off the part it closes, so it moves with it and is hidden with
 * it; its passes run in its slot's turn and clear the stencil after, so each
 * part cut by the plane closes its own cut. A move of the plane — a write to
 * the Plane the clipped materials hold — moves the clip at once; place puts
 * the sheet back on it. Nothing of it can be picked: a click on the cut
 * face meets nothing (see clipRaycast).
 */
export class SliceCap {
  private back: THREE.Mesh
  private front: THREE.Mesh
  private sheet: THREE.Mesh
  private stencilGeometry: THREE.BufferGeometry | null = null
  private materials: THREE.Material[] = []
  private pose = new THREE.Matrix4()

  constructor(
    readonly target: THREE.Mesh,
    private planes: THREE.Plane[],
    sheetGeometry: THREE.PlaneGeometry,
    opts: SliceCapOptions,
  ) {
    let geometry = target.geometry as THREE.BufferGeometry
    if (opts.closed?.index) {
      // The closed shells alone, over the part's own vertices.
      geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', target.geometry.getAttribute('position'))
      geometry.setIndex(new THREE.BufferAttribute(opts.closed.index, 1))
      geometry.boundingSphere = target.geometry.boundingSphere
      this.stencilGeometry = geometry
    }
    const order = FIRST_CAP_ORDER + 2 * opts.slot
    const stencilMaterial = (side: THREE.Side, op: THREE.StencilOp) => {
      const m = new THREE.MeshBasicMaterial({ side, depthWrite: false, depthTest: false, colorWrite: false })
      m.stencilWrite = true
      m.stencilFunc = THREE.AlwaysStencilFunc
      m.stencilFail = op
      m.stencilZFail = op
      m.stencilZPass = op
      m.clippingPlanes = planes
      this.materials.push(m)
      return m
    }
    this.back = new THREE.Mesh(geometry, stencilMaterial(THREE.BackSide, THREE.IncrementWrapStencilOp))
    this.front = new THREE.Mesh(geometry, stencilMaterial(THREE.FrontSide, THREE.DecrementWrapStencilOp))

    let material: THREE.MeshStandardMaterial | THREE.MeshBasicMaterial
    if (opts.color !== null && opts.flat) material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, color: opts.color })
    else {
      material = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide })
      if (opts.color !== null) material.color.setHex(opts.color)
      else {
        setSurfaceColor(material.color, opts.theme)
        // A shade under the surface: a cut face is not the skin of the part.
        material.color.multiplyScalar(0.82)
      }
      applyFinish(material, opts.theme)
    }
    if (opts.hatch) hatch(material)
    if (opts.over) {
      material.polygonOffset = true
      material.polygonOffsetFactor = -1
      material.polygonOffsetUnits = -4
    }
    material.stencilWrite = true
    material.stencilRef = 0
    material.stencilFunc = THREE.NotEqualStencilFunc
    material.stencilFail = THREE.ReplaceStencilOp
    material.stencilZFail = THREE.ReplaceStencilOp
    material.stencilZPass = THREE.ReplaceStencilOp
    this.materials.push(material)
    this.sheet = new THREE.Mesh(sheetGeometry, material)
    this.sheet.matrixAutoUpdate = false
    // The next cap counts from zero.
    this.sheet.onAfterRender = (renderer) => renderer.clearStencil()

    this.back.renderOrder = order
    this.front.renderOrder = order
    this.sheet.renderOrder = order + 1
    for (const mesh of [this.back, this.front, this.sheet]) {
      mesh.raycast = () => {}
      target.add(mesh)
    }
    if (opts.closed) target.userData[CAPPED_TRIANGLES] = opts.closed.closed
  }

  /** Lay the sheet on the plane as it now stands, centred where `centre`
   *  (world) falls on it and `half` millimetres to each side — wide enough
   *  to cross the whole part. */
  place(centre: THREE.Vector3, half: number): void {
    const plane = this.planes[0]
    if (!plane) return
    const at = plane.projectPoint(centre, new THREE.Vector3())
    const turn = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), plane.normal)
    this.pose.compose(at, turn, new THREE.Vector3(2 * half, 2 * half, 1))
    this.target.updateWorldMatrix(true, false)
    this.sheet.matrix.copy(this.target.matrixWorld).invert().multiply(this.pose)
    this.sheet.matrixWorldNeedsUpdate = true
  }

  dispose(): void {
    for (const mesh of [this.back, this.front, this.sheet]) this.target.remove(mesh)
    delete this.target.userData[CAPPED_TRIANGLES]
    for (const m of this.materials) m.dispose()
    if (this.stencilGeometry) {
      // The positions are the part's, and stay on the GPU for it: only the
      // index is this cap's to let go.
      this.stencilGeometry.deleteAttribute('position')
      this.stencilGeometry.dispose()
    }
  }
}

/** A part of a layer's for the section view to close: its mesh, its place
 *  in the draw order (from CAP_SLOT.layers on) and its cut colour — and
 *  whether its cap is drawn over those before it, and hatched (see
 *  SliceCapOptions). */
export interface CapPart {
  mesh: THREE.Mesh
  slot: number
  color: number
  over?: boolean
  hatch?: boolean
}

/**
 * The caps on a layer's parts while the section view cuts them — see
 * SceneLayer.clippingChanged: one on each part that is drawn solid and has
 * closed shells, kept while it stays so and moved with the plane, let go
 * when the part goes, turns see-through or the cut is taken away. A layer
 * hands it its parts whenever the cut, the parts or their look change.
 */
export class CapSet {
  private held = new Map<THREE.Mesh, { cap: SliceCap; planes: THREE.Plane[]; geometry: THREE.BufferGeometry; index: THREE.BufferAttribute | null; slot: number; color: number; over: boolean; hatch: boolean; theme: ViewTheme }>()
  private sheet = new THREE.PlaneGeometry(1, 1)

  /** Close each of `parts` where it is closed while `planes` cut — the
   *  section view's — or none, with null. */
  update(planes: THREE.Plane[] | null, parts: readonly CapPart[], theme: ViewTheme): void {
    const wanted = new Set<THREE.Mesh>()
    for (const part of planes ? parts : []) {
      // A part drawn in several materials is as solid as its first.
      const material = [part.mesh.material].flat()[0] as THREE.Material | undefined
      if (!material || material.transparent || !material.visible) continue
      const geometry = part.mesh.geometry as THREE.BufferGeometry
      const closed = closedPartOf(geometry)
      if (closed.count === 0) continue
      wanted.add(part.mesh)
      let h = this.held.get(part.mesh)
      const same =
        h &&
        h.planes === planes &&
        h.geometry === geometry &&
        h.index === geometry.getIndex() &&
        h.slot === part.slot &&
        h.color === part.color &&
        h.over === Boolean(part.over) &&
        h.hatch === Boolean(part.hatch) &&
        h.theme === theme
      if (h && !same) {
        h.cap.dispose()
        h = undefined
      }
      if (!h) {
        const cap = new SliceCap(part.mesh, planes!, this.sheet, { slot: part.slot, color: part.color, flat: true, theme, closed, over: part.over, hatch: part.hatch })
        h = { cap, planes: planes!, geometry, index: geometry.getIndex(), slot: part.slot, color: part.color, over: Boolean(part.over), hatch: Boolean(part.hatch), theme }
        this.held.set(part.mesh, h)
      }
      if (!geometry.boundingBox) geometry.computeBoundingBox()
      part.mesh.updateWorldMatrix(true, false)
      const box = geometry.boundingBox!.clone().applyMatrix4(part.mesh.matrixWorld)
      h.cap.place(box.getCenter(new THREE.Vector3()), (box.min.distanceTo(box.max) / 2) * 1.3)
    }
    for (const [mesh, h] of this.held) {
      if (wanted.has(mesh)) continue
      h.cap.dispose()
      this.held.delete(mesh)
    }
  }

  dispose(): void {
    for (const h of this.held.values()) h.cap.dispose()
    this.held.clear()
    this.sheet.dispose()
  }
}
