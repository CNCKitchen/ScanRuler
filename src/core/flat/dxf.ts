// SPDX-License-Identifier: AGPL-3.0-only
// The sheet as a DXF — the drawing format CAD was built around, and the one
// to hand a sketch: millimetres by declaration rather than by convention, y
// up like the sheet itself, the origin on the alignment when there is one so
// the part lands in CAD in its own frame, and every fit as the entity CAD
// has for it — LINE, CIRCLE, ARC by centre and angles, POINT, and the spline
// as a SPLINE the sketch reads back exactly. The edge chains go on a layer of
// their own as LWPOLYLINEs, thinned to a tolerance first: a subpixel chain
// has a point per pixel, and a sketch handed a million line segments is a
// sketch nobody can use. Labels are TEXT on a third layer.
//
// AutoCAD 2000 (AC1015) ASCII, the smallest complete skeleton of that
// version — the tables and block records a strict reader insists on, a
// handle on everything — which is the dialect every importer reads. Pure
// string building, no DOM; the input is the same gathered sheet the SVG is
// drawn from, plus the origin and the thinning tolerance.

import { rollMap, sheetRoll } from './datum'
import {
  describeRoll,
  DRAWING_EDGE_COLOR,
  labelSpot,
  num,
  type FlatDrawingInput,
} from './drawing'
import { simplifyRun } from './simplify'
import { splineBezierForm } from './spline'
import type { FlatFit, Vec2 } from './types'

/** How far a thinned edge chain may stray from the detected one: a hundredth
 *  of a millimetre — a quarter of a pixel at 600 dpi, under the detector's
 *  own noise, and enough to drop most of a straight run. In pixels while
 *  nothing sets a scale. */
export const DXF_EDGE_TOLERANCE = { mm: 0.01, px: 0.25 } as const

export interface FlatDxfInput extends FlatDrawingInput {
  /** The alignment's origin in document units — the drawing's (0, 0) — or
   *  null to keep the sheet's own origin. */
  origin: Vec2 | null
  /** How far a thinned edge chain may stray, in document units; zero keeps
   *  every point. */
  edgeTolerance: number
}

export const DXF_LAYERS = { edges: 'edges', elements: 'elements', labels: 'labels' } as const

/** The block record the model space's entities belong to, in the skeleton
 *  below. */
const MODEL_SPACE = '1F'

/** A group: code and value on their own lines, the code right-aligned to
 *  three characters the way AutoCAD writes it. */
const group = (code: number, value: string | number): string => `${String(code).padStart(3)}\n${value}`

/** The signs DXF text has spelt its own way since R12 — every reader turns
 *  these back into the symbol. */
const TEXT_SPELLINGS: Record<string, string> = { 'Ø': '%%c', '°': '%%d', '±': '%%p' }

/** Text as a pre-2007 DXF carries it: the file is a code page, not UTF-8.
 *  The diameter, degree and plus-minus signs go as the %% codes CAD has
 *  always used, the middle dot the readings separate with becomes a comma,
 *  and anything else beyond ASCII goes as AutoCAD's \U+XXXX escape, which
 *  CAD decodes and a plain reader can still make out. */
export function dxfText(s: string): string {
  let out = ''
  for (const ch of s.replace(/\s*·\s*/g, ', ')) {
    const code = ch.codePointAt(0)!
    out +=
      code < 127 ? ch : (TEXT_SPELLINGS[ch] ?? `\\U+${code.toString(16).toUpperCase().padStart(4, '0')}`)
  }
  return out
}

/** A comment line: plain ASCII where a plain substitute exists. */
const comment = (s: string): string => group(999, dxfText(s.replace(/—/g, '-').replace(/×/g, 'x')))

/** A CSS hex colour as the 24-bit integer group 420 carries, or null when
 *  it is not one. */
function trueColor(css: string): number | null {
  const m = /^#([0-9a-f]{6})$/i.exec(css.trim())
  return m ? parseInt(m[1], 16) : null
}

/** A section's worth of the fixed skeleton: every table a 2000 reader looks
 *  for, with the layers of this drawing in the layer table. Handles below
 *  0x100 are the skeleton's own; entities count up from there. */
