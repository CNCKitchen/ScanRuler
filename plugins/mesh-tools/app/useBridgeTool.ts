// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { Vec3 } from '../../../src/core/types'
import type { PickHit, SceneManager } from '../../../src/viewer/SceneManager'
import type { DisplayUnits } from '../../../src/core/units'
import { onScan } from '../../../src/app/scanEvents'
import { useShell } from '../../../src/state/shellStore'
import { useStore } from '../../../src/state/store'
import { useMeshTools } from '../state/meshStore'
import { meshSceneOf } from '../viewer/meshScene'
import type { BridgeGuidance, BridgeReport } from '../core/bridge'
import { bridgeStrokePoints, type BridgeStrokeSample } from '../core/bridgeStroke'
import { meshToolsOf } from '../core/meshClient'
import type { MeshToolsSession } from './meshToolsSession'

export function useBridgeTool(session: MeshToolsSession, sceneRef: RefObject<SceneManager | null>, units: DisplayUnits) {
  const onMesh = useShell((s) => s.workspace === 'mesh')
  const tool = useMeshTools((s) => s.tool)
  const active = onMesh && tool === 'bridge'
  const copyVersion = useMeshTools((s) => s.copyVersion)
  const alignment = useStore((s) => s.appliedAlignment)
  const [points, setPoints] = useState<Vec3[]>([])
  const pointsRef = useRef(points)
  const [firstSideCount, setFirstSideCount] = useState(3)
  const [secondSideCount, setSecondSideCount] = useState(3)
  const total = firstSideCount + secondSideCount
  const [dragging, setDragging] = useState(false)
  const [drawing, setDrawing] = useState(false)
  const [width, setWidth] = useState(2)
  const [bend, setBend] = useState(1)
  const [preview, setPreview] = useState<{ triangles: Float32Array; report: BridgeReport } | null>(null)
  const [guidance, setGuidance] = useState<BridgeGuidance | null>(null)
  const [adjustment, setAdjustment] = useState<{ points: Vec3[]; bend: number; moved: number[] } | null>(null)
  const generation = useRef(0)
  const invalidate = (resetBend = true) => {
    generation.current++
    setPreview(null)
    setGuidance(null)
    if (resetBend) {
      setBend(1)
      setAdjustment(null)
    }
  }
  const clear = () => {
    invalidate()
    meshSceneOf(sceneRef.current)?.cancelBridgeDrag()
    setDragging(false)
    setDrawing(false)
    pointsRef.current = []
    setPoints([])
  }
  useEffect(() => {
    clear()
    // Sample coordinates are meaningful only on the mesh and alignment picked.
  }, [active, copyVersion, alignment])
  useEffect(() => onScan({ loaded: clear, swapped: clear }), [])
  useEffect(() => {
    meshSceneOf(sceneRef.current)?.setBridgePreview(active ? points : [], active ? preview?.triangles ?? null : null,
      active ? guidance : null, active ? adjustment?.moved ?? [] : [])
    return () => meshSceneOf(sceneRef.current)?.setBridgePreview([], null)
  }, [active, points, preview, guidance, adjustment, sceneRef])
  const pick = (hit: PickHit) => {
    if (!active || useMeshTools.getState().editing || useStore.getState().busy) return
    if (drawing || dragging || (points.length === total && !hit.ctrlKey)) return
    invalidate()
    pointsRef.current = hit.ctrlKey ? points.slice(0, -1) : [...points, [...hit.point]]
    setPoints(pointsRef.current)
  }
  const check = async (samples = pointsRef.current, bridgeWidth = width, bridgeBend = 1) => {
    const worker = session.clientRef.current
    if (!worker) {
      useStore.getState().setError('The mesh worker is not running.')
      return
    }
    const version = ++generation.current
    const client = meshToolsOf(worker)
    const scanVersion = client.scanVersion, editedVersion = client.editedVersion
    setPreview(null)
    setGuidance(null)
    useMeshTools.getState().setEditing(true)
    useStore.getState().setError(null)
    try {
      const result = await client.bridgeCheck({ points: samples, width: bridgeWidth, firstSideCount, bend: bridgeBend })
      if (version === generation.current && scanVersion === client.scanVersion && editedVersion === client.editedVersion) {
        if ('guidance' in result) {
          setGuidance(result.guidance)
          useStore.getState().setError(result.guidance.message)
          useStore.getState().setStatus(result.guidance.message)
        } else {
          setBend(bridgeBend)
          setPreview(result)
          useStore.getState().setStatus('Bridge preview only. Check both attachments, then apply. The inferred surface is not measured scan data.')
        }
      }
    } catch (e) {
      if (version === generation.current) {
        const message = e instanceof Error ? e.message : String(e)
        setGuidance({ message, points: [] })
        useStore.getState().setError(message)
      }
    } finally {
      useMeshTools.getState().setEditing(false)
    }
  }
  const reduceBend = async () => {
    const worker = session.clientRef.current
    if (!worker) {
      useStore.getState().setError('The mesh worker is not running.')
      return
    }
    if (!guidance?.canReduceBend || useMeshTools.getState().editing || useStore.getState().busy) return
    const version = ++generation.current
    const client = meshToolsOf(worker)
    const scanVersion = client.scanVersion, editedVersion = client.editedVersion
    useMeshTools.getState().setEditing(true)
    useStore.getState().setError(null)
    useStore.getState().setStatus('Searching for a valid reduced-bend preview...')
    try {
      const result = await client.reduceBridgeBend({ points: pointsRef.current, width, firstSideCount, bend })
      if (version !== generation.current || scanVersion !== client.scanVersion || editedVersion !== client.editedVersion) return
      setBend(result.bend)
      setPreview({ triangles: result.triangles, report: result.report })
      setGuidance(null)
      useStore.getState().setStatus(`Reduced-bend preview: ${(result.bend * 100).toFixed(1)}% of sampled bow retained. Points, attachments and width are unchanged. Inspect before Apply; this is not an exact maximum-curvature solution.`)
    } catch (error) {
      if (version === generation.current) {
        const message = error instanceof Error ? error.message : String(error)
        setGuidance((current) => current ? { ...current, message } : { message, points: [] })
        useStore.getState().setError(message)
      }
    } finally { useMeshTools.getState().setEditing(false) }
  }
  const adjustPoints = async () => {
    const worker = session.clientRef.current
    if (!worker) {
      useStore.getState().setError('The mesh worker is not running.')
      return
    }
    if ((!guidance?.canReduceBend && !(preview && bend < 1)) || useMeshTools.getState().editing || useStore.getState().busy) return
    const version = ++generation.current
    const client = meshToolsOf(worker)
    const scanVersion = client.scanVersion, editedVersion = client.editedVersion
    const previous = pointsRef.current.map((p): Vec3 => [...p])
    useMeshTools.getState().setEditing(true)
    useStore.getState().setError(null)
    useStore.getState().setStatus('Searching for valid surface guide positions...')
    try {
      const result = await client.adjustBridgePoints({ points: previous, width, firstSideCount })
      if (version !== generation.current || scanVersion !== client.scanVersion || editedVersion !== client.editedVersion) return
      if (result.moved.length) setAdjustment({ points: previous, bend, moved: result.moved })
      pointsRef.current = result.points
      setPoints(result.points)
      setBend(1)
      setPreview({ triangles: result.triangles, report: result.report })
      setGuidance(null)
      useStore.getState().setStatus(result.moved.length
        ? `Adjusted guide points ${result.moved.map((i) => i + 1).join(', ')} on the scan. Green rings mark moved points. Rim points and width stayed fixed; full sampled bend is used. Inspect before Apply, or restore previous points.`
        : 'The original guide points already give a valid preview at full sampled bend. No points moved.')
    } catch (error) {
      if (version === generation.current) {
        const message = error instanceof Error ? error.message : String(error)
        // Keep any previously valid reduced-bend preview available on failure.
        useStore.getState().setError(message)
        useStore.getState().setStatus(message)
        if (!preview) setGuidance((current) => current ? { ...current, message } : { message, points: [] })
      }
    } finally { useMeshTools.getState().setEditing(false) }
  }
  const restorePoints = () => {
    if (!adjustment || useMeshTools.getState().editing || useStore.getState().busy) return
    const previous = adjustment
    invalidate()
    pointsRef.current = previous.points
    setPoints(previous.points)
    setBend(previous.bend)
    void check(previous.points, width, previous.bend)
  }
  const handlers = useRef<{
    start(): boolean
    move(index: number, point: Vec3): void
    end(): void
    drawEnd(samples: BridgeStrokeSample[] | null): void
  }>({
    start: () => false,
    move: (_index: number, _point: Vec3) => {},
    end: () => {},
    drawEnd: () => {},
  })
  handlers.current = {
    start: () => {
      if (!active || useMeshTools.getState().editing || useStore.getState().busy) return false
      invalidate()
      setDragging(true)
      return true
    },
    move: (index, point) => {
      invalidate()
      pointsRef.current = pointsRef.current.map((p, i) => i === index ? [...point] : p)
      setPoints(pointsRef.current)
    },
    end: () => {
      setDragging(false)
      if (pointsRef.current.length === total) void check()
    },
    drawEnd: (samples) => {
      setDragging(false)
      setDrawing(false)
      if (!samples) return
      try {
        const drawn = bridgeStrokePoints(samples, firstSideCount, secondSideCount)
        invalidate()
        pointsRef.current = drawn
        setPoints(drawn)
        void check(drawn)
      } catch (error) {
        useStore.getState().setError(`${error instanceof Error ? error.message : String(error)} Previous reference points were kept.`)
      }
    },
  }
  useEffect(() => {
    const scene = meshSceneOf(sceneRef.current)
    if (!scene || !active) return
    scene.onBridgeDrag = {
      start: () => handlers.current.start(),
      move: (index, point) => handlers.current.move(index, point),
      end: () => handlers.current.end(),
    }
    scene.onBridgeDraw = drawing ? {
      start: () => {
        if (useMeshTools.getState().editing || useStore.getState().busy) return false
        setDragging(true)
        useStore.getState().setError(null)
        return true
      },
      end: (samples) => handlers.current.drawEnd(samples),
    } : null
    sceneRef.current?.layerHost().requestHover()
    return () => {
      scene.cancelBridgeDrag()
      scene.onBridgeDrag = null
      scene.onBridgeDraw = null
    }
  }, [active, drawing, sceneRef])
  useEffect(() => {
    if (!drawing || dragging) return
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      setDrawing(false)
    }
    window.addEventListener('keydown', cancel, true)
    return () => window.removeEventListener('keydown', cancel, true)
  }, [drawing, dragging])
  const apply = async () => {
    if (!preview) {
      useStore.getState().setError('Preview and check the bridge before applying it.')
      return
    }
    const landed = await session.bridgeScan({ points, width, firstSideCount, bend }, { units })
    if (landed) clear()
  }
  return {
    points, width, bend, firstSideCount, secondSideCount, total, dragging, drawing, guidance, report: preview?.report ?? null, pick,
    movedPoints: adjustment?.moved ?? [],
    canAdjustPoints: !!guidance?.canReduceBend || (!!preview && bend < 1),
    adjustPoints: () => void adjustPoints(),
    restorePoints,
    reduceBend: () => void reduceBend(),
    toggleDraw: () => setDrawing((value) => !value),
    setCount: (side: 'first' | 'second', value: number) => {
      const other = side === 'first' ? secondSideCount : firstSideCount
      if (!Number.isInteger(value) || value < 2 || value + other > 10) {
        useStore.getState().setError('Choose at least two points per side and no more than ten total.')
        return
      }
      if (value === (side === 'first' ? firstSideCount : secondSideCount)) return
      clear()
      if (side === 'first') setFirstSideCount(value)
      else setSecondSideCount(value)
    },
    setWidth: (value: number) => {
      const hadPreview = preview !== null || guidance !== null
      invalidate(false)
      setWidth(value)
      if (hadPreview) void check(pointsRef.current, value, bend)
    },
    undoPoint: () => {
      invalidate()
      pointsRef.current = pointsRef.current.slice(0, -1)
      setPoints(pointsRef.current)
    },
    clear,
    check: () => void check(pointsRef.current, width, bend),
    apply: () => void apply(),
  }
}

export type BridgeToolState = ReturnType<typeof useBridgeTool>
