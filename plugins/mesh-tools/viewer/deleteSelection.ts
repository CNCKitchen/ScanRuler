// SPDX-License-Identifier: AGPL-3.0-only
import * as THREE from 'three'
import type { SceneManager } from '../../../src/viewer/SceneManager'
import { selectionBoundary, visibleTriangles } from '../core/triangleSelection'
import { useDeleteSelection } from '../state/deleteStore'
import { TriangleVisibility } from './triangleVisibility'

type Point = { x: number; y: number }

export class DeleteSelectionScene {
  private host
  private removeLayer
  private renderer: THREE.WebGLRenderer | null = null
  private idGeometry: THREE.BufferGeometry | null = null
  private source: Uint32Array | null = null
  private visibility: TriangleVisibility | null = null
  private overlay: THREE.Group | null = null
  private cancelStroke: (() => void) | null = null
  enabled = false

  constructor(
    private scene: SceneManager,
    private changed: (mask: Uint8Array) => void,
    private error: (message: string) => void,
    private blocked: () => boolean,
  ) {
    this.host = scene.layerHost()
    this.removeLayer = scene.addLayer({
      order: 9,
      pointerDown: (e) => this.start(e),
      click: () => this.enabled && useDeleteSelection.getState().gesture !== null,
      hover: (at) => {
        if (!this.enabled) return false
        const armed = useDeleteSelection.getState().gesture !== null && !this.blocked()
        this.host.claimDrag(armed && at !== null)
        this.host.setCursor(armed && at ? 'crosshair' : '')
        return armed && at !== null
      },
      clippingChanged: (planes) => {
        this.overlay?.traverse((child) => {
          if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
            const material = child.material as THREE.Material
            material.clippingPlanes = planes
            material.needsUpdate = true
          }
        })
      },
      scanReplaced: () => this.clear(),
      dispose: () => this.dispose(),
    })
  }

  private viewKey(): string {
    const camera = this.host.camera()
    camera.updateMatrixWorld(true)
    this.host.partGroup.updateMatrixWorld(true)
    return [
      ...camera.matrixWorld.elements, ...camera.projectionMatrix.elements,
      ...this.host.partGroup.matrixWorld.elements,
      this.host.canvas.width, this.host.canvas.height,
      ...(this.host.clipPlanes() ?? []).flatMap((p) => [...p.normal.toArray(), p.constant]),
    ].join(',')
  }

  private renderIds(): { pixels: Uint8Array; width: number; height: number; triangles: number } {
    const source = this.scene.scanMesh()
    if (!source) throw new Error('Load a triangle mesh before selecting visible surface.')
    const index = source.indices, position = source.positions
    if (this.source !== index) {
      if (this.source && useDeleteSelection.getState().selection) {
        throw new Error('The mesh changed since selection. Clear and select again before deleting.')
      }
      this.idGeometry?.dispose()
      this.visibility?.dispose()
      this.visibility = null
      const soup = new Float32Array(index.length * 3)
      for (let i = 0; i < index.length; i++) {
        const v = index[i] * 3
        soup[i * 3] = position[v]
        soup[i * 3 + 1] = position[v + 1]
        soup[i * 3 + 2] = position[v + 2]
      }
      this.idGeometry = new THREE.BufferGeometry()
      this.idGeometry.setAttribute('position', new THREE.BufferAttribute(soup, 3))
      this.source = index
    }
    const renderer = this.renderer ??= new THREE.WebGLRenderer({ antialias: false, alpha: true })
    if (renderer.getContext().isContextLost()) throw new Error('Visible selection lost its graphics context. Close and reopen Delete marked, then try again.')
    renderer.debug.onShaderError = (gl, program) => {
      throw new Error(`Visible selection shader failed: ${gl.getProgramInfoLog(program) ?? 'unknown graphics error'}`)
    }
    const width = this.host.canvas.width, height = this.host.canvas.height
    renderer.setSize(width, height, false)
    renderer.setClearColor(0, 0)
    const inverse = this.host.partGroup.matrixWorld.clone().invert()
    const planes = (this.host.clipPlanes() ?? []).map((p) => p.clone().applyMatrix4(inverse))
    const material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      side: THREE.DoubleSide,
      uniforms: {
        planes: { value: planes.map((p) => new THREE.Vector4(...p.normal.toArray(), p.constant)) },
      },
      vertexShader: `
        precision highp float;
        precision highp int;
        uniform mat4 modelViewMatrix;
        uniform mat4 projectionMatrix;
        in vec3 position;
        out vec3 localPosition;
        flat out uint triangleId;
        void main() {
          localPosition = position;
          triangleId = uint(gl_VertexID / 3) + 1u;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        precision highp float;
        precision highp int;
        in vec3 localPosition;
        flat in uint triangleId;
        ${planes.length ? `uniform vec4 planes[${planes.length}];` : ''}
        out vec4 result;
        void main() {
          ${planes.map((_, i) => `if (dot(planes[${i}].xyz, localPosition) + planes[${i}].w < 0.0) discard;`).join('\n')}
          result = vec4(float(triangleId & 255u), float((triangleId >> 8u) & 255u),
            float((triangleId >> 16u) & 255u), float((triangleId >> 24u) & 255u)) / 255.0;
        }`,
    })
    const target = new THREE.WebGLRenderTarget(width, height, { depthBuffer: true })
    const mesh = new THREE.Mesh(this.idGeometry!, material)
    mesh.matrixAutoUpdate = false
    mesh.matrix.copy(this.host.partGroup.matrixWorld)
    mesh.frustumCulled = false
    const stage = new THREE.Scene()
    stage.add(mesh)
    const pixels = new Uint8Array(width * height * 4)
    try {
      renderer.setRenderTarget(target)
      renderer.render(stage, this.host.camera())
      renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels)
    } finally {
      renderer.setRenderTarget(null)
      target.dispose()
      material.dispose()
    }
    return { pixels, width, height, triangles: index.length / 3 }
  }

  selectView(): void {
    try {
      this.viewKey()
      const { pixels, triangles } = this.renderIds()
      const state = useDeleteSelection.getState()
      const visible = visibleTriangles(pixels, triangles)
      const mask = state.selection?.slice() ?? new Uint8Array(triangles)
      for (let t = 0; t < triangles; t++) if (visible[t]) mask[t] = state.remove ? 0 : 1
      this.completeVisibility(mask, state.remove, () => true)
      this.changed(mask)
    } catch (e) {
      this.error(e instanceof Error ? e.message : String(e))
    }
  }

  private completeVisibility(mask: Uint8Array, remove: boolean, contains: (x: number, y: number) => boolean): void {
    if (!this.idGeometry) throw new Error('The selection geometry is not ready.')
    this.visibility ??= new TriangleVisibility(this.idGeometry.getAttribute('position').array as Float32Array)
    const rect = this.host.canvas.getBoundingClientRect()
    this.visibility.apply(mask, remove, this.host.camera(), this.host.partGroup.matrixWorld,
      rect.width, rect.height, this.host.clipPlanes() ?? [], contains)
  }

  show(mask: Uint8Array | null): void {
    this.clearOverlay()
    if (!this.enabled || !mask?.some((v) => v !== 0)) return
    const welded = this.scene.scanMesh()
    if (!welded || welded.indices.length !== mask.length * 3) {
      useDeleteSelection.getState().reset()
      return
    }
    const selected = new Uint32Array(mask.reduce((n, v) => n + v, 0) * 3)
    let at = 0
    for (let t = 0; t < mask.length; t++) {
      if (!mask[t]) continue
      for (let k = 0; k < 3; k++) selected[at++] = welded.indices[t * 3 + k]
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(welded.positions, 3))
    geometry.setIndex(new THREE.BufferAttribute(selected, 1))
    const fill = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
      color: 0xff5a1f, side: THREE.DoubleSide, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      clippingPlanes: this.host.clipPlanes(),
    }))
    fill.renderOrder = 4
    const edges = selectionBoundary(welded.indices, welded.positions.length / 3, mask)
    const lines = new Float32Array(edges.length * 3)
    for (let i = 0; i < edges.length; i++) lines.set(welded.positions.subarray(edges[i] * 3, edges[i] * 3 + 3), i * 3)
    const lineGeometry = new THREE.BufferGeometry()
    lineGeometry.setAttribute('position', new THREE.BufferAttribute(lines, 3))
    const boundary = new THREE.LineSegments(lineGeometry, new THREE.LineBasicMaterial({
      color: 0xffdd00, depthWrite: false, clippingPlanes: this.host.clipPlanes(),
    }))
    boundary.renderOrder = 5
    this.overlay = new THREE.Group()
    this.overlay.add(fill, boundary)
    this.host.partGroup.add(this.overlay)
    this.host.invalidate()
  }

  private start(e: PointerEvent): boolean {
    const state = useDeleteSelection.getState()
    if (!this.enabled || !state.gesture || this.blocked() || e.button !== 0 || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return false
    this.cancelStroke?.()
    try {
      const key = this.viewKey(), source = this.scene.scanMesh()?.indices
      const image = this.renderIds()
      const mask = state.selection?.slice() ?? new Uint8Array(image.triangles)
      const rect = this.host.canvas.getBoundingClientRect()
      const local = (ev: PointerEvent): Point => ({ x: ev.clientX - rect.left, y: ev.clientY - rect.top })
      const points = [local(e)]
      let last = points[0]
      let ended = false
      const radius = state.diameter / 2
      const regions: { contains: (x: number, y: number) => boolean; minX: number; minY: number; maxX: number; maxY: number }[] = []
      const paint = (contains: (x: number, y: number) => boolean, minX: number, minY: number, maxX: number, maxY: number) => {
        regions.push({ contains, minX, minY, maxX, maxY })
        const sx = image.width / rect.width, sy = image.height / rect.height
        for (let y = Math.max(0, Math.floor(minY * sy)); y < Math.min(image.height, Math.ceil(maxY * sy)); y++) {
          for (let x = Math.max(0, Math.floor(minX * sx)); x < Math.min(image.width, Math.ceil(maxX * sx)); x++) {
            if (!contains((x + 0.5) / sx, (y + 0.5) / sy)) continue
            const i = ((image.height - 1 - y) * image.width + x) * 4
            const p = image.pixels
            const id = p[i] + p[i + 1] * 256 + p[i + 2] * 65536 + p[i + 3] * 16777216
            if (id > 0 && id <= mask.length) mask[id - 1] = state.remove ? 0 : 1
          }
        }
      }
      const brush = (a: Point, b: Point) => {
        const dx = b.x - a.x, dy = b.y - a.y, length2 = dx * dx + dy * dy
        paint((x, y) => {
          const t = length2 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / length2)) : 0
          return (x - a.x - t * dx) ** 2 + (y - a.y - t * dy) ** 2 <= radius * radius
        }, Math.min(a.x, b.x) - radius, Math.min(a.y, b.y) - radius, Math.max(a.x, b.x) + radius, Math.max(a.y, b.y) + radius)
      }
      if (state.gesture === 'brush') brush(last, last)
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      svg.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:1000'
      const path = document.createElementNS(svg.namespaceURI, 'polyline')
      path.setAttribute('fill', 'none')
      path.setAttribute('stroke', state.remove ? '#12a594' : '#ff5a1f')
      path.setAttribute('stroke-width', state.gesture === 'brush' ? String(state.diameter) : '2')
      path.setAttribute('stroke-opacity', '0.5')
      path.setAttribute('stroke-linecap', 'round')
      path.setAttribute('stroke-linejoin', 'round')
      svg.appendChild(path)
      this.host.container.appendChild(svg)
      const move = (ev: PointerEvent) => {
        if (ended || ev.pointerId !== e.pointerId) return
        if (points.length >= 4096) {
          finish(true)
          this.error('The selection stroke is too long. Use several shorter strokes.')
          return
        }
        const next = local(ev)
        if (state.gesture === 'brush') brush(last, next)
        last = next
        if (state.gesture === 'window') points.splice(1, 1, next)
        else points.push(next)
        const outline = state.gesture === 'window'
          ? [points[0], { x: next.x, y: points[0].y }, next, { x: points[0].x, y: next.y }, points[0]]
          : state.gesture === 'lasso' ? [...points, points[0]] : points
        path.setAttribute('points', outline.map((p) => `${p.x + rect.left},${p.y + rect.top}`).join(' '))
      }
      const finish = (cancelled: boolean) => {
        if (ended) return
        ended = true
        cleanup()
        if (cancelled) return
        if (source !== this.scene.scanMesh()?.indices || key !== this.viewKey()) {
          this.error('The view or mesh changed during selection. Repeat the stroke in the current view.')
          return
        }
        if (state.gesture !== 'brush') {
          const xs = points.map((p) => p.x), ys = points.map((p) => p.y)
          const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys)
          paint((x, y) => {
            if (state.gesture === 'window') return true
            let inside = false
            for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
              const a = points[i], b = points[j]
              if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside
            }
            return inside
          }, minX, minY, maxX, maxY)
        }
        try {
          this.completeVisibility(mask, state.remove, (x, y) => regions.some((r) =>
            x >= r.minX && x <= r.maxX && y >= r.minY && y <= r.maxY && r.contains(x, y)))
          this.changed(mask)
        } catch (e) {
          this.error(e instanceof Error ? e.message : String(e))
        }
      }
      const up = (ev: PointerEvent) => { if (ev.pointerId === e.pointerId) { move(ev); finish(false) } }
      const cancel = (ev: PointerEvent) => { if (ev.pointerId === e.pointerId) finish(true) }
      const keydown = (ev: KeyboardEvent) => {
        if (ev.key === 'Escape') { ev.preventDefault(); ev.stopImmediatePropagation(); finish(true) }
      }
      const blur = () => finish(true)
      const canvas = this.host.canvas
      const cleanup = () => {
        this.cancelStroke = null
        svg.remove()
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        window.removeEventListener('pointercancel', cancel)
        window.removeEventListener('keydown', keydown, true)
        window.removeEventListener('blur', blur)
        canvas.removeEventListener('lostpointercapture', cancel)
        if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId)
        this.host.claimDrag(false)
        this.host.requestHover()
      }
      this.cancelStroke = () => finish(true)
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
      window.addEventListener('pointercancel', cancel)
      window.addEventListener('keydown', keydown, true)
      window.addEventListener('blur', blur)
      canvas.addEventListener('lostpointercapture', cancel)
      canvas.setPointerCapture(e.pointerId)
      this.host.claimDrag(true)
      move(e)
      return true
    } catch (e) {
      this.cancelStroke?.()
      this.error(e instanceof Error ? e.message : String(e))
      return true
    }
  }

  private clearOverlay(): void {
    if (!this.overlay) return
    for (const child of this.overlay.children) {
      if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
        child.geometry.dispose()
        ;(child.material as THREE.Material).dispose()
      }
    }
    this.host.partGroup.remove(this.overlay)
    this.overlay = null
    this.host.invalidate()
  }

  clear(): void {
    this.cancelStroke?.()
    this.clearOverlay()
    this.idGeometry?.dispose()
    this.visibility?.dispose()
    this.visibility = null
    this.idGeometry = null
    this.source = null
    this.host.claimDrag(false)
    this.host.setCursor('')
  }

  dispose(): void {
    this.clear()
    this.renderer?.dispose()
    this.renderer?.forceContextLoss()
    this.renderer = null
    this.removeLayer()
  }
}
