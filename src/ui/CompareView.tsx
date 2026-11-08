// SPDX-License-Identifier: AGPL-3.0-only
// The reference half of the split view, standing beside the main viewport.
//
// It hangs off the main scene rather than replacing it: the scan keeps the
// viewport it has always had — with its map, its hover reading and its pins —
// and this is a second one linked to its camera. Which is also why the main
// Viewer keeps its exact place in the tree when the split opens; moved into a
// wrapper it would be unmounted and remounted, and a scan's BVH costs seconds
// to build.
//
// Once opened it is kept, hidden, when the split view closes: a new half is a
// new WebGL context and a new upload of the reference's vertex buffers, and the
// stage needs both again at the next tap of the switch. Hidden, it draws
// nothing and reads no layout. What changes in the stores meanwhile is applied
// as it arrives (the effects below keep running, and setting a uniform on a
// paused viewport is only a flag), except for the camera and the section
// plane, which are read off the scan every frame and so are caught up when
// the half is shown again.

import { useEffect, useRef } from 'react'
import type * as THREE from 'three'
import { useDeviation } from '../state/deviationStore'
import { usePrefs } from '../state/prefsStore'
import { useStore } from '../state/store'
import { CompareScene } from '../viewer/CompareScene'
import { schemeById } from '../viewer/navSchemes'
import type { SceneManager } from '../viewer/SceneManager'
import { sceneTheme } from '../viewer/viewThemes'

export function CompareView({
  scene,
  geometry,
  role,
  name,
  active,
}: {
  /** The main viewport, whose camera this half follows — and which follows it
   *  back when the hand is on this side. */
  scene: SceneManager
  geometry: THREE.BufferGeometry
  role: string
  name: string
  /** Whether the half is on the stage. False keeps it, and its context, alive
   *  but paused and out of the layout. */
  active: boolean
}) {
  const holder = useRef<HTMLDivElement>(null)
  const compareRef = useRef<CompareScene | null>(null)
  const navScheme = useStore((s) => s.navScheme)
  const viewTheme = useStore((s) => s.viewTheme)
  const showBackfaces = useDeviation((s) => s.nominalBackfaces)
  const translucent = useDeviation((s) => s.nominalSeeThrough)
  const wireframe = useDeviation((s) => s.nominalMesh)

  useEffect(() => {
    const compare = new CompareScene(
      holder.current!,
      geometry,
      sceneTheme(useStore.getState().viewTheme, usePrefs.getState().dark),
    )
    compare.setNavScheme(schemeById(useStore.getState().navScheme))
    compare.setProjection(useStore.getState().projection)
    // Read from the store rather than from the prop, so a half opened with the
    // switch already on is tinted on its first frame instead of on the next
    // change of it.
    const look = useDeviation.getState()
    compare.setBackfaceTint(look.nominalBackfaces)
    compare.setTranslucent(look.nominalSeeThrough)
    compare.setWireframe(look.nominalMesh)
    compare.linkTo(scene.viewLink())
    // And cut where the scan's half is cut by the section view.
    compare.followSection(() => scene.sectionClip())
    compareRef.current = compare
    return () => {
      compare.dispose()
      compareRef.current = null
    }
  }, [geometry, scene])

  // Shown again: the scan's camera has moved on while this half stood still, so
  // the link is made afresh, which puts this half in the scan's pose (see
  // CameraLink). Runs after the effect above on a fresh half, which is then
  // linked twice; one pose copy.
  useEffect(() => {
    const compare = compareRef.current
    if (!compare) return
    compare.setPaused(!active)
    if (active) compare.linkTo(scene.viewLink())
  }, [active, geometry, scene])

  useEffect(() => {
    compareRef.current?.setNavScheme(schemeById(navScheme))
  }, [navScheme])

  const projection = useStore((s) => s.projection)
  useEffect(() => {
    compareRef.current?.setProjection(projection)
  }, [projection])

  const dark = usePrefs((s) => s.dark)
  useEffect(() => {
    compareRef.current?.setViewTheme(sceneTheme(viewTheme, dark))
  }, [viewTheme, dark])

  // The Reference key's menu is one statement about the part, so it holds
  // wherever the part is shown: the main viewport takes it in useSceneSync,
  // this one here.
  useEffect(() => {
    compareRef.current?.setBackfaceTint(showBackfaces)
  }, [showBackfaces])
  useEffect(() => {
    compareRef.current?.setTranslucent(translucent)
  }, [translucent])
  useEffect(() => {
    compareRef.current?.setWireframe(wireframe)
  }, [wireframe])

  return (
    <div className="comparehalf" data-test="compare-half" hidden={!active}>
      <div className="compareview" ref={holder} />
      <div className="splitcap">
        <b>{role}</b>
        <span>{name}</span>
      </div>
    </div>
  )
}
