// SPDX-License-Identifier: AGPL-3.0-only
// Scaling the scan to its true size. A photogrammetry reconstruction is right
// in shape and has no size at all — structure from motion fixes the scene only
// up to one scale factor — so it comes out in whatever units the program
// chose. The factor worth trusting is measured: a length on the real part,
// taken with calipers, against the same length on the scan.
//
// A scale multiplies every coordinate of the frame the part is in by one
// factor, about its zero point: the datum origin once the part is aligned, the
// file's own origin before. Everything placed on the part or measured off it
// goes with it — fits, sections, typed-in positions, extensions — so the
// session looks the same afterwards, only that size. What the person typed
// as a requirement stays as typed: a dimension's limits, a known or assumed
// diameter.
//
// Pure: the store and the session apply it (state/store, app/partScale).

import type { Rigid } from './deviation/rigid'
import type { Extension } from './elements/extend'
import type { SectionFrame } from './section/frame'
import type { ElementSource, FitData, Vec3 } from './types'

/** The smallest and largest factor a scale takes: past these it is a typing
 *  slip, not a reconstruction's units. */
export const SCALE_MIN = 1e-6
export const SCALE_MAX = 1e6

/** A length known two ways: as the scan has it and as it really is, mm. */
export interface ScaleReference {
  /** What it is, in words — "Distance 1", "Cylinder 2 Ø", "2 points". */
  label: string
  /** As measured on the scan. */
  measured: number
  /** As it is on the real part. */
  true: number
}

/** A reference as the combined factor sees it. */
export interface WeighedReference extends ScaleReference {
  /** The factor this reference alone asks for. */
  factor: number
  /** How far that is off the combined factor, as a share of it: +0.004 asks
   *  for 0.4 % more. */
  off: number
}

export interface CombinedScale {
  factor: number
  references: WeighedReference[]
  /** The largest |off| among the references; 0 for one. */
  spread: number
}

/** How the scan got its size, as the session keeps it: the factor every
 *  scale so far came to together, and the references of the last one. */
export interface ScanScale {
  factor: number
  references: ScaleReference[]
}

/** Why a factor cannot be applied, or null when it can. */
export function factorProblem(factor: number): string | null {
  if (!Number.isFinite(factor) || factor <= 0) return 'The factor must be a positive number.'
  if (factor < SCALE_MIN || factor > SCALE_MAX) return `A factor of ${factor} is out of reach — it must lie between ${SCALE_MIN} and ${SCALE_MAX}.`
  if (factor === 1) return 'A factor of 1 leaves the scan as it is.'
  return null
}

/** Why a reference cannot be used, or null when it can. */
export function referenceProblem(r: ScaleReference): string | null {
  if (!Number.isFinite(r.measured) || r.measured <= 0) return `${r.label} has no length on the scan to scale from.`
  if (!Number.isFinite(r.true) || r.true <= 0) return `${r.label} needs its true length — a positive number.`
  return null
}

/**
 * One factor from any number of references. Each asks for true ÷ measured;
 * together they are averaged in proportion to how long each is, since the
 * same picking or fitting error is a smaller share of a longer length. The
 * mean is taken of the logarithms, so ×2 and ×½ average to ×1, not ×1.25.
 */
export function combineReferences(references: readonly ScaleReference[]): CombinedScale {
  if (references.length === 0) throw new Error('Give at least one reference length.')
  for (const r of references) {
    const problem = referenceProblem(r)
    if (problem) throw new Error(problem)
  }
  let sum = 0
  let weights = 0
  for (const r of references) {
    sum += r.true * Math.log(r.true / r.measured)
    weights += r.true
  }
  const factor = Math.exp(sum / weights)
  const weighed = references.map((r) => {
    const own = r.true / r.measured
    return { ...r, factor: own, off: own / factor - 1 }
  })
  return { factor, references: weighed, spread: Math.max(0, ...weighed.map((r) => Math.abs(r.off))) }
}

export const scalePoint = (p: Vec3, s: number): Vec3 => [p[0] * s, p[1] * s, p[2] * s]

/** The same fit, `s` times the size about the frame's zero point. Directions
 *  and angles are as they were; every length — residuals included — is
 *  times `s`. */
export function scaleFit(fit: FitData, s: number): FitData {
  const base = {
    sigma: fit.sigma * s,
    ...(fit.formError !== undefined ? { formError: fit.formError * s } : {}),
    ...(fit.residualMin !== undefined ? { residualMin: fit.residualMin * s } : {}),
    ...(fit.residualMax !== undefined ? { residualMax: fit.residualMax * s } : {}),
  }
  const center = scalePoint(fit.center, s)
  switch (fit.kind) {
    case 'point':
      return { ...fit, ...base, center }
    case 'line':
      return { ...fit, ...base, center, length: fit.length * s }
    case 'sphere':
      return {
        ...fit,
        ...base,
        center,
        radius: fit.radius * s,
        ...(fit.held ? { held: { freeDiameter: fit.held.freeDiameter * s, shift: fit.held.shift * s } } : {}),
      }
    case 'cylinder':
      return { ...fit, ...base, center, radius: fit.radius * s, length: fit.length * s }
    case 'cone':
      return { ...fit, ...base, center, radius: fit.radius * s, radius1: fit.radius1 * s, radius2: fit.radius2 * s, length: fit.length * s }
    case 'torus':
      return { ...fit, ...base, center, majorRadius: fit.majorRadius * s, minorRadius: fit.minorRadius * s }
    case 'plane':
      return { ...fit, ...base, center, extentU: fit.extentU * s, extentV: fit.extentV * s }
    case 'circle':
      return { ...fit, ...base, center, radius: fit.radius * s }
  }
}

