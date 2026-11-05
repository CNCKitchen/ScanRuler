// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { spreadLabels } from '../src/viewer/labelSpread'

type Pin = ReturnType<typeof pin>

/** A stand-in for a rendered `.viewport-label`: centred at (x, y) by the
 *  CSS2D transform, w × h on screen. */
function pin(x: number, y: number, w = 100, h = 22) {
  return { style: { display: '', transform: `translate(${x}px, ${y}px)`, top: '' }, offsetWidth: w, offsetHeight: h }
}

function spread(pins: Pin[], gap?: number) {
  spreadLabels({ querySelectorAll: () => pins } as unknown as HTMLElement, gap)
}

const tops = (pins: Pin[]) => pins.map((p) => p.style.top)

/** The screen rectangle a pin ends up with, nudge included. */
function rect(p: Pin) {
  const [, x, y] = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(p.style.transform)!.map(Number)
  const dy = p.style.top ? parseFloat(p.style.top) : 0
  return { x0: x - p.offsetWidth / 2, x1: x + p.offsetWidth / 2, y0: y + dy - p.offsetHeight / 2, y1: y + dy + p.offsetHeight / 2 }
}

function overlapping(pins: Pin[], gap = 2) {
  const rs = pins.filter((p) => p.style.display !== 'none').map(rect)
  const pairs: [number, number][] = []
  for (let i = 0; i < rs.length; i++)
    for (let j = i + 1; j < rs.length; j++) {
      const a = rs[i], b = rs[j]
      if (a.x0 < b.x1 + gap && a.x1 > b.x0 - gap && a.y0 < b.y1 + gap - 1e-6 && a.y1 > b.y0 - gap + 1e-6)
        pairs.push([i, j])
    }
  return pairs
}

