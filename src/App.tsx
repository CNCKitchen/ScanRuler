import { useEffect, useRef, useState } from 'react'
import { MeshWorkerClient } from './core/workerClient'
import { buildSummary, pairDistances, type DoneElement } from './core/summary'
import { elementColor, useStore } from './state/store'
import type { SceneManager, OverlayElement, OverlayPair } from './viewer/SceneManager'
import { Viewer } from './ui/Viewer'
import { Sidebar } from './ui/Sidebar'

const LARGE_TRIANGLE_WARNING = 5_000_000

export default function App() {
  const clientRef = useRef<MeshWorkerClient | null>(null)
  if (!clientRef.current) clientRef.current = new MeshWorkerClient()
  const sceneRef = useRef<SceneManager | null>(null)
  const [dragging, setDragging] = useState(false)

  // Region of the pending preview fit, kept out of the store because it is a
  // large typed array that only the scene needs.
  const draftRegion = useRef<Uint32Array | null>(null)
  // Bumped whenever the draft changes, so a fit that resolves after the user
  // has already picked again (or cancelled) is discarded.
  const draftSeq = useRef(0)

  useEffect(() => {
    clientRef.current!.onProgress = (text) => useStore.getState().setStatus(text)
  }, [])

  const clearPreview = () => {
    draftSeq.current++
    draftRegion.current = null
    sceneRef.current?.setPreviewRegion(null)
    sceneRef.current?.setPreviewSphere(null)
  }

  const openFile = async (file: File) => {
    const ext = file.name.split('.').pop()?.toLowerCase()
    if (!ext || !['stl', 'ply', 'obj'].includes(ext)) {
      useStore.getState().setError('Unsupported file type — use STL, PLY, or OBJ.')
      return
    }
    const store = useStore.getState()
    clearPreview()
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
            ? `Large mesh (${mesh.triangleCount.toLocaleString('en-US')} triangles) — fits may take a moment. Press “Create fitting sphere” to start.`
            : 'Press “Create fitting sphere” to start measuring.',
        )
    } catch (e) {
      useStore.getState().loadFailed(e instanceof Error ? e.message : String(e))
    }
  }

  /** Re-fit an already measured element (used when the sigma preset changes). */
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

  /** Fit the draft from every picked point at once and show it as a preview.
   *  Picks may sit on unconnected patches — a partial scan of one ball — and
   *  the region growing seeds from all of them. */
  const runDraftFit = async (picks: [number, number, number][]) => {
    const seq = ++draftSeq.current
    const settings = useStore.getState().settings
    const seeds = picks.flat()
    try {
      const result = await clientRef.current!.fit('sphere', seeds, settings)
      if (seq !== draftSeq.current || !useStore.getState().draft) return
      draftRegion.current = result.region
      sceneRef.current?.setPreviewRegion(
        result.region,
        elementColor(useStore.getState().nextNumber),
      )
      sceneRef.current?.setPreviewSphere(result.center, result.radius)
      useStore.getState().resolveDraft(result)
    } catch (e) {
      if (seq !== draftSeq.current || !useStore.getState().draft) return
      draftRegion.current = null
      sceneRef.current?.setPreviewRegion(null)
      sceneRef.current?.setPreviewSphere(null)
      useStore.getState().failDraft(e instanceof Error ? e.message : String(e))
    }
  }

  const handlePick = (faceVertices: [number, number, number]) => {
    const store = useStore.getState()
    if (!store.fileName || store.busy) return
    if (!store.draft) {
      store.setStatus('Press “Create fitting sphere” to start a new one.')
      return
    }
    const picks: [number, number, number][] = [...store.draft.picks, faceVertices]
    store.setDraftPicks(picks)
    void runDraftFit(picks)
  }

  const handleStartDraft = () => {
    const store = useStore.getState()
    clearPreview()
    store.startDraft()
    store.setStatus('Click a point on the sphere you want to measure.')
  }

  const handleUndoPick = () => {
    const store = useStore.getState()
    if (!store.draft || store.draft.picks.length === 0) return
    const picks = store.draft.picks.slice(0, -1)
    store.setDraftPicks(picks)
    clearPreview()
    if (picks.length > 0) void runDraftFit(picks)
  }

  const handleCancelDraft = () => {
    clearPreview()
    useStore.getState().cancelDraft()
    useStore.getState().setStatus('')
  }

  const handleConfirmDraft = () => {
    const region = draftRegion.current
    const id = useStore.getState().commitDraft()
    if (id === null) return
    clearPreview()
    const el = useStore.getState().elements.find((e) => e.id === id)
    if (el && region) sceneRef.current?.applyRegion(id, el.color, region)
    useStore.getState().setStatus(`${el?.name ?? 'Sphere'} created.`)
  }

  // Changing "Used points" re-fits every element with its stored seeds, and
  // refreshes the pending preview if one is open.
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
    if (store.draft && store.draft.picks.length > 0) {
      store.setDraftPicks(store.draft.picks)
      void runDraftFit(store.draft.picks)
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
      title: `${p.a.name} ↔ ${p.b.name}`,
      value: `${p.dist.toFixed(3)} mm`,
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

  // Enter confirms the pending sphere, Escape discards it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const draft = useStore.getState().draft
      if (!draft) return
      const target = e.target as HTMLElement | null
      if (target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return
      if (e.key === 'Escape') handleCancelDraft()
      else if (e.key === 'Enter' && draft.status === 'ready') handleConfirmDraft()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
    clearPreview()
    sceneRef.current?.clearAllRegions()
    useStore.getState().clearElements()
  }

  const statusText = useStore((s) => s.statusText)
  // Fits run in a worker and can take seconds on a big scan — say so on the
  // canvas, where the user is looking after a pick.
  const fitting = useStore(
    (s) => s.draft?.status === 'fitting' || s.elements.some((e) => e.status === 'fitting'),
  )

  return (
    <div className="app">
      <div className="viewport-wrap">
        <Viewer onReady={(s) => (sceneRef.current = s)} onPick={handlePick} />
        {fitting && (
          <div className="busy-chip" data-test="fitting-chip">
            <span className="spinner" />
            Fitting…
          </div>
        )}
        {statusText && <div className="status-chip">{statusText}</div>}
        {errorText && <div className="status-chip error">{errorText}</div>}
        {dragging && <div className="drop-overlay">Drop your STL / PLY / OBJ here</div>}
      </div>
      <Sidebar
        onOpenFile={(f) => void openFile(f)}
        onStartDraft={handleStartDraft}
        onUndoPick={handleUndoPick}
        onCancelDraft={handleCancelDraft}
        onConfirmDraft={handleConfirmDraft}
        onDelete={handleDelete}
        onClearAll={handleClearAll}
        onCopy={handleCopy}
      />
    </div>
  )
}