/** An element's rebuild recipe at `s` times the size: the positions and
 *  lengths its construction holds of its own. Vertex numbers and references
 *  to other elements are as they were. */
export function scaleSource(source: ElementSource, s: number): ElementSource {
  if (source.type !== 'constructed') return source
  const p = source.params
  const times = (from: number, to: number): number[] => p.map((v, i) => (i >= from && i < to ? v * s : v))
  switch (source.method) {
    case 'point-coords':
    case 'point-centroid':
      return { ...source, params: times(0, 3) }
    case 'plane-offset':
      return { ...source, params: times(0, 1) }
    case 'plane-coords':
      return { ...source, params: times(3, 6) }
    case 'plane-symmetry':
      // The normal, the point, then the mirror image's RMS and its counts.
      return { ...source, params: times(3, 7) }
    case 'circle-coords':
      // The diameter, the normal, the centre.
      return { ...source, params: p.map((v, i) => (i === 0 || i >= 4 ? v * s : v)) }
    default:
      return source
  }
}

export function scaleExtension(e: Extension, s: number): Extension {
  return e.kind === 'cylinder'
    ? { ...e, start: e.start * s, end: e.end * s }
    : { ...e, uMin: e.uMin * s, uMax: e.uMax * s, vMin: e.vMin * s, vMax: e.vMax * s }
}

export function scaleFrame(frame: SectionFrame, s: number): SectionFrame {
  return { ...frame, origin: scalePoint(frame.origin, s) }
}

/** The alignment that puts the scan read `s` times larger where the scaled
 *  part now stands: R·(s·raw) + s·t is s·(R·raw + t), so the rotation stays
 *  and the translation is times `s`. */
export function scaleRigid(m: Rigid, s: number): Rigid {
  return { r: m.r.slice(), t: Float64Array.from(m.t, (v) => v * s) }
}

/** The usual units mix-ups, as factors: a file in cm, m or inches read as
 *  mm, and the other way round. */
const UNIT_GUESSES: { factor: number; word: string }[] = [
  { factor: 10, word: 'centimetres' },
  { factor: 25.4, word: 'inches' },
  { factor: 1000, word: 'metres' },
]

/** Under this diagonal, or over the next, a scan is taken to have no true
 *  size, mm: no part ScanRuler measures is a few millimetres across, or
 *  several metres. */
export const SIZE_PLAUSIBLE_MIN_MM = 5
export const SIZE_PLAUSIBLE_MAX_MM = 5000

/** Whether a scan this big across, mm, looks like it has no true size — and,
 *  when it is too small, which of the usual units mix-ups would bring it to
 *  a size a part has. */
export function sizeLooksOff(diagonal: number): { small: boolean; guesses: { factor: number; word: string }[] } | null {
  if (!(diagonal > 0) || (diagonal >= SIZE_PLAUSIBLE_MIN_MM && diagonal <= SIZE_PLAUSIBLE_MAX_MM)) return null
  const small = diagonal < SIZE_PLAUSIBLE_MIN_MM
  return { small, guesses: small ? UNIT_GUESSES.filter((g) => diagonal * g.factor >= 10 && diagonal * g.factor <= 2000) : [] }
}

/** The name Meshroom gives the textured mesh it ends with — a scan with no
 *  true size, whatever size it came out. */
export const isMeshroomOutput = (fileName: string | null): boolean => !!fileName && /^texturedMesh\.obj$/i.test(fileName)

/** Why a scan looks like it has no true size yet — Meshroom's output by its
 *  name, or a size no part has — with the unit mix-ups that would fit; null
 *  when it looks sized, or was scaled already. */
export function noTrueSize(
  fileName: string | null,
  diagonal: number,
  scaled: boolean,
): { why: 'meshroom' | 'small' | 'large'; guesses: { factor: number; word: string }[] } | null {
  if (scaled) return null
  const off = sizeLooksOff(diagonal)
  if (off) return { why: off.small ? 'small' : 'large', guesses: off.guesses }
  return isMeshroomOutput(fileName) ? { why: 'meshroom', guesses: [] } : null
}

/** The same, in a sentence for the agent's readout, mm. */
export function noTrueSizeText(n: NonNullable<ReturnType<typeof noTrueSize>>, diagonal: number): string {
  // units-ok: the agent's readout, which is in millimetres always
  const across = `${+diagonal.toPrecision(3)} mm across`
  const why = n.why === 'meshroom'
    ? 'It is Meshroom’s output, and photogrammetry gives a part no true size.'
    : `It is ${across} — ${n.why === 'small' ? 'too small' : 'too large'} for a part, so its units are likely not millimetres.`
  const guesses = n.guesses.length ? ` A file in ${n.guesses.map((g) => `${g.word} would be ×${g.factor}`).join(', ')}.` : ''
  return `${why}${guesses} Scale it from a length measured on the real part (scan.scale).`
}
