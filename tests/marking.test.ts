// SPDX-License-Identifier: AGPL-3.0-only
import * as THREE from 'three'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { capsulePoints, lineSteps, SurfaceMarking, type MarkingContext, type PaintBrush } from '../src/viewer/marking'

/** A hundred units of world on a hundred pixels of screen: one unit is one pixel
 *  at this camera, which keeps the arithmetic below readable. */
function rig(brush: Partial<PaintBrush> = {}, navigates = false) {
  const listeners: Record<string, (e: PointerEvent) => void> = {}
  const element = () => ({ setAttribute: vi.fn(), append: vi.fn(), remove: vi.fn(), style: { display: '', setProperty: vi.fn() } })
  const svg = element()
  vi.stubGlobal('document', {
    createElementNS: vi.fn((_ns: string, name: string) => (name === 'svg' ? svg : element())),
    addEventListener: (type: string, fn: (e: PointerEvent) => void) => {
      listeners[type] = fn
    },
    removeEventListener: vi.fn(),
  })
  // Every dab asks for a pick ray first, so these are where the dabs landed.
  const dabs: { x: number; y: number }[] = []
  const ctx = {
    container: {
      appendChild: vi.fn(),
      clientWidth: 100,
      clientHeight: 100,
      getBoundingClientRect: () => ({ left: 10, top: 20 }),
    },
    camera: () => ({ top: 50, bottom: -50, zoom: 1 }),
    worldPerPixel: () => 1,
    partGroup: new THREE.Group(),
    // Nothing under any of them: which surface a dab takes is not on trial.
    raycaster: { intersectObject: () => [] },
    regions: { paintCount: 0, clearPaint: () => false },
    setPickRay: (x: number, y: number) => dabs.push({ x, y }),
    mesh: () => ({ visible: true, geometry: new THREE.BufferGeometry() }),
    paintAttr: () => ({ needsUpdate: false }),
    graphVertex: (v: number) => v,
    setPaintColor: vi.fn(),
    invalidate: vi.fn(),
    claimDrag: vi.fn(),
    navigates: () => navigates,
    requestHover: vi.fn(),
    onPaintChange: vi.fn(),
  } as unknown as MarkingContext
  const marking = new SurfaceMarking(ctx)
  marking.setPaintBrush({ color: '#fff', diameter: 16, erase: false, gesture: 'brush', ...brush })
  const event = (x: number, y: number, more: Partial<PointerEvent> = {}) =>
    ({ button: 0, buttons: 1, clientX: x, clientY: y, pointerType: 'mouse', ...more }) as PointerEvent
  return {
    marking,
    dabs,
    svg,
    onPaintChange: ctx.onPaintChange,
    press: (x: number, y: number, more?: Partial<PointerEvent>) => marking.handlePointerDown(event(x, y, more)),
    move: (x: number, y: number) => listeners.pointermove(event(x, y)),
    release: (x: number, y: number) => listeners.pointerup(event(x, y, { buttons: 0 })),
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('a straight brush line', () => {
  it('runs from press to release, whatever the cursor did between, and marks only at the end', () => {
    const r = rig({ straight: true })
    expect(r.press(20, 30)).toBe(true)
    r.move(70, 90)
    r.move(60, 10)
    r.move(52, 30)
    expect(r.dabs).toEqual([])
    r.release(52, 30)
    r.marking.drainStroke()
    // 32 pixels at 2 apart: an eighth of a 16 pixel brush.
    expect(r.dabs).toHaveLength(17)
    expect(r.dabs[0]).toEqual({ x: 20, y: 30 })
    expect(r.dabs[16]).toEqual({ x: 52, y: 30 })
    for (const d of r.dabs) expect(d.y).toBe(30)
    expect(r.onPaintChange).toHaveBeenCalledTimes(1)
  })

  it('shows its outline in flight and takes it away after', () => {
    const r = rig({ straight: true })
    r.press(20, 30)
    expect(r.svg.style.display).toBe('')
    r.release(20, 30)
    expect(r.svg.style.display).toBe('none')
  })

  it('is one dab for a press that never moved', () => {
    const r = rig({ straight: true })
    r.press(20, 30)
    r.release(20, 30)
    expect(r.dabs).toEqual([{ x: 20, y: 30 }])
  })

  it('marks nothing when a second finger calls it off', () => {
    const r = rig({ straight: true })
    r.press(20, 30, { pointerType: 'touch' })
    r.move(60, 30)
    r.marking.endGesture()
    expect(r.dabs).toEqual([])
    expect(r.svg.style.display).toBe('none')
  })

  it('marks nothing when the gesture is stood down part way', () => {
    const r = rig({ straight: true })
    r.press(20, 30)
    r.move(60, 30)
    r.marking.setPaintBrush({ color: '#fff', diameter: 16, erase: false, gesture: null, straight: true })
    r.release(60, 30)
    expect(r.dabs).toEqual([])
  })
})

describe('what the modifiers do to a brush press', () => {
  const isLine = (r: ReturnType<typeof rig>) => r.svg.style.display !== 'none'

  it('a plain press is freehand with the switch off', () => {
    const r = rig()
    expect(r.press(20, 30)).toBe(true)
    expect(r.dabs).toHaveLength(1) // a mouse dabs at once
    expect(isLine(r)).toBe(false)
  })

  it('the modifier makes it straight, on either platform', () => {
    for (const mod of [{ ctrlKey: true }, { metaKey: true }]) {
      const r = rig()
      expect(r.press(20, 30, mod)).toBe(true)
      expect(r.dabs).toEqual([])
      expect(isLine(r)).toBe(true)
    }
  })

  it('and freehand with the switch on', () => {
    const r = rig({ straight: true })
    expect(r.press(20, 30, { ctrlKey: true })).toBe(true)
    expect(r.dabs).toHaveLength(1)
    expect(isLine(r)).toBe(false)
  })

  it('Shift stays with the camera, with or without the switch', () => {
    expect(rig().press(20, 30, { shiftKey: true })).toBe(false)
    expect(rig({ straight: true }).press(20, 30, { shiftKey: true })).toBe(false)
    expect(rig().press(20, 30, { shiftKey: true, ctrlKey: true })).toBe(false)
  })

  it('a scheme that drives the camera with the chord keeps it', () => {
    const r = rig({}, true)
    expect(r.press(20, 30, { ctrlKey: true })).toBe(false)
    expect(r.dabs).toEqual([])
    expect(isLine(r)).toBe(false)
  })

  it('the modifier stays the camera\'s under a window or lasso', () => {
    expect(rig({ gesture: 'window' }).press(20, 30, { ctrlKey: true })).toBe(false)
    expect(rig({ gesture: 'lasso' }).press(20, 30, { ctrlKey: true })).toBe(false)
  })

  it('the switch leaves a window alone', () => {
    const r = rig({ gesture: 'window', straight: true })
    r.press(20, 30)
    r.move(60, 80)
    r.release(60, 80)
    expect(r.dabs).toEqual([])
    expect(r.onPaintChange).toHaveBeenCalledTimes(1)
  })
})

describe('the spacing of a straight line', () => {
  it('keeps dabs an eighth of the brush apart, never closer than a pixel', () => {
    expect(lineSteps(0, 16)).toBe(0)
    expect(lineSteps(32, 16)).toBe(16)
    expect(lineSteps(33, 16)).toBe(17)
    expect(lineSteps(100, 2)).toBe(100)
    expect(lineSteps(100, 0.1)).toBe(100)
    expect(lineSteps(1000, 800)).toBe(10)
  })
})

describe('the outline of a straight line', () => {
  /** Distance from a point to the segment a–b. */
  const toSegment = (p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) => {
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len2 = dx * dx + dy * dy
    const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
    return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy)
  }

  it('lies one radius from the line, all the way round', () => {
    const a = { x: 10, y: 20 }
    const b = { x: 110, y: 75 }
    const outline = capsulePoints(a, b, 8)
    for (const p of outline) expect(toSegment(p, a, b)).toBeCloseTo(8, 9)
    // Its two ends, reached past the line's own ends.
    const along = (p: { x: number; y: number }) => ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / Math.hypot(b.x - a.x, b.y - a.y)
    const reach = outline.map(along)
    expect(Math.max(...reach)).toBeCloseTo(Math.hypot(100, 55) + 8, 9)
    expect(Math.min(...reach)).toBeCloseTo(-8, 9)
  })

  it('is a circle before the cursor has moved', () => {
    const a = { x: 40, y: 40 }
    for (const p of capsulePoints(a, a, 5)) expect(Math.hypot(p.x - 40, p.y - 40)).toBeCloseTo(5, 9)
  })
})
