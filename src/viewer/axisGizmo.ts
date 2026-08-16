// SPDX-License-Identifier: AGPL-3.0-only
/** Orientation gizmo, drawn into a corner viewport of the same canvas. */
import * as THREE from 'three'

const GIZMO_AXES: [THREE.Vector3, number, string][] = [
  [new THREE.Vector3(1, 0, 0), 0xe5534b, 'X'],
  [new THREE.Vector3(0, 1, 0), 0x2e7d46, 'Y'],
  [new THREE.Vector3(0, 0, 1), 0x1877c0, 'Z'],
]

/** Canvas-textured letter for an axis tip. */
function axisLabel(text: string, color: number): THREE.Sprite {
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 64
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#' + color.toString(16).padStart(6, '0')
  ctx.font = 'bold 46px Barlow, system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, 32, 34)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false }),
  )
  sprite.scale.setScalar(0.6)
  return sprite
}

export class AxisGizmo {
  private scene = new THREE.Scene()
  private camera = new THREE.OrthographicCamera(-1.75, 1.75, 1.75, -1.75, 0.1, 12)
  private disposables: { dispose(): void }[] = []

  constructor() {
    const shaft = new THREE.CylinderGeometry(0.035, 0.035, 0.72, 8)
    shaft.translate(0, 0.36, 0)
    const head = new THREE.ConeGeometry(0.1, 0.26, 12)
    head.translate(0, 0.85, 0)
    this.disposables.push(shaft, head)

    const y = new THREE.Vector3(0, 1, 0)
    for (const [dir, color, text] of GIZMO_AXES) {
      const mat = new THREE.MeshBasicMaterial({ color })
      this.disposables.push(mat)
      const q = new THREE.Quaternion().setFromUnitVectors(y, dir)
      for (const geo of [shaft, head]) {
        const part = new THREE.Mesh(geo, mat)
        part.quaternion.copy(q)
        this.scene.add(part)
      }
      const label = axisLabel(text, color)
      label.position.copy(dir).multiplyScalar(1.3)
      this.scene.add(label)
      this.disposables.push(label.material, label.material.map!)
    }
  }

  /** Draw the gizmo into a bottom-right corner of the given canvas, sharing
   *  the main camera's orientation so it reads as the part's world axes. */
  render(
    renderer: THREE.WebGLRenderer,
    mainCamera: THREE.Camera,
    target: THREE.Vector3,
    w: number,
    h: number,
  ): void {
    const size = Math.min(120, Math.max(74, Math.min(w, h) * 0.18))
    const pad = 14
    this.camera.position
      .subVectors(mainCamera.position, target)
      .normalize()
      .multiplyScalar(6)
    this.camera.quaternion.copy(mainCamera.quaternion)

    renderer.autoClear = false
    renderer.setViewport(w - size - pad, pad, size, size)
    renderer.setScissor(w - size - pad, pad, size, size)
    renderer.setScissorTest(true)
    renderer.clearDepth()
    renderer.render(this.scene, this.camera)
    renderer.setScissorTest(false)
    renderer.autoClear = true
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose()
  }
}
