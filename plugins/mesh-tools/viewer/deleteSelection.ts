// SPDX-License-Identifier: AGPL-3.0-only
import * as THREE from 'three'
import type { SceneManager } from '../../../src/viewer/SceneManager'
import { visibleTriangles } from '../core/triangleSelection'
import { useDeleteSelection } from '../state/deleteStore'
import { WorkerRpc } from '../../../src/core/workerRpc'
import { regionContains, type SelectionRegion, type SelectionRequest, type SelectionResponse } from './selectionJob'
import { useMark } from '../../../src/state/markStore'
import { brushDiameterPixels } from './brushSize'

type Point = { x: number; y: number }

export class DeleteSelectionScene {
  private host
  private removeLayer
  private renderer: THREE.WebGLRenderer | null = null
  private idGeometry: THREE.BufferGeometry | null = null
  private source: Uint32Array | null = null
  private rpc: WorkerRpc | null = null
  private workerSource: Uint32Array | null = null
  private requestId = 0
  private workId = 0
  private edgeCache: { mask: Uint8Array; edges: Uint32Array } | null = null
  private overlay: THREE.Group | null = null
  private cancelStroke: (() => void) | null = null
  private brushCursor: HTMLDivElement
  private cursorAt: Point | null = null
  private stopBrushUpdates: () => void
  enabled = false

