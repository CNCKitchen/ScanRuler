import { useEffect, useRef } from 'react'
import { SceneManager } from '../viewer/SceneManager'

export function Viewer({
  onReady,
  onPick,
}: {
  onReady: (scene: SceneManager) => void
  onPick: (faceVertices: [number, number, number]) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const pickRef = useRef(onPick)
  pickRef.current = onPick
  const readyRef = useRef(onReady)
  readyRef.current = onReady

  useEffect(() => {
    const scene = new SceneManager(containerRef.current!)
    scene.onPick = (v) => pickRef.current(v)
    readyRef.current(scene)
    return () => scene.dispose()
  }, [])

  return <div className="viewport" ref={containerRef} />
}
