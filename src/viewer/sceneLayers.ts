// SPDX-License-Identifier: AGPL-3.0-only
// What a plugin draws in the 3D viewport, and picks there: a layer the
// SceneManager is handed (SceneManager.addLayer), in the part's frame beside
// the scan, told of every change the viewport goes through — the colour
// scheme, the slice through the part, the scan moved or replaced — and asked
// in its turn about every press, click and hover.
//
// The viewport's own picks stand in the same order the layers do, by number:
// a measured element under the cursor at 30, a coordinate plane on offer at
// 60, the grips on the element being made at 15; the scan itself is last. A
// layer picks its place among them.

import type * as THREE from 'three'
import type { Rigid } from '../core/deviation/rigid'
import type { Vec3 } from '../core/types'
import type { PickHit } from './SceneManager'
import type { ViewTheme } from './viewThemes'

/** Where the viewport's own picks stand among the layers'. */
export const LAYER_ORDER = {
  /** The grips on the element being made, and a plugin's grips. */
  grips: 15,
  /** A measured element under the cursor, while element picking is on. */
  elements: 30,
  /** A coordinate plane on offer to a section. */
  worldPlanes: 60,
} as const

/** What the viewport lends a layer. */
export interface SceneLayerHost {
  readonly scene: THREE.Scene
  /** The group the scan rides — every alignment and preview pose moves it,
   *  and whatever stands in the scan's frame goes into it. */
  readonly partGroup: THREE.Group
  readonly raycaster: THREE.Raycaster
  readonly canvas: HTMLCanvasElement
  /** The viewport's element, for anything laid over the canvas. */
  readonly container: HTMLElement
  camera(): THREE.OrthographicCamera
  /** Aim the raycaster through a client point. */
  setPickRay(clientX: number, clientY: number): void
  /** A frame is wanted. */
  invalidate(): void
  /** Test the pointer again on the next frame — what is under it changed. */
  requestHover(): void
  /** Set the canvas's cursor. */
  setCursor(cursor: string): void
  theme(): ViewTheme
  /** Half the part's bounding-box diagonal — the scale overlays are drawn at. */
  modelRadius(): number
  modelCenter(): Vec3
  /** Whether a scan is loaded. */
  hasScan(): boolean
  /** The scan under a client point, as a click reports it. Null off it, or
   *  with the scan hidden. */
  pickScan(clientX: number, clientY: number): PickHit | null
  /** How far along the pick ray through a client point the scan is met. */
  scanDistanceAt(clientX: number, clientY: number): number | null
  /** The planes the part is clipped by, while a slice cuts it open. */
  clipPlanes(): THREE.Plane[] | null
  /** The opacity the scan is drawn at — see-through or solid. */
  scanOpacity(): number
  /** A click at a client point, answered as the viewport answers one. */
  click(clientX: number, clientY: number, additive: boolean): void
  /** With no scan loaded, the part's size — what overlays are drawn at —
   *  comes from the layer: see SceneManager.sizeStage. */
  sizeStage(radius: number, frame?: THREE.Box3): void
  /** The sphere the camera last framed, in world coordinates. */
  framedSphere(): THREE.Sphere
}

/** A plugin's layer. Every part is optional but `order` and `dispose`. */
export interface SceneLayer {
  /** Where the layer's clicks and hovers stand among the viewport's own and
   *  the other layers' — see LAYER_ORDER. Lower comes first. */
  order: number
  /** Whether what the layer lights under the cursor covers the layers after
   *  it: a grip or a sketch region does; a body's face does not. */
  covers?: boolean
  /** A press: true when the layer takes it, the camera standing aside. */
  pointerDown?(e: PointerEvent): boolean
  /** A click that survived the drag threshold: true when the layer took it. */
  click?(clientX: number, clientY: number, additive: boolean): boolean
  /** A click nothing took — on the scan, or on empty space — without Ctrl. */
  clickedAway?(clientX: number, clientY: number): void
  /** The pointer, once per frame it may have moved over something new —
   *  null off the canvas; `covered` while something before this layer is lit
   *  under it. True when the layer lit something. */
  hover?(at: { x: number; y: number } | null, covered: boolean): boolean
  /** The arrow keys with the cursor at `at`, over things that lie one
   *  behind another: step to the next of what the layer has under the
   *  cursor (`step` 1) — the face behind the one in front — or back (−1).
   *  `behind`: something before this layer would take a click there, so a
   *  first step lands on this layer's own first. True when the layer took
   *  the step; it then lights what it stepped to. */
  cycle?(at: { x: number; y: number }, step: 1 | -1, behind: boolean): boolean
  /** Whether a step taken with `cycle` still holds with the cursor at `at`
   *  (null: off the canvas) — it does until the cursor moves off the spot.
   *  While it holds, the layer alone lights under the cursor and takes the
   *  next click, ahead of every layer before it. */
  cycling?(at: { x: number; y: number } | null): boolean
  /** Every frame, before it is drawn, with the canvas's size in pixels. */
  tick?(width: number, height: number): void
  themeChanged?(theme: ViewTheme): void
  /** The part was cut open at a plane — or closed again, with null. */
  clippingChanged?(planes: THREE.Plane[] | null): void
  /** The scan's opacity changed — see-through, or solid again. */
  opacityChanged?(opacity: number): void
  /** The weight of the lines drawn on the part, px. */
  lineWidthChanged?(px: number): void
  /** A datum alignment was baked into the scan's vertices: what stands in
   *  the scan's frame and holds vertices of its own moves with it. */
  partMoved?(transform: Rigid): void
  /** The scan was taken away or replaced: what was made of it goes. */
  scanReplaced?(): void
  /** What an orbit may pivot on, while shown. */
  navTargets?(): THREE.Object3D[]
  /** What the camera frames when there is no scan to frame. */
  frameBox?(): THREE.Box3 | null
  dispose(): void
}