describe('spreadLabels', () => {
  it('(the check itself sees two coincident labels as overlapping)', () => {
    expect(overlapping([pin(0, 0), pin(0, 0)])).toEqual([[0, 1]])
  })

  it('stacks coincident labels upward, lowest staying put, and holds that layout on the next render', () => {
    const pins = [pin(100, 100), pin(100, 100), pin(100, 100)]
    spread(pins)
    expect(tops(pins)).toEqual(['', '-24px', '-48px'])
    spread(pins)
    expect(tops(pins)).toEqual(['', '-24px', '-48px'])
  })

  it('uses the gap it is given', () => {
    const pins = [pin(0, 0), pin(0, 0)]
    spread(pins, 10)
    expect(tops(pins)).toEqual(['', '-32px'])
  })

  it('keeps lifting a label that is pushed into a third one', () => {
    // Centres 10 px apart, so the top pin clears the bottom one only by
    // landing on the middle one, and has to go up once more.
    const pins = [pin(50, 100), pin(150, 90), pin(100, 80)]
    spread(pins)
    expect(tops(pins)).toEqual(['', '-14px', '-28px'])
    expect(overlapping(pins)).toEqual([])
  })

  it('leaves labels alone that are apart on screen, and clears a nudge they no longer need', () => {
    const pins = [pin(0, 100), pin(300, 100), pin(0, 0)]
    pins[0].style.top = '-24px'
    spread(pins)
    expect(tops(pins)).toEqual(['', '', ''])
  })

  it('skips hidden labels and resets a single visible one', () => {
    const pins = [pin(100, 100), pin(100, 100)]
    pins[0].style.display = 'none'
    pins[1].style.top = '-24px'
    spread(pins)
    expect(pins[1].style.top).toBe('')
    spread([])
  })

  // Pairs of label centres on which the offset that should put one label
  // exactly `gap` above the other comes back, in floating point, a hair
  // short — the overlap test stays true after the nudge was applied, and a
  // loop that runs "until clear" never ends. Found by searching the
  // original loop with random sub-pixel positions; three are kept.
  it.each([
    [0.7741, 7.1104],
    [5.4067, 5.4979],
    [15.1655, 14.9569],
  ])('settles on positions (%f, %f) where the exact nudge rounds the wrong way', (ya, yb) => {
    const pins = [pin(100, ya), pin(100, yb)]
    for (let frame = 0; frame < 50; frame++) spread(pins)
    expect(overlapping(pins)).toEqual([])
    const lower = ya >= yb ? 0 : 1
    expect(pins[lower].style.top).toBe('')
    expect(parseFloat(pins[1 - lower].style.top)).toBeLessThan(0)
  })

  it('never overlaps on a crowd of random labels, and stops in bounded time', () => {
    let seed = 12345
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
    for (let trial = 0; trial < 200; trial++) {
      const pins: Pin[] = []
      const n = 2 + Math.floor(rnd() * 7)
      for (let i = 0; i < n; i++) pins.push(pin(rnd() * 300, rnd() * 120, 60 + rnd() * 100, 10 + rnd() * 30))
      spread(pins)
      expect(overlapping(pins)).toEqual([])
    }
  })

  it('measures a label once, and again only when its text or classes change', () => {
    // A pin whose size reads are counted: each one is a forced layout pass
    // in the browser.
    const counted = (x: number, y: number, text: string) => {
      const p = { style: { display: '', transform: `translate(${x}px, ${y}px)`, top: '' }, textContent: text, className: 'viewport-label', w: 100, reads: 0 }
      return Object.defineProperties(p, {
        offsetWidth: { get: () => (p.reads++, p.w) },
        offsetHeight: { get: () => (p.reads++, 22) },
      }) as typeof p & { offsetWidth: number; offsetHeight: number }
    }
    const a = counted(100, 100, '12.00')
    const b = counted(100, 100, '3.00')
    const run = () => spreadLabels({ querySelectorAll: () => [a, b] } as unknown as HTMLElement)
    run()
    expect([a.reads, b.reads]).toEqual([2, 2])
    for (let frame = 0; frame < 10; frame++) run()
    expect([a.reads, b.reads]).toEqual([2, 2])
    expect(b.style.top).toBe('-24px')
    // New text, a new size: measured again, and the layout follows it.
    a.textContent = '12.000 mm'
    a.w = 300
    run()
    expect([a.reads, b.reads]).toEqual([4, 2])
    b.className = 'viewport-label over'
    run()
    expect([a.reads, b.reads]).toEqual([4, 4])
  })

  it('keeps no size measured at nothing, and measures that label again', () => {
    // Out of the layout when first measured — a parent not yet shown — and
    // then in it: the size read at nothing must not stand for it.
    let w = 0
    let reads = 0
    const p = { style: { display: '', transform: 'translate(100px, 100px)', top: '' }, textContent: 'a', className: 'viewport-label' }
    const late = Object.defineProperties(p, {
      offsetWidth: { get: () => (reads++, w) },
      offsetHeight: { get: () => (reads++, w ? 22 : 0) },
    }) as typeof p & { offsetWidth: number; offsetHeight: number }
    const other = pin(100, 100)
    const run = () => spreadLabels({ querySelectorAll: () => [late, other] } as unknown as HTMLElement)
    run()
    expect(reads).toBe(2)
    expect(other.style.top).toBe('')
    w = 100
    run()
    expect(reads).toBe(4)
    // Measured now, it stacks with the other one.
    expect([late.style.top, other.style.top].sort()).toEqual(['', '-24px'])
    run()
    expect(reads).toBe(4)
  })

  it('leaves out labels cut away by the section view, and does nothing with the labels off', () => {
    const cut = { ...pin(100, 100), classList: { contains: (c: string) => c === 'cut-away' } }
    const a = pin(100, 100)
    const b = pin(100, 100)
    spreadLabels({ querySelectorAll: () => [cut, a, b] } as unknown as HTMLElement)
    expect(tops([cut, a, b])).toEqual(['', '', '-24px'])
    const c = pin(100, 100)
    const d = pin(100, 100)
    spreadLabels({ closest: (sel: string) => (sel === '.nolabels' ? {} : null), querySelectorAll: () => [c, d] } as unknown as HTMLElement)
    expect(tops([c, d])).toEqual(['', ''])
  })
})
