import { useEffect, useRef, useState } from 'react'
import { MeshWorkerClient } from './core/workerClient'
import { buildSummary, pairDistances, type DoneElement } from './core/summary'
import { useStore } from './state/store'
import type { SceneManager, OverlayElement, OverlayPair } from './viewer/SceneManager'
import { Viewer } from './ui/Viewer'
import { Sidebar } from './ui/Sidebar'

const LARGE_TRIANGLE_WARNING = 5_000_000

export default function App() {
  const clientRef = useRef<MeshWorkerClient | null>(null)
  if (!clientRef.current) clientRef.current = new MeshWorkerClient()
  const sceneRef = useRef<SceneManager | null>(null)
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    clientRef.current!.onProgress = (text) => useStore.getState().setStatus(text)
  }, [])

  const openFile = async (file: File) => {
    const ext = file.name.split('.').pop()?.toLowerCase()
    if (!ext || !['stl', 'ply', 'obj'].includes(ext)) {
      useStore.getState().setError('Unsupported file type — use STL, PLY, or OBJ.')
      return
    }
    const store = useStore.getState()
    store.beginLoad(file.name)
    try {
      const buffer = await file.arrayBuffer()
      const mesh = await clientRef.current!.load(file.name, buffer)
      useStore.getState().setStatus('Building spatial index…')
      await new Promise((r) => setTimeout(r, 30))
      sceneRef.current?.setMesh(mesh.positions, mesh.indices, mesh.normals)
      useStore.getState().finishLoad(mesh.vertexCount, mesh.triangleCount)
      useStore
        .getState()
        .setStatus(
          mesh.triangleCount > LARGE_TRIANGLE_WARNING
            ? `Large mesh (${mesh.triangleCount.toLocaleString('en-US')} triangles) — fits may take a moment. Click a sphere to fit it.`
            : 'Click a sphere in the model to fit it.',
        )
    } catch (e) {
      useStore.getState().loadFailed(e instanceof Error ? e.message : String(e))
    }
  }

  const runFit = async (elementId: number, seeds: number[]) => {
    const settings = useStore.getState().settings
    try {
      const result = await clientRef.current!.fit('sphere', seeds, settings)
      useStore.getState().resolveFit(elementId, result)
      const el = useStore.getState().elements.find((e) => e.id === elementId)
      if (el) sceneRef.current?.applyRegion(elementId, el.color, result.region)
    } catch (e) {
      useStore.getState().failFit(elementId, e instanceof Error ? e.message : String(e))
    }
  }

  const handlePick = (faceVertices: [number, number, number]) => {
    const store = useStore.getState()
    if (!store.fileName || store.busy) return
    const owner = sceneRef.current?.ownerOfAny(faceVertices) ?? 0
    let id: number
    if (owner !== 0) {
      store.markFitting(owner, faceVertices)
      id = owner
    } else {
      id = store.addPending(faceVertices)
    }
    void runFit(id, faceVertices)
  }

  // Changing "Used points" re-fits every element with its stored seed.
  const sigma = useStore((s) => s.settings.sigma)
  const firstSigma = useRef(true)
  useEffect(() => {
    if (firstSigma.current) {
      firstSigma.current = false
      return
    }
    const store = useStore.getState()
    for (const el of store.elements) {
      if (el.status !== 'done') continue
      store.markFitting(el.id, el.seeds)
      void runFit(el.id, el.seeds)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sigma])

  // Keep viewport overlays in sync with fitted elements.
  const elements = useStore((s) => s.elements)
  const showOverlays = useStore((s) => s.showOverlays)
  useEffect(() => {
    const done = elements.filter((e) => e.status === 'done' && e.center) as (typeof elements[number] &
      DoneElement)[]
    const items: OverlayElement[] = done.map((e) => ({
      id: e.id,
      name: e.name,
      color: e.color,
      center: e.center,
      radius: e.diameter / 2,
    }))
    const pairs: OverlayPair[] = pairDistances(done).map((p) => ({
      a: p.a.center,
      b: p.b.center,
      label: `${p.dist.toFixed(3)} mm`,
    }))
    sceneRef.current?.updateOverlays(items, pairs, showOverlays)
  }, [elements, showOverlays])

  // Error toasts clear themselves.
  const errorText = useStore((s) => s.errorText)
  useEffect(() => {
    if (!errorText) return
    const t = setTimeout(() => useStore.getState().setError(null), 6000)
    return () => clearTimeout(t)
  }, [errorText])

  // Drag & drop anywhere.
  useEffect(() => {
    let depth = 0
    const onDragEnter = (e: DragEvent) => {
      e.preventDefault()
      depth++
      setDragging(true)
    }
    const onDragOver = (e: DragEvent) => e.preventDefault()
    const onDragLeave = () => {
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragging(false)
    }
    const onDrop = (e: DragEvent) => {
      e.preventDefault()
      depth = 0
      setDragging(false)
      const file = e.dataTransfer?.files?.[0]
      if (file) void openFile(file)
    }
    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleCopy = () => {
    const store = useStore.getState()
    const done = store.elements.filter((e) => e.status === 'done' && e.center) as (typeof store.elements[number] &
      DoneElement)[]
    const text = buildSummary(store.fileName ?? '', store.settings, done, pairDistances(done))
    void navigator.clipboard?.writeText(text)
  }

  const handleDelete = (id: number) => {
    sceneRef.current?.clearElement(id)
    useStore.getState().removeElement(id)
  }

  const handleClearAll = () => {
    sceneRef.current?.clearAllRegions()
    useStore.getState().clearElements()
  }

  const statusText = useStore((s) => s.statusText)

  return (
    <div className="app">
      <div className="viewport-wrap">
        <Viewer onReady={(s) => (sceneRef.current = s)} onPick={handlePick} />
        {statusText && <div className="status-chip">{statusText}</div>}
        {errorText && <div className="status-chip error">{errorText}</div>}
        {dragging && <div className="drop-overlay">Drop your STL / PLY / OBJ here</div>}
      </div>
      <Sidebar
        onOpenFile={(f) => void openFile(f)}
        onDelete={handleDelete}
        onClearAll={handleClearAll}
        onCopy={handleCopy}
      />
    </div>
  )
}
