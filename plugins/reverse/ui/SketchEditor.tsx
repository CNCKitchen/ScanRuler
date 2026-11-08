// SPDX-License-Identifier: AGPL-3.0-only
// The box a sketch is drawn in: the slice chains to fit, the tools, the
// Dimension key and the relations — each put on what is selected, or, with
// nothing selected, taken in hand and put on what is clicked next — the
// list of them, and at the bottom the solver's verdict in two words: needs
// input, or solved. The box says little in prose: what a key does is in its
// tooltip, and only an error or a wait gets a line. Finish sketch is its one
// exit, at the top and at the bottom; Escape only leaves the tool in hand. Once a region
// closes the box offers Extrude and Revolve straight away, which finish the
// sketch and open the feature on it. The regions a feature uses are picked
// in the viewport by the extrude or revolve itself, as CAD does it, not
// here. Renders nothing without a sketch draft. The stage beside it is the
// 2D sheet — see SketchViewer.

import { useEffect, useRef, useState } from 'react'
import { datumName } from '../core/datums'
import { planeOffset, planeTakesOffset } from '../core/features'
import { SHARE_MM } from '../core/shareFit'
import { describePlaneRef } from '../core/resolve'
import { nominalOf, nominalText, type NominalKind } from '../core/nominal'
import { fixedPieces, fixId, isDimension, POLYGON_MAX_SIDES, sketchBounds, type Constraint, type Sketch, type SketchPatternSpec } from '../core/sketch'
import { useRePrefs } from '../state/rePrefs'
import { useReverse, type ImagePickMode, type SketchDraft, type SketchTool } from '../state/reStore'
import { IMAGE_MAX_PX, placedImage } from '../core/sketchImage'
import type { DrawModes } from '../core/draw'
import { useStore } from '../../../src/state/store'
import { useShell } from '../../../src/state/shellStore'
import type { SketchChains } from '../app/useReverseWorkspace'
import { FitOptionsModal } from './FitOptionsModal'
import { ExprInput } from './ExprInput'
import { dimensionKind } from '../core/parameters'
import { Icon } from '../../../src/ui/icons'
import { KeyIcon, type KeyIconName } from './reIcons'
import { InfoDot } from '../../../src/ui/InfoDot'
import { NumberInput } from '../../../src/ui/NumberField'
import { NameField } from '../../../src/ui/RefSelect'
import { useLength } from '../../../src/app/useUnits'
import type { LengthPresets } from '../../../src/core/units'
import { CORNER_GAP_MM } from '../core/corners'
import { BuildSays } from './featureFields'

const TOOLS: { id: SketchTool; icon: KeyIconName; label: string; title: string }[] = [
  { id: 'select', icon: 'select', label: 'Select', title: 'Click a piece to select it, a second to pair it; click empty sheet to clear. Drag over empty sheet for a box: rightward it takes what lies wholly inside, leftward whatever it touches; hold Shift or Ctrl to add to the selection. Drag an end, a centre or a piece to move it — it snaps to other ends, the slice and the pieces, and a line moves square to itself; hold Ctrl to move it freely. The right button pans' },
  { id: 'line', icon: 'line', label: 'Line (L)', title: 'Click the start, then every next corner — each line carries on from the last. Press on the last end and drag for an arc tangent to the piece before it. Escape, Enter or a second click on the last end ends the chain; so does landing on another piece’s end. Hold Ctrl to place a point without snapping' },
  { id: 'rectangle', icon: 'rectangle', label: 'Rectangle (R)', title: 'Two opposite corners, the centre and a corner, or one side and the far side at any angle — rest the cursor on the key to choose; the key shows the way last chosen. The rectangle follows the cursor between the clicks' },
  { id: 'polygon', icon: 'polygon', label: 'Polygon', title: 'A regular polygon: its centre, then a corner — or the middle of a side, for one sized across its flats like a hex nut. The sides are equal and drawn about a construction circle to dimension; how many there are is set under the keys while the tool is in hand' },
  { id: 'circle', icon: 'circle', label: 'Circle (C)', title: 'The centre and a point on the rim, the two ends of a diameter, or three points on the rim — rest the cursor on the key to choose; the key shows the way last chosen. The circle follows the cursor between the clicks' },
  { id: 'arc', icon: 'arc', label: 'Arc', title: 'The start, the end and a point it passes through, or the centre, the start and where it ends — rest the cursor on the key to choose; the key shows the way last chosen. The arc follows the cursor' },
  { id: 'spline', icon: 'spline', label: 'Spline (S)', title: 'A smooth curve through the points clicked: click each point in turn — the curve follows the cursor. Click the last point again (or double-click it), press Enter or Escape to end it open; click the first point to close it round. Drag a fit point to bend it. Joined to a line or an arc at an end, it can be held tangent there. With a spline selected, Fit to slice pulls it onto the slice it was drawn over' },
  { id: 'fillet', icon: 'filletCorner', label: 'Fillet (F)', title: 'Round a corner: click the corner point where two lines meet, or one line and then the other. With two lines selected, the key rounds those. The lines need not touch — a short piece bridging their ends is replaced by the round. The radius comes out as a dimension to type over; the next round starts with the last radius' },
  { id: 'chamfer', icon: 'chamferCorner', label: 'Chamfer', title: 'Cut a corner off straight: click the corner point where two lines meet, or one line and then the other. With two lines selected, the key chamfers those. The two distances come out as dimensions to type over — alike for an even chamfer, apart for an uneven one; the next chamfer starts with the last distance' },
  { id: 'point', icon: 'sketchPoint', label: 'Point', title: 'A point at each click — held where it snaps: an end, a centre, the middle of a line, a quadrant of a circle or an arc, on a piece or an axis. A place to hang a relation or a dimension on, as CAD’s sketch point is; it takes no part in the regions' },
  { id: 'trim', icon: 'trim', label: 'Trim (T)', title: 'Click a line, an arc or a circle: the stretch of it between the two nearest places other pieces cross it is taken away — it lights under the cursor first. A piece nothing crosses goes whole; a stretch from the middle leaves two pieces, held in line. Ends the cut moved are held where they now lie, on the piece that cut them' },
  { id: 'project', icon: 'project', label: 'Project', title: 'Click an edge of a body, or a piece of another sketch, on the part under the sheet: it comes into this sketch as a piece of its own, fixed where it lies — to close a profile with, or to hang relations and dimensions on. It lights under the cursor when it can be taken' },
]

/** The relation keys: the tooltip is the name alone, as a CAD sketcher's
 *  is; what each one takes is said on the hint line once it is in hand. */
