// SPDX-License-Identifier: AGPL-3.0-only
// The overlays draw the measured elements, and the sections the cuts, over and
// over as the workspace changes — and a material let go on each rebuild takes
// its shader program with it, to be compiled again on the tap that draws it
// next. So: an update that would draw what is drawn already draws nothing,
// a rebuild keeps the materials of the elements that exist and sets their
// colour in place, and only an element's own going lets its materials go.
import * as THREE from 'three'
import { Line2 } from 'three/addons/lines/Line2.js'
import { describe, expect, it, vi } from 'vitest'
import type { FitData } from '../src/core/types'
import { Overlays, type OverlayElement, type OverlayPair } from '../src/viewer/overlays'
import { SectionOverlay, type SectionOverlayItem } from '../src/viewer/sections'

// A pin is an HTML label; there is no page to make it on here, and what it
// says is not what is tested.
vi.mock('../src/viewer/pinLabel', async (original) => ({
  ...(await original<typeof import('../src/viewer/pinLabel')>()),
  pinLabel: () => Object.assign(new THREE.Object3D(), { element: { remove() {} } }),
}))

const plane: FitData = {
  kind: 'plane',
  center: [0, 0, 0],
  normal: [0, 0, 1],
  basisU: [1, 0, 0],
  basisV: [0, 1, 0],
  extentU: 5,
  extentV: 4,
  sigma: 0.01,
  usedPoints: 100,
  regionSize: 100,
}
const cylinder: FitData = {
  kind: 'cylinder',
  center: [10, 0, 0],
  axis: [0, 0, 1],
  radius: 3,
  length: 8,
  coverage: 180,
  sigma: 0.01,
  usedPoints: 100,
  regionSize: 100,
}

const element = (id: number, fit: FitData, over: Partial<OverlayElement> = {}): OverlayElement => ({
  id,
  name: `E${id}`,
  color: '#3366cc',
  fit,
  style: 'shell',
  ...over,
})

function makeOverlays() {
  const partGroup = new THREE.Group()
  const camera = new THREE.PerspectiveCamera()
  const overlays = new Overlays({
    partGroup,
    modelRadius: () => 10,
    invalidate: () => {},
    camera: () => camera,
    raycaster: new THREE.Raycaster(),
    occluder: () => null,
  })
  return { overlays, root: overlays.clipRoots()[0] }
}

/** Every material under the element overlays, once each. */
function materialsUnder(root: THREE.Object3D): Set<THREE.Material> {
  const found = new Set<THREE.Material>()
  root.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.Material | undefined
    if (m) found.add(m)
  })
  return found
}

/** Which materials are disposed from now on. */
function watchDisposal(materials: Iterable<THREE.Material>): Set<THREE.Material> {
  const gone = new Set<THREE.Material>()
  for (const m of materials) m.addEventListener('dispose', () => gone.add(m))
  return gone
}