function tables(layers: string[]): string[] {
  /** A table: its own handle, how many records it holds, the records. */
  const table = (name: string, handle: string, count: number, records: string[], extra: string[] = []) => [
    group(0, 'TABLE'),
    group(2, name),
    group(5, handle),
    group(330, '0'),
    group(100, 'AcDbSymbolTable'),
    group(70, count),
    ...extra,
    ...records,
    group(0, 'ENDTAB'),
  ]
  const record = (type: string, handle: string, owner: string, sub: string, body: string[]) => [
    group(0, type),
    group(5, handle),
    group(330, owner),
    group(100, 'AcDbSymbolTableRecord'),
    group(100, sub),
    ...body,
  ]
  const ltype = (handle: string, name: string, desc: string) =>
    record('LTYPE', handle, '5', 'AcDbLinetypeTableRecord', [
      group(2, name),
      group(70, 0),
      group(3, desc),
      group(72, 65),
      group(73, 0),
      group(40, 0),
    ])
  return [
    group(0, 'SECTION'),
    group(2, 'TABLES'),
    ...table('VPORT', '8', 0, []),
    ...table('LTYPE', '5', 3, [
      ...ltype('14', 'BYBLOCK', ''),
      ...ltype('15', 'BYLAYER', ''),
      ...ltype('16', 'CONTINUOUS', 'Solid line'),
    ]),
    ...table('LAYER', '2', 4, layers),
    ...table('STYLE', '3', 1, record('STYLE', '11', '3', 'AcDbTextStyleTableRecord', [
      group(2, 'STANDARD'),
      group(70, 0),
      group(40, 0),
      group(41, 1),
      group(50, 0),
      group(71, 0),
      group(42, 2.5),
      group(3, 'txt'),
      group(4, ''),
    ])),
    ...table('VIEW', '6', 0, []),
    ...table('UCS', '7', 0, []),
    ...table('APPID', '9', 1, record('APPID', '12', '9', 'AcDbRegAppTableRecord', [group(2, 'ACAD'), group(70, 0)])),
    ...table('DIMSTYLE', 'A', 0, [], [group(100, 'AcDbDimStyleTable')]),
    ...table('BLOCK_RECORD', '1', 2, [
      ...record('BLOCK_RECORD', MODEL_SPACE, '1', 'AcDbBlockTableRecord', [group(2, '*MODEL_SPACE')]),
      ...record('BLOCK_RECORD', '1B', '1', 'AcDbBlockTableRecord', [group(2, '*PAPER_SPACE')]),
    ]),
    group(0, 'ENDSEC'),
  ]
}

/** The two block definitions a 2000 file must have, both empty. */
const BLOCKS: string[] = [
  group(0, 'SECTION'),
  group(2, 'BLOCKS'),
  group(0, 'BLOCK'), group(5, '20'), group(330, MODEL_SPACE), group(100, 'AcDbEntity'), group(8, '0'),
  group(100, 'AcDbBlockBegin'), group(2, '*MODEL_SPACE'), group(70, 0),
  group(10, 0), group(20, 0), group(30, 0), group(3, '*MODEL_SPACE'), group(1, ''),
  group(0, 'ENDBLK'), group(5, '21'), group(330, MODEL_SPACE), group(100, 'AcDbEntity'), group(8, '0'),
  group(100, 'AcDbBlockEnd'),
  group(0, 'BLOCK'), group(5, '1C'), group(330, '1B'), group(100, 'AcDbEntity'), group(67, 1), group(8, '0'),
  group(100, 'AcDbBlockBegin'), group(2, '*PAPER_SPACE'), group(70, 0),
  group(10, 0), group(20, 0), group(30, 0), group(3, '*PAPER_SPACE'), group(1, ''),
  group(0, 'ENDBLK'), group(5, '1D'), group(330, '1B'), group(100, 'AcDbEntity'), group(67, 1), group(8, '0'),
  group(100, 'AcDbBlockEnd'),
  group(0, 'ENDSEC'),
]

/** The root dictionary and the empty group dictionary it must point at. */
const OBJECTS: string[] = [
  group(0, 'SECTION'),
  group(2, 'OBJECTS'),
  group(0, 'DICTIONARY'), group(5, 'C'), group(330, '0'), group(100, 'AcDbDictionary'), group(281, 1),
  group(3, 'ACAD_GROUP'), group(350, 'D'),
  group(0, 'DICTIONARY'), group(5, 'D'), group(330, 'C'), group(100, 'AcDbDictionary'), group(281, 1),
  group(0, 'ENDSEC'),
]

