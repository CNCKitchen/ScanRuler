// SPDX-License-Identifier: AGPL-3.0-only
// The steps a join left (stepsBetween.ts), said: each face traced back to
// the feature and the sketch piece that made it (traceFace), and the fix
// in the words of the commands that make it — a level fitted into the
// other sketch, or the other sketch's piece projected. The build finds the
// steps; the page, which holds the features and their sketches, says them
// in the join's warning and in the answer of the change that made it — and
// for the person, a short line each in the join's box (stepLines).

import type { Vec3 } from '../../../src/core/types'
import { traceFace, type FaceTrace } from './audit'
import type { FeatureResult } from './buildTypes'
import type { Feature } from './features'
import { HAIR_MM, type StepBetween } from './stepsBetween'
import type { FaceFingerprint } from './topo'

/** How many steps a change's answer lists — the rest counted. */
export const STEPS_LISTED = 5

/** How many a row's warning words — the rest counted. */
const STEPS_WORDED = 3

const r2 = (x: number) => Math.round(x * 100) / 100
const r3 = (x: number) => Math.round(x * 1000) / 1000
/** A step's width in its own digits: 0.07, 0.0004. */
const mm = (x: number) => (x >= 0.01 ? String(r3(x)) : x >= 1e-4 ? String(Math.round(x * 1e5) / 1e5) : x.toExponential(1))

const AXES = ['x', 'y', 'z'] as const
const SQUARE = Math.cos((0.01 * Math.PI) / 180)

/** Where a flat face lies: its coordinate where it is square to an axis
 *  ("x 10.98"), else its middle. */
function placeOf(fp: FaceFingerprint): string {
  if (fp.kind === 'plane') {
    // Square to it within a hundredth of a degree: a wall leaning more
    // has no one coordinate.
    for (let k = 0; k < 3; k++) if (Math.abs(fp.dir[k]) > SQUARE) return `${AXES[k]} ${r2(fp.centroid[k])}`
  }
  return `at (${fp.centroid.map(r2).join(', ')})`
}

const pieceOf = (t: FaceTrace | null) => (t?.piece && t.sketch ? `${t.piece.kind} ${t.piece.id} of ${t.sketch.name}` : null)
const makerOf = (t: FaceTrace | null, fp: FaceFingerprint) => t?.feature.name ?? `feature ${fp.origin}`

/** A face as a step's sentence names it: what it is to its feature, and
 *  where — "wall (x 10.98, line 8 of Plan wing)". */
function faceWords(t: FaceTrace | null, fp: FaceFingerprint, radius?: number): string {
  const what = fp.kind === 'cylinder' || fp.kind === 'cone' ? 'round' : t?.role === 'wall' ? 'wall' : t?.role === 'cap' ? 'end face' : 'face'
  const place = radius !== undefined ? `R${mm(radius)}` : placeOf(fp)
  const piece = pieceOf(t)
  return `${what} (${place}${piece ? `, ${piece}` : ''})`
}

/** The fix for two faces drawn in two sketches: fit the one's level into
 *  the other sketch, or project the other's piece. */
function fixWords(a: FaceTrace | null, b: FaceTrace | null): string {
  if (a?.sketch && b?.sketch && a.sketch.id === b.sketch.id) {
    return a.piece && b.piece ? `make ${a.piece.kind} ${a.piece.id} and ${b.piece.kind} ${b.piece.id} of ${a.sketch.name} one (a collinear or concentric relation, or one piece for both)` : `draw them as one piece in ${a.sketch.name}`
  }
  if (a?.sketch && b?.sketch) {
    const project = b.piece ? `project ${b.piece.kind} ${b.piece.id} (project: [{ sketch: ${JSON.stringify(b.sketch.name)}, pieces: [${b.piece.id}] }]) into ${a.sketch.name} in its place` : `project ${b.sketch.name}'s piece into ${a.sketch.name}`
    return `fit ${a.sketch.name}'s level into ${b.sketch.name} (fit.level), or ${project}`
  }
  return 'one surface for both: project the one into the other’s sketch, or dimension both from one plane'
}

