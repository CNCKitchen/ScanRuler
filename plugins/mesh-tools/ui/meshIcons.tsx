// SPDX-License-Identifier: AGPL-3.0-only
// The icons of the tools this workspace has that the app's own set does not
// draw: on the set's 24-unit grid and with its strokes and fills (see
// src/ui/icons.tsx), so they sit in the tool row beside its own.

import type { ReactNode } from 'react'
import { IconFrame } from '../../../src/ui/icons'

const ICONS = {
  // A profile, and the same profile a step out all round — not a larger
  // copy of it: the corner keeps its radius plus the step.
  offsetSurface: (
    <>
      <path className="i-g" d="M8 20v-8a4 4 0 0 1 4-4h8v12Z" />
      <path className="i-a i-ds" d="M4 20v-8a8 8 0 0 1 8-8h8" />
      <path className="i-a" d="m9.2 9.2-2.6-2.6m0 0v2.3m0-2.3h2.3" />
    </>
  ),
  // The missing piece over the broken part, the two meeting along the same
  // rough line — and, dashed, the body it was cut from, reaching on into the
  // part.
  trimToScan: (
    <>
      <path className="i-g" d="M3 21V14l3-2 3 2 3-3 3 2 3-2 3 1V21Z" />
      <path className="i-f" d="M3 3h18v6.5l-3-1-3 2-3-2-3 3-3-2-3 2Z" />
      <path className="i-a i-ds" d="M3 11.5V16.5H21V9.5" />
    </>
  ),
  // A piece of surface, the normal that pointed into it dashed, and the one
  // it is turned to pointing out.
  flipNormals: (
    <>
      <path className="i-g" d="M2.5 21v-8c5.5-4 13.5-4 19 0v8Z" />
      <path className="i-ds" d="M8 10.5v7.5M5.8 15.8 8 18l2.2-2.2" />
      <path className="i-a" d="M16 10.5V2.5M13.8 4.7 16 2.5l2.2 2.2" />
    </>
  ),
  // A jumble of pieces, overlapping and loose, and one closed skin round
  // them all.
  wrapSkin: (
    <>
      <path className="i-g" d="M7 8h5v6H7Z" />
      <circle className="i-g" cx="15" cy="10.5" r="3.5" />
      <path className="i-g" d="M8 15.5h7v3H8Z" />
      <path className="i-a" d="M3.5 12c0-5.5 3.5-8.5 9-8.5 5 0 8 3 8 7.5 0 5.5-3 9.5-8.5 9.5S3.5 17.5 3.5 12Z" />
    </>
  ),
  // A part cut open: a wall the same thickness all round a sealed hollow.
  shellSolid: (
    <>
      <path className="i-f" fillRule="evenodd" d="M3.5 4.5h17v15h-17ZM7.5 8.5v7h9v-7Z" />
      <path className="i-th" d="M3.5 12h4m9 0h4" />
    </>
  ),
} satisfies Record<string, ReactNode>

export type MeshIconName = keyof typeof ICONS

/** One of the workspace's own icons, 24 px unless told otherwise —
 *  decoration only, as the set's are. */
export function MeshIcon({ name, size = 24 }: { name: MeshIconName; size?: number }) {
  return <IconFrame size={size}>{ICONS[name]}</IconFrame>
}
