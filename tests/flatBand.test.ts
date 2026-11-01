// SPDX-License-Identifier: AGPL-3.0-only
// The 2D sheet's rubber band, driven through its own methods on a stand-in
// for the scene: a gesture the browser cancels draws no region, and leaves
// nothing listening for the next release. A real FlatScene needs WebGL, so
// what is checked here is the band's handling of the document's events.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FlatScene } from '../src/viewer/FlatScene'

type Band = { beginBand(e: PointerEvent): void; bandDiv: unknown }

function pointer(type: string, x = 0, y = 0): PointerEvent {
  return Object.assign(new Event(type), { clientX: x, clientY: y, altKey: false }) as PointerEvent
}

describe('the rubber band', () => {
  const realDocument = globalThis.document
  afterEach(() => {
    globalThis.document = realDocument
  })

  it('is dropped on pointercancel, and the next release selects nothing', () => {
    const doc = Object.assign(new EventTarget(), {
      createElement: () => ({ style: {}, className: '', remove: vi.fn() }),
    })
    globalThis.document = doc as unknown as Document
    const proto = FlatScene.prototype as unknown as Record<string, unknown>
    const scene = {
      container: { appendChild: () => {}, getBoundingClientRect: () => ({ x: 0, y: 0 }) },
      bandDiv: null,
      bandStart: null,
      layoutBand: proto.layoutBand,
      dropBand: proto.dropBand,
      finishBand: vi.fn(),
    }
    ;(proto.beginBand as Band['beginBand']).call(scene, pointer('pointerdown', 10, 10))
    expect(scene.bandDiv).not.toBeNull()
    doc.dispatchEvent(pointer('pointercancel', 40, 40))
    expect(scene.bandDiv).toBeNull()
    doc.dispatchEvent(pointer('pointerup', 80, 80))
    expect(scene.finishBand).not.toHaveBeenCalled()
  })
})
