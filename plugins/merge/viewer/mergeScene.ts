// SPDX-License-Identifier: AGPL-3.0-only
// The layers of a merge in the 3D viewport: each file a cloud of splats (or a
// mesh) in its own colour, held by a group at the layer's pose under the
// scan's group — so a pose is relative to the base as it is shown, and the
// base's alignment moves every layer with it. One layer of the SceneManager
// (src/viewer/sceneLayers.ts), added with SceneManager.addLayer.

import * as THREE from 'three'
import { acceleratedRaycast, computeBoundsTree } from 'three-mesh-bvh'
import type { SceneLayer, SceneLayerHost } from '../../../src/viewer/sceneLayers'
import type { PickHit } from '../../../src/viewer/SceneManager'
import { CloudLayer } from '../../../src/viewer/cloudLayer'
import { pickCloud } from '../../../src/viewer/cloudPick'
import { layerGizmo, type LayerGizmo } from '../../../src/viewer/layerGizmo'
import { PointGrid } from '../../../src/core/geometry/pointGrid'
import { cloneRigid, identityRigid, rigidCompose, rigidFromQuaternion, rigidToColumnMajor, type Rigid } from '../../../src/core/deviation/rigid'

/** The pick radius on screen, px — as the viewport's own cloud pick. */
const PICK_PIXELS = 3

export interface MergeGeometry {
  positions: Float32Array
  normals: Float32Array
  /** Triangles: a mesh layer. Absent: a cloud. */
  indices?: Uint32Array
  /** The cloud's point spacing. */
  spacing?: number
}

interface Entry {
  holder: THREE.Group
  pose: Rigid
  cloud: CloudLayer | null
  mesh: THREE.Mesh | null
  grid: PointGrid | null
  normals: Float32Array
  spacing: number
}

const scratch = new THREE.Matrix4()
const toLocal = new THREE.Matrix4()
const scratchVec = new THREE.Vector3()
// A mesh pick's corners, hit point, weights and triangle, reused per hit.
const triA = new THREE.Vector3(), triB = new THREE.Vector3(), triC = new THREE.Vector3()
const hitLocal = new THREE.Vector3(), bary = new THREE.Vector3()
const tri = new THREE.Triangle()
const ndc = new THREE.Vector2()

export class MergeScene implements SceneLayer {
  order = 20
  private readonly root = new THREE.Group()
  private readonly entries = new Map<string, Entry>()
  private gizmoTool: LayerGizmo | null = null
  private gizmoFor: string | null = null
  /** The mesh picks' own raycaster: the host's is the viewport's. */
  private readonly caster = new THREE.Raycaster()

  constructor(private readonly host: SceneLayerHost) {
    host.partGroup.add(this.root)
  }

