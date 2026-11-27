// SPDX-License-Identifier: AGPL-3.0-only
/** The view cube, drawn into the bottom-right corner of the same canvas: a
 *  cube in the part's world axes, its faces named for the standard views,
 *  with the X, Y and Z axes along three of its edges. Each face, edge and
 *  corner is a button — it lights under the cursor, and a click turns the
 *  camera to look at it (see SceneManager.viewCubeTo). The arrows, Home and
 *  the menu around it are the DOM's (ui/ViewCube.tsx), laid over the same
 *  corner and sized from the same units: VIEW_CUBE_HALF. */
import * as THREE from 'three'
import { CUBE_BAND, regionAt, regionKey, type CubeRegion } from './viewCubeMath'

export type GizmoAxis = 'x' | 'y' | 'z'

/** The colour each axis is drawn in — here, and wherever else the scan's
 *  axes are shown, like the coordinate planes a section is offered. */
export const AXIS_COLORS: Record<GizmoAxis, number> = { x: 0xe5534b, y: 0x2e7d46, z: 0x1877c0 }

/** Half-extent of the corner, in cube units (the cube's half-side is 1):
 *  room around the cube for the axes reaching past it, and for the arrows
 *  and buttons the DOM lays over it. */
export const VIEW_CUBE_HALF = 2.5

/** Gap between the corner and the two canvas edges it sits in. */
export const VIEW_CUBE_PAD = 14

/** How big the corner the cube takes is, for a canvas of this size.
 *  Exported because the fit-to-view button parks directly above it, and a
 *  button that guessed would either overlap the cube or float away from it. */
export function viewCubeSize(w: number, h: number): number {
  return Math.min(150, Math.max(104, Math.min(w, h) * 0.2))
}

/** The faces: the region each is, the screen-up its name reads along (as
 *  the standard view of it stands), and the name. */
const FACES: { region: CubeRegion; up: THREE.Vector3; name: string }[] = [
  { region: [0, -1, 0], up: new THREE.Vector3(0, 0, 1), name: 'FRONT' },
  { region: [0, 1, 0], up: new THREE.Vector3(0, 0, 1), name: 'REAR' },
  { region: [1, 0, 0], up: new THREE.Vector3(0, 0, 1), name: 'RIGHT' },
  { region: [-1, 0, 0], up: new THREE.Vector3(0, 0, 1), name: 'LEFT' },
  { region: [0, 0, 1], up: new THREE.Vector3(0, 1, 0), name: 'TOP' },
  { region: [0, 0, -1], up: new THREE.Vector3(0, -1, 0), name: 'BOTTOM' },
]

const FACE_COLOR = 0xe4e7eb
const HOVER_COLOR = 0x4d9df0
const EDGE_COLOR = 0x6f7882

