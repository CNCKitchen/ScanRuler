// SPDX-License-Identifier: AGPL-3.0-only
// The workspace's own key pictures, drawn on the app's icon grid to its
// rules (see src/ui/icons.tsx): ink for what is there, blue for what the
// key does, dashed for what is only referred to. Kept here rather than in
// the app's set, which every workspace loads. KeyIcon draws one of either.

import type { ReactNode } from 'react'
import { Icon, IconFrame, type IconName } from '../../../src/ui/icons'

const RE_ICONS = {
  // A regular polygon on its construction circle: corners on the circle,
  // the centre and a corner clicked.
  polygon: (
    <>
      <circle className="i-th i-ds" cx="12" cy="12" r="8.5" />
      <path d="M20.5 12 16.25 19.36h-8.5L3.5 12l4.25-7.36h8.5Z" />
      <circle className="i-adt" cx="12" cy="12" r="1.6" />
      <circle className="i-adt" cx="20.5" cy="12" r="1.8" />
    </>
  ),
  // Sides touching the circle: the centre and the middle of a side.
  polygonOutside: (
    <>
      <path d="M19.5 7.67v8.66L12 20.66l-7.5-4.33V7.67L12 3.34Z" />
      <circle className="i-th i-ds" cx="12" cy="12" r="7.5" />
      <circle className="i-adt" cx="12" cy="12" r="1.6" />
      <circle className="i-adt" cx="19.5" cy="12" r="1.8" />
    </>
  ),
  // A point of the sketch where two construction lines cross.
  sketchPoint: (
    <>
      <path className="i-th i-ds" d="M4 12h16M12 4v16" />
      <circle className="i-adt" cx="12" cy="12" r="2.6" />
    </>
  ),
  // Trim: two lines crossing, the stretch beyond the crossing dashed away
  // and the cutter's blue stroke where it is cut.
  trim: (
    <>
      <path d="M3 15h7.5" />
      <path className="i-th i-ds" d="M10.5 15H21" />
      <path className="i-a" d="M10.5 4v16" />
      <path className="i-a" d="M14.5 10.5l5 5M19.5 10.5l-5 5" />
    </>
  ),
  // Two lines of one length.
  equal: (
    <>
      <path d="M3 6.5h9M12 17.5h9" />
      <path className="i-a" d="M9.5 10.5h5M9.5 13.5h5" />
    </>
  ),
  // A piece and its copies in a grid.
  sketchPattern: (
    <>
      <path className="i-g" d="M3.5 3.5h6v6h-6Z" />
      <path className="i-a" d="M14.5 3.5h6v6h-6ZM3.5 14.5h6v6h-6ZM14.5 14.5h6v6h-6Z" />
    </>
  ),
  // And round a centre.
  sketchPatternRound: (
    <>
      <circle className="i-g" cx="12" cy="4.5" r="2.5" />
      <circle className="i-a" cx="18.5" cy="15.75" r="2.5" />
      <circle className="i-a" cx="5.5" cy="15.75" r="2.5" />
      <circle className="i-th i-ds" cx="12" cy="12" r="7.5" />
      <circle className="i-adt" cx="12" cy="12" r="1.4" />
    </>
  ),
  // A block's round taken off — dashed, it goes — and the two faces run on
  // to the corner it stood in.
  deleteFace: (
    <>
      <path className="i-gf" d="M4 4h16v16H4Z" />
      <path d="M12 4h8v16H4v-8" />
      <path className="i-th i-ds" d="M4 12a8 8 0 0 1 8-8" />
      <path className="i-a" d="M4 12V4h8" />
    </>
  ),
  // A body grown all round by a distance.
  offsetBody: (
    <>
      <path className="i-g" d="M7 9h10v8H7Z" />
      <path className="i-a" d="M7 5.5h10A3.5 3.5 0 0 1 20.5 9v8a3.5 3.5 0 0 1-3.5 3.5H7A3.5 3.5 0 0 1 3.5 17V9A3.5 3.5 0 0 1 7 5.5Z" />
    </>
  ),
  // A body carried along an arrow and turned: where it stood, dashed, and
  // where it goes.
  moveBody: (
    <>
      <path className="i-ds" d="M3.5 12.5h7v7h-7Z" />
      <path className="i-f" d="m14.4 3.4 6.4 1.7-1.7 6.4-6.4-1.7Z" />
      <path className="i-a i-th" d="M7 11V7.5h3.5M7 7.5l4.5 4.5" />
    </>
  ),
  // A component of the body list: a folder with a body in it.
  component: (
    <>
      <path d="M2.5 5.5h6.5l2 2h10.5v11h-19Z" />
      <path className="i-f" d="M9.5 10.5h5v5h-5Z" />
    </>
  ),
  // A STEP file — a page with its corner turned — coming in as a body.
  importStep: (
    <>
      <path d="M3.5 2.5h6.5l3 3V12" />
      <path d="M10 2.5v3h3M3.5 2.5V12" />
      <path className="i-a i-th" d="M8 9v6.5h4.5M10.5 13.5l2 2-2 2" />
      <path className="i-f" d="M14.5 12.5h6v8h-6Z" />
    </>
  ),
  // The gap between two bodies, measured.
  clearance: (
    <>
      <path className="i-g" d="M2.5 5h6v14h-6ZM15.5 5h6v14h-6Z" />
      <path className="i-a i-th" d="M9.5 12h5M11 10.5 9.5 12l1.5 1.5M13 10.5l1.5 1.5-1.5 1.5" />
    </>
  ),
  // A picture laid under the sketch, scaled by a length on it.
  sketchImage: (
    <>
      <path className="i-g" d="M3 4.5h18v15H3Z" />
      <path className="i-th" d="m3 16.5 5-5 4 4 3-3 6 6" />
      <circle className="i-th" cx="15.5" cy="8.5" r="1.5" />
      <path className="i-a" d="M5 21.5h14" />
      <circle className="i-adt" cx="5" cy="21.5" r="1.4" />
      <circle className="i-adt" cx="19" cy="21.5" r="1.4" />
    </>
  ),
  // A heat-set insert, knurled, over the hole it is pressed into.
  insert: (
    <>
      <path className="i-g" d="M4 21V9h4.5v12M15.5 21V9H20v12" />
      <path className="i-a" d="M8.5 3.5h7v10h-7Z" />
      <path className="i-a i-th" d="m8.5 6 7 2m-7 1.5 7 2M8.5 3.5l7 2" />
    </>
  ),
  // A note for the agent: a callout pinned on the part, words in it.
  note: (
    <>
      <path d="M3.5 3.5h17v12H12l-4.5 4.5v-4.5h-4Z" />
      <path className="i-a" d="M7 7.5h10M7 11.5h6.5" />
    </>
  ),
  // The playback's keys: play, hold, a step either way, and the end of it.
  play: (
    <>
      <path className="i-f" d="M7.5 4.5v15L19.5 12Z" />
    </>
  ),
  pause: (
    <>
      <path className="i-g" d="M7 5h3.5v14H7ZM13.5 5H17v14h-3.5Z" />
    </>
  ),
  stepBack: (
    <>
      <path d="M6 5v14" />
      <path className="i-f" d="M18.5 5v14L9 12Z" />
    </>
  ),
  stepForward: (
    <>
      <path d="M18 5v14" />
      <path className="i-f" d="M5.5 5v14L15 12Z" />
    </>
  ),
  stop: (
    <>
      <path className="i-g" d="M6 6h12v12H6Z" />
    </>
  ),
  // A block with one edge rounded, and the two lines where the round runs
  // into the flats on either side of it — the tangent edges.
  tangentEdges: (
    <>
      <path className="i-g" d="M3 21V8h6a6 6 0 0 1 6 6v7Z" />
      <path d="m3 8 5-5h6a6 6 0 0 1 6 6v7l-5 5" />
      <path className="i-a" d="m9 8 5-5M15 14l5-5" />
    </>
  ),
  // A feature in the build, as the eye is a sketch shown: a block.
  built: (
    <>
      <path className="i-g" d="M12 3.5 19.5 7.5v9L12 20.5 4.5 16.5v-9Z" />
      <path d="M4.5 7.5 12 11.5l7.5-4M12 11.5v9" />
    </>
  ),
  // Left out of the build, as the eye struck through is a sketch hidden.
  suppressed: (
    <>
      <path className="i-ft i-ds" d="M12 3.5 19.5 7.5v9L12 20.5 4.5 16.5v-9Z" />
      <path d="M4.5 19.5 19.5 4.5" />
    </>
  ),
} satisfies Record<string, ReactNode>

export type ReIconName = keyof typeof RE_ICONS
export type KeyIconName = IconName | ReIconName

const isReIcon = (name: KeyIconName): name is ReIconName => name in RE_ICONS

/** A key's picture from the app's set or the workspace's own. */
export function KeyIcon({ name, size = 24 }: { name: KeyIconName; size?: number }) {
  if (!isReIcon(name)) return <Icon name={name} size={size} />
  return <IconFrame size={size}>{RE_ICONS[name]}</IconFrame>
}
