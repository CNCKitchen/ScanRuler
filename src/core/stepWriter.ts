// SPDX-License-Identifier: AGPL-3.0-only
// The Part 21 primitives both STEP writers are built from: number and string
// formatting to the letter of ISO 10303-21, an entity table that hands out its
// own instance names, and the placements every piece of geometry is hung on.
// All coordinates are millimetres, angles radians.

import type { Vec3 } from './types'

/** A STEP real: always carries a decimal point, exponent uppercased. */
export function num(v: number): string {
  if (!Number.isFinite(v) || Object.is(v, -0)) v = 0
  let s = v.toPrecision(12)
  if (s.includes('e') || s.includes('E')) {
    const [mantRaw, expRaw] = s.toLowerCase().split('e')
    let mant = trimZeros(mantRaw)
    if (!mant.includes('.')) mant += '.'
    return `${mant}E${expRaw}`
  }
  s = trimZeros(s)
  if (!s.includes('.')) s += '.'
  return s
}

function trimZeros(s: string): string {
  if (!s.includes('.')) return s
  return s.replace(/0+$/, '')
}

export function vec(v: Vec3): string {
  return `${num(v[0])},${num(v[1])},${num(v[2])}`
}

/** STEP string literal payload: quotes doubled, non-ASCII replaced — element
 *  names are plain ASCII, this only guards pasted file names. */
export function esc(s: string): string {
  return s
    .replace(/'/g, "''")
    .replace(/\\/g, '\\\\')
    // eslint-disable-next-line no-control-regex
    .replace(/[^\x20-\x7e]/g, '?')
}

export class StepWriter {
  lines: string[] = []
  private id = 0

  add(entity: string): number {
    const id = ++this.id
    this.lines.push(`#${id}=${entity};`)
    return id
  }
}

export function point(w: StepWriter, p: Vec3): number {
  return w.add(`CARTESIAN_POINT('',(${vec(p)}))`)
}

export function direction(w: StepWriter, d: Vec3): number {
  return w.add(`DIRECTION('',(${vec(d)}))`)
}

/** Location + z axis + x reference direction. */
export function placement(w: StepWriter, origin: Vec3, z: Vec3, x: Vec3): number {
  const o = point(w, origin)
  const az = direction(w, z)
  const ax = direction(w, x)
  return w.add(`AXIS2_PLACEMENT_3D('',#${o},#${az},#${ax})`)
}