const RELATIONS: { kind: Constraint['kind']; icon: KeyIconName; label: string }[] = [
  { kind: 'coincident', icon: 'coincident', label: 'Coincident' },
  { kind: 'horizontal', icon: 'horizontal', label: 'Horizontal' },
  { kind: 'vertical', icon: 'vertical', label: 'Vertical' },
  { kind: 'parallel', icon: 'parallel', label: 'Parallel' },
  { kind: 'perpendicular', icon: 'perpendicular', label: 'Perpendicular' },
  { kind: 'tangent', icon: 'tangent', label: 'Tangent' },
  { kind: 'concentric', icon: 'concentric', label: 'Concentric' },
  { kind: 'equal', icon: 'equal', label: 'Equal' },
  { kind: 'symmetric', icon: 'symmetric', label: 'Symmetric' },
]

/** The ways each of the shape tools draws: pictures in the strip that opens
 *  on the tool's key, the one chosen last on the key itself — and what each
 *  click of the way asks for, on the hint line. */
interface DrawMode { id: string; icon: KeyIconName; label: string; title: string; clicks: string[] }
const DRAW_MODES: { [K in keyof DrawModes]: (DrawMode & { id: DrawModes[K] })[] } = {
  rectangle: [
    { id: 'corners', icon: 'rectangle', label: 'Corner rectangle', title: 'Two opposite corners', clicks: ['Click one corner.', 'Click the opposite corner.'] },
    { id: 'center', icon: 'rectangleCenter', label: 'Centre rectangle', title: 'The centre, then a corner — the rectangle stays about its centre, a point where its construction diagonals cross', clicks: ['Click the centre.', 'Click a corner.'] },
    { id: 'threePoint', icon: 'rectangleThreePoint', label: '3-point rectangle', title: 'The two ends of one side, then where the opposite side lies — a rectangle at any angle', clicks: ['Click one end of a side.', 'Click the other end of that side.', 'Click where the opposite side lies.'] },
  ],
  circle: [
    { id: 'center', icon: 'circle', label: 'Centre circle', title: 'The centre, then a point on the rim', clicks: ['Click the centre.', 'Click a point on the rim.'] },
    { id: 'twoPoint', icon: 'circleTwoPoint', label: '2-point circle', title: 'The two ends of a diameter', clicks: ['Click one end of a diameter.', 'Click the other end.'] },
    { id: 'threePoint', icon: 'circleThreePoint', label: '3-point circle', title: 'Three points on the rim', clicks: ['Click a point on the rim — 1 of 3.', 'Click a point on the rim — 2 of 3.', 'Click a point on the rim — 3 of 3.'] },
  ],
  arc: [
    { id: 'threePoint', icon: 'arc', label: '3-point arc', title: 'The start, the end, then a point the arc passes through', clicks: ['Click the start.', 'Click the end.', 'Click a point the arc passes through.'] },
    { id: 'center', icon: 'arcCenter', label: 'Centre arc', title: 'The centre, the start, then where it ends — the shorter way round; a longer arc is drawn through three points', clicks: ['Click the centre.', 'Click the start — how far it lies is the radius.', 'Click where it ends — it runs the shorter way round.'] },
  ],
  polygon: [
    { id: 'inscribed', icon: 'polygon', label: 'Inscribed polygon', title: 'The centre, then a corner — the corners lie on the construction circle', clicks: ['Click the centre.', 'Click a corner.'] },
    { id: 'circumscribed', icon: 'polygonOutside', label: 'Circumscribed polygon', title: 'The centre, then the middle of a side — the sides touch the construction circle, whose diameter is the width across flats', clicks: ['Click the centre.', 'Click the middle of a side.'] },
  ],
}

const isShapeTool = (tool: SketchTool): tool is keyof DrawModes => tool === 'rectangle' || tool === 'polygon' || tool === 'circle' || tool === 'arc'

/** How long the cursor rests on a shape tool's key before its ways open —
 *  long enough that a hand passing over it on the way to another key does
 *  not open them over that key. */
const FLYOUT_OPEN_MS = 250
const FLYOUT_CLOSE_MS = 180

/**
 * A shape tool's key, as CAD has it: the picture of the way it draws now,
 * and — while the cursor rests on it, while the keys are tabbed into, or
 * when it is pressed again while in hand — a strip of the ways under it. The
 * way picked takes the tool up in that way and becomes the key's picture.
 */
