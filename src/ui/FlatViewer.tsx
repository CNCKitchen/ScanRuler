// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState } from 'react'
import type { Vec2 } from '../core/flat/types'
import { FlatScene } from '../viewer/FlatScene'
import { schemeById } from '../viewer/navSchemes'
import { themeById } from '../viewer/viewThemes'
import { useStore } from '../state/store'

/** The 2D Measure viewport, in the same thin-wrapper shape as Viewer:
 *  construct once, wire callbacks through refs so prop changes never
 *  re-create the scene. Mounted only while its workspace is up — unlike the
 *  3D viewport there is no expensive BVH to protect, and a dropped image
 *  redecodes in well under a second. */
export function FlatViewer({
  onReady,
  onPick,
}: {
  /** The scene when it comes up, null when the viewport unmounts — so the
   *  owner never holds a disposed scene. */
  onReady: (scene: FlatScene | null) => void
  onPick: (p: Vec2) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const pickRef = useRef(onPick)
  pickRef.current = onPick
  const readyRef = useRef(onReady)
  readyRef.current = onReady

  const [webglError, setWebglError] = useState<string | null>(null)
  const sceneRef = useRef<FlatScene | null>(null)

  useEffect(() => {
    let scene: FlatScene
    try {
      scene = new FlatScene(
        containerRef.current!,
        themeById(useStore.getState().viewTheme),
      )
    } catch (e) {
      console.error(e)
      setWebglError(e instanceof Error ? e.message : String(e))
      return
    }
    scene.setNavScheme(schemeById(useStore.getState().navScheme))
    scene.onPick = (p) => pickRef.current(p)
    sceneRef.current = scene
    readyRef.current(scene)
    return () => {
      sceneRef.current = null
      readyRef.current(null)
      scene.dispose()
    }
  }, [])

  // The scheme and theme dropdowns live in the status strip and serve every
  // viewport; this one follows them the same way the main view does.
  const navScheme = useStore((s) => s.navScheme)
  const viewTheme = useStore((s) => s.viewTheme)
  useEffect(() => {
    sceneRef.current?.setNavScheme(schemeById(navScheme))
  }, [navScheme])
  useEffect(() => {
    sceneRef.current?.setViewTheme(themeById(viewTheme))
  }, [viewTheme])

  return (
    <div className="viewport" ref={containerRef}>
      {webglError !== null && (
        <div className="webgl-missing" role="alert">
          <b>The 2D view could not be started.</b>
          <p>
            This tool draws everything with WebGL, and your browser refused to create a WebGL
            context. Usually that means hardware acceleration is switched off or the graphics
            driver is blocklisted.
          </p>
          <p className="webgl-missing-detail">{webglError}</p>
        </div>
      )}
    </div>
  )
}