/** One step in a sentence, the join's own face first. */
export function stepSentence(s: StepBetween, features: readonly Feature[]): string {
  const [fa, fb] = s.faces
  const ta = traceFace(features, fa), tb = traceFace(features, fb)
  const a = makerOf(ta, fa), b = makerOf(tb, fb)
  const off = mm(s.off)
  if (s.form === 'round') {
    const [ra, rb] = s.radii ?? [fa.radius, fb.radius]
    // units-ok: a join's step, on its row's warning and in the agent's answer alike
    const axes = s.axisOff !== undefined && s.axisOff > 1e-4 ? `, axes ${mm(s.axisOff)} mm apart` : ''
    // units-ok: a join's step, on its row's warning and in the agent's answer alike
    return `${a}'s ${faceWords(ta, fa, ra)} runs ${off} mm off ${b}'s ${faceWords(tb, fb, rb).replace(/^round /, '')}${axes}: one round drawn twice — ${fixWords(ta, tb)}`
  }
  if (s.form === 'foot' || s.form === 'tangent') {
    // The round first, whichever made it.
    const roundFirst = fa.kind === 'cylinder'
    const [tr, fr, tp, fpl] = roundFirst ? [ta, fa, tb, fb] : [tb, fb, ta, fa]
    const sketch = tr?.sketch?.name
    const round = `${makerOf(tr, fr)}'s ${faceWords(tr, fr, fr.radius)}`
    const face = `${makerOf(tp, fpl)}'s ${faceWords(tp, fpl).replace(/^(wall|end face|face) /, 'face ')}`
    // units-ok: a join's step, on its row's warning and in the agent's answer alike
    if (s.form === 'foot') return `${round} starts ${off} mm off ${face}: a profile that nearly starts on that face — hold its end on the face${sketch ? ` (project the face’s edge into ${sketch} and put the end on it)` : ''}, or let it start clearly off it`
    // units-ok: a join's step, on its row's warning and in the agent's answer alike
    const how = s.creaseDeg !== undefined ? `dips ${off} mm through ${face}, meeting it at ${Math.round(s.creaseDeg * 10) / 10}°` : `stands ${off} mm short of ${face}`
    return `${round} ${how}: a round meant to touch that face — make it tangent to the face${sketch ? ` (project the face’s edge into ${sketch} and hold the arc tangent to it)` : ''}, or let it cross clearly`
  }
  const walls = ta?.role === 'wall' && tb?.role === 'wall'
  const caps = ta?.role === 'cap' && tb?.role === 'cap'
  const other = faceWords(tb, fb).replace(/^(wall|end face|face) /, '')
  // units-ok: a join's step, on its row's warning and in the agent's answer alike
  if (walls) return `${a}'s ${faceWords(ta, fa)} stands ${off} mm off ${b}'s ${other}: one wall drawn twice — ${fixWords(ta, tb)}`
  // units-ok: a join's step, on its row's warning and in the agent's answer alike
  if (caps) return `${a}'s ${faceWords(ta, fa)} lies ${off} mm off ${b}'s ${other}: two heights meant as one — give both extents one parameter, or extrude ${a} up to ${b}'s face`
  // units-ok: a join's step, on its row's warning and in the agent's answer alike
  return `${a}'s ${faceWords(ta, fa)} lies ${off} mm off ${b}'s ${faceWords(tb, fb)}, facing one way: two faces meant as one — ${fixWords(ta, tb)}`
}

/** A join's steps as its row's warning says them: the thinnest few, and
 *  how many more. */
export function stepsWarning(steps: readonly StepBetween[], features: readonly Feature[]): string {
  const said = steps.slice(0, STEPS_WORDED).map((s) => `${stepSentence(s, features)}.`)
  const more = steps.length - said.length
  const hairs = steps.slice(STEPS_WORDED).filter((s) => s.off < HAIR_MM).length
  const lead = steps.length === 1 ? 'A step between features:' : `${steps.length} steps between features:`
  // units-ok: a join's step, on its row's warning and in the agent's answer alike
  const rest = more > 0 ? ` And ${more} more${hairs > 0 ? ` (${hairs === more ? 'all' : hairs} hairline${hairs === 1 ? '' : 's'} under ${HAIR_MM} mm)` : ''} — reverse.body.check lists them by feature.` : ''
  return `${lead} ${said.join(' ')}${rest}`
}

/** A length as the page shows it, in the units shown, to `places` decimals
 *  of a millimetre — with its unit (`len`) or without (`bare`). */
export interface ShowLength {
  len: (mm: number, places: number) => string
  bare: (mm: number, places: number) => string
}

/** One line of a feature's box: what it says, and the sentences the agent
 *  gets for the steps it stands for (stepSentence), for its hover. */
export interface StepLine {
  text: string
  full: string
}

/** How many lines the feature's box lists — the rest counted. */
const STEP_LINES = 5

/** A join's steps as the feature's box lists them, for the person: a short
 *  line each — who stands off whom, by how much, where, and the fix in a
 *  few words. Steps alike but for where (a round starting off a face at
 *  both its ends) are one line with every place; the sketch pieces and the
 *  commands are the hover's. `more`: steps past the lines, and how many of
 *  them are hairlines. */
