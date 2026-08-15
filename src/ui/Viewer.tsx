// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef } from 'react'
import { SceneManager, type PickHit } from '../viewer/SceneManager'

export function Viewer({
  onReady,
  onPick,
  onHover,
  onElementPick,
}: {
  onReady: (scene: SceneManager) => void
  onPick: (hit: PickHit) => void
  onHover?: (hit: PickHit | null) => void
  /** A click that landed on an existing element while element picking is on. */
  onElementPick?: (id: number) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const pickRef = useRef(onPick)
  pickRef.current = onPick
  const hoverRef = useRef(onHover)
  hoverRef.current = onHover
  const elementPickRef = useRef(onElementPick)
  elementPickRef.current = onElementPick
  const readyRef = useRef(onReady)
  readyRef.current = onReady

  useEffect(() => {
    const scene = new SceneManager(containerRef.current!)
    scene.onPick = (hit) => pickRef.current(hit)
    scene.onHover = (hit) => hoverRef.current?.(hit)
    scene.onElementPick = (id) => elementPickRef.current?.(id)
    readyRef.current(scene)
    return () => scene.dispose()
  }, [])

  return <div className="viewport" ref={containerRef} />
}
