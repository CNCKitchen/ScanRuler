// SPDX-License-Identifier: AGPL-3.0-only
// The sheet as a drawing: every detected edge chain and every fitted element
// as SVG at true scale — one user unit per millimetre (per image pixel while
// nothing sets a scale), y down as drawings are, the sheet aligned and turned
// the way it is shown on the stage — so a part aligned along a reference
// edge comes into CAD square. Meant for a CAD sketch to trace and a vector editor
// to pick apart, so each layer is a group with a plain id, every shape is
// the native SVG primitive for it, and nothing hides under a transform: what
// an importer reads is what it draws.
//
// Pure string building over document units, no DOM. App gathers the sheet's
// bounds, chains and elements and hands them in; the report module says what
// the scale rests on.

import { rollMap, sheetRoll } from './datum'
import {
  describeRoll,
  DRAWING_EDGE_COLOR,
  labelSpot,
  num,
  type FlatDrawingElement,
  type FlatDrawingInput,
} from './drawing'
import { splineBezierForm } from './spline'
import type { FlatFit, Vec2 } from './types'

/** The element and the gathered sheet are the drawing exports' shared
 *  shapes — see core/flat/drawing; the SVG names stay for its callers. */
export type FlatSvgElement = FlatDrawingElement
export type FlatSvgInput = FlatDrawingInput