export function stepLines(steps: readonly StepBetween[], features: readonly Feature[], show: ShowLength): { lines: StepLine[]; more: number; hairs: number } {
  const offOf = (x: number) => show.len(x, x >= 0.01 ? 3 : 5)
  const radius = (r: number | undefined) => (r !== undefined ? ` (R${show.bare(r, 2)})` : '')
  // A flat face square to an axis by its coordinate; any other by nothing.
  const placeIn = (fp: FaceFingerprint) => {
    if (fp.kind === 'plane') for (let k = 0; k < 3; k++) if (Math.abs(fp.dir[k]) > SQUARE) return `${AXES[k]} ${show.bare(fp.centroid[k], 2)}`
    return null
  }
  const groups = new Map<string, { places: string[]; steps: StepBetween[] }>()
  for (const s of steps) {
    const [fa, fb] = s.faces
    const ta = traceFace(features, fa), tb = traceFace(features, fb)
    const off = offOf(s.off)
    let line: string
    let place: string | null = null
    if (s.form === 'round') {
      const [ra, rb] = s.radii ?? [fa.radius, fb.radius]
      line = `${makerOf(ta, fa)}${radius(ra)} runs ${off} off ${makerOf(tb, fb)}${radius(rb)} — one round drawn twice`
    } else if (s.form === 'foot' || s.form === 'tangent') {
      const roundFirst = fa.kind === 'cylinder'
      const [tr, fr, tp, fpl] = roundFirst ? [ta, fa, tb, fb] : [tb, fb, ta, fa]
      const round = `${makerOf(tr, fr)}${radius(fr.radius)}`
      place = placeIn(fpl)
      const face = `${makerOf(tp, fpl)}{at}`
      line =
        s.form === 'foot'
          ? `${round} starts ${off} off ${face} — end it on the face, or clearly off it`
          : s.creaseDeg !== undefined
            ? `${round} dips ${off} into ${face} at ${Math.round(s.creaseDeg * 10) / 10}° — make it tangent, or let it cross clearly`
            : `${round} stops ${off} short of ${face} — make it tangent, or let it cross clearly`
    } else {
      place = placeIn(fb)
      const a = makerOf(ta, fa), b = makerOf(tb, fb)
      line =
        ta?.role === 'wall' && tb?.role === 'wall'
          ? `${a}'s wall stands ${off} off ${b}'s{at} — one wall drawn twice`
          : ta?.role === 'cap' && tb?.role === 'cap'
            ? `${a}'s end face lies ${off} off ${b}'s{at} — one height given twice`
            : `${a}'s face lies ${off} off ${b}'s{at} — two faces meant as one`
    }
    const g = groups.get(line) ?? { places: [], steps: [] }
    if (place && !g.places.includes(place)) g.places.push(place)
    g.steps.push(s)
    groups.set(line, g)
  }
  const all = [...groups]
  const lines = all.slice(0, STEP_LINES).map(([line, g]) => ({
    text: `${line.replace('{at}', g.places.length > 0 ? ` (${g.places.join(', ')})` : '')}.`,
    full: g.steps.map((s) => `${stepSentence(s, features)}.`).join('\n'),
  }))
  const unlisted = all.slice(STEP_LINES).flatMap(([, g]) => g.steps)
  return { lines, more: unlisted.length, hairs: unlisted.filter((s) => s.off < HAIR_MM).length }
}

/** A face of a step as an answer names it. */
function faceOut(fp: FaceFingerprint, t: FaceTrace | null) {
  return {
    feature: t?.feature.name ?? null,
    ...(t?.sketch ? { sketch: t.sketch.name } : {}),
    ...(t?.piece ? { piece: t.piece.id } : {}),
    role: fp.kind === 'cylinder' || fp.kind === 'cone' ? 'round' : (t?.role ?? 'other'),
    ...(fp.kind === 'plane' ? { place: placeOf(fp) } : {}),
  }
}

/** A join's steps as a change's answer gives them (stepsBetween — a
 *  change's `steps` are its build's): the thinnest STEPS_LISTED, hairlines
 *  last, each with its form, width, place, the two faces traced and the
 *  sentence; stepsBetweenFound when there are more. */
export function stepsAnswer(steps: readonly StepBetween[] | undefined, features: readonly Feature[]): { stepsBetween?: unknown[]; stepsBetweenFound?: number } {
  if (!steps || steps.length === 0) return {}
  const listed = steps.slice(0, STEPS_LISTED).map((s) => ({
    form: s.form,
    offMm: Number(mm(s.off)),
    at: s.at.map(r3) as Vec3,
    face: faceOut(s.faces[0], traceFace(features, s.faces[0])),
    other: faceOut(s.faces[1], traceFace(features, s.faces[1])),
    note: stepSentence(s, features),
  }))
  return { stepsBetween: listed, ...(steps.length > STEPS_LISTED ? { stepsBetweenFound: steps.length } : {}) }
}

/** A build's results with each join's steps said in its warning, after
 *  what the build itself warned of — which is kept apart as well, for the
 *  feature's box to list the steps its own way (stepLines). */
export function withStepsSaid(results: readonly FeatureResult[], features: readonly Feature[]): FeatureResult[] {
  return results.map((r) =>
    r.status === 'ok' && r.stepsBetween?.length ? { ...r, ...(r.warning ? { ownWarning: r.warning } : {}), warning: [r.warning, stepsWarning(r.stepsBetween, features)].filter(Boolean).join(' ') } : r,
  )
}
