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
    <div className="comparehalf" data-test="compare-half">
      <div className="compareview" ref={holder} />
      <div className="splitcap">
        <b>{role}</b>
        <span>{name}</span>
      </div>
    </div>
  )
}