/** The teal the stage draws detected edges in. */
export const SVG_EDGE_COLOR = DRAWING_EDGE_COLOR

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function buildFlatSvg(r: FlatSvgInput): string {
  // The sheet as it is shown: aligned to the part and turned, the same roll
  // FlatScene gives its camera.
  const rot = rollMap(sheetRoll(r.alignDir, r.turns))
  const { min, max } = r.bounds
  const corners = [rot(min), rot(max), rot([min[0], max[1]]), rot([max[0], min[1]])]
  const x0 = Math.min(...corners.map((c) => c[0]))
  const x1 = Math.max(...corners.map((c) => c[0]))
  const y0 = Math.min(...corners.map((c) => c[1]))
  const y1 = Math.max(...corners.map((c) => c[1]))
  const w = x1 - x0
  const h = y1 - y0
  const dec = r.unit === 'mm' ? 3 : 2
  const n = (v: number) => num(v, dec)
  /** Document → drawing: rolled as shown, then flipped so the top of what is
   *  shown is the drawing's top and its left edge the drawing's left. */
  const at = (p: Vec2): Vec2 => {
    const q = rot(p)
    return [q[0] - x0, y1 - q[1]]
  }
  const diag = Math.hypot(w, h) || 1
  const hair = 10 ** -dec
  const edgeWidth = Math.max(diag * 0.0003, hair)
  const elementWidth = Math.max(diag * 0.0008, hair)
  const fontSize = Math.max(diag * 0.011, hair)

  const line = (a: Vec2, b: Vec2): string => {
    const [ax, ay] = at(a)
    const [bx, by] = at(b)
    return `<line x1="${n(ax)}" y1="${n(ay)}" x2="${n(bx)}" y2="${n(by)}"/>`
  }
  const circle = (c: Vec2, radius: number): string => {
    const [cx, cy] = at(c)
    return `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(radius)}"/>`
  }
  /** The native SVG shape for a fit, in drawing coordinates. */
  const shapes = (fit: FlatFit): string[] => {
    switch (fit.kind) {
      case 'point': {
        // A cross sized off the sheet, as on the stage.
        const s = diag * 0.006
        const [x, y] = fit.at
        return [line([x - s, y], [x + s, y]), line([x, y - s], [x, y + s])]
      }
      case 'line': {
        const [cx, cy] = fit.center
        const [dx, dy] = fit.dir
        const half = fit.length / 2
        return [line([cx - dx * half, cy - dy * half], [cx + dx * half, cy + dy * half])]
      }
      case 'circle':
        return [circle(fit.center, fit.radius)]
      case 'arc': {
        // An arc that has come all the way round has coincident ends, which
        // an SVG arc command draws as nothing — it is a circle.
        if (fit.sweep >= 2 * Math.PI - 1e-6) return [circle(fit.center, fit.radius)]
        const [cx, cy] = fit.center
        const from = at([cx + fit.radius * Math.cos(fit.start), cy + fit.radius * Math.sin(fit.start)])
        const end = fit.start + fit.sweep
        const to = at([cx + fit.radius * Math.cos(end), cy + fit.radius * Math.sin(end)])
        // Counter-clockwise on the sheet stays counter-clockwise on the page
        // (the flip and the turn between them keep the sense), and SVG's
        // sweep flag 0 is the counter-clockwise arc; the large-arc flag says
        // which of the two arcs between the ends is meant.
        const large = fit.sweep > Math.PI ? 1 : 0
        return [
          `<path d="M ${n(from[0])} ${n(from[1])} A ${n(fit.radius)} ${n(fit.radius)} 0 ${large} 0 ${n(to[0])} ${n(to[1])}"/>`,
        ]
      }
      case 'spline': {
        // The curve's own cubic Béziers, pole for pole: the turn and the flip
        // are affine, so the poles map through like any point, and a CAD
        // sketch reads the spline back exactly. A closed one is closed.
        const { poles } = splineBezierForm(fit)
        const pt = (p: Vec2) => {
          const [x, y] = at(p)
          return `${n(x)} ${n(y)}`
        }
        const parts = [`M ${pt(poles[0])}`]
        for (let k = 1; k + 2 < poles.length; k += 3) {
          parts.push(`C ${pt(poles[k])} ${pt(poles[k + 1])} ${pt(poles[k + 2])}`)
        }
        if (fit.closed) parts.push('Z')
        return [`<path d="${parts.join(' ')}"/>`]
      }
    }
  }

  const out: string[] = []
  out.push('<?xml version="1.0" encoding="UTF-8"?>')
  const size =
    r.unit === 'mm'
      ? `width="${n(w)}mm" height="${n(h)}mm"`
      : `width="${n(w)}" height="${n(h)}"`
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" ${size} viewBox="0 0 ${n(w)} ${n(h)}">`)
  out.push(`  <title>${esc(r.title)}</title>`)
  out.push(
    `  <desc>${esc(
      `${r.scaleNote}. One unit is one ${r.unit === 'mm' ? 'millimetre' : 'image pixel'}; ` +
        `y runs down and the origin is the top-left corner of the sheet as shown${describeRoll(r.alignDir, r.turns)}. ` +
        'Layers: edges (the detected edge chains), elements (the fitted geometry), labels.',
    )}</desc>`,
  )

  out.push(
    `  <g id="edges" fill="none" stroke="${SVG_EDGE_COLOR}" stroke-width="${n(edgeWidth)}" stroke-linecap="round" stroke-linejoin="round">`,
  )
  if (r.chains) {
    const { points, offsets } = r.chains
    for (let c = 0; c + 1 < offsets.length; c++) {
      const a = offsets[c]
      const b = offsets[c + 1]
      if (b - a < 2) continue
      const parts: string[] = new Array(b - a)
      for (let i = a; i < b; i++) {
        const [x, y] = at([points[i * 2] * r.chainUnit.x, points[i * 2 + 1] * r.chainUnit.y])
        parts[i - a] = `${n(x)},${n(y)}`
      }
      out.push(`    <polyline points="${parts.join(' ')}"/>`)
    }
  }
  out.push('  </g>')

  out.push(`  <g id="elements" fill="none" stroke-width="${n(elementWidth)}" stroke-linecap="round">`)
  r.elements.forEach((el, i) => {
    out.push(`    <g id="element-${i + 1}" data-name="${esc(el.name)}" stroke="${esc(el.color)}">`)
    out.push(`      <title>${esc(el.name)} — ${esc(el.value)}</title>`)
    for (const s of shapes(el.fit)) out.push(`      ${s}`)
    out.push('    </g>')
  })
  out.push('  </g>')

  out.push(
    `  <g id="labels" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif" font-size="${n(fontSize)}">`,
  )
  for (const el of r.elements) {
    const [lx, ly] = at(labelSpot(el.fit, diag))
    // The name a line above the spot, the reading on it — the block sits
    // beside the feature rather than across it.
    out.push(
      `    <text x="${n(lx)}" y="${n(ly)}" fill="${esc(el.color)}">` +
        `<tspan x="${n(lx)}" dy="-1.2em">${esc(el.name)}</tspan>` +
        `<tspan x="${n(lx)}" dy="1.2em">${esc(el.value)}</tspan></text>`,
    )
  }
  out.push('  </g>')
  out.push('</svg>')
  return out.join('\n') + '\n'
}