export function buildFlatDxf(r: FlatDxfInput): string {
  // The sheet as it is shown — aligned to the part and turned, the same roll
  // FlatScene gives its camera — about the drawing's origin. y stays up.
  const roll = sheetRoll(r.alignDir, r.turns)
  const rot = rollMap(roll)
  const o = r.origin ?? [0, 0]
  const at = (p: Vec2): Vec2 => rot([p[0] - o[0], p[1] - o[1]])
  const dec = r.unit === 'mm' ? 4 : 3
  const n = (v: number) => num(v, dec)
  /** An angle on the sheet as the drawing has it: rolled with it, in
   *  degrees, wrapped to a turn. */
  const deg = (rad: number): string => {
    const d = ((rad + roll) * 180) / Math.PI
    return num(((d % 360) + 360) % 360, 6)
  }

  const { min, max } = r.bounds
  const corners = [at(min), at(max), at([min[0], max[1]]), at([max[0], min[1]])]
  const x0 = Math.min(...corners.map((c) => c[0]))
  const x1 = Math.max(...corners.map((c) => c[0]))
  const y0 = Math.min(...corners.map((c) => c[1]))
  const y1 = Math.max(...corners.map((c) => c[1]))
  const diag = Math.hypot(x1 - x0, y1 - y0) || 1
  const textHeight = diag * 0.011
  const pointSize = diag * 0.012

  let seed = 0x100
  const handle = () => (seed++).toString(16).toUpperCase()
  const xyz = (code: number, p: Vec2): string[] => [group(code, n(p[0])), group(code + 10, n(p[1])), group(code + 20, 0)]

  const ents: string[] = []
  const entity = (type: string, layer: string, rgb: number | null, body: string[]): void => {
    ents.push(group(0, type), group(5, handle()), group(330, MODEL_SPACE), group(100, 'AcDbEntity'), group(8, layer))
    if (rgb !== null) ents.push(group(420, rgb))
    ents.push(...body)
  }

  // The edges: one LWPOLYLINE per chain, thinned. A chain that ends on its
  // own first point is a closed polyline.
  if (r.chains) {
    const { points, offsets } = r.chains
    const { x: ux, y: uy } = r.chainUnit
    // The tolerance is in document units; the chain is judged in its own.
    const tol = r.edgeTolerance / Math.max(ux, uy)
    for (let c = 0; c + 1 < offsets.length; c++) {
      const a = offsets[c]
      const b = offsets[c + 1]
      if (b - a < 2) continue
      const closed =
        b - a > 3 && points[a * 2] === points[(b - 1) * 2] && points[a * 2 + 1] === points[(b - 1) * 2 + 1]
      const kept = simplifyRun(points, a, closed ? b - 1 : b, tol)
      const body = [group(100, 'AcDbPolyline'), group(90, kept.length), group(70, closed ? 1 : 0)]
      for (const i of kept) {
        const [x, y] = at([points[i * 2] * ux, points[i * 2 + 1] * uy])
        body.push(group(10, n(x)), group(20, n(y)))
      }
      entity('LWPOLYLINE', DXF_LAYERS.edges, null, body)
    }
  }

  /** The entity CAD has for a fit — type and body — in drawing coordinates. */
  const shapes = (fit: FlatFit): { type: string; body: string[] }[] => {
    switch (fit.kind) {
      case 'point':
        return [{ type: 'POINT', body: [group(100, 'AcDbPoint'), ...xyz(10, at(fit.at))] }]
      case 'line': {
        const [cx, cy] = fit.center
        const [dx, dy] = fit.dir
        const half = fit.length / 2
        return [
          {
            type: 'LINE',
            body: [
              group(100, 'AcDbLine'),
              ...xyz(10, at([cx - dx * half, cy - dy * half])),
              ...xyz(11, at([cx + dx * half, cy + dy * half])),
            ],
          },
        ]
      }
      case 'circle':
        return [{ type: 'CIRCLE', body: [group(100, 'AcDbCircle'), ...xyz(10, at(fit.center)), group(40, n(fit.radius))] }]
      case 'arc': {
        // An arc that has come all the way round is a circle; an ARC with
        // equal angles is nothing.
        if (fit.sweep >= 2 * Math.PI - 1e-6)
          return [{ type: 'CIRCLE', body: [group(100, 'AcDbCircle'), ...xyz(10, at(fit.center)), group(40, n(fit.radius))] }]
        return [
          {
            type: 'ARC',
            body: [
              group(100, 'AcDbCircle'),
              ...xyz(10, at(fit.center)),
              group(40, n(fit.radius)),
              group(100, 'AcDbArc'),
              group(50, deg(fit.start)),
              group(51, deg(fit.start + fit.sweep)),
            ],
          },
        ]
      }
      case 'spline': {
        // The curve's own cubic Béziers as one B-spline: the poles pole for
        // pole (the roll is rigid, so they map like any point), and a knot
        // vector clamped at the ends with each interior knot three times
        // over — the form that reproduces a run of Béziers exactly. A closed
        // curve's last pole is its first.
        const { poles, knots } = splineBezierForm(fit)
        const knotVector = [
          knots[0], knots[0], knots[0], knots[0],
          ...knots.slice(1, -1).flatMap((k) => [k, k, k]),
          knots[knots.length - 1], knots[knots.length - 1], knots[knots.length - 1], knots[knots.length - 1],
        ]
        const body = [
          group(100, 'AcDbSpline'),
          group(70, 8),
          group(71, 3),
          group(72, knotVector.length),
          group(73, poles.length),
          group(74, 0),
          ...knotVector.map((k) => group(40, num(k, 6))),
          ...poles.flatMap((p) => xyz(10, at(p))),
        ]
        return [{ type: 'SPLINE', body }]
      }
    }
  }

  const text = (p: Vec2, s: string, rgb: number | null): void => {
    if (s === '') return
    entity('TEXT', DXF_LAYERS.labels, rgb, [
      group(100, 'AcDbText'),
      ...xyz(10, p),
      group(40, n(textHeight)),
      group(1, dxfText(s)),
      group(100, 'AcDbText'),
    ])
  }

  for (const el of r.elements) {
    const rgb = trueColor(el.color)
    for (const s of shapes(el.fit)) entity(s.type, DXF_LAYERS.elements, rgb, s.body)
    // The name a line above the spot, the reading on it — the block sits
    // beside the feature rather than across it.
    const [lx, ly] = at(labelSpot(el.fit, diag))
    text([lx, ly + 1.2 * textHeight], el.name, rgb)
    text([lx, ly], el.value, rgb)
  }

  const layer = (name: string, aci: number, rgb: number | null): string[] => [
    group(0, 'LAYER'),
    group(5, handle()),
    group(330, '2'),
    group(100, 'AcDbSymbolTableRecord'),
    group(100, 'AcDbLayerTableRecord'),
    group(2, name),
    group(70, 0),
    group(62, aci),
    ...(rgb === null ? [] : [group(420, rgb)]),
    group(6, 'CONTINUOUS'),
  ]
  const layers = [
    ...layer('0', 7, null),
    ...layer(DXF_LAYERS.edges, 4, trueColor(DRAWING_EDGE_COLOR)),
    ...layer(DXF_LAYERS.elements, 7, null),
    ...layer(DXF_LAYERS.labels, 7, null),
  ]

  const unitWord = r.unit === 'mm' ? 'millimetre' : 'image pixel'
  const header = [
    comment(r.title),
    comment(r.scaleNote),
    comment(
      `One unit is one ${unitWord}; y up; the origin is ${
        r.origin ? "the alignment's origin" : "the sheet's own origin"
      }${describeRoll(r.alignDir, r.turns).replace(/^, /, '; ')}`,
    ),
    comment(
      `Layers: edges (the detected edge chains${
        r.edgeTolerance > 0 ? `, thinned to ${num(r.edgeTolerance, 4)} ${r.unit}` : ''
      }), elements (the fitted geometry), labels`,
    ),
    group(0, 'SECTION'),
    group(2, 'HEADER'),
    group(9, '$ACADVER'), group(1, 'AC1015'),
    group(9, '$DWGCODEPAGE'), group(3, 'ANSI_1252'),
    group(9, '$INSBASE'), group(10, 0), group(20, 0), group(30, 0),
    group(9, '$EXTMIN'), group(10, n(x0)), group(20, n(y0)), group(30, 0),
    group(9, '$EXTMAX'), group(10, n(x1)), group(20, n(y1)), group(30, 0),
    group(9, '$INSUNITS'), group(70, r.unit === 'mm' ? 4 : 0),
    group(9, '$MEASUREMENT'), group(70, 1),
    group(9, '$LUNITS'), group(70, 2),
    group(9, '$LUPREC'), group(70, 4),
    group(9, '$PDMODE'), group(70, 3),
    group(9, '$PDSIZE'), group(40, n(pointSize)),
    group(9, '$HANDSEED'), group(5, seed.toString(16).toUpperCase()),
    group(0, 'ENDSEC'),
  ]

  return [
    ...header,
    ...tables(layers),
    ...BLOCKS,
    group(0, 'SECTION'),
    group(2, 'ENTITIES'),
    ...ents,
    group(0, 'ENDSEC'),
    ...OBJECTS,
    group(0, 'EOF'),
  ].join('\n') + '\n'
}