describe('the element overlays', () => {
  it('draw nothing again when asked for what is drawn, though the input is made afresh', () => {
    const { overlays, root } = makeOverlays()
    expect(overlays.updateOverlays([element(1, plane), element(2, cylinder)], [], [], [], true)).toBe(true)
    const meshes = [...root.children]
    // The same again, in objects of its own.
    expect(
      overlays.updateOverlays([element(1, { ...plane }), element(2, { ...cylinder })], [], [], [], true),
    ).toBe(false)
    expect(root.children.length).toBe(meshes.length)
    expect(root.children.every((c, i) => c === meshes[i])).toBe(true)
  })

  it('draw again for each thing they draw from changing', () => {
    const { overlays } = makeOverlays()
    const base = () => [element(1, plane), element(2, cylinder)]
    overlays.updateOverlays(base(), [], [], [], true)
    const changed: [string, OverlayElement[], boolean][] = [
      ['a name', [element(1, plane, { name: 'other' }), element(2, cylinder)], true],
      ['a colour', [element(1, plane, { color: '#cc3333' }), element(2, cylinder)], true],
      ['a style', [element(1, plane, { style: 'outline' }), element(2, cylinder)], true],
      ['muting', [element(1, plane, { muted: true }), element(2, cylinder)], true],
      ['a figure', [element(1, plane, { value: '12.5' }), element(2, cylinder)], true],
      ['a fit', [element(1, { ...plane, extentU: 6 }), element(2, cylinder)], true],
      ['an element gone', [element(2, cylinder)], true],
      ['an element added', [element(2, cylinder), element(3, plane)], true],
      ['visibility', [element(2, cylinder), element(3, plane)], false],
    ]
    for (const [what, input, visible] of changed) {
      expect(overlays.updateOverlays(input, [], [], [], visible), what).toBe(true)
      expect(overlays.updateOverlays(structuredClone(input), [], [], [], visible), `${what}, then the same`).toBe(false)
    }
  })

  it('draw again for a dimension that changes, a pair, an angle or a pin', () => {
    const { overlays } = makeOverlays()
    const els = [element(1, plane)]
    const pair: OverlayPair = { a: [0, 0, 0], b: [10, 0, 0], title: 'D1', value: '10.000' }
    overlays.updateOverlays(els, [pair], [], [], true)
    expect(overlays.updateOverlays(els, [{ ...pair }], [], [], true)).toBe(false)
    expect(overlays.updateOverlays(els, [{ ...pair, value: '10.500' }], [], [], true)).toBe(true)
    expect(overlays.updateOverlays(els, [{ ...pair, value: '10.500', over: true }], [], [], true)).toBe(true)
    expect(overlays.updateOverlays(els, [], [], [], true)).toBe(true)
  })

  it('draw again after being put away by hand, though asked for what they were', () => {
    const { overlays } = makeOverlays()
    const [elements] = overlays.clipRoots()
    overlays.updateOverlays([element(1, plane)], [], [], [], true)
    overlays.setShown(false)
    expect(elements.visible).toBe(false)
    expect(overlays.updateOverlays([element(1, plane)], [], [], [], true)).toBe(true)
    expect(elements.visible).toBe(true)
  })

  it('keep the same materials across a rebuild, setting the colour in place', () => {
    const { overlays, root } = makeOverlays()
    overlays.updateOverlays([element(1, plane), element(2, cylinder)], [], [], [], true)
    const first = materialsUnder(root)
    expect(first.size).toBeGreaterThan(2)
    const gone = watchDisposal(first)
    const shellOf = (c: THREE.Object3D) => (c as THREE.Mesh).material as THREE.MeshStandardMaterial
    const shell = [...root.children].map(shellOf).find((m) => m.isMeshStandardMaterial)!
    const flags = { transparent: shell.transparent, side: shell.side, depthWrite: shell.depthWrite, polygonOffset: shell.polygonOffset }

    overlays.updateOverlays([element(1, plane, { color: '#cc3333' }), element(2, cylinder)], [], [], [], true)
    const second = materialsUnder(root)
    expect([...second].every((m) => first.has(m))).toBe(true)
    expect(second.size).toBe(first.size)
    expect(gone.size).toBe(0)
    expect(shell.color.getHexString()).toBe(new THREE.Color('#cc3333').getHexString())
    // Nothing that picks a program was touched.
    expect({ transparent: shell.transparent, side: shell.side, depthWrite: shell.depthWrite, polygonOffset: shell.polygonOffset }).toEqual(flags)
  })

  it('let go of the materials of an element that is gone, and of no other', () => {
    const { overlays, root } = makeOverlays()
    overlays.updateOverlays([element(1, plane), element(2, cylinder)], [], [], [], true)
    const mine = (id: number) =>
      new Set(
        overlays
          .pickTargets()
          .filter((o) => o.userData.elementId === id)
          .map((o) => (o as THREE.Mesh).material as THREE.Material),
      )
    const first = mine(1)
    const second = mine(2)
    const all = materialsUnder(root)
    const gone = watchDisposal(all)

    overlays.updateOverlays([element(2, cylinder)], [], [], [], true)
    for (const m of first) expect(gone.has(m)).toBe(true)
    for (const m of second) expect(gone.has(m)).toBe(false)
  })

  it('keep the materials of an element that exists though it is not drawn', () => {
    const { overlays, root } = makeOverlays()
    const exists = new Set([1, 2])
    overlays.updateOverlays([element(1, plane), element(2, cylinder)], [], [], [], true, exists)
    const drawn = materialsUnder(root)
    const gone = watchDisposal(drawn)

    // Away to a workspace that draws none of them, and back.
    overlays.updateOverlays([], [], [], [], false, exists)
    expect(root.children.length).toBe(0)
    expect(gone.size).toBe(0)
    overlays.updateOverlays([element(1, plane), element(2, cylinder)], [], [], [], true, exists)
    expect([...materialsUnder(root)].every((m) => drawn.has(m))).toBe(true)
    expect(gone.size).toBe(0)

    // One of them goes for good while the other is away.
    overlays.updateOverlays([], [], [], [], false, new Set([2]))
    expect(gone.size).toBeGreaterThan(0)
    overlays.updateOverlays([element(2, cylinder)], [], [], [], true, new Set([2]))
    const back = materialsUnder(root)
    expect([...back].some((m) => gone.has(m))).toBe(false)
  })

  it('take a material back unclipped, whatever the section view left it holding', () => {
    const { overlays, root } = makeOverlays()
    overlays.updateOverlays([element(1, plane)], [], [], [], true)
    const cut = [new THREE.Plane(new THREE.Vector3(0, 0, 1), 0)]
    for (const m of materialsUnder(root)) m.clippingPlanes = cut
    overlays.updateOverlays([element(1, plane, { color: '#cc3333' })], [], [], [], true)
    for (const m of materialsUnder(root)) expect(m.clippingPlanes).toBeNull()
  })

  it('draw every callout and every selection stroke with one material, kept', () => {
    const { overlays, root } = makeOverlays()
    const [, strokes] = overlays.clipRoots()
    const a: OverlayPair = { a: [0, 0, 0], b: [10, 0, 0], title: 'D1', value: '10' }
    const b: OverlayPair = { a: [0, 0, 0], b: [0, 10, 0], title: 'D2', value: '10' }
    overlays.updateOverlays([element(1, plane), element(2, cylinder)], [a, b], [], [], true)
    const lines = root.children.filter((c) => (c as THREE.Line).isLine && !(c as THREE.LineSegments).isLineSegments)
    // The guides are lines too, each with a material of its own: the callouts
    // are the lines that share one.
    const callouts = new Set(lines.map((l) => (l as THREE.Line).material as THREE.Material))
    const shared = [...callouts].filter((m) => lines.filter((l) => (l as THREE.Line).material === m).length >= 2)
    expect(shared.length).toBe(1)

    overlays.setHighlightedElements([1, 2])
    const hulls = new Set(strokes.children.map((c) => (c as THREE.Mesh).material as THREE.Material))
    expect(hulls.size).toBe(2)
    const gone = watchDisposal([...hulls, ...shared])
    // Hover moves the selection about, and the zoom rebuilds it.
    overlays.setHighlightedElements([2])
    overlays.setHighlightedElements([1, 2])
    overlays.setPixelScale(0.5)
    expect(gone.size).toBe(0)
    expect(new Set(strokes.children.map((c) => (c as THREE.Mesh).material as THREE.Material))).toEqual(hulls)
  })

  it('let go of everything when put away for good', () => {
    const { overlays, root } = makeOverlays()
    overlays.updateOverlays([element(1, plane)], [{ a: [0, 0, 0], b: [1, 0, 0], title: 'D', value: '1' }], [], [], true)
    overlays.setHighlightedElements([1])
    const [, strokes] = overlays.clipRoots()
    const all = new Set([...materialsUnder(root), ...materialsUnder(strokes)])
    const gone = watchDisposal(all)
    overlays.dispose()
    expect([...all].every((m) => gone.has(m))).toBe(true)
  })
})

