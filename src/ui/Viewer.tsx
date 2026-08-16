// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef } from 'react'
import { SceneManager, type PickHit } from '../viewer/SceneManager'
import type { ExtendSide } from '../core/elements/extend'

export function Viewer({
  onReady,
  onPick,
  onHover,
  onElementPick,
  onPaintChange,
  onExtendDrag,
}: {
  onReady: (scene: SceneManager) => void
  onPick: (hit: PickHit) => void
  onHover?: (hit: PickHit | null) => void
  /** A click that landed on an existing element while element picking is on. */
  onElementPick?: (id: number) => void
  /** A brush stroke ended, with this many vertices marked in total. */
  onPaintChange?: (count: number) => void
  /** One of the grips on the element being made was dragged this far. */
  onExtendDrag?: (side: ExtendSide, delta: number, phase: 'start' | 'move' | 'end') => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const pickRef = useRef(onPick)
  pickRef.current = onPick
  const hoverRef = useRef(onHover)
  hoverRef.current = onHover
  const elementPickRef = useRef(onElementPick)
  elementPickRef.current = onElementPick
  const paintRef = useRef(onPaintChange)
  paintRef.current = onPaintChange
  const extendRef = useRef(onExtendDrag)
  extendRef.current = onExtendDrag
  const readyRef = useRef(onReady)
  readyRef.current = onReady

  useEffect(() => {
    const scene = new SceneManager(containerRef.current!)
    scene.onPick = (hit) => pickRef.current(hit)
    scene.onHover = (hit) => hoverRef.current?.(hit)
    scene.onElementPick = (id) => elementPickRef.current?.(id)
    scene.onPaintChange = (count) => paintRef.current?.(count)
    scene.onExtendDrag = (side, delta, phase) => extendRef.current?.(side, delta, phase)
    readyRef.current(scene)
    return () => scene.dispose()
  }, [])

  return <div className="viewport" ref={containerRef} />
}