/** A face of the cube with its name on it, drawn once into a texture. */
function faceTexture(name: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 256
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, 256, 256)
  ctx.fillStyle = '#4a525b'
  // Long names shrink to stay inside the face's middle.
  const size = Math.min(58, 1180 / name.length / 1.1)
  ctx.font = `600 ${size}px Barlow, system-ui, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(name, 128, 132)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 4
  return texture
}

/** Canvas-textured letter for an axis tip. */
function axisLabel(text: string, color: number): THREE.Sprite {
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 64
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#' + color.toString(16).padStart(6, '0')
  ctx.font = 'bold 50px Barlow, system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, 32, 34)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  // Depth-tested, as the arrows are: the letter of an axis running behind
  // the cube goes behind it too, rather than reading as a mark on a face.
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false }))
  sprite.scale.setScalar(0.62)
  sprite.renderOrder = 3
  return sprite
}

export class ViewCube {
  private scene = new THREE.Scene()
  private camera = new THREE.OrthographicCamera(-VIEW_CUBE_HALF, VIEW_CUBE_HALF, VIEW_CUBE_HALF, -VIEW_CUBE_HALF, 0.1, 20)
  private disposables: { dispose(): void }[] = []
  /** Each face's material and outward normal, for the shading. */
  private faces: { material: THREE.MeshBasicMaterial; normal: THREE.Vector3 }[] = []
  /** The patches the hover lights: nine on each face, an edge's on two
   *  faces and a corner's on three, keyed by their region. */
  private patches: { key: string; region: CubeRegion; mesh: THREE.Mesh; material: THREE.MeshBasicMaterial }[] = []
  private hovered: string | null = null
  private raycaster = new THREE.Raycaster()
  /** Where the cube was last drawn, in canvas pixels from the top-left, so a
   *  pointer can be tested against it. Empty until the first frame. */
  private drawn = { x: 0, y: 0, size: 0 }
  private tmp = new THREE.Vector3()

  constructor() {
    const plane = new THREE.PlaneGeometry(2, 2)
    this.disposables.push(plane)
    for (const face of FACES) {
      const normal = new THREE.Vector3(...face.region)
      const right = new THREE.Vector3().crossVectors(face.up, normal)
      // Local x across the face as it reads, y up it, z out of the cube.
      const basis = new THREE.Matrix4().makeBasis(right, face.up, normal)
      const texture = faceTexture(face.name)
      const material = new THREE.MeshBasicMaterial({ map: texture, color: FACE_COLOR, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 })
      this.disposables.push(texture, material)
      const mesh = new THREE.Mesh(plane, material)
      mesh.quaternion.setFromRotationMatrix(basis)
      mesh.position.copy(normal)
      this.scene.add(mesh)
      this.faces.push({ material, normal })

      // The 3×3 patches: the rim bands and the middle.
      const inner = 1 - CUBE_BAND
      const spans: [number, number][] = [
        [-1, -inner],
        [-inner, inner],
        [inner, 1],
      ]
      for (const [x0, x1] of spans) {
        for (const [y0, y1] of spans) {
          const geo = new THREE.PlaneGeometry(x1 - x0, y1 - y0)
          const material = new THREE.MeshBasicMaterial({ color: HOVER_COLOR, transparent: true, opacity: 0, depthWrite: false })
          this.disposables.push(geo, material)
          const patch = new THREE.Mesh(geo, material)
          patch.quaternion.copy(mesh.quaternion)
          const mid = new THREE.Vector3((x0 + x1) / 2, (y0 + y1) / 2, 0).applyMatrix4(basis)
          patch.position.copy(normal).add(mid)
          patch.renderOrder = 1
          this.scene.add(patch)
          const region = regionAt(patch.position)
          this.patches.push({ key: regionKey(region), region, mesh: patch, material })
        }
      }
    }

    const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(2, 2, 2))
    const edgeMaterial = new THREE.LineBasicMaterial({ color: EDGE_COLOR })
    this.disposables.push(edges, edgeMaterial)
    this.scene.add(new THREE.LineSegments(edges, edgeMaterial))

    // The axes, from the cube's left-front-bottom corner along its edges and
    // on past it, as CAD draws them: the cube is the part's world frame.
    const origin = new THREE.Vector3(-1, -1, -1)
    const length = 2.6
    const shaft = new THREE.CylinderGeometry(0.035, 0.035, length, 8)
    shaft.translate(0, length / 2, 0)
    const head = new THREE.ConeGeometry(0.1, 0.28, 12)
    head.translate(0, length + 0.1, 0)
    this.disposables.push(shaft, head)
    const yAxis = new THREE.Vector3(0, 1, 0)
    for (const [axis, dir, text] of [
      ['x', new THREE.Vector3(1, 0, 0), 'X'],
      ['y', new THREE.Vector3(0, 1, 0), 'Y'],
      ['z', new THREE.Vector3(0, 0, 1), 'Z'],
    ] as const) {
      const color = AXIS_COLORS[axis]
      const material = new THREE.MeshBasicMaterial({ color })
      this.disposables.push(material)
      const q = new THREE.Quaternion().setFromUnitVectors(yAxis, dir)
      for (const geo of [shaft, head]) {
        const part = new THREE.Mesh(geo, material)
        part.quaternion.copy(q)
        part.position.copy(origin)
        part.renderOrder = 2
        this.scene.add(part)
      }
      const label = axisLabel(text, color)
      label.position.copy(origin).addScaledVector(dir, length + 0.42)
      this.scene.add(label)
      this.disposables.push(label.material, label.material.map!)
    }
  }

  /** The corner the cube takes, in canvas pixels from the top-left: what a
   *  pointer is tested against, and what the DOM controls are laid over. */
  corner(): { x: number; y: number; size: number } {
    return this.drawn
  }

  /** The region of the cube under a canvas point (pixels from the canvas's
   *  top-left), or null. Tested against the last drawn frame: the cube
   *  shares the main camera's orientation, and that is where it was. */
  hitTest(px: number, py: number): CubeRegion | null {
    const { x, y, size } = this.drawn
    if (size === 0 || px < x || py < y || px > x + size || py > y + size) return null
    const ndc = new THREE.Vector2(((px - x) / size) * 2 - 1, -(((py - y) / size) * 2 - 1))
    this.camera.updateMatrixWorld()
    this.raycaster.setFromCamera(ndc, this.camera)
    const hit = this.raycaster.intersectObjects(
      this.patches.map((p) => p.mesh),
      false,
    )[0]
    if (!hit) return null
    return this.patches.find((p) => p.mesh === hit.object)?.region ?? null
  }

  /** Light one region, or none. Returns whether anything changed, so the
   *  owner knows to redraw. */
  setHovered(region: CubeRegion | null): boolean {
    const key = region ? regionKey(region) : null
    if (key === this.hovered) return false
    this.hovered = key
    for (const p of this.patches) p.material.opacity = p.key === key ? 0.55 : 0
    return true
  }

  /** Draw the cube into the bottom-right corner of the given canvas,
   *  sharing the main camera's orientation so it reads as the part's world
   *  axes. Returns the size of the corner it took. */
  render(renderer: THREE.WebGLRenderer, mainCamera: THREE.Camera, target: THREE.Vector3, w: number, h: number): number {
    const size = viewCubeSize(w, h)
    const pad = VIEW_CUBE_PAD
    const toCamera = this.tmp.subVectors(mainCamera.position, target).normalize()
    this.camera.position.copy(toCamera).multiplyScalar(8)
    this.camera.quaternion.copy(mainCamera.quaternion)

    // Shaded by how squarely each face meets the eye, lit a little from
    // above, so the cube reads as a solid whichever way it is turned.
    const light = new THREE.Vector3(0.25, 0.55, 1).normalize().applyQuaternion(mainCamera.quaternion)
    for (const f of this.faces) {
      const shade = 0.72 + 0.28 * Math.max(0, f.normal.dot(light))
      f.material.color.setHex(FACE_COLOR).multiplyScalar(shade)
    }

    this.drawn = { x: w - size - pad, y: h - size - pad, size }

    renderer.autoClear = false
    renderer.setViewport(w - size - pad, pad, size, size)
    renderer.setScissor(w - size - pad, pad, size, size)
    renderer.setScissorTest(true)
    renderer.clearDepth()
    renderer.render(this.scene, this.camera)
    renderer.setScissorTest(false)
    renderer.autoClear = true
    return size
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose()
  }
}
