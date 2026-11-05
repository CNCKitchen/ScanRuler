// SPDX-License-Identifier: AGPL-3.0-only
/** Keep the viewport pins legible when their anchors land on top of each
 *  other on screen — concentric cylinders, say, whose labels all sit at the
 *  same "up" offset from a shared axis. The CSS2D renderer only owns each
 *  label's `transform`; the nudge goes into `top`, so the two never fight.
 *
 *  Runs after every label render. Labels are taken bottom-up in screen order:
 *  the lowest keeps its place, and each one above it is pushed further up
 *  until it clears everything already placed. Pushing up rather than down
 *  matches the way the pins are offset in the first place — outward from the
 *  feature, up the screen — so a stack of concentric flags reads in the same
 *  order as the rings themselves. */
/** Sub-pixel distances two labels may still be apart and count as clear. */
const SLACK = 1e-6

/** Each label's size as last measured, with the text, the classes and the
 *  font generation it was measured with. A label's offsetWidth read after
 *  the renderer has just written every label's transform is a forced layout
 *  pass — every frame the view moves, for sizes that only change when the
 *  text does. So a label is measured again only when its text or its
 *  classes changed (an empty note's italic), or a web font arrived and
 *  swapped in for the fallback it was measured in. A label measured at
 *  nothing — out of the layout at the time — is not kept, and is measured
 *  again. */
const sizes = new WeakMap<HTMLElement, { w: number; h: number; text: string | null; cls: string; fonts: number }>()

/** Bumped whenever the document finishes loading fonts: the self-hosted
 *  faces swap in over their fallbacks, and every label measured before
 *  then is the wrong width. */
let fontGeneration = 0
if (typeof document !== 'undefined' && document.fonts) {
  document.fonts.addEventListener('loadingdone', () => {
    fontGeneration++
  })
}

function sizeOf(el: HTMLElement): { w: number; h: number } {
  const text = el.textContent
  const cls = el.className
  const known = sizes.get(el)
  if (known && known.text === text && known.cls === cls && known.fonts === fontGeneration) return known
  const measured = { w: el.offsetWidth, h: el.offsetHeight, text, cls, fonts: fontGeneration }
  if (measured.w > 0 || measured.h > 0) sizes.set(el, measured)
  return measured
}

export function spreadLabels(labelDom: HTMLElement, gap = 2): void {
  // The Labels key off: every tag is out of the layout, and measuring them
  // would read nothing, every frame.
  if (labelDom.closest?.('.nolabels')) return
  // Out of the layout too: a label the renderer put away, and one on the
  // side the section view cuts away — which would measure at nothing, and
  // be measured again every frame for it.
  const els = Array.from(labelDom.querySelectorAll<HTMLElement>('.viewport-label')).filter(
    (el) => el.style.display !== 'none' && !el.classList?.contains('cut-away'),
  )
  if (els.length < 2) {
    for (const el of els) el.style.top = ''
    return
  }
  const boxes = els.map((el) => {
    const m = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)\s*$/.exec(el.style.transform)
    const cx = m ? parseFloat(m[1]) : 0
    const cy = m ? parseFloat(m[2]) : 0
    const { w, h } = sizeOf(el)
    return { el, x0: cx - w / 2, x1: cx + w / 2, y0: cy - h / 2, y1: cy + h / 2, dy: 0 }
  })
  boxes.sort((a, b) => b.y1 - a.y1)
  const placed: typeof boxes = []
  for (const b of boxes) {
    // Lift the box clear of every placed box it still touches, then look
    // again: the lift may have carried it into boxes further up. Each round
    // leaves the box above at least one more of the placed boxes for good,
    // so the rounds are counted rather than run until the arithmetic says
    // the box is free — the offset is computed from the same numbers the
    // overlap test reads back, and rounding can leave the two a last bit
    // apart in the wrong direction forever. The slack covers that bit.
    for (let round = 0; round <= placed.length; round++) {
      let lift = b.dy
      for (const p of placed) {
        if (b.x0 >= p.x1 + gap || b.x1 <= p.x0 - gap) continue
        const above = p.y0 + p.dy - gap
        const below = p.y1 + p.dy + gap
        if (b.y1 + b.dy <= above + SLACK || b.y0 + b.dy >= below - SLACK) continue
        lift = Math.min(lift, above - b.y1)
      }
      if (lift > b.dy - SLACK) break
      b.dy = lift
    }
    placed.push(b)
    b.el.style.top = b.dy ? `${b.dy}px` : ''
  }
}
