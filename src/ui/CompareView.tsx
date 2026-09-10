// SPDX-License-Identifier: AGPL-3.0-only
// The reference half of the split view, standing beside the main viewport.
//
// It hangs off the main scene rather than replacing it: the scan keeps the
// viewport it has always had — with its map, its hover reading and its pins —
// and this is a second one linked to its camera. Which is also why the main
// Viewer keeps its exact place in the tree when the split opens; moved into a
// wrapper it would be unmounted and remounted, and a scan's BVH costs seconds
// to build.

import { useEffect, useRef } from 'react'
import type * as THREE from 'three'
import { useStore } from '../state/store'
import { CompareScene } from '../viewer/CompareScene'
import { schemeById } from '../viewer/navSchemes'
import type { SceneManager } from '../viewer/SceneManager'
import { themeById } from '../viewer/viewThemes'

export function CompareView({
  scene,
  geometry,
  role,
  name,
}: {
  /** The main viewport, whose camera this half follows — and which follows it
   *  back when the hand is on this side. */
  scene: SceneManager
  geometry: THREE.BufferGeometry
  role: string
  name: string
}) {
  const holder = useRef<HTMLDivElement>(null)
  const compareRef = useRef<CompareScene | null>(null)
  const navScheme = useStore((s) => s.navScheme)
  const viewTheme = useStore((s) => s.viewTheme)
  const showBackfaces = useStore((s) => s.showBackfaces)
  const translucent = useStore((s) => s.translucent)
  const wireframe = useStore((s) => s.wireframe)

  useEffect(() => {
    const compare = new CompareScene(
      holder.current!,
      geometry,
      themeById(useStore.getState().viewTheme),
    )
    compare.setNavScheme(schemeById(useStore.getState().navScheme))
    // Read from the store rather than from the prop, so a half opened with the
    // switch already on is tinted on its first frame instead of on the next
    // change of it.
    compare.setBackfaceTint(useStore.getState().showBackfaces)
    compare.setTranslucent(useStore.getState().translucent)
    compare.setWireframe(useStore.getState().wireframe)
    compare.linkTo(scene.viewLink())
    compareRef.current = compare
    return () => {
      compare.dispose()
      compareRef.current = null
    }
  }, [geometry, scene])

  useEffect(() => {
    compareRef.current?.setNavScheme(schemeById(navScheme))
  }, [navScheme])

  useEffect(() => {
    compareRef.current?.setViewTheme(themeById(viewTheme))
  }, [viewTheme])

  // The status strip's switch is one statement about the models, so it holds
  // for both halves: the scan's viewport takes it in useSceneSync, this one
  // here.
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
    <div className="comparehalf" data-test="compare-half">
      <div className="compareview" ref={holder} />
      <div className="splitcap">
        <b>{role}</b>
        <span>{name}</span>
      </div>
    </div>
  )
}
