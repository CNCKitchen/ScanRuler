// SPDX-License-Identifier: AGPL-3.0-only
import * as THREE from 'three'
import { frameExtent, viewHalfHeight, type OrthoViewport } from './orthoViewport'

export const PROJECT_PREVIEW_SIZE = 1024

/** Ignore hidden parents as well as hidden objects; Box3.setFromObject does not. */
export function visiblePreviewBounds(roots: readonly THREE.Object3D[]): THREE.Box3 {
  const box = new THREE.Box3()
  for (const root of roots) {
    root.updateWorldMatrix(true, true)
    root.traverseVisible((object) => {
      if (!(object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.Points)) return
      const materials = Array.isArray(object.material) ? object.material : [object.material]
      if (!materials.some((material) => material.visible && material.colorWrite && material.opacity > 0)) return
      if (!object.geometry.boundingBox) object.geometry.computeBoundingBox()
      if (object.geometry.boundingBox) box.union(object.geometry.boundingBox.clone().applyMatrix4(object.matrixWorld))
    })
  }
  return box
}

export function previewCamera(
  original: THREE.OrthographicCamera | THREE.PerspectiveCamera,
  box: THREE.Box3,
  aspect = 1,
): THREE.OrthographicCamera | THREE.PerspectiveCamera {
  if (box.isEmpty() || ![...box.min.toArray(), ...box.max.toArray(), aspect].every(Number.isFinite) || aspect <= 0) {
    throw new Error('There is no finite visible content to frame in the project preview.')
  }
  const camera = original.clone()
  const centre = box.getCenter(new THREE.Vector3())
  const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1e-3)
  const towardEye = new THREE.Vector3(0, 0, 1).applyQuaternion(camera.quaternion)
  let distance = radius * 4 + 1
  camera.zoom = 1
  camera.position.copy(centre).addScaledVector(towardEye, distance)
  camera.updateMatrixWorld(true)
  if (camera instanceof THREE.OrthographicCamera) {
    const height = viewHalfHeight(frameExtent(box, camera.matrixWorldInverse), aspect)
    camera.top = height
    camera.bottom = -height
    camera.right = height * aspect
    camera.left = -height * aspect
  } else {
    camera.aspect = aspect
    const tanY = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))
    const inverse = camera.quaternion.clone().invert()
    distance = 0
    for (let i = 0; i < 8; i++) {
      const corner = new THREE.Vector3(
        i & 1 ? box.max.x : box.min.x,
        i & 2 ? box.max.y : box.min.y,
        i & 4 ? box.max.z : box.min.z,
      ).sub(centre).applyQuaternion(inverse)
      distance = Math.max(distance, corner.z + Math.max(Math.abs(corner.x) / (tanY * aspect), Math.abs(corner.y) / tanY) * 1.08)
    }
    camera.position.copy(centre).addScaledVector(towardEye, distance)
  }
  camera.near = Math.max(radius * 1e-5, 1e-6)
  camera.far = distance + radius * 2 + 1
  camera.updateProjectionMatrix()
  camera.updateMatrixWorld(true)
  return camera
}

/** Draw through a separate camera and target, never fitting or resizing the live view. */
export async function captureProjectPreview(viewport: OrthoViewport, bounds: THREE.Box3): Promise<Uint8Array> {
  if (bounds.isEmpty()) return emptyPreview()
  const camera = previewCamera(viewport.view, bounds)
  const renderer = viewport.renderer
  const target = new THREE.WebGLRenderTarget(PROJECT_PREVIEW_SIZE, PROJECT_PREVIEW_SIZE, { depthBuffer: true })
  target.texture.colorSpace = THREE.SRGBColorSpace
  const previous = renderer.getRenderTarget()
  const previousViewport = renderer.getViewport(new THREE.Vector4())
  const previousScissor = renderer.getScissor(new THREE.Vector4())
  const previousScissorTest = renderer.getScissorTest()
  const pixels = new Uint8Array(PROJECT_PREVIEW_SIZE * PROJECT_PREVIEW_SIZE * 4)
  try {
    renderer.setRenderTarget(target)
    renderer.setViewport(0, 0, PROJECT_PREVIEW_SIZE, PROJECT_PREVIEW_SIZE)
    renderer.setScissorTest(false)
    renderer.render(viewport.scene, camera)
    renderer.readRenderTargetPixels(target, 0, 0, PROJECT_PREVIEW_SIZE, PROJECT_PREVIEW_SIZE, pixels)
  } finally {
    renderer.setRenderTarget(previous)
    renderer.setViewport(previousViewport)
    renderer.setScissor(previousScissor)
    renderer.setScissorTest(previousScissorTest)
    target.dispose()
  }
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = PROJECT_PREVIEW_SIZE
  const context = canvas.getContext('2d')
  if (!context) throw new Error('The project preview image could not be created.')
  const image = context.createImageData(PROJECT_PREVIEW_SIZE, PROJECT_PREVIEW_SIZE)
  const stride = PROJECT_PREVIEW_SIZE * 4
  for (let row = 0; row < PROJECT_PREVIEW_SIZE; row++) {
    image.data.set(pixels.subarray(row * stride, (row + 1) * stride), (PROJECT_PREVIEW_SIZE - row - 1) * stride)
  }
  context.putImageData(image, 0, 0)
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
    (value) => value ? resolve(value) : reject(new Error('The project preview could not be encoded as PNG.')),
    'image/png',
  ))
  return new Uint8Array(await blob.arrayBuffer())
}

async function emptyPreview(): Promise<Uint8Array> {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = PROJECT_PREVIEW_SIZE
  const context = canvas.getContext('2d')
  if (!context) throw new Error('The project preview image could not be created.')
  context.fillStyle = '#f2f4f7'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.fillStyle = '#344054'
  context.font = '28px sans-serif'
  context.textAlign = 'center'
  context.fillText('No visible geometry or image', canvas.width / 2, canvas.height / 2)
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
    (value) => value ? resolve(value) : reject(new Error('The project preview could not be encoded as PNG.')),
    'image/png',
  ))
  return new Uint8Array(await blob.arrayBuffer())
}