  constructor(
    private scene: SceneManager,
    private changed: (mask: Uint8Array) => void,
    private error: (message: string) => void,
    private blocked: () => boolean,
  ) {
    this.host = scene.layerHost()
    this.brushCursor = document.createElement('div')
    this.brushCursor.dataset.test = 'delete-brush-cursor'
    Object.assign(this.brushCursor.style, {
      position: 'fixed', pointerEvents: 'none', border: '2px solid #ff5a1f',
      borderRadius: '50%', boxSizing: 'border-box', transform: 'translate(-50%, -50%)',
      display: 'none', zIndex: '5',
    })
    this.host.container.appendChild(this.brushCursor)
    const stopMark = useMark.subscribe(() => this.updateBrushCursor())
    const stopDelete = useDeleteSelection.subscribe(() => this.updateBrushCursor())
    this.stopBrushUpdates = () => { stopMark(); stopDelete() }
    this.removeLayer = scene.addLayer({
      order: 9,
      pointerDown: (e) => this.start(e),
      click: () => this.enabled && useDeleteSelection.getState().gesture !== null,
      hover: (at) => {
        this.cursorAt = at
        this.updateBrushCursor()
        if (!this.enabled) return false
        const armed = useDeleteSelection.getState().gesture !== null && !this.blocked()
        this.host.claimDrag(armed && at !== null)
        this.host.setCursor(armed && at ? 'crosshair' : '')
        return armed && at !== null
      },
      tick: () => this.updateBrushCursor(),
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

  private updateBrushCursor(): void {
    const state = useDeleteSelection.getState()
    const at = this.cursorAt
    const visible = this.enabled && state.gesture === 'brush' && !this.blocked() && at !== null
    this.brushCursor.style.display = visible ? 'block' : 'none'
    if (!visible || !at) return
    const camera = this.host.camera()
    this.host.partGroup.updateMatrixWorld(true)
    const diameter = brushDiameterPixels(useMark.getState().diameter, camera,
      this.host.partGroup.matrixWorld, this.host.canvas.getBoundingClientRect().height)
    this.brushCursor.style.width = `${diameter}px`
    this.brushCursor.style.height = `${diameter}px`
    this.brushCursor.style.left = `${at.x}px`
    this.brushCursor.style.top = `${at.y}px`
    this.brushCursor.style.borderColor = state.remove ? '#12a594' : '#ff5a1f'
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

  async selectView(): Promise<void> {
    if (this.blocked() || useDeleteSelection.getState().selecting) return
    const work = ++this.workId
    const key = this.viewKey(), source = this.scene.scanMesh()?.indices
    useDeleteSelection.getState().setProgress('Preparing visible selection...')
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      if (work !== this.workId) return
      const { pixels, triangles } = this.renderIds()
      const state = useDeleteSelection.getState()
      const visible = visibleTriangles(pixels, triangles)
      const mask = state.selection?.slice() ?? new Uint8Array(triangles)
      for (let t = 0; t < triangles; t++) if (visible[t]) mask[t] = state.remove ? 0 : 1
      const result = await this.calculate(mask, state.remove, [], 'select')
      if (work !== this.workId) return
      if (source !== this.scene.scanMesh()?.indices || key !== this.viewKey()) throw new Error('The view or mesh changed during selection. Select again in the current view.')
      this.edgeCache = result
      this.changed(result.mask)
    } catch (e) {
      if (work === this.workId) this.error(e instanceof Error ? e.message : String(e))
    } finally {
      if (work === this.workId) useDeleteSelection.getState().setProgress(null)
    }
  }

  private async calculate(mask: Uint8Array, remove: boolean, regions: SelectionRegion[], type: SelectionRequest['type']): Promise<{ mask: Uint8Array; edges: Uint32Array }> {
    const mesh = this.scene.scanMesh()
    if (!mesh) throw new Error('Load a triangle mesh before selecting visible surface.')
    if (!this.rpc || this.rpc.dead) {
      this.workerSource = null
      this.rpc?.dispose()
      this.rpc = new WorkerRpc(() => new Worker(new URL('./selectionWorker.ts', import.meta.url), { type: 'module' }), 'Visible-selection worker', (data) => {
        const message = data as SelectionResponse
        if (message.type !== 'progress') return false
        if (message.requestId === this.requestId) useDeleteSelection.getState().setProgress(message.text, message.percent)
        return true
      })
    }
    const camera = this.host.camera()
    camera.updateMatrixWorld(true)
    this.host.partGroup.updateMatrixWorld(true)
    const rect = this.host.canvas.getBoundingClientRect()
    const request: SelectionRequest = {
      requestId: ++this.requestId, type, mask, remove, regions,
      ...(this.workerSource !== mesh.indices ? { mesh: { positions: mesh.positions, indices: mesh.indices } } : {}),
      camera: { world: camera.matrixWorld.toArray(), projection: camera.projectionMatrix.toArray() },
      part: this.host.partGroup.matrixWorld.toArray(),
      width: rect.width, height: rect.height,
      planes: (this.host.clipPlanes() ?? []).map((p) => [...p.normal.toArray(), p.constant]),
    }
    const answer = await this.rpc.request<SelectionResponse>(request)
    if (answer.type !== 'done') throw new Error(answer.type === 'error' ? answer.message : 'Visible selection returned an unexpected answer.')
    this.workerSource = mesh.indices
    return { mask: answer.mask, edges: answer.edges }
  }

  async invertSelection(mask: Uint8Array): Promise<void> {
    if (this.blocked()) return
    const work = ++this.workId
    const source = this.scene.scanMesh()?.indices
    useDeleteSelection.getState().setProgress('Finding selection boundaries...')
    try {
      const result = await this.calculate(mask, false, [], 'boundary')
      if (work !== this.workId) return
      if (source !== this.scene.scanMesh()?.indices) throw new Error('The mesh changed during selection. Select the surface again.')
      this.edgeCache = result
      this.changed(result.mask)
    } catch (error) {
      if (work === this.workId) this.error(error instanceof Error ? error.message : String(error))
    } finally {
      if (work === this.workId) useDeleteSelection.getState().setProgress(null)
    }
  }

  async show(mask: Uint8Array | null): Promise<void> {
    if (!this.enabled || !mask?.some((v) => v !== 0)) {
      this.clearOverlay()
      return
    }
    const welded = this.scene.scanMesh()
    if (!welded || welded.indices.length !== mask.length * 3) {
      useDeleteSelection.getState().reset()
      return
    }
    let edges = this.edgeCache?.mask === mask ? this.edgeCache.edges : null
    if (!edges) {
      const work = ++this.workId
      useDeleteSelection.getState().setProgress('Finding selection boundaries...')
      try {
        const result = await this.calculate(mask, false, [], 'boundary')
        if (work !== this.workId || welded.indices !== this.scene.scanMesh()?.indices) return
        edges = result.edges
        this.edgeCache = { mask, edges }
      } catch (error) {
        if (work === this.workId) this.error(error instanceof Error ? error.message : String(error))
        return
      } finally {
        if (work === this.workId) useDeleteSelection.getState().setProgress(null)
      }
    }
    this.clearOverlay()
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
      const radius = brushDiameterPixels(useMark.getState().diameter, this.host.camera(),
        this.host.partGroup.matrixWorld, rect.height) / 2
      const regions: SelectionRegion[] = []
      const paint = (region: SelectionRegion, minX: number, minY: number, maxX: number, maxY: number) => {
        regions.push(region)
        const sx = image.width / rect.width, sy = image.height / rect.height
        for (let y = Math.max(0, Math.floor(minY * sy)); y < Math.min(image.height, Math.ceil(maxY * sy)); y++) {
          for (let x = Math.max(0, Math.floor(minX * sx)); x < Math.min(image.width, Math.ceil(maxX * sx)); x++) {
            if (!regionContains(region, (x + 0.5) / sx, (y + 0.5) / sy)) continue
            const i = ((image.height - 1 - y) * image.width + x) * 4
            const p = image.pixels
            const id = p[i] + p[i + 1] * 256 + p[i + 2] * 65536 + p[i + 3] * 16777216
            if (id > 0 && id <= mask.length) mask[id - 1] = state.remove ? 0 : 1
          }
        }
      }
      const brush = (a: Point, b: Point) => {
        paint({ kind: 'brush', a, b, radius }, Math.min(a.x, b.x) - radius, Math.min(a.y, b.y) - radius, Math.max(a.x, b.x) + radius, Math.max(a.y, b.y) + radius)
      }
      if (state.gesture === 'brush') brush(last, last)
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      svg.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:1000'
      const path = document.createElementNS(svg.namespaceURI, 'polyline')
      path.setAttribute('fill', 'none')
      path.setAttribute('stroke', state.remove ? '#12a594' : '#ff5a1f')
      path.setAttribute('stroke-width', state.gesture === 'brush' ? String(radius * 2) : '2')
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
        this.cursorAt = { x: ev.clientX, y: ev.clientY }
        this.updateBrushCursor()
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
          paint(state.gesture === 'window' ? { kind: 'window', minX, minY, maxX, maxY } : { kind: 'lasso', points },
            minX, minY, maxX, maxY)
        }
        const work = ++this.workId
        useDeleteSelection.getState().setProgress('Checking visible triangles...')
        void this.calculate(mask, state.remove, regions, 'select').then((result) => {
          if (work !== this.workId) return
          if (source !== this.scene.scanMesh()?.indices || key !== this.viewKey()) throw new Error('The view or mesh changed during selection. Repeat the stroke in the current view.')
          this.edgeCache = result
          this.changed(result.mask)
        }).catch((error) => {
          if (work === this.workId) this.error(error instanceof Error ? error.message : String(error))
        }).finally(() => {
          if (work === this.workId) useDeleteSelection.getState().setProgress(null)
        })
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
    this.cancelWork()
    this.cancelStroke?.()
    this.clearOverlay()
    this.idGeometry?.dispose()
    this.idGeometry = null
    this.source = null
    this.cursorAt = null
    this.brushCursor.style.display = 'none'
    this.host.claimDrag(false)
    this.host.setCursor('')
  }

  cancelWork(): void {
    this.workId++
    this.rpc?.dispose()
    this.rpc = null
    this.workerSource = null
    this.edgeCache = null
    useDeleteSelection.getState().setProgress(null)
  }

  dispose(): void {
    this.clear()
    this.stopBrushUpdates()
    this.brushCursor.remove()
    this.renderer?.dispose()
    this.renderer?.forceContextLoss()
    this.renderer = null
    this.removeLayer()
  }
}
