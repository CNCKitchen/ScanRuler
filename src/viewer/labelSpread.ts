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
export function spreadLabels(labelDom: HTMLElement, gap = 2): void {
  const els = Array.from(labelDom.querySelectorAll<HTMLElement>('.viewport-label')).filter(
    (el) => el.style.display !== 'none',
  )
  if (els.length < 2) {
    for (const el of els) el.style.top = ''
    return
  }
  const boxes = els.map((el) => {
    const m = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)\s*$/.exec(el.style.transform)
    const cx = m ? parseFloat(m[1]) : 0
    const cy = m ? parseFloat(m[2]) : 0
    const w = el.offsetWidth
    const h = el.offsetHeight
    return { el, x0: cx - w / 2, x1: cx + w / 2, y0: cy - h / 2, y1: cy + h / 2, dy: 0 }
  })
  boxes.sort((a, b) => b.y1 - a.y1)
  const placed: typeof boxes = []
  for (const b of boxes) {
    let moved = true
    while (moved) {
      moved = false
      for (const p of placed) {
        const overlapX = b.x0 < p.x1 + gap && b.x1 > p.x0 - gap
        const overlapY = b.y0 + b.dy < p.y1 + p.dy + gap && b.y1 + b.dy > p.y0 + p.dy - gap
        if (overlapX && overlapY) {
          b.dy = p.y0 + p.dy - gap - b.y1
          moved = true
        }
      }
    }
    placed.push(b)
    b.el.style.top = b.dy ? `${b.dy}px` : ''
  }
}