describe('the sections', () => {
  const section = (id: number, color = '#22aa66'): SectionOverlayItem => ({
    id,
    name: `S${id}`,
    color,
    frame: { origin: [0, 0, 0], normal: [0, 0, 1], basisU: [1, 0, 0], basisV: [0, 1, 0] },
    cut: { points: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0]), offsets: new Uint32Array([0, 3]) },
    elements: [{ kind: 'point', center: [0.5, 0.5, 0] } as never],
  })
  function makeSections() {
    const sections = new SectionOverlay({
      partGroup: new THREE.Group(),
      modelRadius: () => 10,
      modelCenter: () => [0, 0, 0],
      invalidate: () => {},
    })
    const root = sections.clipRoots()[0]
    return { sections, root }
  }

  it('keep a section’s materials across rebuilds and across being put away', () => {
    const { sections, root } = makeSections()
    sections.setSections([section(1), section(2)], true)
    const first = materialsUnder(root)
    expect(first.size).toBeGreaterThan(2)
    const gone = watchDisposal(first)
    const cutLine = root.children.find((c) => (c as Line2).isLine2) as Line2
    const flags = { transparent: cutLine.material.transparent, depthTest: cutLine.material.depthTest }

    sections.setSections([section(1, '#aa2266'), section(2)], true)
    expect([...materialsUnder(root)].every((m) => first.has(m))).toBe(true)
    expect(gone.size).toBe(0)
    // Put away with the workspace and shown again.
    sections.setSections([section(1), section(2)], false)
    expect(root.children.length).toBe(0)
    sections.setSections([section(1), section(2)], true)
    expect([...materialsUnder(root)].every((m) => first.has(m))).toBe(true)
    expect(gone.size).toBe(0)
    expect({ transparent: cutLine.material.transparent, depthTest: cutLine.material.depthTest }).toEqual(flags)
  })

  it('set the colour in place and let go of a section that is gone', () => {
    const { sections, root } = makeSections()
    sections.setSections([section(1), section(2)], true)
    const lineOf = (id: number) => root.children.filter((c) => (c as Line2).isLine2)[id - 1] as Line2
    const one = lineOf(1).material
    const two = lineOf(2).material
    const gone = watchDisposal([one, two])

    sections.setSections([section(1, '#aa2266')], true)
    expect(lineOf(1).material).toBe(one)
    expect(one.color.getHex()).toBe(new THREE.Color('#aa2266').getHex())
    expect(gone.has(one)).toBe(false)
    expect(gone.has(two)).toBe(true)
  })

  it('let go of everything when put away for good', () => {
    const { sections, root } = makeSections()
    sections.setSections([section(1)], true)
    const all = materialsUnder(root)
    const gone = watchDisposal(all)
    sections.dispose()
    expect([...all].every((m) => gone.has(m))).toBe(true)
  })
})