function ShapeToolKey({ shape, label, title, inHand, onPress }: { shape: keyof DrawModes; label: string; title: string; inHand: boolean; onPress: () => void }) {
  const current = useRePrefs((s) => s.drawModes[shape])
  const modes: DrawMode[] = DRAW_MODES[shape]
  const mode = modes.find((m) => m.id === current) ?? modes[0]
  const [open, setOpen] = useState(false)
  const timer = useRef<number | null>(null)
  /** Open or close after `ms`, whatever was waiting called off. */
  const after = (ms: number, to: boolean) => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = null
    if (ms <= 0) setOpen(to)
    else timer.current = window.setTimeout(() => setOpen(to), ms)
  }
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
    },
    [],
  )
  return (
    <div
      className="toolfly"
      onPointerEnter={(e) => {
        if (e.pointerType === 'mouse') after(open ? 0 : FLYOUT_OPEN_MS, true)
      }}
      onPointerLeave={() => after(FLYOUT_CLOSE_MS, false)}
      onFocus={(e) => {
        if (e.target.matches(':focus-visible')) after(0, true)
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) after(0, false)
      }}
    >
      <button
        data-test={`sketch-tool-${shape}`}
        className={inHand ? 'on' : undefined}
        aria-pressed={inHand}
        aria-haspopup="true"
        aria-expanded={open}
        title={`${label} — ${title}`}
        aria-label={label}
        onClick={() => {
          // On a touch screen there is no resting on a key: pressed again
          // while in hand, it opens its ways.
          if (inHand) after(0, true)
          onPress()
        }}
      >
        <KeyIcon name={mode.icon} size={22} />
      </button>
      {open && (
        <div className="flyout" role="radiogroup" aria-label={`How the ${shape} is drawn`} data-test="sketch-draw-modes">
          {modes.map((m) => (
            <button
              key={m.id}
              role="radio"
              aria-checked={mode.id === m.id}
              className={mode.id === m.id ? 'on' : undefined}
              data-test={`sketch-mode-${m.id}`}
              title={`${m.label} — ${m.title}`}
              aria-label={m.label}
              onClick={() => {
                // A way chosen half way through starts the shape afresh.
                useRePrefs.getState().setDrawMode(shape, m.id as never)
                useReverse.getState().setSketchTool(shape)
                after(0, false)
              }}
            >
              <KeyIcon name={m.icon} size={22} />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

const DIMENSION_TITLE =
  'Dimension (D) — click a line for its length, an arc for its radius, a circle for its diameter (Ø — typed as R… it goes by the radius instead); click a second piece for what lies between the two: the distance between parallel lines, the angle between others, the distance from an end or a centre to a line or to another, or to one of the part’s coordinate planes (the amber lines named XY, YZ, ZX). A line’s middle and a circle’s or an arc’s quadrants are points to pick too. The number then follows the cursor: click where it goes, and type the value; Escape takes it back. Between two points, pull the number above or below them for the distance along X (ΔX), beside them for along Y (ΔY), anywhere else for straight across. With pieces selected, the key dimensions those.'

function constraintLabel(c: Constraint, sketch: Sketch): string {
  const name = (id: number) => {
    const e = sketch.entities.find((x) => x.id === id)
    return e ? `${e.kind} ${e.id}` : `#${id}`
  }
  switch (c.kind) {
    case 'coincident':
      return `Coincident ${name(c.p.entity)} · ${name(c.q.entity)}`
    case 'horizontal':
    case 'vertical':
      return `${c.kind === 'horizontal' ? 'H' : 'V'} ${name(c.entity)}`
    case 'parallel':
    case 'perpendicular':
    case 'tangent':
    case 'concentric':
    case 'equal':
    case 'angle':
      return `${c.kind[0].toUpperCase()}${c.kind.slice(1)} ${name(c.a)} · ${name(c.b)}`
    case 'symmetric':
      return `Symmetric ${name(c.p.entity)} · ${name(c.q.entity)}${typeof c.about === 'object' && 'datum' in c.about ? ` about ${datumName(c.about.datum)}` : ''}`
    case 'length':
    case 'radius':
    case 'diameter':
      return `${c.kind === 'length' ? 'L' : c.kind === 'radius' ? 'R' : 'Ø'} ${name(c.entity)}`
    case 'distance':
      return `${c.axis === 'x' ? 'ΔX' : c.axis === 'y' ? 'ΔY' : 'd'} ${name(c.p.entity)} · ${'datum' in c.q ? datumName(c.q.datum) : 'line' in c.q ? name(c.q.line) : name(c.q.entity)}`
    case 'pointOn':
      return `On ${name(c.p.entity)} · ${'datum' in c.on ? datumName(c.on.datum) : 'line' in c.on ? name(c.on.line) : name(c.on.curve)}`
    case 'collinear':
      return `Collinear ${name(c.line)} · ${'datum' in c.on ? datumName(c.on.datum) : name(c.on.line)}`
  }
}

/** The rounding a dimension of this kind is offered: a diameter rounds as
 *  a length does. */
function nominalKindOf(kind: Constraint['kind']): NominalKind {
  return kind === 'radius' ? 'radius' : kind === 'angle' ? 'angle' : 'length'
}

/** The chip beside a measured number: its rounding, one click to take. */
function NominalChip({ value, kind, testId, onTake }: { value: number; kind: NominalKind; testId: string; onTake: (v: number) => void }) {
  const units = useLength().units
  const n = nominalOf(value, kind)
  if (n === null) return null
  return (
    <button className="chip nominal" data-test={testId} tabIndex={-1} title="The round number this was probably designed at — click to take it" onClick={() => onTake(n)}>
      → {nominalText(n, kind, units)}
    </button>
  )
}

/** A picture file read and scaled down to what a sketch keeps — see
 *  core/sketchImage. A PNG stays a PNG, a drawing's lines kept sharp; a
 *  photo is kept as a JPEG. */
async function readPicture(file: File): Promise<{ src: string; width: number; height: number }> {
  const bitmap = await createImageBitmap(file)
  const k = Math.min(1, IMAGE_MAX_PX / Math.max(bitmap.width, bitmap.height))
  const width = Math.max(1, Math.round(bitmap.width * k))
  const height = Math.max(1, Math.round(bitmap.height * k))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()
  return { src: canvas.toDataURL(file.type === 'image/png' ? 'image/png' : 'image/jpeg', 0.9), width, height }
}

/** The picture under the sketch: laid in from a file, then brought to
 *  scale by two points a known length apart, moved by a point of it and
 *  where that belongs, levelled by two points that should lie level, faded,
 *  or taken away. */
function PictureRow({ draft }: { draft: SketchDraft }) {
  const re = useReverse.getState()
  const image = draft.image
  const pick = draft.imagePick ?? null
  const [length, setLength] = useState<number | null>(null)
  const file = useRef<HTMLInputElement>(null)
  const len = useLength()
  const lay = async (f: File | undefined) => {
    if (!f) return
    try {
      const { src, width, height } = await readPicture(f)
      const b = sketchBounds(draft.sketch)
      const centre: [number, number] = b ? [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2] : [0, 0]
      useReverse.getState().setSketchImage(placedImage(src, width, height, centre, f.name))
    } catch {
      useStore.getState().setError(`${f.name} could not be read as a picture.`)
    }
  }
  const input = <input ref={file} type="file" accept="image/*" hidden data-test="sketch-image-file" onChange={(e) => void lay(e.target.files?.[0]).then(() => (e.target.value = ''))} />
  if (!image) {
    return (
      <div className="toolrow">
        {input}
        <button className="withicon" data-test="sketch-image-add" title="Lay a photo of the part or a dimensioned drawing under the sketch, to trace — then bring it to scale by two points a known length apart" onClick={() => file.current?.click()}>
          <KeyIcon name="sketchImage" size={18} />
          Picture…
        </button>
      </div>
    )
  }
  const key = (mode: ImagePickMode, label: string, title: string) => (
    <button data-test={`sketch-image-${mode}`} className={pick?.mode === mode ? 'on' : undefined} aria-pressed={pick?.mode === mode} title={title} onClick={() => re.startImagePick(pick?.mode === mode ? null : mode)}>
      {label}
    </button>
  )
  return (
    <div className="subbox" data-test="sketch-image">
      {input}
      <div className="kv">
        <KeyIcon name="sketchImage" size={16} />
        <span className="name" title={image.name}>
          {image.name ?? 'Picture'}
        </span>
        {/* The picture's scale as each system reads one: micrometres a
            pixel, or pixels to the inch. */}
        {len.units === 'in' ? (
          <b title="Pixels per inch of the picture">{(25.4 / image.mmPerPx).toFixed(0)} px/in</b>
        ) : (
          <b title="Micrometres per pixel of the picture">{(image.mmPerPx * 1000).toFixed(1)} µm/px</b>
        )}
        <button className="x" data-test="sketch-image-remove" title="Take the picture away" onClick={() => re.setSketchImage(null)}>
          ×
        </button>
      </div>
      <div className="toolrow">
        {key('scale', 'Scale', 'Bring the picture to scale: click two points on it, then type how far apart they are on the part')}
        {key('move', 'Move', 'Move the picture: click a point on it, then where that point belongs — an end, the origin, an axis snaps')}
        {key('level', 'Level', 'Turn the picture level: click two points on it that should lie on a horizontal line')}
      </div>
      {pick?.mode === 'scale' && pick.points.length >= 2 && (
        <div className="toolrow">
          <label className="field">
            <span>Apart on the part</span>
            <ExprInput value={length ?? 0} kind="length" unit={len.word()} testId="sketch-image-length" onCommit={(v) => setLength(v)} onEnter={() => length && re.scaleSketchImage(length)} />
          </label>
          <button className="primary" data-test="sketch-image-apply" disabled={!length} onClick={() => length && re.scaleSketchImage(length)}>
            Scale
          </button>
        </div>
      )}
      <label className="field" title="How much of the picture shows: faded, the scan and the pieces show through it">
        <span>Shown</span>
        <input type="range" min={0.1} max={1} step={0.05} value={image.opacity} data-test="sketch-image-opacity" onChange={(e) => re.setSketchImage({ ...image, opacity: Number(e.target.value) })} />
      </label>
    </div>
  )
}

/** What the Picture row's two clicks ask for, on the hint line. */
function imagePickHint(pick: NonNullable<SketchDraft['imagePick']>): string {
  const n = pick.points.length
  if (pick.mode === 'scale') return n === 0 ? 'Click a point on the picture whose distance to another you know.' : n === 1 ? 'Click the other point.' : 'Type how far apart the two points are on the part.'
  if (pick.mode === 'move') return n === 0 ? 'Click a point on the picture.' : 'Click where that point belongs.'
  return n === 0 ? 'Click a point on a line of the picture that should lie level.' : 'Click another point on that line.'
}

/** A number of the Pattern box: typed, or an expression over the
 *  parameters taken for what it comes to — the copies are pieces of their
 *  own, and nothing keeps them following it. */
function PatternNum({ label, value, unit, testId, onCommit }: { label: string; value: number; unit: '°' | '×' | 'length'; testId: string; onCommit: (v: number) => void }) {
  const len = useLength()
  return (
    <label className="field">
      <span>{label}</span>
      <ExprInput value={value} kind={unit === '°' ? 'angle' : unit === 'length' ? 'length' : 'integer'} unit={unit === 'length' ? len.word() : unit} testId={testId} onCommit={(v) => onCommit(v)} />
    </label>
  )
}

/** The spacing a new grid pattern starts with. */
const PATTERN_SPACING: LengthPresets = { mm: [10], in: [0.5] }

/** The Pattern box: the selected pieces repeated along the sheet's X and Y
 *  — a row, or a grid with a second count — or round a centre, drawn on the
 *  sheet as they would land until applied. */
function PatternBox({ spec, selected }: { spec: SketchPatternSpec; selected: number }) {
  const re = useReverse.getState()
  const set = (next: SketchPatternSpec) => re.setSketchPattern(next)
  const count = (v: number) => Math.max(1, Math.min(500, Math.round(Math.abs(v))))
  // A new grid's spacing: a round figure in the units shown.
  const spacing = useLength().presets(PATTERN_SPACING)[0]
  return (
    <div className="subbox" data-test="sketch-pattern-box">
      <div className="moderow" role="radiogroup" aria-label="How the pieces are repeated">
        <button role="radio" aria-checked={spec.kind === 'rectangular'} className={spec.kind === 'rectangular' ? 'on' : undefined} data-test="sketch-pattern-grid" onClick={() => spec.kind !== 'rectangular' && set({ kind: 'rectangular', step: [spacing, 0], count: 3 })}>
          <KeyIcon name="sketchPattern" size={16} /> Grid
        </button>
        <button role="radio" aria-checked={spec.kind === 'circular'} className={spec.kind === 'circular' ? 'on' : undefined} data-test="sketch-pattern-round" onClick={() => spec.kind !== 'circular' && set({ kind: 'circular', centre: [0, 0], count: 6, angleDeg: 360 })}>
          <KeyIcon name="sketchPatternRound" size={16} /> Round
        </button>
      </div>
      {spec.kind === 'rectangular' ? (
        <>
          <PatternNum label="Along X" value={spec.count} unit="×" testId="sketch-pattern-count" onCommit={(v) => set({ ...spec, count: count(v) })} />
          <PatternNum label="X spacing" value={spec.step[0]} unit="length" testId="sketch-pattern-step" onCommit={(v) => set({ ...spec, step: [v, 0] })} />
          <PatternNum label="Along Y" value={spec.count2 ?? 1} unit="×" testId="sketch-pattern-count2" onCommit={(v) => set({ ...spec, count2: count(v), step2: spec.step2 ?? [0, spec.step[0] || spacing] })} />
          {(spec.count2 ?? 1) > 1 && <PatternNum label="Y spacing" value={spec.step2?.[1] ?? spacing} unit="length" testId="sketch-pattern-step2" onCommit={(v) => set({ ...spec, step2: [0, v] })} />}
        </>
      ) : (
        <>
          <PatternNum label="Count" value={spec.count} unit="×" testId="sketch-pattern-count" onCommit={(v) => set({ ...spec, count: count(v) })} />
          <PatternNum label="Over" value={spec.angleDeg} unit="°" testId="sketch-pattern-angle" onCommit={(v) => set({ ...spec, angleDeg: v })} />
          <PatternNum label="Centre X" value={spec.centre[0]} unit="length" testId="sketch-pattern-cx" onCommit={(v) => set({ ...spec, centre: [v, spec.centre[1]] })} />
          <PatternNum label="Centre Y" value={spec.centre[1]} unit="length" testId="sketch-pattern-cy" onCommit={(v) => set({ ...spec, centre: [spec.centre[0], v] })} />
        </>
      )}
      <p className="hint">{spec.kind === 'rectangular' ? 'Counts take the selection itself in; a negative spacing runs the other way.' : '360° spreads the copies evenly round; less spans that angle, first to last.'}</p>
      <div className="toolrow">
        <button className="primary" data-test="sketch-pattern-apply" disabled={selected === 0} onClick={() => re.applySketchPattern()}>
          Pattern {selected} piece{selected === 1 ? '' : 's'}
        </button>
        <button data-test="sketch-pattern-cancel" onClick={() => re.cancelSketchPattern()}>
          Cancel
        </button>
      </div>
    </div>
  )
}

export function SketchEditor({ chainsOf }: { chainsOf: () => SketchChains | null }) {
  const draft = useReverse((s) => s.sketchDraft)
  const chainCount = useReverse((s) => s.chainCount)
  const chainsStatus = useReverse((s) => s.chainsStatus)
  const gridSnap = useRePrefs((s) => s.gridSnap)
  const showRelations = useRePrefs((s) => s.sketchRelations)
  const drawModes = useRePrefs((s) => s.drawModes)
  const polygonSides = useRePrefs((s) => s.polygonSides)
  const len = useLength()
  const re = useReverse
  const sections = useStore((s) => s.sections)
  const elements = useStore((s) => s.elements)
  // The first sketch on a part still in the scanner's frame: the body will
  // be built there, tilted however the part lay on the turntable. Said once,
  // where the modelling starts — with a feature made the operator has
  // chosen, and an alignment applied later carries the features along.
  const unaligned = useStore((s) => s.appliedAlignment === null && s.fileName !== null)
  const firstFeature = useReverse((s) => s.features.length === 0)
  // A dimension just made is there to be typed into: the row of one that
  // was not there a moment ago takes the focus, its number selected — a
  // round's radius, a chamfer's distances. One the Dimension tool makes
  // opens on the sheet instead, under the hand, once it is put down
  // (useSketchSceneSync); while it follows the cursor nothing takes the keys.
  const boxRef = useRef<HTMLDivElement>(null)
  const knownDimensions = useRef<Set<number>>(new Set())
  const dimensionIds = draft ? draft.sketch.constraints.filter(isDimension).map((c) => c.id) : []
  const dimensionKey = dimensionIds.join(',')
  const selectedConstraint = draft?.selectedConstraint ?? null
  const inHand = draft?.dimMade ?? null
  useEffect(() => {
    const fresh = selectedConstraint !== null && selectedConstraint !== inHand && dimensionIds.includes(selectedConstraint) && !knownDimensions.current.has(selectedConstraint)
    knownDimensions.current = new Set(dimensionIds)
    if (!fresh) return
    const input = boxRef.current?.querySelector<HTMLInputElement>(`[data-dimension="${selectedConstraint}"]`)
    input?.focus()
    input?.select()
    // Runs on the listed dependencies only, not on everything it reads.
  }, [dimensionKey, selectedConstraint, inHand])
  const [fitOptionsOpen, setFitOptionsOpen] = useState(false)

  if (!draft) return null

  const sketch = draft.sketch
  const relations = sketch.constraints.filter((c) => !isDimension(c) && !c.inferred)
  const inferred = sketch.constraints.filter((c) => !isDimension(c) && c.inferred)
  const dimensions = sketch.constraints.filter(isDimension)
  // Every Fix is a relation of the list too, removed as one is.
  const fixes = fixedPieces(sketch)
  const fittedCount = Object.keys(draft.fitted).length
  const unfitted = chainCount - fittedCount
  const found = draft.found.length
  const report = draft.report
  const hasSelection = draft.selection.length > 0
  const oneLine = draft.selection.length === 1 && sketch.entities.find((e) => e.id === draft.selection[0])?.kind === 'line'
  const empty = sketch.entities.length === 0
  const unmet = report && !report.ok ? report.unmet : []
  // Two states the operator reads, needs input and solved; the solver's
  // own words — unmet, redundant, the RMS — wait in the tooltip.
  const status = empty ? 'empty' : unmet.length > 0 ? 'failed' : 'ready'
  const unmetTitle = unmet
    .map((u) => {
      const c = sketch.constraints.find((x) => x.id === u.id)
      return c ? `${constraintLabel(c, sketch)} — off by ${u.residual.toFixed(3)}` : `#${u.id}`
    })
    .join('\n')
  const solvedTitle =
    report && report.ok
      ? [
          report.softRms > 0 ? `The fitted pieces sit on the slice to ${len.fmt(report.softRms)} RMS` : 'Every relation and dimension is met',
          report.redundant > 0 ? `${report.redundant} relation${report.redundant === 1 ? '' : 's'} say nothing new (redundant)` : '',
          report.underConstrained.length > 0 ? `${report.underConstrained.length} piece${report.underConstrained.length === 1 ? '' : 's'} not fully constrained — drawn in the loose colour` : 'Every piece is fully constrained',
          `${report.iterations} solver step${report.iterations === 1 ? '' : 's'}`,
        ]
          .filter(Boolean)
          .join('\n')
      : ''
  // The shape tool in hand, the way it draws, and what its next click is.
  const shape = isShapeTool(draft.tool) ? draft.tool : null
  const shapeModes: DrawMode[] = shape ? DRAW_MODES[shape] : []
  const shapeMode = shape ? shapeModes.find((m) => m.id === drawModes[shape]) ?? shapeModes[0] : null
  // One line, and only when there is something to say: what went wrong,
  // what is being waited for, or what the tool in hand wants clicked next.
  const hint =
    draft.error ??
    (draft.imagePick
      ? imagePickHint(draft.imagePick)
      : chainsStatus === 'cutting'
      ? 'Cutting the scan on the sketch plane…'
      : shapeMode
        ? shapeMode.clicks[Math.min(draft.pending.length, shapeMode.clicks.length - 1)]
      : draft.tool === 'spline'
        ? draft.pending.length === 0
          ? 'Click the first point of the curve.'
          : draft.pending.length < 3
            ? 'Click the next point — the last one again, or Enter, ends the curve.'
            : 'Click the next point — the last one again, or Enter, ends it; the first point closes it.'
      : draft.tool === 'dimension'
        ? draft.dimMade != null
          ? draft.dimPick
            ? 'Click where the number goes — or a second piece, end or plane for the distance or angle to it.'
            : 'Click where the number goes.'
          : draft.dimPick
            ? 'Click the second piece, end or coordinate plane.'
            : 'Click what to dimension: a line, a round piece, an end — or a coordinate plane’s line.'
        : draft.tool === 'fillet' || draft.tool === 'chamfer'
          ? draft.selection.length > 0
            ? 'Click the second line of the corner.'
            : 'Click a corner point, or the first of its two lines.'
          : draft.tool === 'trim'
            ? 'Click the stretch of a line, an arc or a circle to take away — up to where other pieces cross it.'
          : draft.tool === 'point'
            ? 'Click where the point goes — an end, a middle, a quadrant or a piece holds it.'
          : draft.tool === 'relation'
            ? draft.armedRelation === 'symmetric'
              ? draft.selection.length === 0
                ? 'Symmetric: click the first of the two pieces that mirror each other.'
                : draft.selection.length === 1
                  ? 'Click the piece that mirrors it.'
                  : 'Click the line they mirror about — a construction line, or a coordinate plane’s line on the sheet.'
              : draft.armedRelation === 'coincident'
                ? (draft.relPicks?.length ?? 0) > 0
                  ? 'Now the second: an end, a centre, a piece, or a coordinate plane’s line.'
                  : 'Coincident: click an end, a centre or a piece — then what it lies on: another end, a line, an arc, or a coordinate plane’s line (the amber lines).'
                : draft.selection.length > 0
                  ? 'Click the second piece.'
                  : 'Click the piece to put it on.'
            : null)

  const finishKey = (testId: string) => (
    <button className="primary block" data-test={testId} title="Finish the sketch — Enter or a middle click does the same. With nothing drawn, nothing is made." onClick={() => re.getState().commitSketch()}>
      Finish sketch
    </button>
  )

  return (
    <div className="draftbox" data-test="sketch-editor" ref={boxRef}>
      <div className="sec-head">
        {draft.featureId !== undefined ? `Edit ${draft.name}` : 'New sketch'}
        <InfoDot title="Sketching">
          <p>
            The sketch lies on its plane — a section, a plane element, a coordinate plane or a
            face of a body — and is drawn on the part, which faces the plane and is cut open at it;
            the view bar's <b>Model</b> and <b>Slice</b> keys put the part away and show it whole.
          </p>
          <p>
            <b>Fit all chains</b> cuts every slice chain into lines and arcs, each keeping its
            slice points: the solver holds every piece to its points while the relations and the
            dimensions you type are met exactly. <b>Infer corners</b> joins ends within {len.fmt(CORNER_GAP_MM, 0)} and
            adds a tangency where a line runs into an arc; <b>Close</b> bridges what is left open.
          </p>
          <p>
            Every closed region is filled faintly; <b>Extrude</b> and <b>Revolve</b> appear as soon
            as one closes and take it straight into a feature. <b>Finish sketch</b> keeps the
            drawing as a feature for later; Escape only puts the tool down, and a sketch you did not
            want is undone with Ctrl+Z from the feature list.
          </p>
          <p>
            <b>Dimension</b> (D) and the relations work both ways round: on the pieces selected, or,
            with nothing selected, on what is clicked next. The Line tool (L) draws a chain, each
            line from the end of the last; press on that end and drag for a tangent arc.
            A new dimension's number follows the cursor until a click puts it down, and opens there
            to be typed; Escape takes it back. Later it is dragged to where it reads best, and
            clicked to be typed over.
          </p>
        </InfoDot>
      </div>

      {finishKey('sketch-finish-top')}

      {draft.featureId !== undefined && (
        <NameField value={draft.name} testId="sketch-name" onChange={(n) => re.getState().setSketchName(n)} />
      )}
      <BuildSays featureId={draft.featureId} />

      <p className="hint" data-test="sketch-plane">
        On {describePlaneRef(draft.plane, { sections, elements }, len.units)}
        {chainsStatus === 'ready' && ` · ${chainCount} slice chain${chainCount === 1 ? '' : 's'}`}
      </p>
      {planeTakesOffset(draft.plane) && (
        <label className="field" data-test="sketch-offset" title={draft.plane.kind === 'world' ? 'Where the coordinate plane lies along its axis — a number, or an expression over the parameters the sketch then follows' : 'How far the sketch stands off its plane, along the plane’s normal — out of a face is positive. A number, or an expression over the parameters'}>
          <span>{draft.plane.kind === 'world' ? `Plane at ${draft.plane.axis.toUpperCase()} =` : 'Offset'}</span>
          <ExprInput value={planeOffset(draft.plane)} expr={draft.exprs?.offset} kind="length" unit={len.word()} testId="sketch-offset-input" onCommit={(v, expr) => re.getState().setSketchOffset(v, expr)} />
        </label>
      )}

      <label className="field" data-test="sketch-level" title="Cut the scan this far off the sketch’s plane, along its normal, and fit that level’s outline into this sketch — another height of a stacked part. Fit all chains then lands on the pieces already drawn: a wall they have is not fitted again, and the new walls end on theirs. 0 cuts at the plane (a face’s a hair inside it).">
        <span>Level</span>
        <ExprInput value={draft.level ?? 0} kind="length" unit={len.word()} testId="sketch-level-input" onCommit={(v) => re.getState().setSketchLevel(v)} />
      </label>

      <PictureRow draft={draft} />

      {unaligned && firstFeature && draft.featureId === undefined && (
        <p className="hint" data-test="sketch-align-nudge">
          Part not aligned yet.{' '}
          <button
            className="chip nominal"
            data-test="sketch-align-go"
            title="The part is still in the scanner's frame, and the body will be built in it — a STEP file that lies askew in CAD. Aligning the part onto its fitted planes first makes the model square. This opens the 3-2-1 alignment in the 3D Measure workspace; the sketch stays open and moves with the part."
            onClick={() => {
              useShell.getState().setWorkspace('elements')
              useStore.getState().startAlignment()
            }}
          >
            Align in 3D Measure…
          </button>
        </p>
      )}

      <div className="toolrow">
        <button
          className="withicon"
          data-test="sketch-fit-all"
          disabled={chainsStatus !== 'ready' || unfitted <= 0}
          title="Cut every slice chain into lines and arcs, each with its slice points behind it"
          onClick={() => {
            const chains = chainsOf()
            if (chains) re.getState().autoFit(chains.chains, 'all', useRePrefs.getState().fitOptions, SHARE_MM)
          }}
        >
          <Icon name="fitAll" size={18} />
          Fit all chains
        </button>
        <button
          className="withicon"
          data-test="sketch-infer"
          disabled={fittedCount === 0}
          title={`Join neighbouring ends within ${len.fmt(CORNER_GAP_MM, 0)}, with a tangency where a line meets an arc`}
          onClick={() => re.getState().inferAllCorners()}
        >
          <Icon name="inferCorners" size={18} />
          Infer corners
        </button>
        <button
          className="withicon"
          data-test="sketch-close"
          disabled={fittedCount === 0}
          title="Bridge every gap left open along the fitted chains"
          onClick={() => re.getState().closeAll()}
        >
          <Icon name="closeChain" size={18} />
          Close
        </button>
      </div>
      <button
        className="chip nominal"
        data-test="sketch-fit-options"
        aria-haspopup="dialog"
        aria-expanded={fitOptionsOpen}
        title="How fine the slice is cut, the fit tolerance, corners joined, lines laid along the axes — in a window of its own; a change there refits the chains"
        onClick={() => setFitOptionsOpen((on) => !on)}
      >
        Fit options…
      </button>
      <FitOptionsModal open={fitOptionsOpen} onClose={() => setFitOptionsOpen(false)} chainsOf={chainsOf} />

      <div className="iconrow" data-test="sketch-tools">
        {TOOLS.map((t) =>
          isShapeTool(t.id) ? (
            <ShapeToolKey key={t.id} shape={t.id} label={t.label} title={t.title} inHand={draft.tool === t.id} onPress={() => re.getState().setSketchTool(t.id)} />
          ) : (
          <button
            key={t.id}
            data-test={`sketch-tool-${t.id}`}
            className={draft.tool === t.id ? 'on' : undefined}
            aria-pressed={draft.tool === t.id}
            title={`${t.label} — ${t.title}`}
            aria-label={t.label}
            onClick={() => {
              // A corner tool on two lines already selected works on those;
              // pressed again while in hand it is put down.
              const corner = t.id === 'fillet' || t.id === 'chamfer'
              if (corner && draft.selection.length === 2 && draft.tool !== t.id) return t.id === 'fillet' ? re.getState().filletSelected() : re.getState().chamferSelected()
              re.getState().setSketchTool(corner && draft.tool === t.id ? 'select' : t.id)
            }}
          >
            <KeyIcon name={t.icon} size={22} />
          </button>
          ),
        )}
        <button
          data-test="sketch-grid-snap"
          className={gridSnap ? 'on' : undefined}
          aria-pressed={gridSnap}
          aria-label="Snap to grid"
          title="Snap to grid — drawn and dragged points snap to the grid as well as to ends, the slice and pieces — off, the grid is only there to read against"
          onClick={() => useRePrefs.getState().setGridSnap(!gridSnap)}
        >
          <Icon name="gridSnap" size={22} />
        </button>
        <button
          data-test="sketch-show-relations"
          className={showRelations ? 'on' : undefined}
          aria-pressed={showRelations}
          aria-label="Show relations"
          title="Show relations — draw every relation beside its piece as a glyph. Off, only the one selected in the list below is drawn; the dimensions are always shown"
          onClick={() => useRePrefs.getState().setSketchRelations(!showRelations)}
        >
          <Icon name={showRelations ? 'eye' : 'eyeOff'} size={22} />
        </button>
      </div>
      {draft.tool === 'polygon' && (
        <label className="kv" data-test="sketch-polygon-sides" title="How many sides the polygon has — three and up">
          <span className="name">Sides</span>
          <NumberInput
            min={3}
            max={POLYGON_MAX_SIDES}
            step={1}
            value={polygonSides}
            data-test="sketch-polygon-sides-input"
            onCommit={(v) => {
              if (v !== null) useRePrefs.getState().setPolygonSides(v)
            }}
          />
        </label>
      )}
      {draft.selection.some((id) => sketch.entities.find((e) => e.id === id)?.kind === 'spline') && (
        <button
          className="chip nominal"
          data-test="sketch-spline-fit"
          disabled={chainsStatus !== 'ready'}
          title="Fit the selected spline to the slice it was drawn over: the slice points along it — within a twentieth of its length — become its soft data, and the solver pulls the curve onto them, its fit points moving as far as its relations let them. Add fit points where the outline bends more than the curve can follow"
          onClick={() => {
            const chains = chainsOf()
            if (chains) re.getState().fitSplinesToSlice(chains.chains)
          }}
        >
          Fit spline to slice
        </button>
      )}
      {hint && (
        <p className="hint" data-test="sketch-hint">
          {hint}
        </p>
      )}

      <div className="g-label">
        <span>Dimension · Relations</span>
        <b>{draft.selection.length} selected</b>
      </div>
      <div className="iconrow ten" data-test="sketch-relations">
        <button
          data-test="sketch-dimension"
          className={draft.tool === 'dimension' ? 'on' : undefined}
          aria-pressed={draft.tool === 'dimension'}
          title={DIMENSION_TITLE}
          aria-label="Dimension"
          onClick={() => (hasSelection ? re.getState().dimensionSelection() : re.getState().setSketchTool(draft.tool === 'dimension' ? 'select' : 'dimension'))}
        >
          <Icon name="dimDistance" size={20} />
        </button>
        {RELATIONS.map((r) => {
          const armed = draft.tool === 'relation' && draft.armedRelation === r.kind
          return (
            <button
              key={r.kind}
              data-test={`sketch-rel-${r.kind}`}
              className={armed ? 'on' : undefined}
              aria-pressed={armed}
              title={r.label}
              aria-label={r.label}
              onClick={() => (hasSelection && !armed ? re.getState().addRelation(r.kind) : armed ? re.getState().setSketchTool('select') : re.getState().armRelation(r.kind))}
            >
              <KeyIcon name={r.icon} size={20} />
            </button>
          )
        })}
      </div>
      <div className="iconrow" data-test="sketch-edit">
        <button data-test="sketch-delete" disabled={!hasSelection} aria-label="Delete" title="Delete the selected pieces" onClick={() => re.getState().deleteSelected()}>
          <Icon name="del" size={22} />
        </button>
        <button data-test="sketch-sharpen" disabled={!hasSelection} aria-label="Sharp corner" title="Sharp corner — Remove the selected fillet arc or chamfer line and carry its two lines to the corner" onClick={() => re.getState().sharpenSelected()}>
          <Icon name="sharpCorner" size={22} />
        </button>
        <button data-test="sketch-fix" disabled={!hasSelection} aria-label="Fix" title="Fix — Lock the selected pieces where they are" onClick={() => re.getState().toggleFixedSelected()}>
          <Icon name="fix" size={22} />
        </button>
        <button data-test="sketch-construction" disabled={!hasSelection} aria-label="Construction" title="Construction — Construction geometry takes no part in the regions — an axis to revolve about, a mirror line" onClick={() => re.getState().toggleConstructionSelected()}>
          <Icon name="construction" size={22} />
        </button>
        <button data-test="sketch-pattern" disabled={!hasSelection} className={draft.pattern ? 'on' : undefined} aria-pressed={Boolean(draft.pattern)} aria-label="Pattern" title="Pattern — Repeat the selected pieces in a row, a grid or round a centre. Each copy is a piece of its own and keeps the relations and dimensions the pieces have among themselves" onClick={() => (draft.pattern ? re.getState().cancelSketchPattern() : re.getState().openSketchPattern())}>
          <KeyIcon name="sketchPattern" size={22} />
        </button>
        <button data-test="sketch-align" disabled={!oneLine} aria-label="Align" title="Align — Turn the sheet so the selected line lies along its X axis — a crooked edge of the scan becomes the horizontal the rest is drawn against. Nothing moves on the part." onClick={() => re.getState().alignToSelected()}>
          <Icon name="alignSheet" size={22} />
        </button>
      </div>

      {draft.pattern && <PatternBox spec={draft.pattern} selected={draft.selection.length} />}

      {inferred.length > 0 && (
        <div className="chiprow" data-test="sketch-inferred">
          {inferred.map((c) => (
            <span key={c.id} className={'relchip' + (draft.selectedConstraint === c.id ? ' sel' : '') + (unmet.some((u) => u.id === c.id) ? ' warn' : '')} data-test="sketch-inferred-chip" title="Inferred while drawing — the piece was drawn nearly so. Click to select it, × to take it off." onClick={() => re.getState().selectConstraint(c.id)}>
              {constraintLabel(c, sketch)}
              <button className="x" tabIndex={-1} title="Take the inferred relation off" onClick={(e) => { e.stopPropagation(); re.getState().selectConstraint(c.id); re.getState().removeSelectedConstraint() }}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {(relations.length > 0 || dimensions.length > 0 || fixes.length > 0) && (
        <div className="relations" data-test="sketch-constraints">
          {dimensions.map((c) => (
            <div key={c.id} className={'kv' + (draft.selectedConstraint === c.id ? ' sel' : '')} data-test="sketch-dimension-row">
              <span className="name" onClick={() => re.getState().selectConstraint(c.id)}>
                {constraintLabel(c, sketch)}
              </span>
              {(c.kind === 'radius' || c.kind === 'diameter') && (
                <button
                  className="chip"
                  data-test="sketch-dimension-form"
                  tabIndex={-1}
                  title={c.kind === 'radius' ? 'Give it by its diameter instead' : 'Give it by its radius instead'}
                  onClick={() => re.getState().setDimensionForm(c.id, c.kind === 'radius' ? 'diameter' : 'radius')}
                >
                  {c.kind === 'radius' ? '→ Ø' : '→ R'}
                </button>
              )}
              {c.kind === 'distance' && 'entity' in c.q && (
                <button
                  className="chip"
                  data-test="sketch-distance-axis"
                  tabIndex={-1}
                  title={`Measured ${c.axis === 'x' ? 'along X (ΔX)' : c.axis === 'y' ? 'along Y (ΔY)' : 'straight across'} — click to measure it ${c.axis === 'x' ? 'along Y' : c.axis === 'y' ? 'straight across' : 'along X'} instead. Placing a new one does the same: pull its number above or below the two points for ΔX, beside them for ΔY`}
                  onClick={() => re.getState().setDistanceAxis(c.id, c.axis === 'x' ? 'y' : c.axis === 'y' ? null : 'x')}
                >
                  {c.axis === 'x' ? '↔ ΔX' : c.axis === 'y' ? '↕ ΔY' : '⤢ d'}
                </button>
              )}
              {!c.expr && <NominalChip value={c.value} kind={nominalKindOf(c.kind)} testId="sketch-nominal" onTake={(v) => re.getState().setDimensionValue(c.id, v)} />}
              {/* A number, or an expression over the parameters kept beside
                  it. Escape is the field's own: it leaves the number, and goes
                  no further to put the tool or the selection down. Enter takes
                  the number — typed, or as it stands — and with it the
                  Dimension tool's pick is done. */}
              <ExprInput
                value={c.value}
                expr={c.expr}
                kind={dimensionKind(c.kind)}
                unit={c.kind === 'angle' ? '°' : len.word()}
                testId="sketch-dimension-input"
                dataDimension={c.id}
                onCommit={(v, expr) => re.getState().setDimensionValue(c.id, v, expr)}
                onEnter={() => re.getState().finishDimension(c.id)}
              />
              {unmet.some((u) => u.id === c.id) && <b className="warn">⚠</b>}
              <button className="x" tabIndex={-1} title="Remove the dimension" onClick={() => { re.getState().selectConstraint(c.id); re.getState().removeSelectedConstraint() }}>
                ×
              </button>
            </div>
          ))}
          {relations.map((c) => (
            <div key={c.id} className={'kv' + (draft.selectedConstraint === c.id ? ' sel' : '')} data-test="sketch-relation-row">
              <span className="name" onClick={() => re.getState().selectConstraint(c.id)}>
                {constraintLabel(c, sketch)}
              </span>
              {unmet.some((u) => u.id === c.id) && <b className="warn">⚠</b>}
              <button className="x" tabIndex={-1} title="Remove the relation" onClick={() => { re.getState().selectConstraint(c.id); re.getState().removeSelectedConstraint() }}>
                ×
              </button>
            </div>
          ))}
          {fixes.map((e) => (
            <div key={fixId(e.id)} className={'kv' + (draft.selectedConstraint === fixId(e.id) ? ' sel' : '')} data-test="sketch-fix-row">
              <span className="name" onClick={() => re.getState().selectConstraint(fixId(e.id))}>
                Fix {e.kind} {e.id}
              </span>
              <button className="x" tabIndex={-1} title="Take the Fix off — the piece is free to move again" onClick={() => { re.getState().selectConstraint(fixId(e.id)); re.getState().removeSelectedConstraint() }}>
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="dro">
        <div className="dro-label">
          <span>Sketch</span>
          <span data-test="sketch-counts">
            {sketch.entities.length} piece{sketch.entities.length === 1 ? '' : 's'} · {found} region{found === 1 ? '' : 's'}
            {report && report.underConstrained.length > 0 && (
              <span data-test="sketch-loose" title="Pieces a relation or dimension does not pin down yet — drawn in the loose colour on the sheet; the rest in the constrained colour">
                {' '}· {report.underConstrained.length} loose
              </span>
            )}
          </span>
        </div>
        <div className={'dro-window ' + status + (status === 'failed' ? ' alarm' : '')} data-test="sketch-status" title={status === 'failed' ? unmetTitle : solvedTitle}>
          {status === 'empty' && <b style={{ fontSize: 12, fontWeight: 400, color: 'var(--dim)' }}>Needs input</b>}
          {status === 'failed' && (
            <b>
              ⚠ {unmet.length} relation{unmet.length === 1 ? '' : 's'} not met
            </b>
          )}
          {status === 'ready' && <b style={{ fontSize: 13 }}>Solved{found > 0 ? ` · ${found} closed region${found === 1 ? '' : 's'}` : ' · no closed region yet'}</b>}
        </div>
      </div>
      {found > 0 && (
        <div className="toolrow" data-test="sketch-feature-keys">
          <button className="primary withicon" data-test="sketch-extrude" title="Finish the sketch and extrude every region of it — the body shows as a ghost with arrows to drag; a click on a region lets it go" onClick={() => re.getState().finishAndExtrude()}>
            <Icon name="extrude" size={18} />
            Extrude
          </button>
          <button className="primary withicon" data-test="sketch-revolve" title="Finish the sketch and revolve every region of it about an axis picked next" onClick={() => re.getState().finishAndRevolve()}>
            <Icon name="revolve" size={18} />
            Revolve
          </button>
        </div>
      )}

      {finishKey('sketch-finish')}
    </div>
  )
}
