// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState } from 'react'
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

  // WebGL could not be started — three's renderer constructor threw. Without
  // this catch that exception would take down the whole React tree and leave
  // a bare grey page, which is indistinguishable from a hung app.
  const [webglError, setWebglError] = useState<string | null>(null)

  useEffect(() => {
    let scene: SceneManager
    try {
      scene = new SceneManager(containerRef.current!)
    } catch (e) {
      console.error(e)
      setWebglError(e instanceof Error ? e.message : String(e))
      return
    }
    scene.onPick = (hit) => pickRef.current(hit)
    scene.onHover = (hit) => hoverRef.current?.(hit)
    scene.onElementPick = (id) => elementPickRef.current?.(id)
    scene.onPaintChange = (count) => paintRef.current?.(count)
    scene.onExtendDrag = (side, delta, phase) => extendRef.current?.(side, delta, phase)
    readyRef.current(scene)
    return () => scene.dispose()
  }, [])

  return (
    <div className="viewport" ref={containerRef}>
      {webglError !== null && (
        <div className="webgl-missing" role="alert">
          <b>The 3D view could not be started.</b>
          <p>
            This tool draws everything with WebGL, and your browser refused to create a WebGL
            context. Usually that means hardware acceleration is switched off or the graphics
            driver is blocklisted.
          </p>
          <p>
            In Firefox, check <i>Settings → General → Performance → Use hardware acceleration
            when available</i> (and that <code>webgl.disabled</code> is <code>false</code> in{' '}
            <code>about:config</code>), then reload. Failing that, try another browser — nothing
            is uploaded either way, all processing stays on your machine.
          </p>
          <p className="webgl-missing-detail">{webglError}</p>
        </div>
      )}
    </div>
  )
}