  add(id: string, geom: MergeGeometry, color: string): void {
    this.remove(id)
    const holder = new THREE.Group()
    const entry: Entry = { holder, pose: identityRigid(), cloud: null, mesh: null, grid: null, normals: geom.normals, spacing: geom.spacing ?? 1 }
    if (geom.indices) {
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.BufferAttribute(geom.positions, 3))
      g.setAttribute('normal', new THREE.BufferAttribute(geom.normals, 3))
      g.setIndex(new THREE.BufferAttribute(geom.indices, 1))
      computeBoundsTree.call(g)
      const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: new THREE.Color(color), side: THREE.DoubleSide }))
      mesh.raycast = acceleratedRaycast
      entry.mesh = mesh
      holder.add(mesh)
    } else {
      const cloud = new CloudLayer(geom.positions, geom.normals, entry.spacing)
      // Tinted through everywhere: the splat shader paints an untinted point
      // the bare surface grey, not its vertex colour (regionTint.ts).
      cloud.setAttribute('tint', new THREE.BufferAttribute(new Float32Array(geom.positions.length / 3).fill(1), 1))
      entry.cloud = cloud
      holder.add(cloud.object)
    }
    this.entries.set(id, entry)
    this.root.add(holder)
    this.setColor(id, color)
    const planes = this.host.clipPlanes()
    if (planes) this.clipEntry(entry, planes)
  }

  setPose(id: string, pose: Rigid): void {
    const e = this.entries.get(id)
    if (!e) return
    e.pose = cloneRigid(pose)
    this.place(e)
  }

  private place(e: Entry): void {
    scratch.fromArray(rigidToColumnMajor(e.pose))
    scratch.decompose(e.holder.position, e.holder.quaternion, e.holder.scale)
    e.holder.updateMatrixWorld(true)
    this.host.invalidate()
  }

  setVisible(id: string, v: boolean): void {
    const e = this.entries.get(id)
    if (!e) return
    e.holder.visible = v
    this.host.invalidate()
  }

  setColor(id: string, c: string): void {
    const e = this.entries.get(id)
    if (!e) return
    const color = new THREE.Color(c)
    if (e.mesh) (e.mesh.material as THREE.MeshStandardMaterial).color.copy(color)
    if (e.cloud) {
      // The splat shader reads the vertex colour: one colour for every point.
      const n = e.cloud.object.geometry.getAttribute('position').count
      const rgb = new Float32Array(n * 3)
      for (let i = 0; i < n; i++) {
        rgb[3 * i] = color.r
        rgb[3 * i + 1] = color.g
        rgb[3 * i + 2] = color.b
      }
      e.cloud.setAttribute('color', new THREE.BufferAttribute(rgb, 3))
    }
    this.host.invalidate()
  }

  remove(id: string): void {
    const e = this.entries.get(id)
    if (!e) return
    if (this.gizmoFor === id) this.gizmo(null, () => {})
    this.root.remove(e.holder)
    e.cloud?.dispose()
    if (e.mesh) {
      e.mesh.geometry.disposeBoundsTree?.()
      e.mesh.geometry.dispose()
      ;(e.mesh.material as THREE.Material).dispose()
    }
    this.entries.delete(id)
    this.host.invalidate()
  }

  clear(): void {
    for (const id of [...this.entries.keys()]) this.remove(id)
  }

  /** The layer under a point of the canvas (NDC, y up), nearest the eye,
   *  among `ids` or all shown. The hit is in that layer's own frame. */
  pick(ndcX: number, ndcY: number, ids?: string[]): (PickHit & { layerId: string }) | null {
    const caster = this.caster
    caster.setFromCamera(ndc.set(ndcX, ndcY), this.host.camera())
    const ray = caster.ray.clone()
    const planes = this.host.clipPlanes() ?? []
    const world = scratchVec
    let best: (PickHit & { layerId: string }) | null = null
    let bestT = Infinity
    for (const [id, e] of this.entries) {
      if (ids && !ids.includes(id)) continue
      if (!e.holder.visible) continue
      e.holder.updateWorldMatrix(true, true)
      toLocal.copy(e.holder.matrixWorld).invert()
      let hit: PickHit | null = null
      if (e.cloud) {
        const local = ray.clone().applyMatrix4(toLocal)
        const radius = Math.max(PICK_PIXELS * this.host.worldPerPixel(), 1.5 * e.spacing)
        e.grid ??= new PointGrid(e.cloud.object.geometry.getAttribute('position').array as Float32Array, 2 * e.spacing)
        hit = pickCloud(e.grid, e.normals, local, radius, planes.map((p) => p.clone().applyMatrix4(toLocal)))
      } else if (e.mesh) {
        const found = caster.intersectObject(e.mesh, false).find((i) => i.face && !planes.some((p) => p.distanceToPoint(i.point) < 0))
        if (found?.face) {
          const f = found.face
          const pos = e.mesh.geometry.getAttribute('position') as THREE.BufferAttribute
          tri.set(triA.fromBufferAttribute(pos, f.a), triB.fromBufferAttribute(pos, f.b), triC.fromBufferAttribute(pos, f.c))
          const p = hitLocal.copy(found.point).applyMatrix4(toLocal)
          const w = bary
          tri.getBarycoord(p, w)
          hit = {
            vertices: [f.a, f.b, f.c],
            weights: [w.x, w.y, w.z],
            faceIndex: found.faceIndex ?? -1,
            point: [p.x, p.y, p.z],
            normal: [f.normal.x, f.normal.y, f.normal.z],
            clientX: 0,
            clientY: 0,
            ctrlKey: false,
          }
        }
      }
      if (!hit) continue
      const t = world.set(...hit.point).applyMatrix4(e.holder.matrixWorld).distanceTo(ray.origin)
      if (t < bestT) {
        bestT = t
        best = { ...hit, layerId: id }
      }
    }
    return best
  }

  /** The handle on a layer — null puts it away. `onChange` gets the pose,
   *  relative to the base as shown, at every step of a drag. */
  gizmo(id: string | null, onChange: (pose: Rigid) => void, mode: 'translate' | 'rotate' = 'translate'): void {
    const e = id === null ? null : this.entries.get(id)
    if (!e) {
      this.gizmoTool?.attach(null, () => {})
      this.gizmoFor = null
      return
    }
    this.gizmoTool ??= layerGizmo(this.host)
    this.gizmoFor = id
    this.gizmoTool.attach(e.holder, () => {
      const q = e.holder.quaternion
      const p = e.holder.position
      const pose = rigidFromQuaternion(q.w, q.x, q.y, q.z)
      pose.t.set([p.x, p.y, p.z])
      e.pose = pose
      onChange(cloneRigid(pose))
    }, mode)
  }

  // A transform baked into the base's vertices carries the layers with it:
  // pose' = T ∘ pose. (A display alignment moves partGroup and needs nothing.)
  partMoved(transform: Rigid): void {
    for (const e of this.entries.values()) {
      e.pose = rigidCompose(transform, e.pose)
      this.place(e)
    }
  }

  tick(): void {
    this.gizmoTool?.tick()
  }

  clippingChanged(planes: THREE.Plane[] | null): void {
    for (const e of this.entries.values()) this.clipEntry(e, planes)
  }

  private clipEntry(e: Entry, planes: THREE.Plane[] | null): void {
    e.cloud?.setClipPlanes(planes ?? [])
    if (e.mesh) {
      const m = e.mesh.material as THREE.Material
      m.clippingPlanes = planes
      m.needsUpdate = true
    }
  }

  dispose(): void {
    this.clear()
    this.gizmoTool?.dispose()
    this.gizmoTool = null
    this.root.removeFromParent()
  }
}
